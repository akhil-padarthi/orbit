import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, run, newId, nowIso, tx } from '../db/database.js';
import { signJwt } from '../lib/jwt.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { HttpError, serializeCookie, unauthorized, badRequest } from '../lib/http.js';
import { validate, z } from '../lib/validate.js';
import { authenticate } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { PERMISSIONS } from '../lib/rbac.js';

const REFRESH_COOKIE = 'orbit_rt';
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: Number(process.env.LOGIN_RATE_LIMIT ?? 10) });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function issueAccessToken(user) {
  return signJwt(
    { sub: user.id, tid: user.tenant_id ?? user.tenantId, role: user.role, typ: 'access', jti: newId() },
    config.jwt.secret,
    { expiresInSec: config.jwt.accessTtlSec, issuer: config.jwt.issuer, audience: config.jwt.audience },
  );
}

/** Refresh tokens are opaque random strings; only their SHA-256 hash is stored. */
function issueRefreshToken(user, familyId = newId()) {
  const token = crypto.randomBytes(32).toString('base64url');
  const id = newId();
  run(
    `INSERT INTO refresh_tokens (id, tenant_id, user_id, family_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, user.tenant_id, user.id, familyId, sha256(token),
    new Date(Date.now() + config.jwt.refreshTtlSec * 1000).toISOString(), nowIso(),
  );
  return { token, id };
}

function refreshCookie(token) {
  return serializeCookie(REFRESH_COOKIE, token, {
    maxAge: config.jwt.refreshTtlSec,
    path: '/api/auth',
    secure: config.isProd,
  });
}
const clearCookie = () => serializeCookie(REFRESH_COOKIE, '', { maxAge: 0, path: '/api/auth', secure: config.isProd });

export function publicUser(u, tenant) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    gradeLevel: u.grade_level ?? null,
    tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone } : undefined,
    permissions: PERMISSIONS[u.role],
  };
}

function sessionResponse(ctx, user, tenant, refresh) {
  ctx.headers['Set-Cookie'] = refreshCookie(refresh.token);
  return {
    accessToken: issueAccessToken(user),
    tokenType: 'Bearer',
    expiresIn: config.jwt.accessTtlSec,
    // Also returned in the body for non-browser clients (mobile apps, scripts).
    refreshToken: refresh.token,
    user: publicUser(user, tenant),
  };
}

const loginSchema = z.object({
  tenant: z.string().trim().toLowerCase().min(1, 'School code is required'),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, 'Password is required'),
});

export function registerAuthRoutes(router) {
  router.post('/api/auth/login', async (ctx) => {
    const input = validate(loginSchema, ctx.body);
    const key = `${ctx.ip}|${input.tenant}|${input.email}`;
    loginLimiter.consume(key);

    const tenant = one('SELECT * FROM tenants WHERE slug = ?', input.tenant);
    const user = tenant && one('SELECT * FROM users WHERE tenant_id = ? AND email = ?', tenant.id, input.email);
    // Always run a hash comparison so response time does not reveal whether the account exists.
    const ok = await verifyPassword(input.password, user?.password_hash ?? DUMMY_HASH);
    if (!tenant || !user || !ok) throw new HttpError(401, 'invalid_credentials', 'Incorrect school code, email or password');
    if (user.status !== 'active') throw new HttpError(403, 'account_inactive', 'This account is not active. Contact your school administrator.');

    loginLimiter.reset(key);
    return sessionResponse(ctx, user, tenant, issueRefreshToken(user));
  });

  router.post('/api/auth/refresh', (ctx) => {
    const presented = ctx.cookies[REFRESH_COOKIE] || ctx.body?.refreshToken;
    if (!presented) throw unauthorized('No refresh token');
    const row = one('SELECT * FROM refresh_tokens WHERE token_hash = ?', sha256(presented));
    if (!row) throw new HttpError(401, 'invalid_refresh', 'Refresh token invalid');

    if (row.revoked_at) {
      // A rotated token was presented again: likely theft. Kill the entire family.
      run('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?', nowIso(), row.family_id);
      ctx.headers['Set-Cookie'] = clearCookie();
      throw new HttpError(401, 'refresh_reused', 'Session expired. Please sign in again.');
    }
    if (row.expires_at <= nowIso()) throw new HttpError(401, 'refresh_expired', 'Session expired. Please sign in again.');

    const user = one('SELECT * FROM users WHERE id = ? AND tenant_id = ?', row.user_id, row.tenant_id);
    if (!user || user.status !== 'active') throw unauthorized('Account is not active');
    const tenant = one('SELECT * FROM tenants WHERE id = ?', user.tenant_id);

    const next = tx(() => {
      const issued = issueRefreshToken(user, row.family_id);
      run('UPDATE refresh_tokens SET revoked_at = ?, replaced_by = ? WHERE id = ?', nowIso(), issued.id, row.id);
      return issued;
    });
    return sessionResponse(ctx, user, tenant, next);
  });

  router.post('/api/auth/logout', (ctx) => {
    const presented = ctx.cookies[REFRESH_COOKIE] || ctx.body?.refreshToken;
    if (presented) {
      const row = one('SELECT family_id FROM refresh_tokens WHERE token_hash = ?', sha256(presented));
      if (row) run('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE family_id = ?', nowIso(), row.family_id);
    }
    ctx.headers['Set-Cookie'] = clearCookie();
    return { ok: true };
  });

  router.get('/api/auth/me', authenticate, (ctx) => {
    const user = one('SELECT * FROM users WHERE id = ?', ctx.user.id);
    const tenant = one('SELECT * FROM tenants WHERE id = ?', ctx.user.tenantId);
    return { user: publicUser(user, tenant) };
  });

  router.post('/api/auth/change-password', authenticate, async (ctx) => {
    const input = validate(
      z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8, 'Use at least 8 characters').max(200) }),
      ctx.body,
    );
    const user = one('SELECT * FROM users WHERE id = ?', ctx.user.id);
    if (!(await verifyPassword(input.currentPassword, user.password_hash))) throw badRequest('Current password is incorrect');
    run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(input.newPassword), nowIso(), user.id);
    // Sign out other devices.
    run('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?', nowIso(), user.id);
    return { ok: true };
  });
}

// Pre-computed hash of a random string, used to equalise timing for unknown accounts.
let DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
hashPassword(crypto.randomBytes(16).toString('hex')).then((h) => (DUMMY_HASH = h));
