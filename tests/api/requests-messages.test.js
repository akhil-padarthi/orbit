import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginAll, waitForJob, waitFor } from '../helpers.js';

let app, c, s, sec;
before(async () => {
  app = await startTestServer();
  c = api(app.url);
  s = await loginAll(c);
  sec = Object.fromEntries((await c.get('/api/sections', { token: s.admin.token })).body.sections.map((x) => [x.name, x]));
});
after(() => app.close());

describe('flex-block join requests', () => {
  let req;
  test('a student requests to join a flex block; the block’s teacher is the approver', async () => {
    const r = await c.post('/api/requests', { type: 'session_join', sectionId: sec['Math Lab'].id, reason: 'Quiz prep please' }, { token: s.student.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    req = r.body.request;
    assert.equal(req.status, 'pending');
    assert.equal(req.approverId, s.teacher.user.id);
    assert.deepEqual(req.events.map((e) => e.event), ['created']);
    const notes = (await c.get('/api/notifications', { token: s.teacher.token })).body.notifications;
    assert.ok(notes.some((n) => n.title.includes('Ava Johnson wants to join Math Lab')));
  });

  test('duplicate pending requests and non-flex sections are refused', async () => {
    assert.equal((await c.post('/api/requests', { type: 'session_join', sectionId: sec['Math Lab'].id, reason: 'again' }, { token: s.student.token })).status, 409);
    assert.equal((await c.post('/api/requests', { type: 'session_join', sectionId: sec.Biology.id, reason: 'pls' }, { token: s.student.token })).status, 400);
    assert.equal((await c.post('/api/requests', { type: 'absence_excuse', studentId: s.student.user.id, date: '2030-01-01', reason: 'Sick day' }, { token: s.student.token })).status, 403);
  });

  test('only the assigned teacher or an admin may decide', async () => {
    assert.equal((await c.post(`/api/requests/${req.id}/decision`, { decision: 'approve' }, { token: s.teacher2.token })).status, 403);
    assert.equal((await c.post(`/api/requests/${req.id}/decision`, { decision: 'approve' }, { token: s.student.token })).status, 403);
    assert.equal((await c.get(`/api/requests/${req.id}`, { token: s.student2.token })).status, 403);
    const visible = await c.get(`/api/requests/${req.id}`, { token: s.parent.token });
    assert.equal(visible.status, 200, 'the student’s guardian can follow the request');
  });

  test('approval returns 202, then a background job enrolls the student', async () => {
    const r = await c.post(`/api/requests/${req.id}/decision`, { decision: 'approve', note: 'See you Thursday' }, { token: s.teacher.token });
    assert.equal(r.status, 202);
    assert.equal(r.body.request.status, 'approved');
    const job = await waitForJob(c, s.teacher.token, r.body.job.id);
    assert.equal(job.status, 'succeeded');
    const done = (await c.get(`/api/requests/${req.id}`, { token: s.student.token })).body.request;
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.events.map((e) => e.event), ['created', 'approved', 'completed']);
    assert.equal(done.decisionNote, 'See you Thursday');
    const flex = (await c.get('/api/sections?kind=flex', { token: s.student.token })).body.sections.find((x) => x.name === 'Math Lab');
    assert.equal(flex.enrolled, true);
    assert.equal((await c.post(`/api/requests/${req.id}/decision`, { decision: 'deny' }, { token: s.teacher.token })).status, 409);
  });

  test('denial notifies the student and needs no job', async () => {
    const r = (await c.post('/api/requests', { type: 'session_join', sectionId: sec['Writing Center'].id, reason: 'Essay help' }, { token: s.student2.token })).body.request;
    const d = await c.post(`/api/requests/${r.id}/decision`, { decision: 'deny', note: 'Full this week' }, { token: s.teacher3.token });
    assert.equal(d.status, 200);
    assert.equal(d.body.request.status, 'denied');
    const notes = (await c.get('/api/notifications', { token: s.student2.token })).body.notifications;
    assert.ok(notes.some((n) => n.title === 'Request denied' && n.body === 'Full this week'));
  });

  test('requesters can cancel while pending', async () => {
    const r = (await c.post('/api/requests', { type: 'session_join', sectionId: sec['Writing Center'].id, reason: 'Second try' }, { token: s.student2.token })).body.request;
    assert.equal((await c.post(`/api/requests/${r.id}/cancel`, {}, { token: s.teacher3.token })).status, 403);
    const x = await c.post(`/api/requests/${r.id}/cancel`, {}, { token: s.student2.token });
    assert.equal(x.body.request.status, 'cancelled');
  });

  test('if the block fills up after approval, the job fails the request instead of over-enrolling', async () => {
    // Writing Center has 4 seats. Fill 3 directly, request a 4th and 5th, approve both.
    const students = (await c.get('/api/users?role=student', { token: s.admin.token })).body.users.filter((u) => u.status === 'active');
    for (const u of students.filter((u) => !['Ava Johnson', 'Liam Chen', 'Ethan Brooks'].includes(u.name)).slice(0, 3)) {
      assert.equal((await c.post(`/api/sections/${sec['Writing Center'].id}/enrollments`, { studentId: u.id }, { token: s.admin.token })).status, 201);
    }
    const a = (await c.post('/api/requests', { type: 'session_join', sectionId: sec['Writing Center'].id, reason: 'one' }, { token: s.student.token })).body.request;
    const b = (await c.post('/api/requests', { type: 'session_join', sectionId: sec['Writing Center'].id, reason: 'two' }, { token: s.student3.token })).body.request;
    const ja = (await c.post(`/api/requests/${a.id}/decision`, { decision: 'approve' }, { token: s.teacher3.token })).body.job;
    const jb = (await c.post(`/api/requests/${b.id}/decision`, { decision: 'approve' }, { token: s.teacher3.token })).body.job;
    const [ra, rb] = [await waitForJob(c, s.teacher3.token, ja.id), await waitForJob(c, s.teacher3.token, jb.id)];
    assert.equal(ra.status, 'succeeded');
    assert.equal(rb.status, 'failed');
    assert.equal(rb.attempts, 1, 'a full block is a permanent failure — no retries');
    const failed = (await c.get(`/api/requests/${b.id}`, { token: s.student3.token })).body.request;
    assert.equal(failed.status, 'failed');
    assert.match(failed.events.at(-1).note, /full/);
    const full = (await c.get(`/api/sections/${sec['Writing Center'].id}`, { token: s.admin.token })).body.section;
    assert.equal(full.enrolledCount, 4);
  });
});

describe('absence excuses', () => {
  test('a parent excuses their child for a day; approval marks every class that day excused', async () => {
    // Pick a recent school day where Ava has non-present records.
    const recs = (await c.get('/api/attendance?limit=1000', { token: s.parent.token })).body.records;
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
    const day = fmt.format(new Date(recs.find((r) => r.status !== 'excused' && Date.parse(r.startsAt) < Date.now() - 864e5).startsAt));
    const r = await c.post('/api/requests', { type: 'absence_excuse', studentId: s.student.user.id, date: day, reason: 'Doctor visit' }, { token: s.parent.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.request.approverId, null, 'any admin can decide');
    assert.equal((await c.post(`/api/requests/${r.body.request.id}/decision`, { decision: 'approve' }, { token: s.teacher.token })).status, 403);
    const d = await c.post(`/api/requests/${r.body.request.id}/decision`, { decision: 'approve' }, { token: s.admin.token });
    assert.equal(d.status, 202);
    const job = await waitForJob(c, s.admin.token, d.body.job.id);
    assert.equal(job.status, 'succeeded');
    const after = (await c.get('/api/attendance?limit=1000', { token: s.parent.token })).body.records.filter((x) => fmt.format(new Date(x.startsAt)) === day);
    assert.ok(after.length > 0);
    // Real presence is never overwritten; everything else is now excused.
    assert.ok(after.every((x) => x.status === 'excused' || x.status === 'present' || x.status === 'late'));
    assert.equal(job.result.date, day);
  });

  test('parents can only excuse their own children, once per day', async () => {
    assert.equal((await c.post('/api/requests', { type: 'absence_excuse', studentId: s.student2.user.id, date: '2030-01-02', reason: 'x y z' }, { token: s.parent.token })).status, 403);
    assert.equal((await c.post('/api/requests', { type: 'absence_excuse', studentId: s.student.user.id, date: '2030-01-02', reason: 'Trip' }, { token: s.parent.token })).status, 201);
    assert.equal((await c.post('/api/requests', { type: 'absence_excuse', studentId: s.student.user.id, date: '2030-01-02', reason: 'Trip' }, { token: s.parent.token })).status, 409);
    assert.equal((await c.post('/api/requests', { type: 'session_join', sectionId: sec['Math Lab'].id, reason: 'x y z' }, { token: s.parent.token })).status, 403);
  });

  test('request lists are scoped per role', async () => {
    const teacherList = (await c.get('/api/requests', { token: s.teacher.token })).body.requests;
    assert.ok(teacherList.every((r) => r.approverId === s.teacher.user.id));
    const mine = (await c.get('/api/requests', { token: s.student2.token })).body.requests;
    assert.ok(mine.every((r) => r.studentId === s.student2.user.id));
    const toDecide = (await c.get('/api/requests?scope=to_decide', { token: s.admin.token })).body.requests;
    assert.ok(toDecide.every((r) => r.status === 'pending'));
    assert.deepEqual((await c.get('/api/requests?scope=to_decide', { token: s.student.token })).body.requests, []);
  });
});

describe('messaging policy', () => {
  test('students can message their teachers but not other students', async () => {
    const contacts = (await c.get('/api/messages/contacts', { token: s.student.token })).body.contacts;
    assert.ok(contacts.some((x) => x.id === s.teacher.user.id));
    assert.ok(contacts.every((x) => x.role === 'teacher' || x.role === 'admin'));
    assert.equal((await c.post('/api/conversations', { userId: s.student2.user.id }, { token: s.student.token })).status, 403);
  });

  test('parents can message their child’s teachers, not unrelated teachers', async () => {
    const contacts = (await c.get('/api/messages/contacts', { token: s.parent2.token })).body.contacts.map((x) => x.id); // David → Liam (Algebra, Biology)
    assert.ok(contacts.includes(s.teacher.user.id));
    assert.ok(contacts.includes(s.teacher2.user.id));
    assert.ok(!contacts.includes(s.teacher3.user.id), 'Liam doesn’t take English 10');
    assert.equal((await c.post('/api/conversations', { userId: s.teacher3.user.id }, { token: s.parent2.token })).status, 403);
  });

  test('a direct conversation is created once and reused', async () => {
    const a = await c.post('/api/conversations', { userId: s.teacher.user.id }, { token: s.parent2.token });
    assert.equal(a.status, 201);
    const b = await c.post('/api/conversations', { userId: s.parent2.user.id }, { token: s.teacher.token });
    assert.equal(b.status, 200);
    assert.equal(a.body.conversation.id, b.body.conversation.id);
  });

  test('messages are delivered, counted unread, and cleared on read', async () => {
    const conv = (await c.post('/api/conversations', { userId: s.teacher.user.id }, { token: s.parent2.token })).body.conversation;
    const sent = await c.post(`/api/conversations/${conv.id}/messages`, { body: '  Hello from David  ' }, { token: s.parent2.token });
    assert.equal(sent.status, 201);
    assert.equal(sent.body.message.body, 'Hello from David');
    const list = (await c.get('/api/conversations', { token: s.teacher.token })).body.conversations.find((x) => x.id === conv.id);
    assert.equal(list.unread, 1);
    assert.equal(list.lastMessage.body, 'Hello from David');
    await c.post(`/api/conversations/${conv.id}/read`, {}, { token: s.teacher.token });
    const after = (await c.get('/api/conversations', { token: s.teacher.token })).body.conversations.find((x) => x.id === conv.id);
    assert.equal(after.unread, 0);
    const msgs = (await c.get(`/api/conversations/${conv.id}/messages`, { token: s.teacher.token })).body.messages;
    assert.equal(msgs.at(-1).senderName, 'David Chen');
  });

  test('non-members can’t read or post; empty messages are rejected', async () => {
    const conv = (await c.post('/api/conversations', { userId: s.teacher.user.id }, { token: s.parent2.token })).body.conversation;
    assert.equal((await c.get(`/api/conversations/${conv.id}/messages`, { token: s.teacher2.token })).status, 403);
    assert.equal((await c.post(`/api/conversations/${conv.id}/messages`, { body: 'hi' }, { token: s.teacher2.token })).status, 403);
    assert.equal((await c.post(`/api/conversations/${conv.id}/messages`, { body: '   ' }, { token: s.parent2.token })).status, 400);
    assert.equal((await c.get(`/api/conversations/${conv.id}/messages`, { token: s.rAdmin.token })).status, 404);
  });

  test('class channels contain the teacher and enrolled students and follow enrollment changes', async () => {
    const convs = (await c.get('/api/conversations', { token: s.teacher.token })).body.conversations;
    const algebra = convs.find((x) => x.kind === 'section' && x.title === 'Algebra I');
    assert.ok(algebra);
    const names = algebra.members.map((m) => m.name);
    assert.ok(names.includes('Marcus Reed') && names.includes('Ava Johnson'));
    assert.ok(!names.includes('Ethan Brooks'));
    await c.post(`/api/sections/${sec['Algebra I'].id}/enrollments`, { studentId: s.student3.user.id }, { token: s.admin.token });
    const updated = (await c.get('/api/conversations', { token: s.student3.token })).body.conversations;
    assert.ok(updated.some((x) => x.kind === 'section' && x.title === 'Algebra I'));
  });
});

describe('announcements', () => {
  test('teachers post to their own sections; admins can post school-wide', async () => {
    assert.equal((await c.post('/api/announcements', { title: 'Lab', body: 'Goggles', sectionId: sec.Biology.id }, { token: s.teacher.token })).status, 403);
    assert.equal((await c.post('/api/announcements', { title: 'Quiz', body: 'Ch 5', sectionId: sec['Algebra I'].id }, { token: s.teacher.token })).status, 201);
    assert.equal((await c.post('/api/announcements', { title: 'Snow day', body: 'Closed' }, { token: s.admin.token })).status, 201);
    const forEthan = (await c.get('/api/announcements', { token: s.student2.token })).body.announcements.map((a) => a.title); // Liam: Algebra
    assert.ok(forEthan.includes('Quiz') && forEthan.includes('Snow day'));
    const forOther = (await c.get('/api/announcements', { token: s.rStudent.token })).body.announcements.map((a) => a.title);
    assert.ok(!forOther.includes('Snow day'));
  });
});

describe('dashboards', () => {
  test('each role gets its own dashboard shape', async () => {
    const a = (await c.get('/api/dashboard', { token: s.admin.token })).body;
    assert.equal(a.role, 'admin');
    assert.ok(a.stats.students >= 8 && Array.isArray(a.trend) && a.trend.length > 0);
    const t = (await c.get('/api/dashboard', { token: s.teacher.token })).body;
    assert.equal(t.role, 'teacher');
    assert.ok(t.sections.every((x) => ['Algebra I', 'Math Lab'].includes(x.name)));
    const st = (await c.get('/api/dashboard', { token: s.student.token })).body;
    assert.equal(st.role, 'student');
    assert.ok(st.attendance.rate > 0);
    const p = (await c.get('/api/dashboard', { token: s.parent.token })).body;
    assert.equal(p.role, 'parent');
    assert.deepEqual(p.children.map((x) => x.name), ['Ava Johnson']);
  });

  test('public config exposes demo accounts only in demo mode', async () => {
    const cfg = (await c.get('/api/config')).body;
    assert.equal(cfg.demoMode, true);
    assert.equal(cfg.demo.tenants.length, 2);
    assert.deepEqual(cfg.demo.tenants[0].accounts.map((x) => x.role), ['admin', 'teacher', 'student', 'parent']);
    await waitFor(() => true);
  });
});
