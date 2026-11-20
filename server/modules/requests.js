import { all, one, run, newId, nowIso, tx, parseJson } from '../db/database.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { REQUEST_TYPES_BY_ROLE, childIdsOf, loadSectionFor } from '../lib/rbac.js';
import { notFound, conflict, forbidden, badRequest } from '../lib/http.js';
import { validate, z, isoDate } from '../lib/validate.js';
import { publishToUsers } from '../realtime/hub.js';
import { enqueue, serializeJob, registerHandler, PermanentJobError } from '../jobs/queue.js';
import { notify } from './notifications.js';
import { dayRangeUtc, localDate, addDays } from '../lib/time.js';
import { ensureSectionConversation } from './messages.js';
import { upsertRecord, broadcastAttendance } from './attendance.js';
import { getSession } from './schedule.js';

/**
 * Asynchronous request workflow
 *
 *   pending ──approve──▶ approved ──(background job)──▶ completed
 *      │                                   └──────────▶ failed   (e.g. flex block filled up meanwhile)
 *      ├──deny────▶ denied
 *      └──cancel──▶ cancelled (by requester)
 *
 * Types
 *   session_join    student asks to join a flex block → decided by that block's teacher (or an admin)
 *   absence_excuse  guardian excuses their child for a day → decided by an admin (attendance office)
 *
 * Every transition is written to request_events (audit trail) and pushed live to everyone involved.
 */

const REQUEST_SELECT = `
  SELECT r.*, rq.name AS requester_name, rq.role AS requester_role, st.name AS student_name,
         ap.name AS approver_name, sec.name AS section_name
  FROM requests r
  JOIN users rq ON rq.id = r.requester_id
  JOIN users st ON st.id = r.student_id
  LEFT JOIN users ap ON ap.id = r.approver_id
  LEFT JOIN sections sec ON sec.id = r.section_id`;

export function serializeRequest(r, withEvents = false) {
  const out = {
    id: r.id,
    type: r.type,
    status: r.status,
    requesterId: r.requester_id,
    requesterName: r.requester_name,
    requesterRole: r.requester_role,
    studentId: r.student_id,
    studentName: r.student_name,
    sectionId: r.section_id,
    sectionName: r.section_name,
    approverId: r.approver_id,
    approverName: r.approver_name,
    reason: r.reason,
    decisionNote: r.decision_note,
    data: parseJson(r.data, {}),
    jobId: r.job_id,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (withEvents) {
    out.events = all(
      `SELECT e.*, u.name AS actor_name FROM request_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.request_id = ? ORDER BY e.created_at, e.rowid`,
      r.id,
    ).map((e) => ({ id: e.id, event: e.event, note: e.note, actorId: e.actor_id, actorName: e.actor_name, createdAt: e.created_at }));
  }
  return out;
}

const loadRequest = (tenantId, id) => one(`${REQUEST_SELECT} WHERE r.id = ? AND r.tenant_id = ?`, id, tenantId);

function addEvent(r, actorId, event, note = null) {
  run(`INSERT INTO request_events (id, tenant_id, request_id, actor_id, event, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId(), r.tenant_id, r.id, actorId, event, note, nowIso());
}

/** Everyone who should see live updates for a request. */
function stakeholders(r) {
  const guardians = all('SELECT parent_id FROM guardianships WHERE student_id = ?', r.student_id).map((g) => g.parent_id);
  const admins = r.approver_id ? [] : all("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'", r.tenant_id).map((a) => a.id);
  return [r.requester_id, r.student_id, r.approver_id, ...guardians, ...admins];
}

function broadcastRequest(id, tenantId) {
  const r = loadRequest(tenantId, id);
  publishToUsers(stakeholders(r), 'request.updated', serializeRequest(r));
  return r;
}

function canDecide(user, r) {
  if (user.role === 'admin') return true;
  return user.role === 'teacher' && r.approver_id === user.id;
}

function canView(user, r) {
  if (user.role === 'admin') return true;
  if (r.requester_id === user.id || r.student_id === user.id || r.approver_id === user.id) return true;
  if (user.role === 'parent') return childIdsOf(user).includes(r.student_id);
  return false;
}

const createSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session_join'), sectionId: z.string().min(1), reason: z.string().trim().min(3).max(500) }),
  z.object({ type: z.literal('absence_excuse'), studentId: z.string().min(1), date: isoDate, reason: z.string().trim().min(3).max(500) }),
]);

export function registerRequestRoutes(router) {
  router.use('/api/requests', (r) => {
    r.get('', (ctx) => {
      const u = ctx.user;
      const params = [u.tenantId];
      let where = 'r.tenant_id = ?';
      const scope = ctx.query.scope ?? 'all';
      if (u.role === 'teacher') {
        where += ' AND r.approver_id = ?';
        params.push(u.id);
      } else if (u.role === 'student') {
        where += ' AND (r.requester_id = ? OR r.student_id = ?)';
        params.push(u.id, u.id);
      } else if (u.role === 'parent') {
        const kids = childIdsOf(u);
        where += ` AND (r.requester_id = ? OR r.student_id IN (${kids.length ? kids.map(() => '?').join(',') : "''"}))`;
        params.push(u.id, ...kids);
      }
      if (scope === 'to_decide') {
        if (u.role === 'admin') where += " AND r.status = 'pending'";
        else if (u.role === 'teacher') where += " AND r.status = 'pending'";
        else return { requests: [] };
      }
      if (ctx.query.status) {
        where += ' AND r.status = ?';
        params.push(ctx.query.status);
      }
      const rows = all(`${REQUEST_SELECT} WHERE ${where} ORDER BY r.created_at DESC LIMIT 200`, ...params);
      return { requests: rows.map((x) => serializeRequest(x)) };
    });

    r.get('/:id', (ctx) => {
      const req = loadRequest(ctx.user.tenantId, ctx.params.id);
      if (!req) throw notFound('Request');
      if (!canView(ctx.user, req)) throw forbidden('You cannot view this request');
      return { request: serializeRequest(req, true), canDecide: req.status === 'pending' && canDecide(ctx.user, req) };
    });

    r.post('', requirePermission('requests.create'), (ctx) => {
      const u = ctx.user;
      const input = validate(createSchema, ctx.body);
      if (!REQUEST_TYPES_BY_ROLE[u.role].includes(input.type)) throw forbidden(`Your role cannot create ${input.type} requests`);

      let row;
      if (input.type === 'session_join') {
        const section = loadSectionFor(u, input.sectionId, 'read');
        if (section.kind !== 'flex') throw badRequest('You can only request to join flex blocks');
        if (one('SELECT 1 AS x FROM enrollments WHERE section_id = ? AND student_id = ?', section.id, u.id)) throw conflict('You are already in this block');
        if (one("SELECT 1 AS x FROM requests WHERE student_id = ? AND section_id = ? AND status = 'pending'", u.id, section.id)) {
          throw conflict('You already have a pending request for this block');
        }
        if (section.capacity && one('SELECT COUNT(*) AS n FROM enrollments WHERE section_id = ?', section.id).n >= section.capacity) {
          throw conflict('This block is full');
        }
        row = { type: input.type, studentId: u.id, sectionId: section.id, approverId: section.teacher_id, data: {} };
      } else {
        if (!childIdsOf(u).includes(input.studentId)) throw forbidden('You can only excuse your own children');
        const today = localDate(new Date(), u.timezone);
        if (input.date < addDays(today, -30)) throw badRequest('Excuses must be submitted within 30 days');
        if (one("SELECT 1 AS x FROM requests WHERE student_id = ? AND type = 'absence_excuse' AND status IN ('pending','approved','completed') AND json_extract(data, '$.date') = ?", input.studentId, input.date)) {
          throw conflict('There is already an excuse for that day');
        }
        row = { type: input.type, studentId: input.studentId, sectionId: null, approverId: null, data: { date: input.date } };
      }

      const id = newId();
      const now = nowIso();
      tx(() => {
        run(
          `INSERT INTO requests (id, tenant_id, type, status, requester_id, student_id, section_id, approver_id, reason, data, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, u.tenantId, row.type, u.id, row.studentId, row.sectionId, row.approverId, input.reason, JSON.stringify(row.data), now, now,
        );
        addEvent({ id, tenant_id: u.tenantId }, u.id, 'created');
      });
      const created = broadcastRequest(id, u.tenantId);
      const deciders = created.approver_id ? [created.approver_id] : all("SELECT id FROM users WHERE tenant_id = ? AND role = 'admin'", u.tenantId).map((a) => a.id);
      notify(u.tenantId, deciders, {
        kind: 'request',
        title: row.type === 'session_join' ? `${u.name} wants to join ${created.section_name}` : `Absence excuse for ${created.student_name}`,
        body: input.reason,
        link: '/requests',
      });
      ctx.status = 201;
      return { request: serializeRequest(created, true) };
    });

    r.post('/:id/decision', requirePermission('requests.decide'), (ctx) => {
      const { decision, note } = validate(z.object({ decision: z.enum(['approve', 'deny']), note: z.string().trim().max(500).optional() }), ctx.body);
      const req = loadRequest(ctx.user.tenantId, ctx.params.id);
      if (!req) throw notFound('Request');
      if (!canDecide(ctx.user, req)) throw forbidden('You are not the approver for this request');
      if (req.status !== 'pending') throw conflict(`Request is already ${req.status}`);

      const now = nowIso();
      if (decision === 'deny') {
        tx(() => {
          run(`UPDATE requests SET status = 'denied', approver_id = ?, decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
            ctx.user.id, note ?? null, now, now, req.id);
          addEvent(req, ctx.user.id, 'denied', note ?? null);
        });
        const updated = broadcastRequest(req.id, ctx.user.tenantId);
        notify(ctx.user.tenantId, [req.requester_id], { kind: 'request', title: 'Request denied', body: note ?? `${ctx.user.name} denied your request.`, link: '/requests' });
        return { request: serializeRequest(updated, true) };
      }

      // Approve: record the decision now, apply the effect in the background.
      const job = tx(() => {
        run(`UPDATE requests SET status = 'approved', approver_id = ?, decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
          ctx.user.id, note ?? null, now, now, req.id);
        addEvent(req, ctx.user.id, 'approved', note ?? null);
        const j = enqueue({ tenantId: ctx.user.tenantId, type: 'request.apply', payload: { requestId: req.id }, createdBy: ctx.user.id });
        run('UPDATE requests SET job_id = ? WHERE id = ?', j.id, req.id);
        return j;
      });
      const updated = broadcastRequest(req.id, ctx.user.tenantId);
      ctx.status = 202;
      return { request: serializeRequest(updated, true), job: serializeJob(job) };
    });

    r.post('/:id/cancel', (ctx) => {
      const req = loadRequest(ctx.user.tenantId, ctx.params.id);
      if (!req) throw notFound('Request');
      if (req.requester_id !== ctx.user.id) throw forbidden('Only the requester can cancel');
      if (req.status !== 'pending') throw conflict(`Request is already ${req.status}`);
      tx(() => {
        run(`UPDATE requests SET status = 'cancelled', updated_at = ? WHERE id = ?`, nowIso(), req.id);
        addEvent(req, ctx.user.id, 'cancelled');
      });
      return { request: serializeRequest(broadcastRequest(req.id, ctx.user.tenantId), true) };
    });
  }, authenticate);
}

// ---------------------------------------------------------------------------
// Background job: apply an approved request
// ---------------------------------------------------------------------------

function finish(req, status, note) {
  tx(() => {
    run('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), req.id);
    addEvent(req, null, status, note);
  });
  broadcastRequest(req.id, req.tenant_id);
  notify(req.tenant_id, [req.requester_id, req.student_id], {
    kind: 'request',
    title: status === 'completed' ? 'Request approved' : 'Request could not be completed',
    body: note,
    link: '/requests',
  });
}

registerHandler(
  'request.apply',
  async (job, { payload }) => {
    const req = one('SELECT r.*, sec.name AS section_name, sec.capacity FROM requests r LEFT JOIN sections sec ON sec.id = r.section_id WHERE r.id = ?', payload.requestId);
    if (!req) throw new PermanentJobError('Request no longer exists');
    if (req.status !== 'approved') return { skipped: true, reason: `status is ${req.status}` };

    if (req.type === 'session_join') {
      const already = one('SELECT 1 AS x FROM enrollments WHERE section_id = ? AND student_id = ?', req.section_id, req.student_id);
      if (!already) {
        const count = one('SELECT COUNT(*) AS n FROM enrollments WHERE section_id = ?', req.section_id).n;
        if (req.capacity && count >= req.capacity) throw new PermanentJobError(`${req.section_name} is full`);
        run(`INSERT INTO enrollments (tenant_id, section_id, student_id, source, created_at) VALUES (?, ?, ?, 'request', ?)`,
          req.tenant_id, req.section_id, req.student_id, nowIso());
        ensureSectionConversation(req.tenant_id, req.section_id);
      }
      finish(req, 'completed', `Enrolled in ${req.section_name}`);
      return { enrolled: true, sectionId: req.section_id };
    }

    if (req.type === 'absence_excuse') {
      const { date } = parseJson(req.data, {});
      const tz = one('SELECT timezone FROM tenants WHERE id = ?', req.tenant_id).timezone;
      const { start, end } = dayRangeUtc(date, tz);
      const sessions = all(
        `SELECT s.id FROM sessions s JOIN enrollments e ON e.section_id = s.section_id
         WHERE s.tenant_id = ? AND e.student_id = ? AND s.status != 'cancelled' AND s.starts_at >= ? AND s.starts_at < ?`,
        req.tenant_id, req.student_id, start, end,
      );
      let excused = 0;
      for (const { id } of sessions) {
        const existing = one('SELECT status FROM attendance_records WHERE session_id = ? AND student_id = ?', id, req.student_id);
        if (existing && (existing.status === 'present' || existing.status === 'late')) continue; // never overwrite real attendance
        const recordId = upsertRecord({ tenantId: req.tenant_id, sessionId: id, studentId: req.student_id, status: 'excused', method: 'request', recordedBy: req.approver_id, note: 'Excused via request' });
        broadcastAttendance(getSession(req.tenant_id, id), recordId);
        excused++;
      }
      finish(req, 'completed', `${excused} class${excused === 1 ? '' : 'es'} marked excused for ${date}`);
      return { excused, date };
    }
    throw new PermanentJobError(`Unknown request type ${req.type}`);
  },
  {
    onFinalFailure: (job, err) => {
      const req = one('SELECT * FROM requests WHERE id = ?', JSON.parse(job.payload).requestId);
      if (req && req.status === 'approved') finish(req, 'failed', err.message);
    },
  },
);
