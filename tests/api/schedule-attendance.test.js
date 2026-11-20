import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, api, loginAll, waitForJob, minutesFromNow } from '../helpers.js';
import { offsetCoordinate } from '../../server/lib/geo.js';

const CAMPUS = { lat: 42.3505, lng: -71.0726 }; // Northfield, 200 m fence
const near = (north, east, accuracy = 10) => ({ ...offsetCoordinate(CAMPUS.lat, CAMPUS.lng, north, east), accuracy });

let app, c, s, sec, bioSession, liveAlgebra;
before(async () => {
  app = await startTestServer();
  c = api(app.url);
  s = await loginAll(c);
  const secs = (await c.get('/api/sections', { token: s.admin.token })).body.sections;
  sec = Object.fromEntries(secs.map((x) => [x.name, x]));
  const now = Date.now();
  liveAlgebra = (await c.get('/api/sessions', { token: s.teacher.token })).body.sessions.find(
    (x) => x.sectionName === 'Algebra I' && Date.parse(x.startsAt) <= now && Date.parse(x.endsAt) > now,
  );
});
after(() => app.close());

describe('scheduling', () => {
  test('a teacher schedules a session for their own section', async () => {
    const r = await c.post('/api/sessions', { sectionId: sec.Biology.id, startsAt: minutesFromNow(-1), endsAt: minutesFromNow(40) }, { token: s.teacher2.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    bioSession = r.body.session;
    assert.equal(bioSession.status, 'scheduled');
    assert.equal(bioSession.sectionName, 'Biology');
  });

  test('double-booking the same section is a 409 with the clash listed', async () => {
    const r = await c.post('/api/sessions', { sectionId: sec.Biology.id, startsAt: minutesFromNow(10), endsAt: minutesFromNow(20) }, { token: s.teacher2.token });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.details.conflicts[0].reason, 'section');
  });

  test('a teacher cannot be in two places at once', async () => {
    // Mr. Reed is teaching the live Algebra I session; Math Lab is also his.
    const r = await c.post('/api/sessions', { sectionId: sec['Math Lab'].id, startsAt: liveAlgebra.startsAt, endsAt: liveAlgebra.endsAt }, { token: s.teacher.token });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.details.conflicts[0].reason, 'teacher');
  });

  test('a room cannot hold two classes at once', async () => {
    const club = await c.post('/api/sections', { name: 'Chess Club', room: 'Room 204', teacherId: s.teacher2.user.id }, { token: s.admin.token });
    assert.equal(club.status, 201);
    const r = await c.post('/api/sessions', { sectionId: club.body.section.id, startsAt: liveAlgebra.startsAt, endsAt: liveAlgebra.endsAt }, { token: s.admin.token });
    assert.equal(r.status, 409);
    assert.ok(r.body.error.details.conflicts.some((x) => x.reason === 'room'));
  });

  test('recurring sessions: creates every matching weekday in the school’s time zone', async () => {
    const debate = (await c.post('/api/sections', { name: 'Debate', room: 'Room 300', teacherId: s.teacher3.user.id }, { token: s.admin.token })).body.section;
    const r = await c.post('/api/sessions/recurring', { sectionId: debate.id, daysOfWeek: [1, 3], startTime: '15:30', endTime: '16:30', fromDate: '2031-03-03', toDate: '2031-03-30' }, { token: s.teacher3.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.created, 8); // Mondays and Wednesdays in March 2031 from the 3rd: 3,5,10,12,17,19,24,26
    const list = (await c.get(`/api/sessions?sectionId=${debate.id}&from=2031-03-01T00:00:00Z&to=2031-04-01T00:00:00Z`, { token: s.teacher3.token })).body.sessions;
    assert.equal(list.length, 8);
    // 15:30 in New York on 3 March 2031 (EST) is 20:30 UTC; after the 9 March DST switch it is 19:30 UTC.
    assert.equal(list[0].startsAt, '2031-03-03T20:30:00.000Z');
    assert.equal(list.at(-1).startsAt, '2031-03-26T19:30:00.000Z');
  });

  test('recurring sessions refuse clashes unless asked to skip them', async () => {
    const debate = (await c.get('/api/sections', { token: s.admin.token })).body.sections.find((x) => x.name === 'Debate');
    // Ms. Torres teaches English 10 at 10:00 every weekday for the next two weeks.
    const today = new Date();
    const from = new Date(today.getTime() + 7 * 864e5).toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 11 * 864e5).toISOString().slice(0, 10);
    const body = { sectionId: debate.id, daysOfWeek: [1, 2, 3, 4, 5], startTime: '10:15', endTime: '11:00', fromDate: from, toDate: to };
    const strict = await c.post('/api/sessions/recurring', body, { token: s.teacher3.token });
    assert.equal(strict.status, 409);
    const lenient = await c.post('/api/sessions/recurring', { ...body, skipConflicts: true }, { token: s.teacher3.token });
    assert.equal(lenient.status, 201);
    assert.ok(lenient.body.skipped.length >= 3);
    assert.equal(lenient.body.created, 0);
  });

  test('validation errors are 400s with field details', async () => {
    const r = await c.post('/api/sessions', { sectionId: sec.Biology.id, startsAt: minutesFromNow(60), endsAt: minutesFromNow(30) }, { token: s.teacher2.token });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.details[0].path, 'endsAt');
    const r2 = await c.post('/api/sessions/recurring', { sectionId: sec.Biology.id, daysOfWeek: [9], startTime: '25:00', endTime: '10:00', fromDate: 'x', toDate: 'y' }, { token: s.teacher2.token });
    assert.equal(r2.status, 400);
  });

  test('start-now opens check-in immediately and blocks overlaps', async () => {
    const r = await c.post(`/api/sections/${sec['Writing Center'].id}/sessions/start`, { durationMin: 30 }, { token: s.teacher3.token });
    assert.equal(r.status, 201);
    assert.ok(Date.parse(r.body.session.startsAt) <= Date.now());
    const again = await c.post(`/api/sections/${sec['Writing Center'].id}/sessions/start`, { durationMin: 30 }, { token: s.teacher3.token });
    assert.equal(again.status, 409);
    const cancel = await c.patch(`/api/sessions/${r.body.session.id}`, { status: 'cancelled' }, { token: s.teacher3.token });
    assert.equal(cancel.body.session.status, 'cancelled');
  });

  test('students only see sessions for classes they take, with their own status', async () => {
    const list = (await c.get('/api/sessions', { token: s.student3.token })).body.sessions; // Ethan: Biology, English 10
    assert.ok(list.length > 0);
    assert.ok(list.every((x) => ['Biology', 'English 10'].includes(x.sectionName)));
    assert.ok(list.every((x) => 'myStatus' in x && !('counts' in x)));
  });
});

describe('geofenced check-in', () => {
  test('inside the fence at the start of class → present', async () => {
    const r = await c.post('/api/attendance/check-in', { sessionId: bioSession.id, ...near(30, 25) }, { token: s.student.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.record.status, 'present');
    assert.equal(r.body.record.method, 'geo');
    assert.ok(Math.abs(r.body.distance - 39) <= 1);
  });

  test('checking in twice is idempotent', async () => {
    const r = await c.post('/api/attendance/check-in', { sessionId: bioSession.id, ...near(5, 5) }, { token: s.student.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.alreadyCheckedIn, true);
    assert.ok(Math.abs(r.body.record.distanceM - 39) <= 1);
  });

  test('outside the fence → 422 with the distance', async () => {
    const r = await c.post('/api/attendance/check-in', { sessionId: bioSession.id, ...near(900, 800) }, { token: s.student2.token });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'outside_geofence');
    assert.ok(Math.abs(r.body.error.details.distance - 1204) < 3);
    assert.equal(r.body.error.details.radius, 200);
  });

  test('just past the edge is forgiven within GPS accuracy (max 30 m)', async () => {
    const ok = await c.post('/api/attendance/check-in', { sessionId: bioSession.id, ...near(215, 0, 20) }, { token: s.student2.token });
    assert.equal(ok.status, 201);
  });

  test('imprecise GPS fixes are rejected', async () => {
    const r = await c.post('/api/attendance/check-in', { sessionId: bioSession.id, ...near(10, 10, 150) }, { token: s.student3.token });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'low_accuracy');
  });

  test('invalid coordinates are a 400', async () => {
    const r = await c.post('/api/attendance/check-in', { sessionId: bioSession.id, latitude: 123, longitude: 0 }, { token: s.student3.token });
    assert.equal(r.status, 400);
  });

  test('students can only check in to classes they’re enrolled in', async () => {
    const r = await c.post('/api/attendance/check-in', { sessionId: liveAlgebra.id, ...near(10, 10) }, { token: s.student3.token });
    assert.equal(r.status, 403);
  });

  test('check-in is closed before the window opens', async () => {
    const tomorrow = (await c.get('/api/sessions', { token: s.student.token })).body.sessions.find((x) => Date.parse(x.startsAt) > Date.now() + 3600e3);
    const r = await c.post('/api/attendance/check-in', { sessionId: tomorrow.id, ...near(10, 10) }, { token: s.student.token });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'too_early');
  });

  test('more than 5 minutes after the start → late', async () => {
    const r = await c.post('/api/attendance/check-in', { sessionId: liveAlgebra.id, ...near(-20, 40) }, { token: s.student.token });
    assert.equal(r.status, 201);
    assert.equal(r.body.record.status, 'late');
  });

  test('a GPS check-in overrides an earlier "absent" mark', async () => {
    const mark = await c.put(`/api/sessions/${bioSession.id}/attendance`, { records: [{ studentId: s.student3.user.id, status: 'absent' }] }, { token: s.teacher2.token });
    assert.equal(mark.status, 200);
    assert.equal(mark.body.records[0].status, 'absent');
    const r = await c.post('/api/attendance/check-in', { sessionId: bioSession.id, ...near(0, 50, 15) }, { token: s.student3.token });
    assert.equal(r.status, 201);
    assert.equal(r.body.record.status, 'present');
  });
});

describe('teacher marking and finalizing', () => {
  test('only enrolled students can be marked', async () => {
    const r = await c.put(`/api/sessions/${bioSession.id}/attendance`, { records: [{ studentId: s.student.user.id, status: 'present' }, { studentId: s.rStudent.user.id, status: 'present' }] }, { token: s.teacher2.token });
    assert.equal(r.status, 400);
  });

  test('bulk marking with notes', async () => {
    const roster = (await c.get(`/api/sessions/${bioSession.id}`, { token: s.teacher2.token })).body.roster;
    const zoe = roster.find((r) => r.studentName === 'Zoe Kim');
    const r = await c.put(`/api/sessions/${bioSession.id}/attendance`, { records: [{ studentId: zoe.studentId, status: 'excused', note: 'Nurse visit' }] }, { token: s.teacher2.token });
    assert.equal(r.status, 200);
    assert.equal(r.body.records[0].note, 'Nurse visit');
    assert.equal(r.body.records[0].method, 'manual');
  });

  test('finalize marks the rest absent and notifies guardians in the background', async () => {
    const before = (await c.get(`/api/sessions/${bioSession.id}`, { token: s.teacher2.token })).body;
    const unmarked = before.roster.filter((r) => !r.status).length;
    const r = await c.post(`/api/sessions/${bioSession.id}/finalize`, {}, { token: s.teacher2.token });
    assert.equal(r.status, 202);
    assert.equal(r.body.markedAbsent, unmarked);
    assert.equal(r.body.session.status, 'finalized');
    assert.ok(r.body.roster.every((x) => x.status));
    const job = await waitForJob(c, s.teacher2.token, r.body.job.id);
    assert.equal(job.status, 'succeeded');
    assert.ok(job.result.flagged >= unmarked);
    assert.equal(job.result.lmsJobId, null); // not linked to the LMS yet
  });

  test('finalized sessions reject check-ins and a second finalize', async () => {
    assert.equal((await c.post(`/api/sessions/${bioSession.id}/finalize`, {}, { token: s.teacher2.token })).status, 409);
    const r = await c.post('/api/attendance/check-in', { sessionId: bioSession.id, ...near(10, 10) }, { token: s.student2.token });
    assert.equal(r.status, 409);
  });

  test('the attendance summary matches the records', async () => {
    const recs = (await c.get('/api/attendance?limit=1000', { token: s.student.token })).body.records;
    const sum = (await c.get('/api/attendance/summary', { token: s.student.token })).body;
    const n = (st) => recs.filter((r) => r.status === st).length;
    assert.equal(sum.counts.present, n('present'));
    assert.equal(sum.counts.absent, n('absent'));
    const expected = Math.round(((n('present') + n('late')) / (n('present') + n('late') + n('absent'))) * 1000) / 10;
    assert.equal(sum.rate, expected);
    const filtered = (await c.get('/api/attendance?status=late', { token: s.student.token })).body.records;
    assert.ok(filtered.every((r) => r.status === 'late'));
  });
});
