import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginAll, waitForJob, minutesFromNow } from '../helpers.js';
import { offsetCoordinate } from '../../server/lib/geo.js';

let app, c, s;
before(async () => {
  app = await startTestServer();
  c = api(app.url);
  s = await loginAll(c, ['admin', 'teacher', 'teacher2', 'student', 'rAdmin']);
});
after(() => app.close());

const sync = async (kind, token = s.admin.token) => {
  const r = await c.post(`/api/integrations/${kind}/sync`, {}, { token });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.headers.get('location'), `/api/jobs/${r.body.job.id}`);
  return waitForJob(c, token, r.body.job.id);
};

describe('SIS (OneRoster) sync', () => {
  test('imports new people, classes and enrollments and withdraws departed students', async () => {
    const job = await sync('sis');
    assert.equal(job.status, 'succeeded', job.lastError);
    const r = job.result;
    assert.equal(r.users.created, 3); // Jordan, Amara, Caleb
    assert.equal(r.users.deactivated, 1); // Lucas (tobedeleted)
    assert.equal(r.users.updated, 0);
    assert.equal(r.sections.created, 1); // Robotics Lab
    assert.equal(r.enrollments.added, 5); // 4 Robotics + Jordan → Algebra I
    assert.ok(r.enrollments.removed >= 1); // Lucas leaves Biology

    const users = (await c.get('/api/users', { token: s.admin.token })).body.users;
    const jordan = users.find((u) => u.name === 'Jordan Blake');
    assert.equal(jordan.status, 'invited');
    assert.equal(jordan.externalId, 'nf-stu-9');
    assert.equal(users.find((u) => u.name === 'Lucas Rivera').status, 'inactive');

    const robotics = (await c.get('/api/sections', { token: s.admin.token })).body.sections.find((x) => x.name === 'Robotics Lab');
    assert.equal(robotics.teacherName, 'Priya Shah');
    assert.equal(robotics.enrolledCount, 4);

    const integ = (await c.get('/api/integrations', { token: s.admin.token })).body.integrations.find((i) => i.kind === 'sis');
    assert.equal(integ.lastStatus, 'ok');
    assert.ok(integ.lastSyncedAt);
    assert.equal(integ.clientSecretHint, '••••cret');
    assert.ok(!('clientSecret' in integ), 'secret is never returned');
  });

  test('a second sync is idempotent', async () => {
    const job = await sync('sis');
    const r = job.result;
    assert.deepEqual([r.users.created, r.users.updated, r.users.deactivated], [0, 0, 0]);
    assert.deepEqual([r.sections.created, r.sections.updated], [0, 0]);
    assert.deepEqual([r.enrollments.added, r.enrollments.removed], [0, 0]);
  });

  test('imported accounts can’t sign in until an admin activates them', async () => {
    const login = () => c.post('/api/auth/login', { tenant: 'northfield', email: 'jordan@northfield.test', password: 'anything' });
    assert.equal((await login()).status, 401);
    const jordan = (await c.get('/api/users?search=Jordan', { token: s.admin.token })).body.users[0];
    const reset = await c.post(`/api/users/${jordan.id}/reset-password`, {}, { token: s.admin.token });
    assert.equal(reset.body.user.status, 'active');
    const ok = await c.post('/api/auth/login', { tenant: 'northfield', email: 'jordan@northfield.test', password: reset.body.tempPassword });
    assert.equal(ok.status, 200);
  });

  test('manual and request-based enrollments survive a full sync', async () => {
    const mathLab = (await c.get('/api/sections', { token: s.admin.token })).body.sections.find((x) => x.name === 'Math Lab');
    const before = mathLab.enrolledCount;
    await sync('sis');
    const after = (await c.get('/api/sections', { token: s.admin.token })).body.sections.find((x) => x.name === 'Math Lab');
    assert.equal(after.enrolledCount, before);
  });

  test('a sync already in progress returns 409 with the running job', async () => {
    const first = await c.post('/api/integrations/sis/sync', {}, { token: s.admin.token });
    const second = await c.post('/api/integrations/sis/sync', {}, { token: s.admin.token });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.details.job.id, first.body.job.id);
    await waitForJob(c, s.admin.token, first.body.job.id);
  });

  test('rejected credentials fail permanently without retrying', async () => {
    await c.patch('/api/integrations/sis', { clientSecret: 'wrong' }, { token: s.admin.token });
    const job = await sync('sis');
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 1);
    assert.match(job.lastError, /credentials were rejected/);
    const integ = (await c.get('/api/integrations', { token: s.admin.token })).body.integrations.find((i) => i.kind === 'sis');
    assert.equal(integ.lastStatus, 'error');
    const notes = (await c.get('/api/notifications', { token: s.admin.token })).body.notifications;
    assert.ok(notes.some((n) => n.title === 'SIS sync failed'));
    await c.patch('/api/integrations/sis', { clientSecret: 'northfield-secret' }, { token: s.admin.token });
  });

  test('an unreachable server is retried with backoff, then fails', async () => {
    await c.patch('/api/integrations/sis', { baseUrl: 'http://127.0.0.1:9' }, { token: s.admin.token });
    const job = await sync('sis');
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 3);
    assert.match(job.lastError, /Could not reach/);
    await c.patch('/api/integrations/sis', { baseUrl: '/mock/oneroster/northfield' }, { token: s.admin.token });
    assert.equal((await sync('sis')).status, 'succeeded');
  });

  test('paused integrations can’t sync; settings are validated', async () => {
    await c.patch('/api/integrations/sis', { enabled: false }, { token: s.admin.token });
    assert.equal((await c.post('/api/integrations/sis/sync', {}, { token: s.admin.token })).status, 409);
    await c.patch('/api/integrations/sis', { enabled: true }, { token: s.admin.token });
    assert.equal((await c.patch('/api/integrations/sis', { baseUrl: 'ftp://nope' }, { token: s.admin.token })).status, 400);
    assert.equal((await c.patch('/api/integrations/nope', {}, { token: s.admin.token })).status, 404);
  });

  test('each school syncs only its own roster', async () => {
    const job = await sync('sis', s.rAdmin.token);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.result.users.created, 0);
    const nf = (await c.get('/api/users', { token: s.admin.token })).body.users;
    assert.ok(nf.every((u) => u.email.endsWith('@northfield.test')));
  });
});

describe('LMS (Canvas) sync and grade passback', () => {
  test('links courses and people by SIS id, following pagination', async () => {
    const job = await sync('lms');
    assert.equal(job.status, 'succeeded', job.lastError);
    assert.equal(job.result.coursesLinked, 4); // mock pages 3 per page → 2 pages
    assert.equal(job.result.coursesUnmatched, 1); // teacher sandbox
    assert.ok(job.result.usersLinked >= 10);
    const secs = (await c.get('/api/sections', { token: s.admin.token })).body.sections;
    assert.equal(secs.find((x) => x.name === 'Algebra I').lmsCourseId, '1101');
    assert.equal(secs.find((x) => x.name === 'Math Lab').lmsCourseId, null);
  });

  test('finalizing a linked section pushes attendance grades to Canvas automatically', async () => {
    const bio = (await c.get('/api/sections', { token: s.admin.token })).body.sections.find((x) => x.name === 'Biology');
    const sess = (await c.post('/api/sessions', { sectionId: bio.id, startsAt: minutesFromNow(-2), endsAt: minutesFromNow(30) }, { token: s.teacher2.token })).body.session;
    const pos = offsetCoordinate(42.3505, -71.0726, 20, 20);
    assert.equal((await c.post('/api/attendance/check-in', { sessionId: sess.id, ...pos, accuracy: 8 }, { token: s.student.token })).status, 201);

    const fin = await c.post(`/api/sessions/${sess.id}/finalize`, {}, { token: s.teacher2.token });
    assert.equal(fin.status, 202);
    const followUp = await waitForJob(c, s.teacher2.token, fin.body.job.id);
    assert.ok(followUp.result.lmsJobId, 'grade passback was queued');
    const push = await waitForJob(c, s.teacher2.token, followUp.result.lmsJobId);
    assert.equal(push.status, 'succeeded', push.lastError);
    assert.ok(push.result.pushed >= 3);

    // Read back what Canvas received.
    const tokenRes = await fetch(`${app.url}/mock/canvas/northfield/login/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from('orbit-northfield:northfield-secret').toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const { access_token } = await tokenRes.json();
    const subs = await (await fetch(`${app.url}/mock/canvas/northfield/api/v1/courses/1102/assignments/${push.result.assignmentId}/submissions`, { headers: { Authorization: `Bearer ${access_token}` } })).json();
    assert.equal(subs.length, push.result.pushed);
    const ava = (await c.get('/api/attendance/summary?sectionId=' + bio.id + '&studentId=' + s.student.user.id, { token: s.admin.token })).body;
    // Canvas user id for Ava = userIdBase (5000) + her index (5th user) = 5005.
    const avaSub = subs.find((x) => x.user_id === 5005);
    assert.ok(avaSub, 'Ava’s grade was posted');
    assert.ok(Math.abs(avaSub.score - ava.rate) < 0.11, `${avaSub.score} vs ${ava.rate}`);
  });

  test('a second passback reuses the same Canvas assignment', async () => {
    const algebra = (await c.get('/api/sections', { token: s.admin.token })).body.sections.find((x) => x.name === 'Algebra I');
    const r1 = await c.post('/api/integrations/lms/push-attendance', { sectionId: algebra.id }, { token: s.admin.token });
    const j1 = await waitForJob(c, s.admin.token, r1.body.job.id);
    const r2 = await c.post('/api/integrations/lms/push-attendance', { sectionId: algebra.id }, { token: s.admin.token });
    const j2 = await waitForJob(c, s.admin.token, r2.body.job.id);
    assert.equal(j1.status, 'succeeded');
    assert.equal(j1.result.assignmentId, j2.result.assignmentId);
  });

  test('integration endpoints are admin-only', async () => {
    assert.equal((await c.post('/api/integrations/lms/sync', {}, { token: s.teacher.token })).status, 403);
    assert.equal((await c.get('/api/jobs', { token: s.teacher.token })).status, 403);
    const someJob = (await c.get('/api/jobs', { token: s.admin.token })).body.jobs[0];
    assert.equal((await c.get(`/api/jobs/${someJob.id}`, { token: s.student.token })).status, 403);
    assert.equal((await c.get(`/api/jobs/${someJob.id}`, { token: s.rAdmin.token })).status, 404);
  });
});
