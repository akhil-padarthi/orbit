import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp, useApi, useEvent, useFormat, STATUS_LABEL } from '../context.jsx';
import { Button, ErrorNote, JobStatus, Link, Loading, Status } from '../ui.jsx';
import { Orbit, formatDistance } from '../Orbit.jsx';
import { CheckInPanel } from './CheckIn.jsx';

const STATUSES = ['present', 'late', 'absent', 'excused'];

export function SessionPage({ params }) {
  const { data, error, loading, reload, setData } = useApi(`/api/sessions/${params.id}`);
  const fmt = useFormat();
  if (loading && !data) return <div className="page"><Loading /></div>;
  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  const s = data.session;
  const now = Date.now();
  const live = s.status === 'scheduled' && now >= Date.parse(s.checkInOpensAt) && now <= Date.parse(s.endsAt);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="crumb"><Link to="/schedule">Schedule</Link></p>
          <h1>{s.sectionName}</h1>
          <p className="muted">
            {fmt.date(s.startsAt)}, {fmt.time(s.startsAt)}–{fmt.time(s.endsAt)} in {s.room} with {s.teacherName}
          </p>
        </div>
        <span className={`session-state state-${live ? 'live' : s.status}`}>
          {live ? 'Checking in now' : s.status === 'finalized' ? 'Attendance finalized' : s.status === 'cancelled' ? 'Cancelled' : now > Date.parse(s.endsAt) ? 'Ended — not finalized' : 'Upcoming'}
        </span>
      </header>
      {data.canManage ? (
        <LiveBoard data={data} setData={setData} reload={reload} live={live} />
      ) : (
        <LearnerView data={data} live={live} reload={reload} />
      )}
    </div>
  );
}

function LiveBoard({ data, setData, reload, live }) {
  const { realtime, toast } = useApp();
  const fmt = useFormat();
  const s = data.session;
  const [campus, setCampus] = useState(null);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);
  const [job, setJob] = useState(null);
  const [finalizing, setFinalizing] = useState(false);
  const [fresh, setFresh] = useState(new Set());

  useEffect(() => {
    api('/api/campuses').then((d) => setCampus(d.campuses[0])).catch(() => {});
  }, []);

  // Live roster: subscribe to this section's channel for real-time check-ins.
  useEffect(() => realtime?.subscribe(`section:${s.sectionId}`), [realtime, s.sectionId]);
  useEvent('attendance.updated', (evt) => {
    if (evt.sessionId !== s.id) return;
    setData((d) => {
      const roster = d.roster.map((r) => (r.studentId === evt.record.studentId ? { ...r, ...evt.record } : r));
      const counts = { present: 0, late: 0, absent: 0, excused: 0 };
      for (const r of roster) if (r.status) counts[r.status]++;
      return { ...d, roster, counts };
    });
    if (evt.record.method === 'geo') {
      setFresh((f) => new Set(f).add(evt.record.studentId));
      setTimeout(() => setFresh((f) => { const n = new Set(f); n.delete(evt.record.studentId); return n; }), 4000);
    }
  });
  useEvent('session.updated', (sess) => sess.id === s.id && reload());

  async function mark(studentId, status) {
    setSaving(studentId);
    setError(null);
    try {
      await api(`/api/sessions/${s.id}/attendance`, { method: 'PUT', body: { records: [{ studentId, status }] } });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(null);
    }
  }

  async function finalize() {
    setFinalizing(true);
    setError(null);
    try {
      const res = await api(`/api/sessions/${s.id}/finalize`, { method: 'POST', body: {} });
      setJob(res.job);
      toast(`Attendance finalized. ${res.markedAbsent} marked absent.`, 'success');
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setFinalizing(false);
    }
  }

  const here = data.counts.present + data.counts.late;
  const unmarked = data.roster.filter((r) => !r.status).length;

  return (
    <div className="board">
      <section className="board-orbit panel">
        {campus ? (
          <Orbit
            radiusM={campus.radiusM}
            points={data.roster.filter((r) => r.distanceM != null && (r.status === 'present' || r.status === 'late')).map((r) => ({ id: r.studentId, distance: r.distanceM, status: r.status, label: r.studentName }))}
            label={`${here} students checked in inside the campus zone`}
          />
        ) : null}
        <div className="board-count" aria-live="polite">
          <strong data-testid="here-count">{here}</strong>
          <span>of {data.roster.length} here</span>
        </div>
        <ul className="legend">
          {STATUSES.map((st) => (
            <li key={st}>
              <Status status={st} small /> {data.counts[st]}
            </li>
          ))}
          <li><Status status={null} small /> {unmarked}</li>
        </ul>
        {s.status === 'scheduled' ? (
          <div className="finalize">
            <p className="muted small">Finalizing marks everyone not yet checked in as absent and notifies their families.</p>
            <Button variant="primary" onClick={finalize} busy={finalizing}>Finalize attendance</Button>
          </div>
        ) : null}
        {job ? <JobStatus job={job} onDone={(j) => j.status === 'succeeded' && toast('Families notified and grades synced', 'success')} /> : null}
      </section>

      <section className="panel board-roster">
        <div className="panel-head">
          <h2>Roster</h2>
          {live ? <span className="pulse-dot">Live</span> : null}
        </div>
        <ErrorNote error={error} />
        <ul className="roster">
          {data.roster.map((r) => (
            <li key={r.studentId} className={fresh.has(r.studentId) ? 'just-in' : ''} data-testid={`roster-${r.studentName}`}>
              <span className="r-name">
                {r.studentName}
                <small className="muted">
                  {r.checkedInAt ? `Checked in ${fmt.time(r.checkedInAt)}` : r.method === 'system' ? 'Marked by Orbit' : r.method === 'manual' ? 'Marked by teacher' : r.method === 'request' ? 'Excused by request' : 'Not checked in'}
                  {r.distanceM != null ? `, ${formatDistance(r.distanceM)} from center` : ''}
                </small>
              </span>
              <span className="seg seg-status" role="group" aria-label={`Attendance for ${r.studentName}`}>
                {STATUSES.map((st) => (
                  <button
                    key={st}
                    className={r.status === st ? `on st-${st}` : ''}
                    aria-pressed={r.status === st}
                    disabled={saving === r.studentId || s.status === 'cancelled'}
                    onClick={() => mark(r.studentId, st)}
                    title={STATUS_LABEL[st]}
                  >
                    {STATUS_LABEL[st]}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function LearnerView({ data, live, reload }) {
  const { user } = useApp();
  const fmt = useFormat();
  const s = data.session;
  const mine = data.roster.find((r) => r.studentId === user.id);
  useEvent('attendance.updated', (evt) => evt.sessionId === s.id && reload());
  return (
    <div className="stack">
      {user.role === 'student' && live && !['present', 'late', 'excused'].includes(mine?.status) ? (
        <CheckInPanel session={{ ...s, myStatus: mine?.status }} onCheckedIn={reload} />
      ) : null}
      <section className="panel">
        <h2>{user.role === 'student' ? 'Your attendance' : 'Attendance'}</h2>
        {data.roster.length ? (
          <ul className="plain-list">
            {data.roster.map((r) => (
              <li key={r.studentId}>
                <strong>{r.studentName}</strong> <Status status={r.status} small />
                {r.checkedInAt ? <span className="muted"> checked in at {fmt.time(r.checkedInAt)}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing recorded yet.</p>
        )}
      </section>
    </div>
  );
}
