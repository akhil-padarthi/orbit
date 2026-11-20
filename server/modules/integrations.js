import { all, one, run, nowIso, parseJson } from '../db/database.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { notFound, conflict, forbidden } from '../lib/http.js';
import { validate, z } from '../lib/validate.js';
import { enqueue, registerHandler, serializeJob, PermanentJobError } from '../jobs/queue.js';
import { syncOneRoster } from '../integrations/oneroster.js';
import { syncCanvas, pushAttendanceToCanvas } from '../integrations/canvas.js';
import { notify } from './notifications.js';
import { loadSectionFor } from '../lib/rbac.js';

const JOB_FOR_KIND = { sis: 'sis.sync', lms: 'lms.sync' };

function serializeIntegration(i) {
  const recentJobs = all(
    `SELECT * FROM jobs WHERE tenant_id = ? AND type IN (?, ?) ORDER BY created_at DESC LIMIT 5`,
    i.tenant_id, JOB_FOR_KIND[i.kind], i.kind === 'lms' ? 'lms.pushAttendance' : '-',
  ).map(serializeJob);
  return {
    id: i.id,
    kind: i.kind,
    provider: i.provider,
    baseUrl: i.base_url,
    clientId: i.client_id,
    clientSecretSet: Boolean(i.client_secret),
    clientSecretHint: i.client_secret ? `••••${i.client_secret.slice(-4)}` : null,
    enabled: Boolean(i.enabled),
    lastSyncedAt: i.last_synced_at,
    lastStatus: i.last_status,
    lastSummary: parseJson(i.last_summary),
    recentJobs,
  };
}

const getIntegration = (tenantId, kind) => one('SELECT * FROM integrations WHERE tenant_id = ? AND kind = ?', tenantId, kind);

function activeJob(tenantId, type) {
  return one(`SELECT * FROM jobs WHERE tenant_id = ? AND type = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`, tenantId, type);
}

export function registerIntegrationRoutes(router) {
  router.use('/api/integrations', (r) => {
    r.get('', (ctx) => ({
      integrations: all('SELECT * FROM integrations WHERE tenant_id = ? ORDER BY kind DESC', ctx.user.tenantId).map(serializeIntegration),
    }));

    r.patch('/:kind', (ctx) => {
      const i = getIntegration(ctx.user.tenantId, ctx.params.kind);
      if (!i) throw notFound('Integration');
      const input = validate(z.object({
        baseUrl: z.string().trim().min(1).refine((v) => v.startsWith('/') || /^https?:\/\//.test(v), 'Must be an http(s) URL').optional(),
        clientId: z.string().trim().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
      }), ctx.body);
      run(
        'UPDATE integrations SET base_url = ?, client_id = ?, client_secret = ?, enabled = ? WHERE id = ?',
        input.baseUrl ?? i.base_url, input.clientId ?? i.client_id, input.clientSecret ?? i.client_secret,
        input.enabled === undefined ? i.enabled : input.enabled ? 1 : 0, i.id,
      );
      return { integration: serializeIntegration(getIntegration(ctx.user.tenantId, ctx.params.kind)) };
    });

    // Long-running sync → 202 Accepted with a job the client can watch (WebSocket or polling).
    r.post('/:kind/sync', (ctx) => {
      const i = getIntegration(ctx.user.tenantId, ctx.params.kind);
      if (!i) throw notFound('Integration');
      if (!i.enabled) throw conflict('Integration is disabled');
      const type = JOB_FOR_KIND[i.kind];
      const running = activeJob(ctx.user.tenantId, type);
      if (running) throw conflict('A sync is already in progress', { job: serializeJob(running) });
      const job = enqueue({ tenantId: ctx.user.tenantId, type, payload: { integrationId: i.id }, createdBy: ctx.user.id });
      ctx.status = 202;
      ctx.headers.Location = `/api/jobs/${job.id}`;
      return { job: serializeJob(job) };
    });

    r.post('/lms/push-attendance', (ctx) => {
      const { sectionId } = validate(z.object({ sectionId: z.string().min(1) }), ctx.body);
      loadSectionFor(ctx.user, sectionId, 'manage');
      const i = getIntegration(ctx.user.tenantId, 'lms');
      if (!i?.enabled) throw conflict('LMS integration is not enabled');
      const job = enqueue({ tenantId: ctx.user.tenantId, type: 'lms.pushAttendance', payload: { sectionId }, createdBy: ctx.user.id });
      ctx.status = 202;
      return { job: serializeJob(job) };
    });
  }, authenticate, requirePermission('integrations.manage'));

  router.use('/api/jobs', (r) => {
    r.get('', requirePermission('jobs.view'), (ctx) => ({
      jobs: all('SELECT * FROM jobs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50', ctx.user.tenantId).map(serializeJob),
    }));
    r.get('/:id', (ctx) => {
      const job = one('SELECT * FROM jobs WHERE id = ? AND tenant_id = ?', ctx.params.id, ctx.user.tenantId);
      if (!job) throw notFound('Job');
      if (ctx.user.role !== 'admin' && job.created_by !== ctx.user.id) throw forbidden('You cannot view this job');
      return { job: serializeJob(job) };
    });
  }, authenticate);
}

// ---------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------

function loadEnabledIntegration(tenantId, kind) {
  const i = getIntegration(tenantId, kind);
  if (!i) throw new PermanentJobError('Integration not configured');
  if (!i.enabled) throw new PermanentJobError('Integration is disabled');
  return i;
}

function recordOutcome(i, status, summary) {
  run('UPDATE integrations SET last_synced_at = ?, last_status = ?, last_summary = ? WHERE id = ?', nowIso(), status, JSON.stringify(summary), i.id);
}

function syncHandler(kind, fn, label) {
  registerHandler(
    JOB_FOR_KIND[kind],
    async (job, helpers) => {
      const i = loadEnabledIntegration(job.tenant_id, kind);
      const summary = await fn(i, helpers);
      recordOutcome(i, 'ok', summary);
      notify(job.tenant_id, [job.created_by], { kind: 'integration', title: `${label} sync finished`, body: describe(kind, summary), link: '/integrations' });
      return summary;
    },
    {
      onFinalFailure: (job, err) => {
        const i = getIntegration(job.tenant_id, kind);
        if (i) recordOutcome(i, 'error', { error: err.message });
        notify(job.tenant_id, [job.created_by], { kind: 'integration', title: `${label} sync failed`, body: err.message, link: '/integrations' });
      },
    },
  );
}

function describe(kind, s) {
  if (kind === 'sis') {
    return `Users: ${s.users.created} new, ${s.users.updated} updated, ${s.users.deactivated} deactivated. Sections: ${s.sections.created} new. Enrollments: +${s.enrollments.added}/−${s.enrollments.removed}.`;
  }
  return `${s.coursesLinked} courses and ${s.usersLinked} people linked.`;
}

syncHandler('sis', syncOneRoster, 'SIS');
syncHandler('lms', syncCanvas, 'LMS');

registerHandler('lms.pushAttendance', async (job, helpers) => {
  const i = loadEnabledIntegration(job.tenant_id, 'lms');
  return pushAttendanceToCanvas(i, helpers.payload.sectionId, helpers);
});

/** Follow-up work after a teacher finalizes a session. */
registerHandler('attendance.finalized', async (job, { payload }) => {
  const session = one(
    `SELECT s.*, sec.name AS section_name, sec.lms_course_id, t.timezone FROM sessions s
     JOIN sections sec ON sec.id = s.section_id JOIN tenants t ON t.id = s.tenant_id WHERE s.id = ?`,
    payload.sessionId,
  );
  if (!session) throw new PermanentJobError('Session not found');
  const when = new Intl.DateTimeFormat('en-US', { timeZone: session.timezone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(session.starts_at));

  const flagged = all(
    `SELECT ar.student_id, ar.status, u.name FROM attendance_records ar JOIN users u ON u.id = ar.student_id
     WHERE ar.session_id = ? AND ar.status IN ('absent','late')`,
    session.id,
  );
  let guardiansNotified = 0;
  for (const f of flagged) {
    const guardians = all('SELECT parent_id FROM guardianships WHERE student_id = ?', f.student_id).map((g) => g.parent_id);
    notify(job.tenant_id, guardians, {
      kind: 'attendance',
      title: `${f.name} was marked ${f.status}`,
      body: `${session.section_name} · ${when}`,
      link: '/attendance',
    });
    guardiansNotified += guardians.length;
  }

  let lmsJobId = null;
  const lms = getIntegration(job.tenant_id, 'lms');
  if (lms?.enabled && session.lms_course_id) {
    lmsJobId = enqueue({ tenantId: job.tenant_id, type: 'lms.pushAttendance', payload: { sectionId: session.section_id }, createdBy: job.created_by }).id;
  }
  return { flagged: flagged.length, guardiansNotified, lmsJobId };
});
