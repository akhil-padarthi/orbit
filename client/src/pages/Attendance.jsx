import { useMemo, useState } from 'react';
import { useApp, useApi, useEvent, useFormat } from '../context.jsx';
import { ErrorNote, Field, Link, Loading, Meter, Status, Empty, pct } from '../ui.jsx';
import { formatDistance } from '../Orbit.jsx';

const METHOD = { geo: 'GPS check-in', manual: 'Marked by teacher', system: 'Auto-marked at close', request: 'Excuse request' };

export function Attendance() {
  const { user, path } = useApp();
  const fmt = useFormat();
  const initial = Object.fromEntries(new URLSearchParams(path.split('?')[1] ?? ''));
  const [filters, setFilters] = useState({ sectionId: '', studentId: initial.studentId ?? '', status: '', from: '', to: '' });
  const query = {
    ...filters,
    from: filters.from ? `${filters.from}T00:00:00Z` : undefined,
    to: filters.to ? `${filters.to}T23:59:59Z` : undefined,
  };
  const records = useApi('/api/attendance', query);
  const summary = useApi('/api/attendance/summary', query);
  const sections = useApi('/api/sections');
  const people = useApi(user.role === 'admin' || user.role === 'teacher' ? '/api/users' : user.role === 'parent' ? '/api/dashboard' : null, user.role === 'parent' ? undefined : { role: 'student' });
  useEvent('attendance.updated', () => {
    records.reload();
    summary.reload();
  });

  const students = useMemo(() => {
    if (user.role === 'parent') return people.data?.children?.map((c) => ({ id: c.id, name: c.name })) ?? [];
    return people.data?.users ?? [];
  }, [people.data]);
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  const s = summary.data;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Attendance</h1>
          <p className="muted">{user.role === 'student' ? 'Every class you’ve been marked for.' : user.role === 'parent' ? 'Your children’s attendance record.' : 'Search attendance across your classes.'}</p>
        </div>
      </header>

      <div className="filters">
        {user.role !== 'student' && students.length ? (
          <Field label="Student">
            <select value={filters.studentId} onChange={set('studentId')}>
              <option value="">All students</option>
              {students.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Class">
          <select value={filters.sectionId} onChange={set('sectionId')}>
            <option value="">All classes</option>
            {(sections.data?.sections ?? []).filter((x) => user.role !== 'student' || x.enrolled).map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Status">
          <select value={filters.status} onChange={set('status')}>
            <option value="">Any status</option>
            <option value="present">Present</option>
            <option value="late">Late</option>
            <option value="absent">Absent</option>
            <option value="excused">Excused</option>
          </select>
        </Field>
        <Field label="From"><input type="date" value={filters.from} onChange={set('from')} /></Field>
        <Field label="To"><input type="date" value={filters.to} onChange={set('to')} /></Field>
      </div>

      {s ? (
        <section className="summary-line" aria-label="Summary">
          <span className="sum-rate">
            <strong data-testid="attendance-rate">{pct(s.rate)}</strong> attendance
          </span>
          <Meter value={s.rate} />
          <span>{s.counts.present} present</span>
          <span>{s.counts.late} late</span>
          <span>{s.counts.absent} absent</span>
          <span>{s.counts.excused} excused</span>
        </section>
      ) : null}

      <ErrorNote error={records.error ?? summary.error} />
      {records.loading && !records.data ? <Loading /> : null}
      {records.data?.records.length === 0 ? <Empty title="No attendance matches these filters." /> : null}
      {records.data?.records.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Class</th>
                {user.role !== 'student' ? <th>Student</th> : null}
                <th>Status</th>
                <th>How</th>
                <th>Checked in</th>
              </tr>
            </thead>
            <tbody>
              {records.data.records.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap"><Link to={`/sessions/${r.sessionId}`}>{fmt.date(r.startsAt)}</Link></td>
                  <td>{r.sectionName}</td>
                  {user.role !== 'student' ? <td>{r.studentName}</td> : null}
                  <td><Status status={r.status} small /></td>
                  <td className="muted">{METHOD[r.method]}{r.method === 'geo' && r.distanceM != null ? `, ${formatDistance(r.distanceM)}` : ''}</td>
                  <td className="nowrap">{r.checkedInAt ? fmt.time(r.checkedInAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
