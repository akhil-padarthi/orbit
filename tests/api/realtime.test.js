import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginAll, connectWs, minutesFromNow, waitForJob } from '../helpers.js';
import { offsetCoordinate } from '../../server/lib/geo.js';

let app, c, s, sec;
before(async () => {
  app = await startTestServer();
  c = api(app.url);
  s = await loginAll(c);
  sec = Object.fromEntries((await c.get('/api/sections', { token: s.admin.token })).body.sections.map((x) => [x.name, x]));
});
after(() => app.close());

const closed = (ws) => new Promise((resolve) => ws.ws.on('close', (code) => resolve(code)));

describe('connection & auth', () => {
  test('the first frame must be a valid auth frame', async () => {
    const anon = await connectWs(app.url);
    const done = closed(anon);
    anon.send({ type: 'subscribe', channel: 'section:x' });
    assert.equal(await done, 4401);

    const bad = await connectWs(app.url);
    const badDone = closed(bad);
    bad.send({ type: 'auth', token: 'not-a-jwt' });
    const err = await bad.next('error');
    assert.equal(err.data.code, 'invalid_token');
    assert.equal(await badDone, 4401);
  });

  test('ready frame includes who is online; ping/pong works', async () => {
    const a = await connectWs(app.url, s.teacher.token);
    a.send({ type: 'ping' });
    assert.ok((await a.next('pong')).data.t);
    const b = await connectWs(app.url, s.student.token);
    const presence = await a.next((m) => m.type === 'presence' && m.data.userId === s.student.user.id);
    assert.equal(presence.data.online, true);
    b.close();
    const gone = await a.next((m) => m.type === 'presence' && m.data.userId === s.student.user.id && !m.data.online);
    assert.equal(gone.data.online, false);
    a.close();
  });
});

describe('live events', () => {
  test('messages arrive instantly for every member, with typing indicators', async () => {
    const teacher = await connectWs(app.url, s.teacher.token);
    const parent = await connectWs(app.url, s.parent2.token);
    const conv = (await c.post('/api/conversations', { userId: s.teacher.user.id }, { token: s.parent2.token })).body.conversation;

    parent.send({ type: 'typing', conversationId: conv.id });
    const typing = await teacher.next('typing');
    assert.equal(typing.data.name, 'David Chen');

    await c.post(`/api/conversations/${conv.id}/messages`, { body: 'Is the quiz on Friday?' }, { token: s.parent2.token });
    const got = await teacher.next('message.created');
    assert.equal(got.data.body, 'Is the quiz on Friday?');
    assert.equal(got.data.senderName, 'David Chen');
    const echo = await parent.next('message.created');
    assert.equal(echo.data.id, got.data.id);
    teacher.close();
    parent.close();
  });

  test('typing in a conversation you are not in is ignored', async () => {
    const teacher = await connectWs(app.url, s.teacher.token);
    const intruder = await connectWs(app.url, s.student3.token);
    const conv = (await c.post('/api/conversations', { userId: s.teacher.user.id }, { token: s.parent2.token })).body.conversation;
    intruder.send({ type: 'typing', conversationId: conv.id });
    await assert.rejects(teacher.next('typing', 400));
    teacher.close();
    intruder.close();
  });

  test('a teacher’s live board sees check-ins; the student’s parent is told too', async () => {
    const sess = (await c.post('/api/sessions', { sectionId: sec.Biology.id, startsAt: minutesFromNow(-1), endsAt: minutesFromNow(45) }, { token: s.teacher2.token })).body.session;
    const teacher = await connectWs(app.url, s.teacher2.token);
    teacher.send({ type: 'subscribe', channel: `section:${sec.Biology.id}` });
    assert.equal((await teacher.next('subscribed')).data.channel, `section:${sec.Biology.id}`);
    const parent = await connectWs(app.url, s.parent.token);

    const pos = offsetCoordinate(42.3505, -71.0726, 10, 10);
    await c.post('/api/attendance/check-in', { sessionId: sess.id, ...pos, accuracy: 5 }, { token: s.student.token });
    const live = await teacher.next('attendance.updated');
    assert.equal(live.data.sessionId, sess.id);
    assert.equal(live.data.record.studentName, 'Ava Johnson');
    assert.equal(live.data.record.status, 'present');
    const toParent = await parent.next('attendance.updated');
    assert.equal(toParent.data.record.studentId, s.student.user.id);

    // Finalizing pushes absences, the job lifecycle, and the guardian notification.
    await c.post(`/api/sessions/${sess.id}/finalize`, {}, { token: s.teacher2.token });
    const david = await connectWs(app.url, s.parent2.token);
    const jobDone = await teacher.next((m) => m.type === 'job.updated' && m.data.status === 'succeeded');
    assert.equal(jobDone.data.type, 'attendance.finalized');
    const notes = (await c.get('/api/notifications', { token: s.parent2.token })).body.notifications;
    assert.ok(notes.some((n) => n.title === 'Liam Chen was marked absent'));
    [teacher, parent, david].forEach((w) => w.close());
  });

  test('students and other teachers cannot subscribe to a section board', async () => {
    const student = await connectWs(app.url, s.student.token);
    student.send({ type: 'subscribe', channel: `section:${sec['Algebra I'].id}` });
    assert.equal((await student.next('error')).data.code, 'forbidden');
    const other = await connectWs(app.url, s.teacher3.token);
    other.send({ type: 'subscribe', channel: `section:${sec['Algebra I'].id}` });
    assert.equal((await other.next('error')).data.code, 'forbidden');
    const foreign = await connectWs(app.url, s.rAdmin.token);
    foreign.send({ type: 'subscribe', channel: `section:${sec['Algebra I'].id}` });
    assert.equal((await foreign.next('error')).data.code, 'not_found');
    [student, other, foreign].forEach((w) => w.close());
  });

  test('request decisions are pushed to the requester as they happen', async () => {
    const student = await connectWs(app.url, s.student2.token);
    // (Liam already has a seeded pending Math Lab request, so use the Writing Center.)
    const created = await c.post('/api/requests', { type: 'session_join', sectionId: sec['Writing Center'].id, reason: 'Essay help' }, { token: s.student2.token });
    assert.equal(created.status, 201);
    const req = created.body.request;
    assert.equal((await student.next((m) => m.type === 'request.updated' && m.data.id === req.id)).data.status, 'pending');
    await c.post(`/api/requests/${req.id}/decision`, { decision: 'approve' }, { token: s.teacher3.token });
    assert.equal((await student.next((m) => m.type === 'request.updated' && m.data.id === req.id)).data.status, 'approved');
    assert.equal((await student.next((m) => m.type === 'request.updated' && m.data.id === req.id)).data.status, 'completed');
    const note = await student.next('notification');
    assert.equal(note.data.title, 'Request approved');
    student.close();
  });

  test('school-wide announcements never cross into another school', async () => {
    const nf = await connectWs(app.url, s.student3.token);
    const rv = await connectWs(app.url, s.rStudent.token);
    await c.post('/api/announcements', { title: 'Assembly at 2pm', body: 'Gym' }, { token: s.admin.token });
    assert.equal((await nf.next('announcement.created')).data.title, 'Assembly at 2pm');
    await assert.rejects(rv.next('announcement.created', 400));
    nf.close();
    rv.close();
  });

  test('sync job progress streams to the admin who started it', async () => {
    const admin = await connectWs(app.url, s.admin.token);
    const r = await c.post('/api/integrations/sis/sync', {}, { token: s.admin.token });
    const progress = await admin.next((m) => m.type === 'job.updated' && m.data.id === r.body.job.id && m.data.status === 'running' && m.data.progress);
    assert.match(progress.data.progress, /Fetch|Apply/);
    const done = await admin.next((m) => m.type === 'job.updated' && m.data.id === r.body.job.id && m.data.status === 'succeeded');
    assert.equal(done.data.result.users.created, 3);
    await waitForJob(c, s.admin.token, r.body.job.id);
    admin.close();
  });
});
