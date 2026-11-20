import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startTestServer, api, loginAll } from '../helpers.js';

let app, c, s;
before(async () => {
  app = await startTestServer({ LOGIN_RATE_LIMIT: '5' });
  c = api(app.url);
  s = await loginAll(c, ['admin', 'teacher', 'student', 'parent']);
});
after(() => app.close());

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('login', () => {
  test('returns an access token, refresh cookie and role permissions', async () => {
    const res = await c.post('/api/auth/login', { tenant: 'northfield', email: 'AVA@northfield.test ', password: 'orbit123' });
    assert.equal(res.status, 200);
    assert.equal(res.body.tokenType, 'Bearer');
    assert.equal(res.body.user.role, 'student');
    assert.equal(res.body.user.tenant.slug, 'northfield');
    assert.ok(res.body.user.permissions.includes('attendance.checkin'));
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /orbit_rt=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/api\/auth/);
    const claims = JSON.parse(Buffer.from(res.body.accessToken.split('.')[1], 'base64url'));
    assert.equal(claims.role, 'student');
    assert.equal(claims.typ, 'access');
    assert.equal(claims.exp - claims.iat, 900);
  });

  test('rejects wrong password, unknown email and wrong school with the same message', async () => {
    const a = await c.post('/api/auth/login', { tenant: 'northfield', email: 'm.reed@northfield.test', password: 'nope' });
    const b = await c.post('/api/auth/login', { tenant: 'northfield', email: 'ghost@northfield.test', password: 'orbit123' });
    const d = await c.post('/api/auth/login', { tenant: 'riverside', email: 'm.reed@northfield.test', password: 'orbit123' });
    for (const r of [a, b, d]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, 'invalid_credentials');
    }
  });

  test('validates input', async () => {
    const r = await c.post('/api/auth/login', { tenant: '', email: 'not-an-email' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'bad_request');
  });

  test('rate-limits repeated failures per account', async () => {
    const attempt = () => c.post('/api/auth/login', { tenant: 'northfield', email: 'p.shah@northfield.test', password: 'bad' });
    for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 401);
    const blocked = await attempt();
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
  });

  test('a deactivated account cannot sign in and its token stops working immediately', async () => {
    const users = await c.get('/api/users?search=zoe', { token: s.admin.token });
    const zoe = users.body.users[0];
    const login = await c.post('/api/auth/login', { tenant: 'northfield', email: 'zoe@northfield.test', password: 'orbit123' });
    assert.equal(login.status, 200);
    assert.equal((await c.patch(`/api/users/${zoe.id}`, { status: 'inactive' }, { token: s.admin.token })).status, 200);
    assert.equal((await c.get('/api/dashboard', { token: login.body.accessToken })).status, 401);
    const again = await c.post('/api/auth/login', { tenant: 'northfield', email: 'zoe@northfield.test', password: 'orbit123' });
    assert.equal(again.status, 403);
    assert.equal(again.body.error.code, 'account_inactive');
    assert.equal((await c.post('/api/auth/refresh', { refreshToken: login.body.refreshToken })).status, 401);
  });
});

describe('access tokens', () => {
  test('protected routes need a token', async () => {
    assert.equal((await c.get('/api/dashboard')).status, 401);
    assert.equal((await c.get('/api/dashboard', { token: 'garbage' })).status, 401);
  });

  test('a tampered role claim is rejected', async () => {
    const [h, p, sig] = s.student.token.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    const forged = `${h}.${b64({ ...claims, role: 'admin' })}.${sig}`;
    const r = await c.get('/api/integrations', { token: forged });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'invalid_token');
  });

  test('alg:none is rejected', async () => {
    const claims = JSON.parse(Buffer.from(s.admin.token.split('.')[1], 'base64url'));
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.`;
    assert.equal((await c.get('/api/dashboard', { token: none })).status, 401);
  });

  test('expired tokens return token_expired so clients know to refresh', async () => {
    const { config } = await import('../../server/config.js');
    const claims = JSON.parse(Buffer.from(s.teacher.token.split('.')[1], 'base64url'));
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const payload = b64({ ...claims, exp: Math.floor(Date.now() / 1000) - 120 });
    const sig = crypto.createHmac('sha256', config.jwt.secret).update(`${header}.${payload}`).digest('base64url');
    const r = await c.get('/api/dashboard', { token: `${header}.${payload}.${sig}` });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'token_expired');
  });

  test('role and permissions come from the database, not just the token', async () => {
    const me = await c.get('/api/auth/me', { token: s.parent.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.role, 'parent');
    assert.deepEqual(me.body.user.permissions.sort(), ['attendance.view', 'messages.send', 'requests.create']);
  });
});

describe('refresh tokens', () => {
  test('rotate on every use (cookie flow)', async () => {
    const login = await c.post('/api/auth/login', { tenant: 'northfield', email: 'maya@northfield.test', password: 'orbit123' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r1 = await c.post('/api/auth/refresh', {}, { cookie });
    assert.equal(r1.status, 200);
    assert.ok(r1.body.accessToken);
    const cookie2 = r1.headers.get('set-cookie').split(';')[0];
    assert.notEqual(cookie, cookie2);
    assert.equal((await c.get('/api/dashboard', { token: r1.body.accessToken })).status, 200);
    const r2 = await c.post('/api/auth/refresh', {}, { cookie: cookie2 });
    assert.equal(r2.status, 200);
  });

  test('re-using a rotated token revokes the whole session family', async () => {
    const login = await c.post('/api/auth/login', { tenant: 'northfield', email: 'noah@northfield.test', password: 'orbit123' });
    const first = login.body.refreshToken;
    const rotated = await c.post('/api/auth/refresh', { refreshToken: first });
    assert.equal(rotated.status, 200);
    const replay = await c.post('/api/auth/refresh', { refreshToken: first });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'refresh_reused');
    // The legitimate newer token is now dead too.
    assert.equal((await c.post('/api/auth/refresh', { refreshToken: rotated.body.refreshToken })).status, 401);
  });

  test('logout revokes the refresh token and clears the cookie', async () => {
    const login = await c.post('/api/auth/login', { tenant: 'northfield', email: 'sofia@northfield.test', password: 'orbit123' });
    const out = await c.post('/api/auth/logout', { refreshToken: login.body.refreshToken });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await c.post('/api/auth/refresh', { refreshToken: login.body.refreshToken })).status, 401);
  });

  test('missing or bogus refresh tokens are rejected', async () => {
    assert.equal((await c.post('/api/auth/refresh', {})).status, 401);
    assert.equal((await c.post('/api/auth/refresh', { refreshToken: 'abc' })).status, 401);
  });
});

describe('password change', () => {
  test('requires the current password and signs out other sessions', async () => {
    const login = await c.post('/api/auth/login', { tenant: 'northfield', email: 'ethan@northfield.test', password: 'orbit123' });
    const t = login.body.accessToken;
    assert.equal((await c.post('/api/auth/change-password', { currentPassword: 'wrong', newPassword: 'new-password-1' }, { token: t })).status, 400);
    assert.equal((await c.post('/api/auth/change-password', { currentPassword: 'orbit123', newPassword: 'short' }, { token: t })).status, 400);
    assert.equal((await c.post('/api/auth/change-password', { currentPassword: 'orbit123', newPassword: 'new-password-1' }, { token: t })).status, 200);
    assert.equal((await c.post('/api/auth/refresh', { refreshToken: login.body.refreshToken })).status, 401);
    assert.equal((await c.post('/api/auth/login', { tenant: 'northfield', email: 'ethan@northfield.test', password: 'new-password-1' })).status, 200);
  });
});

describe('http hardening', () => {
  test('security headers are set on API and static responses', async () => {
    const r = await c.get('/api/health');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  });

  test('unknown endpoints 404, wrong methods 405, bad JSON 400', async () => {
    assert.equal((await c.get('/api/nope')).status, 404);
    assert.equal((await c.call('DELETE', '/api/auth/login')).status, 405);
    const bad = await fetch(app.url + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(bad.status, 400);
  });

  test('static file serving blocks path traversal', async () => {
    const r = await fetch(app.url + '/..%2f..%2fpackage.json');
    const text = await r.text();
    assert.ok(!text.includes('"name": "orbit"'));
  });
});
