/**
 * Test helpers: boot an isolated Orbit server (in-memory SQLite, random port, fresh seed)
 * and talk to it like a real client would.
 */
import WebSocket from 'ws';

export async function startTestServer(env = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JOB_POLL_MS: '20',
    JOB_BACKOFF_MS: '40',
    DEMO_MODE: 'true',
    ...env,
  });
  const { startServer } = await import('../server/app.js');
  const app = await startServer({ port: 0, host: '127.0.0.1', dbFile: ':memory:' });
  return app;
}

export function api(base) {
  async function call(method, path, { token, body, cookie } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
  return {
    call,
    get: (p, o) => call('GET', p, o),
    post: (p, body, o = {}) => call('POST', p, { ...o, body: body ?? {} }),
    put: (p, body, o = {}) => call('PUT', p, { ...o, body }),
    patch: (p, body, o = {}) => call('PATCH', p, { ...o, body }),
    delete: (p, o) => call('DELETE', p, o),
  };
}

export const ACCOUNTS = {
  admin: ['northfield', 'admin@northfield.test'],
  teacher: ['northfield', 'm.reed@northfield.test'], // Algebra I + Math Lab (flex)
  teacher2: ['northfield', 'p.shah@northfield.test'], // Biology
  teacher3: ['northfield', 'e.torres@northfield.test'], // English 10 + Writing Center (flex)
  student: ['northfield', 'ava@northfield.test'], // Algebra I, Biology, English 10; child of rachel
  student2: ['northfield', 'liam@northfield.test'], // Algebra I, Biology; child of david
  student3: ['northfield', 'ethan@northfield.test'], // Biology, English 10 — not in Algebra I
  parent: ['northfield', 'rachel.johnson@northfield.test'],
  parent2: ['northfield', 'david.chen@northfield.test'],
  rAdmin: ['riverside', 'admin@riverside.test'],
  rTeacher: ['riverside', 'o.haddad@riverside.test'],
  rStudent: ['riverside', 'isla@riverside.test'],
  rParent: ['riverside', 'helen.grant@riverside.test'],
};

/** Log in every account once; returns { role: { token, user, refreshToken } }. */
export async function loginAll(client, which = Object.keys(ACCOUNTS)) {
  const out = {};
  for (const key of which) {
    const [tenant, email] = ACCOUNTS[key];
    const res = await client.post('/api/auth/login', { tenant, email, password: 'orbit123' });
    if (res.status !== 200) throw new Error(`login ${key} failed: ${res.status} ${JSON.stringify(res.body)}`);
    out[key] = { token: res.body.accessToken, user: res.body.user, refreshToken: res.body.refreshToken, cookie: res.headers.get('set-cookie') };
  }
  return out;
}

/** Poll a job until it settles. */
export async function waitForJob(client, token, jobId, { timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.get(`/api/jobs/${jobId}`, { token });
    if (res.status !== 200) throw new Error(`job lookup failed ${res.status}`);
    if (['succeeded', 'failed'].includes(res.body.job.status)) return res.body.job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} still ${res.body.job.status}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Open an authenticated WebSocket and collect events. */
export async function connectWs(base, token) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
  const events = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const w = waiters.find((x) => x.match(msg));
    if (w) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    } else {
      events.push(msg);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const client = {
    ws,
    events,
    send: (obj) => ws.send(JSON.stringify(obj)),
    next(match, timeoutMs = 3000) {
      const pred = typeof match === 'string' ? (m) => m.type === match : match;
      const found = events.find(pred);
      if (found) {
        events.splice(events.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const w = { match: pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`Timed out waiting for ws event`));
          }
        }, timeoutMs);
      });
    },
    close: () => ws.close(),
  };
  if (token) {
    client.send({ type: 'auth', token });
    await client.next('ready');
  }
  return client;
}

export const minutesFromNow = (m) => new Date(Date.now() + m * 60000).toISOString();
