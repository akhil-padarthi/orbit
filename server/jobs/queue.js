import { config } from '../config.js';
import { one, run, newId, nowIso, parseJson } from '../db/database.js';
import { publishToUsers } from '../realtime/hub.js';
import { logger } from '../lib/logger.js';

/**
 * Durable, database-backed job queue.
 * - Jobs survive restarts (stored in SQLite); stale "running" jobs are re-queued on boot.
 * - Atomic claim with UPDATE … RETURNING so two workers never run the same job.
 * - Failed jobs retry with exponential backoff up to max_attempts.
 * - Every state change is pushed over WebSocket as `job.updated` to the user who started it.
 */

const handlers = new Map();
let timer = null;
let running = false;
let stopped = true;

export function registerHandler(type, fn, { onFinalFailure } = {}) {
  handlers.set(type, { fn, onFinalFailure });
}

export function serializeJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    payload: parseJson(job.payload, {}),
    result: parseJson(job.result),
    progress: job.progress,
    lastError: job.last_error,
    runAt: job.run_at,
    createdBy: job.created_by,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

function broadcast(job) {
  if (job.created_by) publishToUsers([job.created_by], 'job.updated', serializeJob(job));
}

export function enqueue({ tenantId, type, payload = {}, createdBy = null, maxAttempts = 3, delayMs = 0 }) {
  if (!handlers.has(type)) throw new Error(`No handler registered for job type ${type}`);
  const now = nowIso();
  const id = newId();
  run(
    `INSERT INTO jobs (id, tenant_id, type, payload, status, attempts, max_attempts, run_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
    id, tenantId, type, JSON.stringify(payload), maxAttempts, new Date(Date.now() + delayMs).toISOString(), createdBy, now, now,
  );
  const job = one('SELECT * FROM jobs WHERE id = ?', id);
  broadcast(job);
  queueMicrotask(() => kick());
  return job;
}

function claimNext() {
  const now = nowIso();
  return one(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = ?, updated_at = ?
     WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at, created_at LIMIT 1)
     RETURNING *`,
    now, now, now,
  );
}

async function runJob(job) {
  const handler = handlers.get(job.type);
  const helpers = {
    tenantId: job.tenant_id,
    payload: parseJson(job.payload, {}),
    progress(message) {
      run('UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?', message, nowIso(), job.id);
      broadcast(one('SELECT * FROM jobs WHERE id = ?', job.id));
    },
  };
  try {
    if (!handler) throw new Error(`No handler for ${job.type}`);
    const result = await handler.fn(job, helpers);
    run(
      `UPDATE jobs SET status = 'succeeded', result = ?, last_error = NULL, locked_at = NULL, updated_at = ? WHERE id = ?`,
      JSON.stringify(result ?? {}), nowIso(), job.id,
    );
  } catch (err) {
    const message = err?.message ?? String(err);
    const final = job.attempts >= job.max_attempts || err?.permanent === true;
    if (final) {
      run(`UPDATE jobs SET status = 'failed', last_error = ?, locked_at = NULL, updated_at = ? WHERE id = ?`, message, nowIso(), job.id);
      logger.warn('Job failed permanently', { id: job.id, type: job.type, error: message });
      try {
        await handler?.onFinalFailure?.(job, err, helpers);
      } catch (hookErr) {
        logger.error('onFinalFailure hook threw', { error: hookErr.message });
      }
    } else {
      const backoff = config.jobs.baseBackoffMs * 2 ** (job.attempts - 1);
      run(
        `UPDATE jobs SET status = 'queued', last_error = ?, run_at = ?, locked_at = NULL, updated_at = ? WHERE id = ?`,
        message, new Date(Date.now() + backoff).toISOString(), nowIso(), job.id,
      );
      logger.info('Job will retry', { id: job.id, type: job.type, attempt: job.attempts, backoffMs: backoff });
    }
  }
  broadcast(one('SELECT * FROM jobs WHERE id = ?', job.id));
}

/** Process every job that is currently due. */
export async function kick() {
  if (running || stopped) return;
  running = true;
  try {
    let job;
    while (!stopped && (job = claimNext())) await runJob(job);
  } finally {
    running = false;
  }
}

export function startWorker() {
  stopped = false;
  // Recover jobs that were mid-flight when the process died.
  run(
    `UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = ? WHERE status = 'running' AND locked_at < ?`,
    nowIso(), new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  );
  timer = setInterval(() => kick(), config.jobs.pollMs);
  timer.unref();
  kick();
}

export async function stopWorker() {
  stopped = true;
  clearInterval(timer);
  while (running) await new Promise((r) => setTimeout(r, 10));
}

/** Mark a job as permanently failing (no retries), e.g. for validation errors. */
export class PermanentJobError extends Error {
  constructor(message) {
    super(message);
    this.permanent = true;
  }
}
