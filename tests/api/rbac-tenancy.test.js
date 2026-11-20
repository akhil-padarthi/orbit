import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginAll } from '../helpers.js';
import { signJwt } from '../../server/lib/jwt.js';

let app, c, s, ids;
before(async () => {
  app = await startTestServer();
  c = api(app.url);
  s = await loginAll(c);
  const secs = (await c.get('/api/sections', { token: s.admin.token })).body.sections;
  const rsecs = (await c.get('/api/sections', { token: s.rAdmin.token })).body.sections;
  const sessions = (await c.get('/api/sessions', { token: s.admin.token })).body.sessions;
  ids = {
    algebra: secs.find((x) => x.name === 'Algebra I').id,
    biology: secs.find((x) => x.name === 'Biology').id,
    mathLab: secs.find((x) => x.name === 'Math Lab').id,
    chem: rsecs.find((x) => x.name === 'Chemistry').id,
    algebraSession: sessions.find((x) => x.sectionName === 'Algebra I').id,
    ava: s.student.user.id,
    ethan: s.student3.user.id,
  };
});
after(() => app.close());

describe('role permission matrix', () => {
  // [method, path, body, { role: expectedStatus }]
  const matrix = () => [
    ['GET', '/api/integrations', null, { admin: 200, teacher: 403, student: 403, parent: 403 }],
    ['POST', '/api/integrations/sis/sync', {}, { teacher: 403, student: 403, parent: 403 }],
    ['GET', '/api/jobs', null, { admin: 200, teacher: 403, student: 403, parent: 403 }],
    ['GET', '/api/users', null, { admin: 200, teacher: 200, student: 403, parent: 403 }],
    ['POST', '/api/users', { name: 'X', email: 'x@northfield.test', role: 'admin' }, { teacher: 403, student: 403, parent: 403 }],
    ['POST', '/api/sections', { name: 'New' }, { teacher: 403, student: 403, parent: 403 }],
    ['PATCH', '/api/campuses/does-not-matter', { radiusM: 300 }, { teacher: 403, student: 403, parent: 403 }],
    ['POST', '/api/sessions', { sectionId: ids.algebra, startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' }, { student: 403, parent: 403 }],
    ['PUT', `/api/sessions/${ids.algebraSession}/attendance`, { records: [{ studentId: ids.ava, status: 'present' }] }, { admin: 200, teacher: 200, student: 403, parent: 403 }],
    ['POST', '/api/attendance/check-in', { sessionId: ids.algebraSession, latitude: 0, longitude: 0 }, { admin: 403, teacher: 403, parent: 403 }],
    ['POST', '/api/announcements', { title: 'Hi', body: 'There' }, { admin: 201, teacher: 400, student: 403, parent: 403 }],
    ['POST', '/api/requests/x/decision', { decision: 'approve' }, { student: 403, parent: 403 }],
    ['GET', '/api/dashboard', null, { admin: 200, teacher: 200, student: 200, parent: 200 }],
  ];
  for (const role of ['admin', 'teacher', 'student', 'parent']) {
    test(`${role}`, async () => {
      for (const [method, path, body, expected] of matrix()) {
        if (!(role in expected)) continue;
        const r = await c.call(method, path, { token: s[role].token, body: body ?? undefined });
        assert.equal(r.status, expected[role], `${role} ${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
      }
    });
  }
});

describe('data scoping within a school', () => {
  test('a teacher cannot manage another teacher’s section', async () => {
    const r = await c.post(`/api/sections/${ids.biology}/sessions/start`, { durationMin: 30 }, { token: s.teacher.token });
    assert.equal(r.status, 403);
    const board = await c.post('/api/sessions', { sectionId: ids.biology, startsAt: '2030-01-01T10:00:00Z', endsAt: '2030-01-01T11:00:00Z' }, { token: s.teacher.token });
    assert.equal(board.status, 403);
  });

  test('teachers only see their own sections and students', async () => {
    const secs = (await c.get('/api/sections', { token: s.teacher.token })).body.sections.map((x) => x.name).sort();
    assert.deepEqual(secs, ['Algebra I', 'Math Lab']);
    const att = (await c.get('/api/attendance', { token: s.teacher.token })).body.records;
    assert.ok(att.length > 0);
    assert.ok(att.every((r) => ['Algebra I', 'Math Lab'].includes(r.sectionName)));
    // Ethan isn't in any of Mr. Reed's classes.
    assert.equal((await c.get(`/api/attendance?studentId=${ids.ethan}`, { token: s.teacher.token })).status, 403);
  });

  test('students see only their own records; parents only their children', async () => {
    const mine = (await c.get('/api/attendance', { token: s.student.token })).body.records;
    assert.ok(mine.length > 0 && mine.every((r) => r.studentId === ids.ava));
    assert.equal((await c.get(`/api/attendance?studentId=${s.student2.user.id}`, { token: s.student.token })).status, 403);
    const kids = (await c.get('/api/attendance', { token: s.parent.token })).body.records;
    assert.ok(kids.length > 0 && kids.every((r) => r.studentId === ids.ava));
    assert.equal((await c.get(`/api/attendance?studentId=${s.student2.user.id}`, { token: s.parent.token })).status, 403);
  });

  test('students cannot open another class’s live roster', async () => {
    const bio = (await c.get('/api/sessions', { token: s.admin.token })).body.sessions.find((x) => x.sectionName === 'English 10');
    const r = await c.get(`/api/sessions/${bio.id}`, { token: s.student2.token }); // Liam isn't in English 10
    assert.equal(r.status, 403);
    const own = await c.get(`/api/sessions/${ids.algebraSession}`, { token: s.student.token });
    assert.equal(own.status, 200);
    assert.equal(own.body.canManage, false);
    assert.ok(own.body.roster.every((r) => r.studentId === ids.ava), 'students see only their own row');
  });
});

describe('multi-tenant isolation', () => {
  test('ids from another school behave as if they do not exist', async () => {
    for (const [path, method, body] of [
      [`/api/sections/${ids.algebra}`, 'GET'],
      [`/api/sessions/${ids.algebraSession}`, 'GET'],
      [`/api/sessions/${ids.algebraSession}/attendance`, 'PUT', { records: [{ studentId: ids.ava, status: 'absent' }] }],
      [`/api/sessions/${ids.algebraSession}/finalize`, 'POST', {}],
      [`/api/sections/${ids.algebra}/sessions/start`, 'POST', { durationMin: 30 }],
    ]) {
      const r = await c.call(method, path, { token: s.rAdmin.token, body });
      assert.equal(r.status, 404, `${method} ${path} → ${r.status}`);
    }
    const checkIn = await c.post('/api/attendance/check-in', { sessionId: ids.algebraSession, latitude: 42.35, longitude: -71.07 }, { token: s.rStudent.token });
    assert.equal(checkIn.status, 404);
    const msg = await c.post('/api/conversations', { userId: s.teacher.user.id }, { token: s.rParent.token });
    assert.equal(msg.status, 404);
    const att = await c.get(`/api/attendance?studentId=${ids.ava}`, { token: s.rAdmin.token });
    assert.equal(att.status, 404);
  });

  test('list endpoints never return another school’s rows', async () => {
    const users = (await c.get('/api/users', { token: s.rAdmin.token })).body.users;
    assert.ok(users.length > 0 && users.every((u) => u.email.endsWith('@riverside.test')));
    const secs = (await c.get('/api/sections', { token: s.rAdmin.token })).body.sections;
    assert.ok(!secs.some((x) => x.id === ids.algebra));
    const sess = (await c.get('/api/sessions', { token: s.rAdmin.token })).body.sessions;
    assert.ok(sess.every((x) => x.sectionId !== ids.algebra));
    const att = (await c.get('/api/attendance', { token: s.rAdmin.token })).body.records;
    assert.ok(att.every((r) => r.sectionName === 'Chemistry' || r.sectionName === 'Study Hall'));
    const reqs = (await c.get('/api/requests', { token: s.rAdmin.token })).body.requests;
    assert.ok(reqs.every((r) => !r.studentName.includes('Johnson')));
    const ann = (await c.get('/api/announcements', { token: s.rAdmin.token })).body.announcements;
    assert.ok(ann.every((a) => a.authorName === 'Grace Holloway' || a.authorName === 'Omar Haddad'));
    const integ = (await c.get('/api/integrations', { token: s.rAdmin.token })).body.integrations;
    assert.ok(integ.every((i) => i.baseUrl.includes('riverside')));
  });

  test('a token whose tenant claim is swapped is refused', async () => {
    const { config } = await import('../../server/config.js');
    const rAdminClaims = JSON.parse(Buffer.from(s.rAdmin.token.split('.')[1], 'base64url'));
    const nfAdminClaims = JSON.parse(Buffer.from(s.admin.token.split('.')[1], 'base64url'));
    // Even a validly signed token can't pair a Northfield user with Riverside's tenant id.
    const crossed = signJwt({ sub: nfAdminClaims.sub, tid: rAdminClaims.tid, role: 'admin', typ: 'access' }, config.jwt.secret, {
      expiresInSec: 60, issuer: config.jwt.issuer, audience: config.jwt.audience,
    });
    assert.equal((await c.get('/api/users', { token: crossed })).status, 401);
  });

  test('the same email can exist in two schools independently', async () => {
    const add = await c.post('/api/users', { name: 'Marcus Reed (Riverside)', email: 'm.reed@northfield.test', role: 'teacher', password: 'riverside-pass-1' }, { token: s.rAdmin.token });
    assert.equal(add.status, 201);
    const a = await c.post('/api/auth/login', { tenant: 'riverside', email: 'm.reed@northfield.test', password: 'riverside-pass-1' });
    const b = await c.post('/api/auth/login', { tenant: 'northfield', email: 'm.reed@northfield.test', password: 'orbit123' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.user.id, b.body.user.id);
    assert.equal(a.body.user.tenant.slug, 'riverside');
  });
});

describe('user administration', () => {
  test('admin creates a user with a one-time temporary password', async () => {
    const r = await c.post('/api/users', { name: 'New Teacher', email: 'new.teacher@northfield.test', role: 'teacher' }, { token: s.admin.token });
    assert.equal(r.status, 201);
    assert.match(r.body.tempPassword, /^[a-z]+-[a-z]+-\d{3}$/);
    const login = await c.post('/api/auth/login', { tenant: 'northfield', email: 'new.teacher@northfield.test', password: r.body.tempPassword });
    assert.equal(login.status, 200);
    assert.equal((await c.post('/api/users', { name: 'Dup', email: 'new.teacher@northfield.test', role: 'student' }, { token: s.admin.token })).status, 409);
  });

  test('admins cannot lock themselves out', async () => {
    const r = await c.patch(`/api/users/${s.admin.user.id}`, { role: 'teacher' }, { token: s.admin.token });
    assert.equal(r.status, 400);
  });

  test('linking a guardian grants that parent visibility', async () => {
    const ethan = ids.ethan;
    assert.equal((await c.get(`/api/attendance?studentId=${ethan}`, { token: s.parent2.token })).status, 403);
    const link = await c.post('/api/guardianships', { parentId: s.parent2.user.id, studentId: ethan }, { token: s.admin.token });
    assert.equal(link.status, 201);
    assert.equal((await c.get(`/api/attendance?studentId=${ethan}`, { token: s.parent2.token })).status, 200);
    assert.equal((await c.delete(`/api/guardianships/${s.parent2.user.id}/${ethan}`, { token: s.admin.token })).status, 200);
    assert.equal((await c.get(`/api/attendance?studentId=${ethan}`, { token: s.parent2.token })).status, 403);
  });
});
