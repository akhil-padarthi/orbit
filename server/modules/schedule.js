import { all, one, run, newId, nowIso, tx } from '../db/database.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { loadSectionFor, visibleSectionIds, childIdsOf } from '../lib/rbac.js';
import { notFound, conflict, badRequest, forbidden } from '../lib/http.js';
import { validate, z, isoDateTime, isoDate, hhmm } from '../lib/validate.js';
import { zonedToUtc, addDays, weekday, minutes, toIso } from '../lib/time.js';
import { config } from '../config.js';
import { ensureSectionConversation } from './messages.js';
import { publish, channel } from '../realtime/hub.js';

// ---------------------------------------------------------------------------
// Helpers shared with other modules
// ---------------------------------------------------------------------------

export function serializeSection(s) {
  return {
    id: s.id,
    name: s.name,
    courseCode: s.course_code,
    room: s.room,
    kind: s.kind,
    capacity: s.capacity,
    teacherId: s.teacher_id,
    teacherName: s.teacher_name ?? null,
    campusId: s.campus_id,
    campusName: s.campus_name ?? null,
    enrolledCount: s.enrolled_count ?? undefined,
    externalId: s.external_id,
    lmsCourseId: s.lms_course_id,
  };
}

const SECTION_SELECT = `
  SELECT sec.*, u.name AS teacher_name, c.name AS campus_name,
         (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = sec.id) AS enrolled_count
  FROM sections sec LEFT JOIN users u ON u.id = sec.teacher_id LEFT JOIN campuses c ON c.id = sec.campus_id`;

export function getSection(tenantId, id) {
  return one(`${SECTION_SELECT} WHERE sec.id = ? AND sec.tenant_id = ?`, id, tenantId);
}

const SESSION_SELECT = `
  SELECT s.*, sec.name AS section_name, sec.course_code, sec.room, sec.kind, sec.teacher_id, sec.campus_id, u.name AS teacher_name
  FROM sessions s JOIN sections sec ON sec.id = s.section_id LEFT JOIN users u ON u.id = sec.teacher_id`;

export function getSession(tenantId, id) {
  return one(`${SESSION_SELECT} WHERE s.id = ? AND s.tenant_id = ?`, id, tenantId);
}

export function serializeSession(s) {
  return {
    id: s.id,
    sectionId: s.section_id,
    sectionName: s.section_name,
    courseCode: s.course_code,
    room: s.room,
    kind: s.kind,
    teacherId: s.teacher_id,
    teacherName: s.teacher_name,
    startsAt: s.starts_at,
    endsAt: s.ends_at,
    status: s.status,
    finalizedAt: s.finalized_at,
    checkInOpensAt: new Date(new Date(s.starts_at).getTime() - minutes(config.attendance.opensBeforeStartMin)).toISOString(),
  };
}

/** Sessions that would clash with a proposed time slot (same section, same teacher, or same room on the same campus). */
export function findConflicts({ tenantId, section, startsAt, endsAt, excludeSessionId = null }) {
  return all(
    `SELECT s.id, s.starts_at, s.ends_at, sec.name AS section_name, sec.room, u.name AS teacher_name,
            CASE WHEN s.section_id = ? THEN 'section'
                 WHEN sec.teacher_id IS NOT NULL AND sec.teacher_id = ? THEN 'teacher'
                 ELSE 'room' END AS reason
     FROM sessions s JOIN sections sec ON sec.id = s.section_id LEFT JOIN users u ON u.id = sec.teacher_id
     WHERE s.tenant_id = ? AND s.status != 'cancelled' AND s.id != COALESCE(?, '')
       AND s.starts_at < ? AND s.ends_at > ?
       AND (s.section_id = ?
            OR (sec.teacher_id IS NOT NULL AND sec.teacher_id = ?)
            OR (sec.room IS NOT NULL AND sec.room = ? AND sec.campus_id = ?))
     ORDER BY s.starts_at`,
    section.id, section.teacher_id, tenantId, excludeSessionId, endsAt, startsAt, section.id, section.teacher_id, section.room, section.campus_id,
  ).map((c) => ({ sessionId: c.id, startsAt: c.starts_at, endsAt: c.ends_at, sectionName: c.section_name, room: c.room, teacherName: c.teacher_name, reason: c.reason }));
}

function createSession(user, section, startsAt, endsAt) {
  const id = newId();
  run(
    `INSERT INTO sessions (id, tenant_id, section_id, starts_at, ends_at, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
    id, user.tenantId, section.id, startsAt, endsAt, user.id, nowIso(),
  );
  return id;
}

function attendanceCounts(sessionId) {
  const counts = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const r of all('SELECT status, COUNT(*) AS n FROM attendance_records WHERE session_id = ? GROUP BY status', sessionId)) counts[r.status] = r.n;
  return counts;
}

export function sessionRoster(session) {
  return all(
    `SELECT u.id AS student_id, u.name, u.grade_level, ar.id AS record_id, ar.status, ar.method, ar.checked_in_at, ar.distance_m, ar.accuracy_m, ar.note, ar.updated_at
     FROM enrollments e JOIN users u ON u.id = e.student_id
     LEFT JOIN attendance_records ar ON ar.session_id = ? AND ar.student_id = e.student_id
     WHERE e.section_id = ? AND u.status != 'inactive' ORDER BY u.name`,
    session.id, session.section_id,
  ).map((r) => ({
    studentId: r.student_id,
    studentName: r.name,
    gradeLevel: r.grade_level,
    status: r.status ?? null,
    method: r.method ?? null,
    checkedInAt: r.checked_in_at ?? null,
    distanceM: r.distance_m ?? null,
    accuracyM: r.accuracy_m ?? null,
    note: r.note ?? null,
    updatedAt: r.updated_at ?? null,
  }));
}

function inClause(ids) {
  return ids.map(() => '?').join(',');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const sectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  courseCode: z.string().trim().max(40).optional().nullable(),
  room: z.string().trim().max(60).optional().nullable(),
  teacherId: z.string().optional().nullable(),
  campusId: z.string().optional(),
  kind: z.enum(['class', 'flex']).default('class'),
  capacity: z.number().int().positive().max(1000).optional().nullable(),
});

const sessionSchema = z.object({ sectionId: z.string().min(1), startsAt: isoDateTime, endsAt: isoDateTime }).refine(
  (v) => new Date(v.endsAt) > new Date(v.startsAt), { message: 'endsAt must be after startsAt', path: ['endsAt'] },
);

const recurringSchema = z.object({
  sectionId: z.string().min(1),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1),
  startTime: hhmm,
  endTime: hhmm,
  fromDate: isoDate,
  toDate: isoDate,
  skipConflicts: z.boolean().default(false),
}).refine((v) => v.endTime > v.startTime, { message: 'endTime must be after startTime', path: ['endTime'] })
  .refine((v) => v.toDate >= v.fromDate, { message: 'toDate must be on or after fromDate', path: ['toDate'] });

function assertTeacher(tenantId, teacherId) {
  if (!teacherId) return;
  const t = one("SELECT id FROM users WHERE id = ? AND tenant_id = ? AND role = 'teacher'", teacherId, tenantId);
  if (!t) throw badRequest('teacherId must be a teacher in this school');
}

function defaultCampus(tenantId, campusId) {
  const campus = campusId
    ? one('SELECT id FROM campuses WHERE id = ? AND tenant_id = ?', campusId, tenantId)
    : one('SELECT id FROM campuses WHERE tenant_id = ? ORDER BY created_at LIMIT 1', tenantId);
  if (!campus) throw badRequest('Campus not found');
  return campus.id;
}

export function registerScheduleRoutes(router) {
  router.use('/api', (r) => {
    // ---- Sections -------------------------------------------------------
    r.get('/sections', (ctx) => {
      const u = ctx.user;
      const kind = ctx.query.kind;
      let rows;
      const ids = visibleSectionIds(u);
      if (ids === null) {
        rows = all(`${SECTION_SELECT} WHERE sec.tenant_id = ? ORDER BY sec.kind, sec.name`, u.tenantId);
      } else {
        // Students can also browse flex blocks they might request to join.
        const extra = u.role === 'student' ? " OR sec.kind = 'flex'" : '';
        rows = all(
          `${SECTION_SELECT} WHERE sec.tenant_id = ? AND (sec.id IN (${ids.length ? inClause(ids) : "''"})${extra}) ORDER BY sec.kind, sec.name`,
          u.tenantId, ...ids,
        );
      }
      if (kind) rows = rows.filter((s) => s.kind === kind);
      const enrolled = new Set(u.role === 'student' ? ids : []);
      return { sections: rows.map((s) => ({ ...serializeSection(s), enrolled: u.role === 'student' ? enrolled.has(s.id) : undefined })) };
    });

    r.get('/sections/:id', (ctx) => {
      const section = loadSectionFor(ctx.user, ctx.params.id, 'read');
      const full = serializeSection(getSection(ctx.user.tenantId, section.id));
      const canManage = ctx.user.role === 'admin' || (ctx.user.role === 'teacher' && section.teacher_id === ctx.user.id);
      let roster;
      if (canManage) {
        roster = all(
          `SELECT u.id, u.name, u.email, u.grade_level, e.source,
                  (SELECT GROUP_CONCAT(p.name, ', ') FROM guardianships g JOIN users p ON p.id = g.parent_id WHERE g.student_id = u.id) AS guardians
           FROM enrollments e JOIN users u ON u.id = e.student_id WHERE e.section_id = ? ORDER BY u.name`,
          section.id,
        ).map((s) => ({ id: s.id, name: s.name, email: s.email, gradeLevel: s.grade_level, source: s.source, guardians: s.guardians }));
      }
      return { section: full, roster, canManage };
    });

    r.post('/sections', requirePermission('sections.manage'), (ctx) => {
      const input = validate(sectionSchema, ctx.body);
      assertTeacher(ctx.user.tenantId, input.teacherId);
      const id = newId();
      run(
        `INSERT INTO sections (id, tenant_id, campus_id, teacher_id, name, course_code, room, kind, capacity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ctx.user.tenantId, defaultCampus(ctx.user.tenantId, input.campusId), input.teacherId ?? null, input.name,
        input.courseCode ?? null, input.room ?? null, input.kind, input.capacity ?? null, nowIso(),
      );
      ensureSectionConversation(ctx.user.tenantId, id);
      ctx.status = 201;
      return { section: serializeSection(getSection(ctx.user.tenantId, id)) };
    });

    r.patch('/sections/:id', requirePermission('sections.manage'), (ctx) => {
      const section = loadSectionFor(ctx.user, ctx.params.id, 'manage');
      const input = validate(sectionSchema.partial(), ctx.body);
      if (input.teacherId !== undefined) assertTeacher(ctx.user.tenantId, input.teacherId);
      const merged = {
        name: input.name ?? section.name,
        course_code: input.courseCode !== undefined ? input.courseCode : section.course_code,
        room: input.room !== undefined ? input.room : section.room,
        teacher_id: input.teacherId !== undefined ? input.teacherId : section.teacher_id,
        campus_id: input.campusId ? defaultCampus(ctx.user.tenantId, input.campusId) : section.campus_id,
        kind: input.kind ?? section.kind,
        capacity: input.capacity !== undefined ? input.capacity : section.capacity,
      };
      run(
        `UPDATE sections SET name = ?, course_code = ?, room = ?, teacher_id = ?, campus_id = ?, kind = ?, capacity = ? WHERE id = ? AND tenant_id = ?`,
        merged.name, merged.course_code, merged.room, merged.teacher_id, merged.campus_id, merged.kind, merged.capacity, section.id, ctx.user.tenantId,
      );
      ensureSectionConversation(ctx.user.tenantId, section.id);
      return { section: serializeSection(getSection(ctx.user.tenantId, section.id)) };
    });

    r.post('/sections/:id/enrollments', requirePermission('sections.manage'), (ctx) => {
      const section = loadSectionFor(ctx.user, ctx.params.id, 'manage');
      const { studentId } = validate(z.object({ studentId: z.string().min(1) }), ctx.body);
      const student = one("SELECT id FROM users WHERE id = ? AND tenant_id = ? AND role = 'student'", studentId, ctx.user.tenantId);
      if (!student) throw notFound('Student');
      if (one('SELECT 1 AS x FROM enrollments WHERE section_id = ? AND student_id = ?', section.id, studentId)) throw conflict('Student is already enrolled');
      if (section.capacity) {
        const n = one('SELECT COUNT(*) AS n FROM enrollments WHERE section_id = ?', section.id).n;
        if (n >= section.capacity) throw conflict('Section is full');
      }
      run(`INSERT INTO enrollments (tenant_id, section_id, student_id, source, created_at) VALUES (?, ?, ?, 'manual', ?)`, ctx.user.tenantId, section.id, studentId, nowIso());
      ensureSectionConversation(ctx.user.tenantId, section.id);
      ctx.status = 201;
      return { ok: true };
    });

    r.delete('/sections/:id/enrollments/:studentId', requirePermission('sections.manage'), (ctx) => {
      const section = loadSectionFor(ctx.user, ctx.params.id, 'manage');
      const res = run('DELETE FROM enrollments WHERE section_id = ? AND student_id = ? AND tenant_id = ?', section.id, ctx.params.studentId, ctx.user.tenantId);
      if (!res.changes) throw notFound('Enrollment');
      ensureSectionConversation(ctx.user.tenantId, section.id);
      return { ok: true };
    });

    // ---- Sessions (the schedule) ------------------------------------------
    r.get('/sessions', (ctx) => {
      const u = ctx.user;
      const from = ctx.query.from ? toIso(ctx.query.from) : new Date(Date.now() - minutes(60 * 24 * 7)).toISOString();
      const to = ctx.query.to ? toIso(ctx.query.to) : new Date(Date.now() + minutes(60 * 24 * 7)).toISOString();
      if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw badRequest('from/to must be valid dates');
      const ids = visibleSectionIds(u);
      const params = [u.tenantId, from, to];
      let where = 's.tenant_id = ? AND s.starts_at >= ? AND s.starts_at < ?';
      if (ids !== null) {
        if (!ids.length) return { sessions: [] };
        where += ` AND s.section_id IN (${inClause(ids)})`;
        params.push(...ids);
      }
      if (ctx.query.sectionId) {
        where += ' AND s.section_id = ?';
        params.push(ctx.query.sectionId);
      }
      if (ctx.query.status) {
        where += ' AND s.status = ?';
        params.push(ctx.query.status);
      }
      const rows = all(`${SESSION_SELECT} WHERE ${where} ORDER BY s.starts_at LIMIT 2000`, ...params);

      const kids = u.role === 'parent' ? childIdsOf(u) : [];
      return {
        sessions: rows.map((s) => {
          const out = serializeSession(s);
          if (u.role === 'admin' || u.role === 'teacher') {
            out.enrolled = one('SELECT COUNT(*) AS n FROM enrollments WHERE section_id = ?', s.section_id).n;
            out.counts = attendanceCounts(s.id);
          } else if (u.role === 'student') {
            out.myStatus = one('SELECT status FROM attendance_records WHERE session_id = ? AND student_id = ?', s.id, u.id)?.status ?? null;
          } else if (u.role === 'parent') {
            out.children = all(
              `SELECT u.id, u.name, ar.status FROM enrollments e JOIN users u ON u.id = e.student_id
               LEFT JOIN attendance_records ar ON ar.session_id = ? AND ar.student_id = u.id
               WHERE e.section_id = ? AND e.student_id IN (${kids.length ? inClause(kids) : "''"})`,
              s.id, s.section_id, ...kids,
            ).map((c) => ({ id: c.id, name: c.name, status: c.status ?? null }));
          }
          return out;
        }),
      };
    });

    r.get('/sessions/:id', (ctx) => {
      const s = getSession(ctx.user.tenantId, ctx.params.id);
      if (!s) throw notFound('Session');
      const section = loadSectionFor(ctx.user, s.section_id, 'read');
      const canManage = ctx.user.role === 'admin' || (ctx.user.role === 'teacher' && section.teacher_id === ctx.user.id);
      const out = { session: serializeSession(s), canManage };
      if (canManage) {
        out.roster = sessionRoster(s);
        out.counts = attendanceCounts(s.id);
      } else {
        const visible = ctx.user.role === 'student' ? [ctx.user.id] : childIdsOf(ctx.user);
        out.roster = sessionRoster(s).filter((r) => visible.includes(r.studentId));
      }
      return out;
    });

    r.post('/sessions', requirePermission('sessions.manage'), (ctx) => {
      const input = validate(sessionSchema, ctx.body);
      const section = loadSectionFor(ctx.user, input.sectionId, 'manage');
      const startsAt = toIso(input.startsAt);
      const endsAt = toIso(input.endsAt);
      const conflicts = findConflicts({ tenantId: ctx.user.tenantId, section, startsAt, endsAt });
      if (conflicts.length) throw conflict('That time clashes with existing sessions', { conflicts });
      const id = createSession(ctx.user, section, startsAt, endsAt);
      ctx.status = 201;
      return { session: serializeSession(getSession(ctx.user.tenantId, id)) };
    });

    r.post('/sessions/recurring', requirePermission('sessions.manage'), (ctx) => {
      const input = validate(recurringSchema, ctx.body);
      const section = loadSectionFor(ctx.user, input.sectionId, 'manage');
      const tz = ctx.user.timezone;
      const slots = [];
      for (let d = input.fromDate; d <= input.toDate; d = addDays(d, 1)) {
        if (!input.daysOfWeek.includes(weekday(d))) continue;
        slots.push({ date: d, startsAt: zonedToUtc(d, input.startTime, tz).toISOString(), endsAt: zonedToUtc(d, input.endTime, tz).toISOString() });
        if (slots.length > 400) throw badRequest('That would create more than 400 sessions; choose a shorter range');
      }
      if (!slots.length) throw badRequest('No dates in that range fall on the selected days');

      const withConflicts = slots.map((s) => ({ ...s, conflicts: findConflicts({ tenantId: ctx.user.tenantId, section, startsAt: s.startsAt, endsAt: s.endsAt }) }));
      const clashing = withConflicts.filter((s) => s.conflicts.length);
      if (clashing.length && !input.skipConflicts) {
        throw conflict(`${clashing.length} of ${slots.length} sessions clash with existing sessions`, {
          conflicts: clashing.map((c) => ({ date: c.date, startsAt: c.startsAt, with: c.conflicts })),
        });
      }
      const created = tx(() => withConflicts.filter((s) => !s.conflicts.length).map((s) => createSession(ctx.user, section, s.startsAt, s.endsAt)));
      ctx.status = 201;
      return { created: created.length, skipped: clashing.map((c) => c.date), sessionIds: created };
    });

    r.post('/sections/:id/sessions/start', requirePermission('sessions.manage'), (ctx) => {
      const section = loadSectionFor(ctx.user, ctx.params.id, 'manage');
      const { durationMin } = validate(z.object({ durationMin: z.number().int().min(5).max(240).default(50) }), ctx.body);
      const start = new Date(Math.floor(Date.now() / 60000) * 60000);
      const startsAt = start.toISOString();
      const endsAt = new Date(start.getTime() + minutes(durationMin)).toISOString();
      const conflicts = findConflicts({ tenantId: ctx.user.tenantId, section, startsAt, endsAt });
      if (conflicts.length) throw conflict('You already have a session during this time', { conflicts });
      const id = createSession(ctx.user, section, startsAt, endsAt);
      const session = serializeSession(getSession(ctx.user.tenantId, id));
      publish(channel.section(section.id), 'session.updated', session);
      ctx.status = 201;
      return { session };
    });

    r.patch('/sessions/:id', requirePermission('sessions.manage'), (ctx) => {
      const s = getSession(ctx.user.tenantId, ctx.params.id);
      if (!s) throw notFound('Session');
      const section = loadSectionFor(ctx.user, s.section_id, 'manage');
      const input = validate(
        z.object({ startsAt: isoDateTime.optional(), endsAt: isoDateTime.optional(), status: z.enum(['cancelled', 'scheduled']).optional() }),
        ctx.body,
      );
      if (s.status === 'finalized') throw conflict('Finalized sessions cannot be changed');
      const startsAt = input.startsAt ? toIso(input.startsAt) : s.starts_at;
      const endsAt = input.endsAt ? toIso(input.endsAt) : s.ends_at;
      if (endsAt <= startsAt) throw badRequest('endsAt must be after startsAt');
      const status = input.status ?? s.status;
      if (status !== 'cancelled') {
        const conflicts = findConflicts({ tenantId: ctx.user.tenantId, section, startsAt, endsAt, excludeSessionId: s.id });
        if (conflicts.length) throw conflict('That time clashes with existing sessions', { conflicts });
      }
      run('UPDATE sessions SET starts_at = ?, ends_at = ?, status = ? WHERE id = ? AND tenant_id = ?', startsAt, endsAt, status, s.id, ctx.user.tenantId);
      const session = serializeSession(getSession(ctx.user.tenantId, s.id));
      publish(channel.section(section.id), 'session.updated', session);
      return { session };
    });

    r.get('/schedule/conflicts', requirePermission('sessions.manage'), (ctx) => {
      const { sectionId, startsAt, endsAt } = validate(sessionSchema, ctx.query);
      const section = loadSectionFor(ctx.user, sectionId, 'manage');
      if (!section) throw forbidden();
      return { conflicts: findConflicts({ tenantId: ctx.user.tenantId, section, startsAt: toIso(startsAt), endsAt: toIso(endsAt) }) };
    });
  }, authenticate);
}
