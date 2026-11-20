import { useState } from 'react';
import { api } from '../api.js';
import { useApp, useApi, useEvent, useFormat, timeAgo } from '../context.jsx';
import { Button, Empty, ErrorNote, Field, JobStatus, Link, Loading, Meter, Status, pct } from '../ui.jsx';
import { CheckInPanel } from './CheckIn.jsx';

export function Dashboard() {
  const { user } = useApp();
  const { data, error, loading, reload, setData } = useApi('/api/dashboard');
  const fmt = useFormat();

  // Keep the page live: attendance, requests and job changes refresh the numbers.
  useEvent('attendance.updated', () => reload());
  useEvent('request.updated', () => reload());
  useEvent('session.updated', () => reload());

  const hour = fmt.hour();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>
            {greeting}, {user.name.split(' ')[0]}
          </h1>
          <p className="muted">{fmt.longDate(new Date().toISOString())}</p>
        </div>
      </header>
      {loading && !data ? <Loading /> : null}
      <ErrorNote error={error} />
      {data?.role === 'admin' ? <AdminToday data={data} /> : null}
      {data?.role === 'teacher' ? <TeacherToday data={data} /> : null}
      {data?.role === 'student' ? <StudentToday data={data} onChange={reload} setData={setData} /> : null}
      {data?.role === 'parent' ? <ParentToday data={data} /> : null}
    </div>
  );
}

/** Today's classes in bell-schedule order, with a marker on the one happening now. */
function DayTimeline({ sessions, render, emptyText = 'No classes today.' }) {
  const fmt = useFormat();
  const now = Date.now();
  if (!sessions.length) return <Empty title={emptyText} />;
  return (
    <ol className="timeline">
      {sessions.map((s, i) => {
        const state = now > Date.parse(s.endsAt) ? 'past' : now >= Date.parse(s.startsAt) ? 'now' : 'next';
        return (
          <li key={s.id} className={`tl-row tl-${state}`}>
            <span className="tl-index" aria-hidden="true">{i + 1}</span>
            <span className="tl-time">
              {fmt.time(s.startsAt)}
              <small>{fmt.time(s.endsAt)}</small>
            </span>
            <span className="tl-body">
              <span className="tl-title">
                {s.sectionName}
                {state === 'now' ? <b className="now-tag">Now</b> : null}
                {s.kind === 'flex' ? <b className="flex-tag">Flex</b> : null}
              </span>
              <span className="tl-meta">
                {s.room}
                {s.teacherName ? ` with ${s.teacherName}` : ''}
              </span>
            </span>
            <span className="tl-side">{render?.(s, state)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function TeacherToday({ data }) {
  return (
    <div className="grid-2">
      <section className="panel span-2-mobile">
        <div className="panel-head">
          <h2>Your day</h2>
          {data.pendingRequests ? (
            <Link to="/requests" className="text-link">
              {data.pendingRequests} request{data.pendingRequests === 1 ? '' : 's'} waiting for you
            </Link>
          ) : null}
        </div>
        <DayTimeline
          sessions={data.today}
          render={(s) => {
            const here = s.counts.present + s.counts.late;
            return (
              <span className="tl-stat">
                <span>
                  <strong>{here}</strong>/{s.enrolled} here
                </span>
                <Link to={`/sessions/${s.id}`} className={`btn btn-${s.live ? 'primary' : 'default'} btn-sm`}>
                  {s.live ? 'Open live board' : s.status === 'finalized' ? 'Review' : 'Open'}
                </Link>
              </span>
            );
          }}
        />
      </section>
      <div className="stack">
        <section className="panel">
          <h2>Your sections</h2>
          <ul className="rate-list">
            {data.sections.map((s) => (
              <li key={s.id}>
                <span>
                  {s.name}
                  <small className="muted"> · {s.enrolled} students</small>
                </span>
                <Meter value={s.rate} />
                <span className="num">{pct(s.rate)}</span>
              </li>
            ))}
          </ul>
        </section>
        <Announcements canPost />
      </div>
    </div>
  );
}

function StudentToday({ data, onChange }) {
  // Once a student checks in, keep showing that panel (now in its "checked in" state) instead of hiding it.
  const [stickyId, setStickyId] = useState(null);
  const candidate = data.today.find((s) => s.checkInOpen && !['present', 'late', 'excused'].includes(s.myStatus));
  const open = data.today.find((s) => s.id === (stickyId ?? candidate?.id));
  return (
    <>
      {open ? (
        <CheckInPanel
          key={open.id}
          session={open}
          onCheckedIn={() => {
            setStickyId(open.id);
            onChange();
          }}
        />
      ) : null}
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Today’s classes</h2>
            <Link to="/requests" className="text-link">Join a flex block</Link>
          </div>
          <DayTimeline
            sessions={data.today}
            render={(s, state) =>
              s.myStatus ? <Status status={s.myStatus} small /> : state === 'past' ? <Status status={null} small /> : s.checkInOpen ? <Link to={`/sessions/${s.id}`} className="btn btn-sm">Check in</Link> : <span className="muted small">Opens 10 min before</span>
            }
          />
        </section>
        <div className="stack">
          <section className="panel">
            <h2>Your attendance</h2>
            <p className="big-rate">{pct(data.attendance.rate)}</p>
            <p className="muted">
              {data.attendance.counts.present} present, {data.attendance.counts.late} late, {data.attendance.counts.absent} absent, {data.attendance.counts.excused} excused
            </p>
            <Trend points={data.trend} />
          </section>
          <Announcements />
        </div>
      </div>
    </>
  );
}

function ParentToday({ data }) {
  const fmt = useFormat();
  if (!data.children.length) return <Empty title="No students are linked to your account yet.">Ask the school office to connect your child’s record.</Empty>;
  return (
    <div className="stack">
      {data.children.map((c) => (
        <section className="panel child" key={c.id}>
          <div className="panel-head">
            <h2>
              {c.name} <small className="muted">Grade {c.gradeLevel}</small>
            </h2>
            <span className="child-rate">
              <Meter value={c.attendance.rate} /> <strong>{pct(c.attendance.rate)}</strong> attendance
            </span>
          </div>
          <div className="grid-2 tight">
            <DayTimeline sessions={c.today} render={(s, state) => (s.status ? <Status status={s.status} small /> : state === 'next' ? <span className="muted small">Later</span> : <Status status={null} small />)} />
            <div>
              <h3>Recent absences and late arrivals</h3>
              {c.recent.length ? (
                <ul className="plain-list">
                  {c.recent.map((r, i) => (
                    <li key={i}>
                      <Status status={r.status} small /> {r.sectionName} <span className="muted">· {fmt.date(r.startsAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">None. Great streak.</p>
              )}
              <Link to="/requests" className="btn btn-sm">Excuse an absence</Link>
            </div>
          </div>
        </section>
      ))}
      <Announcements />
    </div>
  );
}

function AdminToday({ data }) {
  const s = data.stats;
  return (
    <>
      <section className="pulse" aria-label="School at a glance">
        <div><strong>{pct(data.today.rate)}</strong><span>here today so far</span></div>
        <div><strong>{data.today.live}</strong><span>class{data.today.live === 1 ? '' : 'es'} checking in now</span></div>
        <div><strong>{data.pendingRequests}</strong><span><Link to="/requests">pending requests</Link></span></div>
        <div><strong>{s.students}</strong><span>students, {s.teachers} teachers, {s.parents} parents</span></div>
        {s.invited ? <div><strong>{s.invited}</strong><span><Link to="/people">accounts to activate</Link></span></div> : null}
      </section>
      <div className="grid-2">
        <section className="panel">
          <h2>Attendance, last two weeks</h2>
          <Trend points={data.trend} large />
        </section>
        <section className="panel">
          <h2>Students to check in on</h2>
          {data.atRisk.length ? (
            <ul className="rate-list">
              {data.atRisk.map((st) => (
                <li key={st.id}>
                  <Link to={`/attendance?studentId=${st.id}`}>{st.name}</Link>
                  <Meter value={st.rate} />
                  <span className="num">{pct(st.rate)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Everyone is above 90% attendance.</p>
          )}
        </section>
        <section className="panel">
          <h2>Today across the school</h2>
          <DayTimeline
            sessions={data.today.list}
            render={(x) => (
              <span className="tl-stat">
                <span><strong>{x.counts.present + x.counts.late}</strong>/{x.enrolled}</span>
                <Link to={`/sessions/${x.id}`} className="btn btn-sm">{x.live ? 'Live board' : 'Open'}</Link>
              </span>
            )}
          />
        </section>
        <div className="stack">
          <section className="panel">
            <div className="panel-head">
              <h2>Recent sync jobs</h2>
              <Link to="/integrations" className="text-link">Integrations</Link>
            </div>
            {data.recentJobs.length ? (
              <ul className="plain-list">
                {data.recentJobs.map((j) => (
                  <li key={j.id}>
                    <span className={`job-dot ${j.status}`} /> {j.type} <span className="muted">· {j.status} · {timeAgo(j.createdAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No background jobs yet. Run a SIS sync from Integrations.</p>
            )}
          </section>
          <Announcements canPost schoolWide />
        </div>
      </div>
    </>
  );
}

/** Daily attendance rate as simple bars, with the 90% target marked. */
function Trend({ points, large }) {
  const fmt = useFormat();
  if (!points?.length) return <p className="muted">No finished classes yet.</p>;
  const h = large ? 140 : 70;
  const w = Math.max(points.length * 28 + 30, 150);
  const min = large ? 70 : 0; // school-wide rates cluster high, so zoom in; individual days vary widely
  const y = (v) => h - ((Math.max(v, min) - min) / (100 - min)) * h;
  return (
    <svg className="trend" viewBox={`0 0 ${w} ${h + 20}`} role="img" aria-label="Daily attendance rate">
      <line x1="0" x2={w - 30} y1={y(90)} y2={y(90)} className="target" />
      <text x={w - 26} y={y(90) + 3} className="target-label">90%</text>
      {points.map((p, i) => {
        const none = p.rate == null;
        const top = none ? 0 : Math.min(y(p.rate), h - 2);
        const cls = none ? 'none' : p.rate >= 95 ? 'good' : p.rate >= 90 ? 'ok' : 'low';
        return (
          <g key={p.date} transform={`translate(${i * 28 + 4} 0)`}>
            <rect y={top} width="20" height={h - top} rx="3" className={cls}>
              <title>{`${fmt.date(p.date + 'T12:00:00Z')}: ${none ? 'all excused' : pct(p.rate)}`}</title>
            </rect>
            <text x="10" y={h + 14} textAnchor="middle">{p.date.slice(8)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export function Announcements({ canPost, schoolWide }) {
  const { user, toast } = useApp();
  const { data, reload, setData } = useApi('/api/announcements');
  const sections = useApi(canPost ? '/api/sections' : null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', sectionId: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEvent('announcement.created', (a) => setData((d) => (d ? { announcements: [a, ...d.announcements.filter((x) => x.id !== a.id)] } : d)));

  async function post(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/announcements', { method: 'POST', body: { ...form, sectionId: form.sectionId || null } });
      setForm({ title: '', body: '', sectionId: '' });
      setOpen(false);
      toast('Announcement posted', 'success');
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const mySections = (sections.data?.sections ?? []).filter((s) => user.role === 'admin' || s.teacherId === user.id);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Announcements</h2>
        {canPost ? <button className="text-btn" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : 'Post'}</button> : null}
      </div>
      {open ? (
        <form className="form-stack" onSubmit={post}>
          <Field label="Audience">
            <select value={form.sectionId} onChange={(e) => setForm({ ...form, sectionId: e.target.value })} required={!schoolWide}>
              {schoolWide ? <option value="">Whole school</option> : <option value="" disabled>Choose a class…</option>}
              {mySections.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required maxLength={140} />
          </Field>
          <Field label="Message">
            <textarea rows={3} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} required />
          </Field>
          <ErrorNote error={error} />
          <Button variant="primary" busy={busy} type="submit">Post announcement</Button>
        </form>
      ) : null}
      {data?.announcements?.length ? (
        <ul className="announcements">
          {data.announcements.slice(0, 5).map((a) => (
            <li key={a.id}>
              <p className="a-title">{a.title}</p>
              <p className="a-body">{a.body}</p>
              <p className="muted small">
                {a.authorName} · {a.sectionName ?? 'Whole school'} · {timeAgo(a.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing posted yet.</p>
      )}
    </section>
  );
}

export { DayTimeline, Trend, JobStatus };
