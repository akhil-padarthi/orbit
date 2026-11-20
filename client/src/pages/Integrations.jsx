import { useState } from 'react';
import { api } from '../api.js';
import { useApp, useApi, useEvent, timeAgo } from '../context.jsx';
import { Button, ErrorNote, Field, JobStatus, Loading, Pill } from '../ui.jsx';

const INFO = {
  sis: { title: 'Student information system', provider: 'OneRoster 1.1', blurb: 'Imports students, teachers, families, classes and enrollments. Runs as a full sync: people who leave are deactivated.' },
  lms: { title: 'Learning management system', provider: 'Canvas LMS', blurb: 'Links classes to Canvas courses and posts each student’s attendance rate to an “Attendance” assignment.' },
};

export function Integrations() {
  const { data, error, loading, reload } = useApi('/api/integrations');
  useEvent('job.updated', (j) => (j.status === 'succeeded' || j.status === 'failed') && reload());
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Integrations</h1>
          <p className="muted">Syncs run in the background. You can leave this page — you’ll get a notification when they finish.</p>
        </div>
      </header>
      <ErrorNote error={error} />
      {loading && !data ? <Loading /> : null}
      <div className="stack">
        {data?.integrations.map((i) => <IntegrationPanel key={i.id} integration={i} onChange={reload} />)}
      </div>
    </div>
  );
}

function IntegrationPanel({ integration: i, onChange }) {
  const { toast } = useApp();
  const info = INFO[i.kind];
  const [job, setJob] = useState(i.recentJobs.find((j) => j.status === 'queued' || j.status === 'running') ?? null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ baseUrl: i.baseUrl, clientId: i.clientId, clientSecret: '' });
  const sections = useApi(i.kind === 'lms' ? '/api/sections' : null);
  const [pushSection, setPushSection] = useState('');

  async function sync() {
    setError(null);
    try {
      const res = await api(`/api/integrations/${i.kind}/sync`, { method: 'POST', body: {} });
      setJob(res.job);
    } catch (err) {
      setError(err);
      if (err.details?.job) setJob(err.details.job);
    }
  }
  async function save(e) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/integrations/${i.kind}`, { method: 'PATCH', body: { baseUrl: form.baseUrl, clientId: form.clientId, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}) } });
      setEditing(false);
      toast('Connection saved', 'success');
      onChange();
    } catch (err) {
      setError(err);
    }
  }
  async function toggle() {
    await api(`/api/integrations/${i.kind}`, { method: 'PATCH', body: { enabled: !i.enabled } }).catch(setError);
    onChange();
  }
  async function pushGrades() {
    setError(null);
    try {
      const res = await api('/api/integrations/lms/push-attendance', { method: 'POST', body: { sectionId: pushSection } });
      setJob(res.job);
    } catch (err) {
      setError(err);
    }
  }

  const s = i.lastSummary;
  return (
    <section className="panel integration" data-testid={`integration-${i.kind}`}>
      <div className="panel-head">
        <div>
          <h2>{info.title}</h2>
          <p className="muted small">{info.provider}, {i.baseUrl.startsWith('/') ? 'bundled demo server' : i.baseUrl}</p>
        </div>
        <span className="int-state">
          {i.lastStatus === 'ok' ? <Pill tone="green">Last sync OK</Pill> : i.lastStatus === 'error' ? <Pill tone="red">Last sync failed</Pill> : <Pill>Never synced</Pill>}
          {i.enabled ? null : <Pill tone="neutral">Paused</Pill>}
        </span>
      </div>
      <p>{info.blurb}</p>

      {s && !s.error ? (
        <p className="int-summary">
          {i.kind === 'sis'
            ? `Last run ${timeAgo(i.lastSyncedAt)}: ${s.users.created} people added, ${s.users.updated} updated, ${s.users.deactivated} deactivated, ${s.sections.created} classes added, ${s.enrollments.added} enrollments added and ${s.enrollments.removed} removed.`
            : `Last run ${timeAgo(i.lastSyncedAt)}: ${s.coursesLinked} courses and ${s.usersLinked} people linked, ${s.coursesUnmatched} courses without a matching class.`}
        </p>
      ) : null}
      {s?.error ? <p className="error-note">{s.error}</p> : null}

      <div className="row-actions">
        <Button variant="primary" onClick={sync} disabled={!i.enabled || job?.status === 'running' || job?.status === 'queued'}>Sync now</Button>
        <Button onClick={() => setEditing((e) => !e)}>{editing ? 'Close settings' : 'Connection settings'}</Button>
        <Button onClick={toggle}>{i.enabled ? 'Pause' : 'Resume'}</Button>
      </div>
      {job ? <JobStatus job={job} onDone={(j) => { toast(j.status === 'succeeded' ? `${i.kind.toUpperCase()} sync finished` : `${i.kind.toUpperCase()} sync failed`, j.status === 'succeeded' ? 'success' : 'error'); onChange(); }} /> : null}
      <ErrorNote error={error} />

      {i.kind === 'lms' ? (
        <div className="push">
          <Field label="Post attendance grades for">
            <select value={pushSection} onChange={(e) => setPushSection(e.target.value)}>
              <option value="">Choose a class…</option>
              {(sections.data?.sections ?? []).filter((x) => x.lmsCourseId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </Field>
          <Button onClick={pushGrades} disabled={!pushSection || !i.enabled}>Post to Canvas</Button>
        </div>
      ) : null}

      {editing ? (
        <form className="form-stack settings" onSubmit={save}>
          <Field label="Base URL" hint="For a real SIS or Canvas, use its https address."><input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} required /></Field>
          <div className="row-2">
            <Field label="Client ID"><input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} required /></Field>
            <Field label="Client secret" hint={`Saved: ${i.clientSecretHint ?? 'none'}`}><input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} placeholder="Leave blank to keep" /></Field>
          </div>
          <Button variant="primary" type="submit">Save connection</Button>
        </form>
      ) : null}

      {i.recentJobs.length ? (
        <details className="history">
          <summary>Recent runs</summary>
          <ul className="plain-list">
            {i.recentJobs.map((j) => (
              <li key={j.id}>
                <span className={`job-dot ${j.status}`} /> {j.type === 'lms.pushAttendance' ? 'Grade passback' : 'Sync'}: {j.status}
                <span className="muted"> {timeAgo(j.createdAt)}{j.attempts > 1 ? `, ${j.attempts} attempts` : ''}{j.lastError && j.status === 'failed' ? `, ${j.lastError}` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
