import { useState } from 'react';
import { api } from '../api.js';
import { useApp, useApi, ROLE_LABEL } from '../context.jsx';
import { Button, ErrorNote, Field, Loading, Modal, Pill } from '../ui.jsx';

export function People() {
  const { user, toast } = useApp();
  const isAdmin = user.role === 'admin';
  const [role, setRole] = useState('');
  const [search, setSearch] = useState('');
  const { data, error, loading, reload } = useApi('/api/users', { role, search });
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const [secret, setSecret] = useState(null);

  async function reset(u) {
    try {
      const res = await api(`/api/users/${u.id}/reset-password`, { method: 'POST', body: {} });
      setSecret({ name: u.name, email: u.email, password: res.tempPassword });
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  async function setStatus(u, status) {
    try {
      await api(`/api/users/${u.id}`, { method: 'PATCH', body: { status } });
      toast(status === 'inactive' ? `${u.name} deactivated` : `${u.name} reactivated`, 'success');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>People</h1>
          <p className="muted">{isAdmin ? 'Everyone in your school. Accounts imported from the SIS start as invited until you set a password.' : 'Staff, plus the students and families in your classes.'}</p>
        </div>
        {isAdmin ? (
          <div className="head-actions">
            <Button onClick={() => setLinking(true)}>Link parent to student</Button>
            <Button variant="primary" onClick={() => setAdding(true)}>Add person</Button>
          </div>
        ) : null}
      </header>
      <div className="filters">
        <Field label="Search"><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or email" /></Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Everyone</option>
            {Object.entries(ROLE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}s</option>
            ))}
          </select>
        </Field>
      </div>
      <ErrorNote error={error} />
      {loading && !data ? <Loading /> : null}
      {data ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Email</th>
                <th>Family</th>
                <th>Source</th>
                {isAdmin ? <th><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} className={u.status === 'inactive' ? 'dim' : ''}>
                  <td>
                    {u.name}
                    {u.status !== 'active' ? <> <Pill tone={u.status === 'invited' ? 'amber' : 'neutral'}>{u.status === 'invited' ? 'Invited' : 'Inactive'}</Pill></> : null}
                  </td>
                  <td>{ROLE_LABEL[u.role]}{u.gradeLevel ? `, grade ${u.gradeLevel}` : ''}</td>
                  <td className="muted">{u.email}</td>
                  <td className="muted">{u.children ? `Parent of ${u.children}` : u.guardians ? `Guardian: ${u.guardians}` : '—'}</td>
                  <td className="muted small">{u.externalId ? `SIS${u.lmsLinked ? ' + LMS' : ''}` : 'Orbit'}</td>
                  {isAdmin ? (
                    <td className="row-actions nowrap">
                      <button className="text-btn" onClick={() => reset(u)}>{u.status === 'invited' ? 'Activate' : 'Reset password'}</button>
                      {u.id !== user.id && u.status === 'active' ? <button className="text-btn danger" onClick={() => setStatus(u, 'inactive')}>Deactivate</button> : null}
                      {u.status === 'inactive' && u.id !== user.id ? <button className="text-btn" onClick={() => setStatus(u, 'active')}>Reactivate</button> : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {adding ? <AddPerson onClose={() => setAdding(false)} onAdded={(res) => { setAdding(false); setSecret({ name: res.user.name, email: res.user.email, password: res.tempPassword }); reload(); }} /> : null}
      {linking ? <LinkGuardian onClose={() => setLinking(false)} onDone={() => { setLinking(false); toast('Family linked', 'success'); reload(); }} /> : null}
      {secret ? (
        <Modal title="Temporary password" onClose={() => setSecret(null)}>
          <p>Share this with {secret.name} privately. It’s shown only once.</p>
          <p className="secret"><code data-testid="temp-password">{secret.password}</code></p>
          <p className="muted small">They sign in with school code <code>{user.tenant.slug}</code> and {secret.email}.</p>
        </Modal>
      ) : null}
    </div>
  );
}

function AddPerson({ onClose, onAdded }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'student', gradeLevel: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onAdded(await api('/api/users', { method: 'POST', body: { ...form, gradeLevel: form.gradeLevel || null } }));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }
  return (
    <Modal title="Add person" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Full name"><input value={form.name} onChange={set('name')} required /></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={set('email')} required /></Field>
        <div className="row-2">
          <Field label="Role">
            <select value={form.role} onChange={set('role')}>
              {Object.entries(ROLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>
          {form.role === 'student' ? <Field label="Grade"><input value={form.gradeLevel} onChange={set('gradeLevel')} /></Field> : null}
        </div>
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" busy={busy}>Add and create password</Button>
      </form>
    </Modal>
  );
}

function LinkGuardian({ onClose, onDone }) {
  const parents = useApi('/api/users', { role: 'parent' });
  const students = useApi('/api/users', { role: 'student' });
  const [form, setForm] = useState({ parentId: '', studentId: '' });
  const [error, setError] = useState(null);
  async function submit(e) {
    e.preventDefault();
    try {
      await api('/api/guardianships', { method: 'POST', body: form });
      onDone();
    } catch (err) {
      setError(err);
    }
  }
  return (
    <Modal title="Link parent to student" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <Field label="Parent or guardian">
          <select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })} required>
            <option value="" disabled>Choose…</option>
            {(parents.data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Student">
          <select value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })} required>
            <option value="" disabled>Choose…</option>
            {(students.data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <ErrorNote error={error} />
        <Button variant="primary" type="submit">Link</Button>
      </form>
    </Modal>
  );
}
