import { all, one, run, newId, nowIso, tx } from '../db/database.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { loadSectionFor, visibleStudentIds, assertCanViewStudent } from '../lib/rbac.js';
import { notFound, conflict, unprocessable, forbidden, badRequest } from '../lib/http.js';
import { validate, z } from '../lib/validate.js';
import { checkGeofence, isValidCoordinate } from '../lib/geo.js';
import { minutes, toIso } from '../lib/time.js';
import { config } from '../config.js';
import { publish, publishToUsers, channel } from '../realtime/hub.js';
import { enqueue, serializeJob } from '../jobs/queue.js';
import { getSession, serializeSession, sessionRoster } from './schedule.js';

export function serializeRecord(r) {
  return {
    id: r.id,
    sessionId: r.session_id,
    studentId: r.student_id,
    studentName: r.student_name ?? undefined,
    status: r.status,
    method: r.method,
    checkedInAt: r.checked_in_at,
    distanceM: r.distance_m,
    accuracyM: r.accuracy_m,
    note: r.note,
    recordedBy: r.recorded_by,
    updatedAt: r.updated_at,
  };
}

const RECORD_SELECT = `SELECT ar.*, u.name AS student_name FROM attendance_records ar JOIN users u ON u.id = ar.student_id`;

/** Push a changed record to the section's live board, the student, and their guardians. */
export function broadcastAttendance(session, recordId) {
  const record = serializeRecord(one(`${RECORD_SELECT} WHERE ar.id = ?`, recordId));
  const payload = { sessionId: session.id, sectionId: session.section_id, sectionName: session.section_name, record };
  publish(channel.section(session.section_id), 'attendance.updated', payload);
  const guardians = all('SELECT parent_id FROM guardianships WHERE student_id = ?', record.studentId).map((g) => g.parent_id);
  publishToUsers([record.studentId, ...guardians], 'attendance.updated', payload);
  return record;
}

/** Upsert a record. Returns the record id. */
export function upsertRecord({ tenantId, sessionId, studentId, status, method, recordedBy = null, note = null, geo = null }) {
  const existing = one('SELECT id FROM attendance_records WHERE session_id = ? AND student_id = ?', sessionId, studentId);
  const now = nowIso();
  if (existing) {
    run(
      `UPDATE attendance_records SET status = ?, method = ?, note = ?, recorded_by = ?, updated_at = ?,
         checked_in_at = COALESCE(?, checked_in_at), latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
         accuracy_m = COALESCE(?, accuracy_m), distance_m = COALESCE(?, distance_m)
       WHERE id = ?`,
      status, method, note, recordedBy, now, geo?.checkedInAt ?? null, geo?.latitude ?? null, geo?.longitude ?? null,
      geo?.accuracy ?? null, geo?.distance ?? null, existing.id,
    );
    return existing.id;
  }
  const id = newId();
  run(
    `INSERT INTO attendance_records (id, tenant_id, session_id, student_id, status, method, checked_in_at, latitude, longitude, accuracy_m, distance_m, note, recorded_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, tenantId, sessionId, studentId, status, method, geo?.checkedInAt ?? null, geo?.latitude ?? null, geo?.longitude ?? null,
    geo?.accuracy ?? null, geo?.distance ?? null, note, recordedBy, now,
  );
  return id;
}

/** Attendance rate = (present + late) / (present + late + absent). Excused sessions are left out. */
export function summarize(rows) {
  const counts = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + (r.n ?? 1);
  const attended = counts.present + counts.late;
  const denominator = attended + counts.absent;
  return { counts, total: denominator + counts.excused, rate: denominator ? Math.round((attended / denominator) * 1000) / 10 : null };
}

const checkInSchema = z.object({
  sessionId: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
  accuracy: z.number().nonnegative().default(0),
});

const markSchema = z.object({
  records: z.array(z.object({
    studentId: z.string().min(1),
    status: z.enum(['present', 'late', 'absent', 'excused']),
    note: z.string().trim().max(500).optional().nullable(),
  })).min(1).max(500),
});

export function registerAttendanceRoutes(router) {
  router.use('/api', (r) => {
    /**
     * Student self check-in, verified server-side:
     *  1) enrolled in the section   2) inside the check-in window
     *  3) GPS fix precise enough     4) inside the campus geofence
     */
    r.post('/attendance/check-in', requirePermission('attendance.checkin'), (ctx) => {
      const input = validate(checkInSchema, ctx.body);
      if (!isValidCoordinate(input.latitude, input.longitude)) throw badRequest('Invalid coordinates');
      const session = getSession(ctx.user.tenantId, input.sessionId);
      if (!session) throw notFound('Session');
      const enrolled = one('SELECT 1 AS x FROM enrollments WHERE section_id = ? AND student_id = ?', session.section_id, ctx.user.id);
      if (!enrolled) throw forbidden('You are not enrolled in this class');
      if (session.status !== 'scheduled') throw conflict(`This session is ${session.status}; check-in is closed`);

      const now = Date.now();
      const start = Date.parse(session.starts_at);
      const opensAt = start - minutes(config.attendance.opensBeforeStartMin);
      if (now < opensAt) {
        throw unprocessable('too_early', `Check-in opens ${config.attendance.opensBeforeStartMin} minutes before class starts`, { opensAt: new Date(opensAt).toISOString() });
      }
      if (now > Date.parse(session.ends_at)) throw unprocessable('too_late', 'This session has ended', { endedAt: session.ends_at });

      if (input.accuracy > config.attendance.maxAccuracyM) {
        throw unprocessable('low_accuracy', `Location is too imprecise (±${Math.round(input.accuracy)} m). Move near a window or enable precise location and try again.`, {
          accuracy: input.accuracy, maxAccuracy: config.attendance.maxAccuracyM,
        });
      }
      const campus = one('SELECT * FROM campuses WHERE id = ? AND tenant_id = ?', session.campus_id, ctx.user.tenantId);
      const fence = checkGeofence(input, campus);
      if (!fence.inside) {
        throw unprocessable('outside_geofence', `You appear to be ${fence.distance} m from ${campus.name}. You must be within ${fence.radius} m to check in.`, {
          distance: fence.distance, radius: fence.radius, campus: campus.name,
        });
      }

      const existing = one('SELECT * FROM attendance_records WHERE session_id = ? AND student_id = ?', session.id, ctx.user.id);
      if (existing && (existing.status === 'present' || existing.status === 'late' || existing.status === 'excused')) {
        // Idempotent: repeated taps don't change an existing check-in.
        return { record: serializeRecord(existing), alreadyCheckedIn: true, distance: fence.distance };
      }
      const status = now > start + minutes(config.attendance.lateAfterMin) ? 'late' : 'present';
      const recordId = upsertRecord({
        tenantId: ctx.user.tenantId, sessionId: session.id, studentId: ctx.user.id, status, method: 'geo', recordedBy: ctx.user.id,
        geo: { checkedInAt: new Date(now).toISOString(), latitude: input.latitude, longitude: input.longitude, accuracy: input.accuracy, distance: fence.distance },
      });
      const record = broadcastAttendance(session, recordId);
      ctx.status = 201;
      return { record, alreadyCheckedIn: false, distance: fence.distance };
    });

    // Teacher/admin marks (or corrects) attendance in bulk.
    r.put('/sessions/:id/attendance', requirePermission('attendance.mark'), (ctx) => {
      const session = getSession(ctx.user.tenantId, ctx.params.id);
      if (!session) throw notFound('Session');
      loadSectionFor(ctx.user, session.section_id, 'manage');
      if (session.status === 'cancelled') throw conflict('This session was cancelled');
      const { records } = validate(markSchema, ctx.body);
      const enrolled = new Set(all('SELECT student_id FROM enrollments WHERE section_id = ?', session.section_id).map((e) => e.student_id));
      const unknown = records.filter((rec) => !enrolled.has(rec.studentId));
      if (unknown.length) throw badRequest('Some students are not enrolled in this section', { studentIds: unknown.map((u) => u.studentId) });

      const ids = tx(() => records.map((rec) => upsertRecord({
        tenantId: ctx.user.tenantId, sessionId: session.id, studentId: rec.studentId, status: rec.status, method: 'manual',
        recordedBy: ctx.user.id, note: rec.note ?? null,
      })));
      return { records: ids.map((id) => broadcastAttendance(session, id)) };
    });

    // Close a session: everyone not yet marked becomes absent; follow-ups run in the background.
    r.post('/sessions/:id/finalize', requirePermission('attendance.mark'), (ctx) => {
      const session = getSession(ctx.user.tenantId, ctx.params.id);
      if (!session) throw notFound('Session');
      loadSectionFor(ctx.user, session.section_id, 'manage');
      if (session.status === 'finalized') throw conflict('Session is already finalized');
      if (session.status === 'cancelled') throw conflict('Session was cancelled');

      const marked = tx(() => {
        const missing = all(
          `SELECT e.student_id FROM enrollments e JOIN users u ON u.id = e.student_id
           WHERE e.section_id = ? AND u.status != 'inactive'
             AND NOT EXISTS (SELECT 1 FROM attendance_records ar WHERE ar.session_id = ? AND ar.student_id = e.student_id)`,
          session.section_id, session.id,
        );
        const ids = missing.map((m) => upsertRecord({
          tenantId: ctx.user.tenantId, sessionId: session.id, studentId: m.student_id, status: 'absent', method: 'system', recordedBy: ctx.user.id,
        }));
        run(`UPDATE sessions SET status = 'finalized', finalized_at = ? WHERE id = ?`, nowIso(), session.id);
        return ids;
      });
      const updated = getSession(ctx.user.tenantId, session.id);
      for (const id of marked) broadcastAttendance(updated, id);
      publish(channel.section(session.section_id), 'session.updated', serializeSession(updated));

      const job = enqueue({ tenantId: ctx.user.tenantId, type: 'attendance.finalized', payload: { sessionId: session.id }, createdBy: ctx.user.id });
      ctx.status = 202; // accepted: guardian notifications + LMS grade passback continue asynchronously
      return { session: serializeSession(updated), markedAbsent: marked.length, roster: sessionRoster(updated), job: serializeJob(job) };
    });

    // Attendance history, scoped to what the caller may see.
    r.get('/attendance', requirePermission('attendance.view'), (ctx) => {
      const { where, params } = scopedFilter(ctx);
      const limit = Math.min(Number(ctx.query.limit) || 200, 1000);
      const rows = all(
        `SELECT ar.*, u.name AS student_name, s.starts_at, s.ends_at, sec.name AS section_name, sec.id AS section_id
         FROM attendance_records ar JOIN users u ON u.id = ar.student_id JOIN sessions s ON s.id = ar.session_id JOIN sections sec ON sec.id = s.section_id
         WHERE ${where} ORDER BY s.starts_at DESC LIMIT ?`,
        ...params, limit,
      );
      return {
        records: rows.map((r) => ({ ...serializeRecord(r), sectionId: r.section_id, sectionName: r.section_name, startsAt: r.starts_at, endsAt: r.ends_at })),
      };
    });

    r.get('/attendance/summary', requirePermission('attendance.view'), (ctx) => {
      const { where, params } = scopedFilter(ctx);
      const rows = all(
        `SELECT ar.status, COUNT(*) AS n FROM attendance_records ar JOIN sessions s ON s.id = ar.session_id JOIN sections sec ON sec.id = s.section_id
         WHERE ${where} GROUP BY ar.status`,
        ...params,
      );
      return summarize(rows);
    });
  }, authenticate);
}

/** Build a WHERE clause limited to the caller's visible students/sections plus optional filters. */
function scopedFilter(ctx) {
  const u = ctx.user;
  const q = ctx.query;
  const clauses = ['ar.tenant_id = ?'];
  const params = [u.tenantId];

  if (q.studentId) {
    assertCanViewStudent(u, q.studentId);
    clauses.push('ar.student_id = ?');
    params.push(q.studentId);
  }
  if (q.sectionId) {
    loadSectionFor(u, q.sectionId, u.role === 'teacher' ? 'manage' : 'read');
    clauses.push('s.section_id = ?');
    params.push(q.sectionId);
  }
  if (u.role === 'teacher') {
    // Teachers see records for their own sections only.
    clauses.push('sec.teacher_id = ?');
    params.push(u.id);
  } else {
    const ids = visibleStudentIds(u);
    if (ids !== null) {
      clauses.push(`ar.student_id IN (${ids.length ? ids.map(() => '?').join(',') : "''"})`);
      params.push(...ids);
    }
  }
  if (q.status) {
    clauses.push('ar.status = ?');
    params.push(q.status);
  }
  if (q.from) {
    clauses.push('s.starts_at >= ?');
    params.push(toIso(q.from));
  }
  if (q.to) {
    clauses.push('s.starts_at < ?');
    params.push(toIso(q.to));
  }
  return { where: clauses.join(' AND '), params };
}
