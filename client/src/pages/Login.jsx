import { useEffect, useState } from 'react';
import { api, login } from '../api.js';
import { useApp, ROLE_LABEL } from '../context.jsx';
import { Button, ErrorNote, Field } from '../ui.jsx';
import { Logo } from '../brand.jsx';

export function Login() {
  const { setUser } = useApp();
  const [form, setForm] = useState({ tenant: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState(null);
  const [demoSchool, setDemoSchool] = useState(0);

  useEffect(() => {
    api('/api/config').then((c) => setDemo(c.demo ?? null)).catch(() => {});
  }, []);

  async function submit(values = form) {
    setBusy(true);
    setError(null);
    try {
      const data = await login(values.tenant, values.email, values.password);
      setUser(data.user);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  const school = demo?.tenants?.[demoSchool];

  return (
    <div className="login">
      <section className="login-art" aria-hidden="true">
        <Logo light />
        <svg viewBox="0 0 400 400" className="login-orbit">
          <circle cx="200" cy="200" r="170" className="lo-ring faint" />
          <circle cx="200" cy="200" r="120" className="lo-ring" />
          <circle cx="200" cy="200" r="70" className="lo-zone" />
          <rect x="190" y="190" width="20" height="20" rx="4" className="lo-campus" />
          <circle cx="252" cy="178" r="8" className="lo-dot a" />
          <circle cx="160" cy="240" r="8" className="lo-dot b" />
          <circle cx="228" cy="250" r="8" className="lo-dot c" />
          <circle cx="318" cy="118" r="8" className="lo-dot d" />
        </svg>
        <p className="login-line">Know who’s here, what’s next, and who needs a hand.</p>
      </section>

      <section className="login-panel">
        <form
          className="login-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <h1>Sign in</h1>
          <Field label="School code">
            <input name="tenant" autoComplete="organization" value={form.tenant} onChange={(e) => setForm({ ...form, tenant: e.target.value })} placeholder="e.g. northfield" required />
          </Field>
          <Field label="Email">
            <input name="email" type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </Field>
          <Field label="Password">
            <input name="password" type="password" autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          </Field>
          <ErrorNote error={error} />
          <Button variant="primary" type="submit" busy={busy} className="wide">Sign in</Button>
        </form>

        {demo ? (
          <div className="demo">
            <div className="demo-head">
              <h2>Try a demo account</h2>
              <div className="seg" role="tablist" aria-label="Demo school">
                {demo.tenants.map((t, i) => (
                  <button key={t.slug} role="tab" aria-selected={i === demoSchool} className={i === demoSchool ? 'on' : ''} onClick={() => setDemoSchool(i)}>
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="demo-accounts">
              {school?.accounts.map((a) => (
                <button
                  key={a.email}
                  className="demo-account"
                  data-role={a.role}
                  onClick={() => {
                    const values = { tenant: school.slug, email: a.email, password: demo.password };
                    setForm(values);
                    submit(values);
                  }}
                >
                  <span className="demo-role">{ROLE_LABEL[a.role]}</span>
                  <span className="demo-name">{a.name}</span>
                </button>
              ))}
            </div>
            <p className="muted small">
              School code <code>{school?.slug}</code>, password <code>{demo.password}</code> for every demo account.
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}
