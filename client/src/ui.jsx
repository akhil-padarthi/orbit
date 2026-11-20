import { useEffect, useState } from 'react';
import { useApp, STATUS_LABEL } from './context.jsx';
import { api } from './api.js';

export function Link({ to, children, className, ...rest }) {
  const { navigate } = useApp();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

export function Button({ variant = 'default', busy, children, className = '', ...rest }) {
  return (
    <button className={`btn btn-${variant} ${className}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function Status({ status, small }) {
  if (!status) return <span className={`status status-none${small ? ' small' : ''}`}>Not yet</span>;
  return <span className={`status status-${status}${small ? ' small' : ''}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function Pill({ tone = 'neutral', children }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Avatar({ name, online, size = 32 }) {
  const initials = (name ?? '?').split(' ').map((p) => p[0]).slice(0, 2).join('');
  let hash = 0;
  for (const ch of name ?? '') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = [158, 205, 25, 280, 340, 45][hash % 6];
  return (
    <span className="avatar" style={{ width: size, height: size, '--hue': hue, fontSize: size * 0.4 }} aria-hidden="true">
      {initials}
      {online !== undefined ? <i className={online ? 'presence on' : 'presence'} /> : null}
    </span>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="muted">{children}</p> : null}
      {action}
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <div className="error-note" role="alert">
      {error.message ?? String(error)}
      {error.details?.conflicts?.length ? (
        <ul>
          {error.details.conflicts.slice(0, 5).map((c, i) => (
            <li key={i}>{c.with ? `${c.date}: clashes with ${c.with.map((w) => w.sectionName).join(', ')}` : `${c.sectionName} (${c.reason})`}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/** Tracks a background job live and renders its state. */
export function JobStatus({ job: initial, onDone }) {
  const { realtime } = useApp();
  const [job, setJob] = useState(initial);
  useEffect(() => {
    setJob(initial);
  }, [initial?.id]);
  useEffect(() => {
    if (!initial) return;
    let settled = false;
    const update = (j) => {
      if (settled || j.id !== initial.id) return;
      setJob(j);
      if (j.status === 'succeeded' || j.status === 'failed') {
        settled = true;
        onDone?.(j);
      }
    };
    const off = realtime?.on('job.updated', update);
    // The job may finish before we subscribe, or the socket may be reconnecting: also poll.
    const poll = async () => {
      try {
        const { job: j } = await api(`/api/jobs/${initial.id}`);
        update(j);
      } catch {
        /* ignore */
      }
    };
    poll();
    const timer = setInterval(() => !settled && poll(), 2000);
    return () => {
      off?.();
      clearInterval(timer);
    };
  }, [realtime, initial?.id]);
  if (!job) return null;
  const label = {
    queued: job.attempts > 0 ? `Retrying (attempt ${job.attempts + 1} of ${job.maxAttempts})…` : 'Queued…',
    running: job.progress ?? 'Working…',
    succeeded: 'Done',
    failed: `Failed: ${job.lastError}`,
  }[job.status];
  return (
    <div className={`job job-${job.status}`} role="status" data-testid="job-status">
      {job.status === 'running' || job.status === 'queued' ? <span className="spinner" aria-hidden="true" /> : null}
      <span>{label}</span>
    </div>
  );
}

export function Meter({ value, tone }) {
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const t = tone ?? (value == null ? 'none' : value >= 95 ? 'good' : value >= 90 ? 'ok' : 'low');
  return (
    <span className={`meter meter-${t}`} aria-hidden="true">
      <span style={{ width: `${v}%` }} />
    </span>
  );
}

export const pct = (rate) => (rate == null ? '—' : `${rate % 1 === 0 ? rate : rate.toFixed(1)}%`);
