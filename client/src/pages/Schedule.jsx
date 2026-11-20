import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp, useApi, useEvent, useFormat } from '../context.jsx';
import { Button, ErrorNote, Field, Link, Loading, Modal, Status } from '../ui.jsx';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const weekday = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

export function Schedule() {
  const { user, navigate, toast } = useApp();
  const fmt = useFormat();
  const today = fmt.dayKey(new Date().toISOString());
  const [weekStart, setWeekStart] = useState(() => addDays(today, -((weekday(today) + 6) % 7)));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const query = { from: `${addDays(weekStart, -1)}T00:00:00Z`, to: `${addDays(weekStart, 8)}T00:00:00Z` };
  const { data, error, loading, reload } = useApi('/api/sessions', query);
  const canManage = user.role === 'admin' || user.role === 'teacher';
  const [modal, setModal] = useState(null);
  useEvent('session.updated', reload);
  useEvent('attendance.updated', reload);

  const byDay = useMemo(() => {
    const map = Object.fromEntries(days.map((d) => [d, []]));
    for (const s of data?.sessions ?? []) {
      const k = fmt.dayKey(s.startsAt);
      if (map[k]) map[k].push(s);
    }
    return map;
  }, [data, days]);
  const visibleDays = days.filter((d, i) => i < 5 || byDay[d].length);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Schedule</h1>
          <p className="muted">Week of {fmt.date(`${weekStart}T12:00:00Z`)}</p>
        </div>
        <div className="head-actions">
          <div className="seg">
            <button onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Previous week">‹ Prev</button>
            <button onClick={() => setWeekStart(addDays(today, -((weekday(today) + 6) % 7)))}>This week</button>
            <button onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Next week">Next ›</button>
          </div>
          {canManage ? (
            <>
              <Button onClick={() => setModal('start')}>Start a class now</Button>
              <Button variant="primary" onClick={() => setModal('add')}>Add sessions</Button>
            </>
          ) : null}
        </div>
      </header>
      <ErrorNote error={error} />
      {loading && !data ? <Loading /> : null}
      <div className="week" style={{ '--days': visibleDays.length }}>
        {visibleDays.map((d) => (
          <section key={d} className={`day${d === today ? ' today' : ''}`} aria-label={fmt.date(`${d}T12:00:00Z`)}>
            <h2>
              {DAY_NAMES[weekday(d)]} <span>{Number(d.slice(8))}</span>
            </h2>
            {byDay[d].length ? (
              byDay[d].map((s) => (
                <Link key={s.id} to={`/sessions/${s.id}`} className={`block block-${s.kind} block-${s.status}`}>
                  <span className="b-time">{fmt.time(s.startsAt)}</span>
                  <span className="b-name">{s.sectionName}</span>
                  <span className="b-room">{s.room}</span>
                  {s.status === 'cancelled' ? <span className="b-flag">Cancelled</span> : null}
                  {s.myStatus ? <Status status={s.myStatus} small /> : null}
                  {s.children?.map((c) => (
                    <span key={c.id} className="b-child">
                      {c.name.split(' ')[0]} <Status status={c.status} small />
                    </span>
                  ))}
                  {s.counts && s.status !== 'cancelled' ? (
                    <span className="b-count">
                      {s.counts.present + s.counts.late}/{s.enrolled} here
                    </span>
                  ) : null}
                </Link>
              ))
            ) : (
              <p className="muted small day-empty">No classes</p>
            )}
          </section>
        ))}
      </div>

      {modal === 'add' ? (
        <AddSessions
          onClose={() => setModal(null)}
          onDone={(n) => {
            setModal(null);
            toast(`${n} session${n === 1 ? '' : 's'} added`, 'success');
            reload();
          }}
        />
      ) : null}
      {modal === 'start' ? (
        <StartNow
          onClose={() => setModal(null)}
          onDone={(s) => {
            setModal(null);
            navigate(`/sessions/${s.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function useManageableSections() {
  const { user } = useApp();
  const { data } = useApi('/api/sections');
  return (data?.sections ?? []).filter((s) => user.role === 'admin' || s.teacherId === user.id);
}

function AddSessions({ onClose, onDone }) {
  const fmt = useFormat();
  const sections = useManageableSections();
  const today = fmt.dayKey(new Date().toISOString());
  const [form, setForm] = useState({ sectionId: '', date: today, toDate: addDays(today, 28), startTime: '13:30', endTime: '14:15', repeat: false, days: [2, 4], skipConflicts: false });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = form.repeat
        ? { sectionId: form.sectionId, daysOfWeek: form.days, startTime: form.startTime, endTime: form.endTime, fromDate: form.date, toDate: form.toDate, skipConflicts: form.skipConflicts }
        : { sectionId: form.sectionId, daysOfWeek: [weekday(form.date)], startTime: form.startTime, endTime: form.endTime, fromDate: form.date, toDate: form.date };
      const res = await api('/api/sessions/recurring', { method: 'POST', body });
      onDone(res.created);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Add sessions" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Class">
          <select value={form.sectionId} onChange={set('sectionId')} required>
            <option value="" disabled>Choose a class…</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.kind === 'flex' ? ' (flex)' : ''} — {s.room}</option>
            ))}
          </select>
        </Field>
        <div className="row-2">
          <Field label="Starts"><input type="time" value={form.startTime} onChange={set('startTime')} required /></Field>
          <Field label="Ends"><input type="time" value={form.endTime} onChange={set('endTime')} required /></Field>
        </div>
        <Field label={form.repeat ? 'From' : 'Date'}><input type="date" value={form.date} onChange={set('date')} required /></Field>
        <label className="check"><input type="checkbox" checked={form.repeat} onChange={set('repeat')} /> Repeat weekly</label>
        {form.repeat ? (
          <>
            <Field label="Until"><input type="date" value={form.toDate} onChange={set('toDate')} required /></Field>
            <fieldset className="days">
              <legend>On</legend>
              {[1, 2, 3, 4, 5].map((d) => (
                <label key={d} className={form.days.includes(d) ? 'on' : ''}>
                  <input
                    type="checkbox"
                    checked={form.days.includes(d)}
                    onChange={(e) => setForm({ ...form, days: e.target.checked ? [...form.days, d].sort() : form.days.filter((x) => x !== d) })}
                  />
                  {DAY_NAMES[d]}
                </label>
              ))}
            </fieldset>
            <label className="check"><input type="checkbox" checked={form.skipConflicts} onChange={set('skipConflicts')} /> Skip dates that clash instead of failing</label>
          </>
        ) : null}
        <p className="muted small">Times are in the school’s time zone ({fmt.timeZone}). Orbit blocks double-booking a teacher, room or class.</p>
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" busy={busy}>Add to schedule</Button>
      </form>
    </Modal>
  );
}

function StartNow({ onClose, onDone }) {
  const sections = useManageableSections();
  const [sectionId, setSectionId] = useState('');
  const [duration, setDuration] = useState(50);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api(`/api/sections/${sectionId}/sessions/start`, { method: 'POST', body: { durationMin: Number(duration) } });
      onDone(res.session);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal title="Start a class now" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <p className="muted">Opens check-in immediately — useful for a make-up class or a club meeting.</p>
        <Field label="Class">
          <select value={sectionId} onChange={(e) => setSectionId(e.target.value)} required>
            <option value="" disabled>Choose a class…</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Length (minutes)"><input type="number" min="5" max="240" value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" busy={busy}>Start and open check-in</Button>
      </form>
    </Modal>
  );
}
