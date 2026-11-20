import { useState } from 'react';
import { api } from '../api.js';
import { useApp, useApi, useEvent, useFormat, timeAgo } from '../context.jsx';
import { Button, Empty, ErrorNote, Field, JobStatus, Loading, Modal, Pill } from '../ui.jsx';

const TYPE_LABEL = { session_join: 'Join flex block', absence_excuse: 'Absence excuse' };
const STATUS_TONE = { pending: 'amber', approved: 'blue', completed: 'green', denied: 'red', cancelled: 'neutral', failed: 'red' };
const STATUS_TEXT = { pending: 'Waiting for decision', approved: 'Approved — applying', completed: 'Done', denied: 'Denied', cancelled: 'Cancelled', failed: 'Couldn’t complete' };
const EVENT_TEXT = { created: 'Submitted', approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled', completed: 'Completed', failed: 'Failed' };

export function Requests() {
  const { user } = useApp();
  const deciding = user.role === 'admin' || user.role === 'teacher';
  const [tab, setTab] = useState(deciding ? 'to_decide' : 'all');
  const { data, error, loading, reload, setData } = useApi('/api/requests', { scope: tab });
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  useEvent('request.updated', (r) => {
    setData((d) => {
      if (!d) return d;
      const exists = d.requests.some((x) => x.id === r.id);
      if (tab === 'to_decide' && r.status !== 'pending') return { requests: d.requests.filter((x) => x.id !== r.id) };
      return { requests: exists ? d.requests.map((x) => (x.id === r.id ? r : x)) : [r, ...d.requests] };
    });
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{user.role === 'student' ? 'Flex & requests' : user.role === 'parent' ? 'Absence excuses' : 'Requests'}</h1>
          <p className="muted">
            {user.role === 'student'
              ? 'Ask to join a flex block. Your teacher approves it, then you’re enrolled automatically.'
              : user.role === 'parent'
                ? 'Excuse your child for a day. Once the office approves, every class that day is marked excused.'
                : 'Approve flex-block requests and absence excuses. Approved requests are applied in the background.'}
          </p>
        </div>
        <div className="head-actions">
          {deciding ? (
            <div className="seg" role="tablist">
              <button role="tab" aria-selected={tab === 'to_decide'} className={tab === 'to_decide' ? 'on' : ''} onClick={() => setTab('to_decide')}>Needs your decision</button>
              <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? 'on' : ''} onClick={() => setTab('all')}>All</button>
            </div>
          ) : (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {user.role === 'student' ? 'Request a flex block' : 'Excuse an absence'}
            </Button>
          )}
        </div>
      </header>

      {user.role === 'student' ? <FlexBlocks onRequested={reload} /> : null}

      <ErrorNote error={error} />
      {loading && !data ? <Loading /> : null}
      {data && !data.requests.length ? (
        <Empty title={tab === 'to_decide' ? 'Nothing waiting for you.' : 'No requests yet.'}>{tab === 'to_decide' ? 'New requests appear here the moment they’re submitted.' : null}</Empty>
      ) : null}
      {data?.requests.length ? (
        <ul className="requests">
          {data.requests.map((r) => (
            <li key={r.id}>
              <button className="req-row" onClick={() => setOpenId(r.id)} data-testid="request-row">
                <span className="req-main">
                  <span className="req-title">
                    {r.type === 'session_join' ? `${r.studentName} → ${r.sectionName}` : `${r.studentName}, ${r.data.date}`}
                  </span>
                  <span className="muted small">
                    {TYPE_LABEL[r.type]} from {r.requesterName}, {timeAgo(r.createdAt)}
                  </span>
                </span>
                <Pill tone={STATUS_TONE[r.status]}>{STATUS_TEXT[r.status]}</Pill>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {openId ? <RequestDetail id={openId} onClose={() => setOpenId(null)} onChanged={reload} /> : null}
      {creating ? <CreateRequest onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload(); }} /> : null}
    </div>
  );
}

function FlexBlocks({ onRequested }) {
  const { toast } = useApp();
  const { data, reload } = useApi('/api/sections', { kind: 'flex' });
  const [target, setTarget] = useState(null);
  useEvent('request.updated', (r) => r.type === 'session_join' && (r.status === 'completed' || r.status === 'failed') && reload());
  if (!data?.sections.length) return null;
  return (
    <section className="panel flex-blocks">
      <h2>Flex blocks</h2>
      <ul>
        {data.sections.map((s) => {
          const full = s.capacity && s.enrolledCount >= s.capacity;
          return (
            <li key={s.id}>
              <span>
                <strong>{s.name}</strong>
                <small className="muted"> with {s.teacherName}, {s.room}</small>
              </span>
              <span className="muted small">{s.capacity ? `${s.enrolledCount}/${s.capacity} seats` : `${s.enrolledCount} enrolled`}</span>
              {s.enrolled ? <Pill tone="green">You’re in</Pill> : <Button className="btn-sm" disabled={full} onClick={() => setTarget(s)}>{full ? 'Full' : 'Request to join'}</Button>}
            </li>
          );
        })}
      </ul>
      {target ? (
        <CreateRequest
          section={target}
          onClose={() => setTarget(null)}
          onCreated={() => {
            setTarget(null);
            toast('Request sent to your teacher', 'success');
            reload();
            onRequested();
          }}
        />
      ) : null}
    </section>
  );
}

function CreateRequest({ section, onClose, onCreated }) {
  const { user } = useApp();
  const fmt = useFormat();
  const flex = useApi(user.role === 'student' && !section ? '/api/sections' : null, { kind: 'flex' });
  const kids = useApi(user.role === 'parent' ? '/api/dashboard' : null);
  const [form, setForm] = useState({ sectionId: section?.id ?? '', studentId: '', date: fmt.dayKey(new Date().toISOString()), reason: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = user.role === 'student'
        ? { type: 'session_join', sectionId: form.sectionId, reason: form.reason }
        : { type: 'absence_excuse', studentId: form.studentId, date: form.date, reason: form.reason };
      await api('/api/requests', { method: 'POST', body });
      onCreated();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Modal title={user.role === 'student' ? `Join ${section?.name ?? 'a flex block'}` : 'Excuse an absence'} onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        {user.role === 'student' && !section ? (
          <Field label="Flex block">
            <select value={form.sectionId} onChange={set('sectionId')} required>
              <option value="" disabled>Choose a block…</option>
              {(flex.data?.sections ?? []).filter((s) => !s.enrolled).map((s) => (
                <option key={s.id} value={s.id}>{s.name} with {s.teacherName}</option>
              ))}
            </select>
          </Field>
        ) : null}
        {user.role === 'parent' ? (
          <>
            <Field label="Child">
              <select value={form.studentId} onChange={set('studentId')} required>
                <option value="" disabled>Choose…</option>
                {(kids.data?.children ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Day"><input type="date" value={form.date} onChange={set('date')} required /></Field>
          </>
        ) : null}
        <Field label="Reason" hint={user.role === 'student' ? 'Your teacher sees this.' : 'Visible to the attendance office.'}>
          <textarea rows={3} value={form.reason} onChange={set('reason')} required minLength={3} maxLength={500} />
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" busy={busy}>Send request</Button>
      </form>
    </Modal>
  );
}

function RequestDetail({ id, onClose, onChanged }) {
  const { user, toast } = useApp();
  const fmt = useFormat();
  const { data, error, reload } = useApi(`/api/requests/${id}`);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [job, setJob] = useState(null);
  useEvent('request.updated', (r) => r.id === id && reload());

  async function act(path, body, label) {
    setBusy(label);
    setActionError(null);
    try {
      const res = await api(`/api/requests/${id}/${path}`, { method: 'POST', body });
      if (res.job) setJob(res.job);
      toast(label === 'approve' ? 'Approved. Applying now…' : label === 'deny' ? 'Request denied' : 'Request cancelled', 'success');
      reload();
      onChanged();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  const r = data?.request;
  return (
    <Modal title="Request" onClose={onClose} wide>
      <ErrorNote error={error} />
      {!r ? <Loading /> : (
        <div className="req-detail">
          <div className="req-facts">
            <p className="req-big">{r.type === 'session_join' ? `${r.studentName} wants to join ${r.sectionName}` : `Excuse ${r.studentName} on ${r.data.date}`}</p>
            <blockquote>{r.reason}</blockquote>
            <p className="muted small">From {r.requesterName}. {r.approverName ? `Decided by ${r.approverName}.` : 'Any administrator can decide.'}</p>
            {r.decisionNote ? <p><strong>Note:</strong> {r.decisionNote}</p> : null}
            {data.canDecide ? (
              <div className="decide">
                <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
                <div className="row-actions">
                  <Button variant="primary" busy={busy === 'approve'} onClick={() => act('decision', { decision: 'approve', note: note || undefined }, 'approve')}>Approve</Button>
                  <Button variant="danger" busy={busy === 'deny'} onClick={() => act('decision', { decision: 'deny', note: note || undefined }, 'deny')}>Deny</Button>
                </div>
              </div>
            ) : null}
            {r.status === 'pending' && r.requesterId === user.id ? (
              <Button busy={busy === 'cancel'} onClick={() => act('cancel', {}, 'cancel')}>Cancel request</Button>
            ) : null}
            <ErrorNote error={actionError} />
            {job ? <JobStatus job={job} /> : null}
          </div>
          <ol className="events" aria-label="History">
            {r.events.map((e) => (
              <li key={e.id} className={`ev-${e.event}`}>
                <span className="ev-name">{EVENT_TEXT[e.event] ?? e.event}</span>
                <span className="muted small">{e.actorName ?? 'Orbit'}, {fmt.date(e.createdAt)} {fmt.time(e.createdAt)}</span>
                {e.note ? <span className="small">{e.note}</span> : null}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}
