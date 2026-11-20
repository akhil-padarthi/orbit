import { all, one } from '../db/database.js';
import { authenticate } from '../middleware/auth.js';
import { childIdsOf } from '../lib/rbac.js';
import { dayRangeUtc, localDate, addDays, minutes } from '../lib/time.js';
import { summarize } from './attendance.js';
import { serializeSession } from './schedule.js';
import { serializeJob } from '../jobs/queue.js';
import { config } from '../config.js';

const countsFor = (sessionId) => {
  const c = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const r of all('SELECT status, COUNT(*) AS n FROM attendance_records WHERE session_id = ? GROUP BY status', sessionId)) c[r.status] = r.n;
  return c;
};

function isCheckInOpen(s, now = Date.now()) {
  return s.status === 'scheduled' && now >= Date.parse(s.starts_at) - minutes(config.attendance.opensBeforeStartMin) && now <= Date.parse(s.ends_at);
}

function todaysSessions(user, extraWhere = '', ...params) {
  const { start, end } = dayRangeUtc(localDate(new Date(), user.timezone), user.timezone);
  return all(
    `SELECT s.*, sec.name AS section_name, sec.course_code, sec.room, sec.kind, sec.teacher_id, u.name AS teacher_name
     FROM sessions s JOIN sections sec ON sec.id = s.section_id LEFT JOIN users u ON u.id = sec.teacher_id
     WHERE s.tenant_id = ? AND s.starts_at >= ? AND s.starts_at < ? AND s.status != 'cancelled' ${extraWhere}
     ORDER BY s.starts_at`,
    user.tenantId, start, end, ...params,
  );
}

/** Attendance rate per school day for the last two weeks (tenant-wide or for given students). */
function trend(user, studentIds = null) {
  const since = new Date(Date.now() - minutes(60 * 24 * 14)).toISOString();
  const filter = studentIds ? ` AND ar.student_id IN (${studentIds.map(() => '?').join(',') || "''"})` : '';
  const rows = all(
    `SELECT ar.status, s.starts_at FROM attendance_records ar JOIN sessions s ON s.id = ar.session_id
     WHERE ar.tenant_id = ? AND s.starts_at >= ? AND s.status = 'finalized'${filter}`,
    user.tenantId, since, ...(studentIds ?? []),
  );
  const byDay = new Map();
  for (const r of rows) {
    const d = localDate(new Date(r.starts_at), user.timezone);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(r);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, rs]) => ({ date, ...summarize(rs) }));
}

export function registerDashboardRoutes(router) {
  router.get('/api/dashboard', authenticate, (ctx) => {
    const u = ctx.user;
    const t = u.tenantId;

    if (u.role === 'admin') {
      const count = (role) => one("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = ? AND status != 'inactive'", t, role).n;
      const today = todaysSessions(u);
      const todayRecords = today.length
        ? all(`SELECT status, COUNT(*) AS n FROM attendance_records WHERE session_id IN (${today.map(() => '?').join(',')}) GROUP BY status`, ...today.map((s) => s.id))
        : [];
      const lowAttendance = all(
        `SELECT u.id, u.name, ar.status, COUNT(*) AS n FROM attendance_records ar JOIN users u ON u.id = ar.student_id
         JOIN sessions s ON s.id = ar.session_id WHERE ar.tenant_id = ? AND s.status = 'finalized' AND u.status != 'inactive' GROUP BY u.id, ar.status`,
        t,
      ).reduce((acc, r) => {
        (acc[r.id] ??= { id: r.id, name: r.name, rows: [] }).rows.push(r);
        return acc;
      }, {});
      const atRisk = Object.values(lowAttendance)
        .map((s) => ({ id: s.id, name: s.name, ...summarize(s.rows) }))
        .filter((s) => s.rate != null && s.rate < 90)
        .sort((a, b) => a.rate - b.rate)
        .slice(0, 6);
      return {
        role: 'admin',
        stats: {
          students: count('student'), teachers: count('teacher'), parents: count('parent'),
          sections: one('SELECT COUNT(*) AS n FROM sections WHERE tenant_id = ?', t).n,
          invited: one("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND status = 'invited'", t).n,
        },
        today: {
          sessions: today.length,
          live: today.filter((s) => isCheckInOpen(s)).length,
          ...summarize(todayRecords),
          list: today.map((s) => ({ ...serializeSession(s), counts: countsFor(s.id), live: isCheckInOpen(s),
            enrolled: one('SELECT COUNT(*) AS n FROM enrollments WHERE section_id = ?', s.section_id).n })),
        },
        pendingRequests: one("SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ? AND status = 'pending'", t).n,
        trend: trend(u),
        atRisk,
        recentJobs: all('SELECT * FROM jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 5', t).map(serializeJob),
      };
    }

    if (u.role === 'teacher') {
      const today = todaysSessions(u, 'AND sec.teacher_id = ?', u.id);
      const sections = all(
        `SELECT sec.id, sec.name, sec.kind, sec.room, (SELECT COUNT(*) FROM enrollments e WHERE e.section_id = sec.id) AS enrolled
         FROM sections sec WHERE sec.tenant_id = ? AND sec.teacher_id = ? ORDER BY sec.kind, sec.name`,
        t, u.id,
      ).map((s) => ({
        ...s,
        ...summarize(all(
          `SELECT ar.status, COUNT(*) AS n FROM attendance_records ar JOIN sessions se ON se.id = ar.session_id
           WHERE se.section_id = ? AND se.status = 'finalized' GROUP BY ar.status`, s.id,
        )),
      }));
      return {
        role: 'teacher',
        today: today.map((s) => ({
          ...serializeSession(s), counts: countsFor(s.id), live: isCheckInOpen(s),
          enrolled: one('SELECT COUNT(*) AS n FROM enrollments WHERE section_id = ?', s.section_id).n,
        })),
        sections,
        pendingRequests: one("SELECT COUNT(*) AS n FROM requests WHERE tenant_id = ? AND approver_id = ? AND status = 'pending'", t, u.id).n,
      };
    }

    if (u.role === 'student') {
      const today = todaysSessions(u, 'AND s.section_id IN (SELECT section_id FROM enrollments WHERE student_id = ?)', u.id);
      return {
        role: 'student',
        today: today.map((s) => ({
          ...serializeSession(s),
          myStatus: one('SELECT status FROM attendance_records WHERE session_id = ? AND student_id = ?', s.id, u.id)?.status ?? null,
          checkInOpen: isCheckInOpen(s),
        })),
        attendance: summarize(all(
          `SELECT ar.status, COUNT(*) AS n FROM attendance_records ar JOIN sessions s ON s.id = ar.session_id
           WHERE ar.student_id = ? AND s.status = 'finalized' GROUP BY ar.status`, u.id,
        )),
        trend: trend(u, [u.id]),
        pendingRequests: one("SELECT COUNT(*) AS n FROM requests WHERE student_id = ? AND status = 'pending'", u.id).n,
      };
    }

    // parent
    const kids = childIdsOf(u);
    return {
      role: 'parent',
      children: kids.map((id) => {
        const child = one('SELECT id, name, grade_level FROM users WHERE id = ?', id);
        const today = todaysSessions(u, 'AND s.section_id IN (SELECT section_id FROM enrollments WHERE student_id = ?)', id);
        return {
          id: child.id,
          name: child.name,
          gradeLevel: child.grade_level,
          attendance: summarize(all(
            `SELECT ar.status, COUNT(*) AS n FROM attendance_records ar JOIN sessions s ON s.id = ar.session_id
             WHERE ar.student_id = ? AND s.status = 'finalized' GROUP BY ar.status`, id,
          )),
          today: today.map((s) => ({
            ...serializeSession(s),
            status: one('SELECT status FROM attendance_records WHERE session_id = ? AND student_id = ?', s.id, id)?.status ?? null,
            live: isCheckInOpen(s),
          })),
          recent: all(
            `SELECT ar.status, s.starts_at, sec.name AS section_name FROM attendance_records ar JOIN sessions s ON s.id = ar.session_id
             JOIN sections sec ON sec.id = s.section_id WHERE ar.student_id = ? AND ar.status != 'present' ORDER BY s.starts_at DESC LIMIT 5`, id,
          ).map((r) => ({ status: r.status, startsAt: r.starts_at, sectionName: r.section_name })),
        };
      }),
      pendingRequests: one("SELECT COUNT(*) AS n FROM requests WHERE requester_id = ? AND status = 'pending'", u.id).n,
    };
  });

  // Public, unauthenticated configuration for the login screen.
  router.get('/api/config', () => {
    const out = { appName: config.appName, demoMode: config.demoMode };
    if (config.demoMode) {
      out.demo = {
        password: 'orbit123',
        tenants: all('SELECT id, slug, name FROM tenants ORDER BY name').map((tn) => ({
          slug: tn.slug,
          name: tn.name,
          accounts: ['admin', 'teacher', 'student', 'parent'].map((role) => one(
            `SELECT name, email, role FROM users WHERE tenant_id = ? AND role = ? AND status = 'active' AND password_hash IS NOT NULL ORDER BY created_at, rowid LIMIT 1`,
            tn.id, role,
          )).filter(Boolean),
        })),
      };
    }
    return out;
  });

  router.get('/api/health', () => ({ ok: true, time: new Date().toISOString() }));
}
