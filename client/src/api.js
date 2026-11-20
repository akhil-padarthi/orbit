/**
 * API client. The short-lived access token lives only in memory; the refresh token is an
 * httpOnly cookie the browser sends to /api/auth/refresh. Expired access tokens are
 * refreshed transparently and the request retried once.
 */
let accessToken = null;
let refreshing = null;
const sessionListeners = new Set();

export class ApiError extends Error {
  constructor(status, error = {}) {
    super(error.message ?? `Request failed (${status})`);
    this.status = status;
    this.code = error.code;
    this.details = error.details;
  }
}

export const session = {
  get token() {
    return accessToken;
  },
  set(token) {
    accessToken = token;
  },
  onExpired(fn) {
    sessionListeners.add(fn);
    return () => sessionListeners.delete(fn);
  },
};

export function refreshSession() {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(res.status, body.error);
        accessToken = body.accessToken;
        return body;
      })
      .finally(() => (refreshing = null));
  }
  return refreshing;
}

export async function api(path, { method = 'GET', body, query, retry = true } = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (res.status === 401 && retry && !path.startsWith('/api/auth/')) {
    try {
      await refreshSession();
      return api(path, { method, body, query, retry: false });
    } catch {
      accessToken = null;
      sessionListeners.forEach((fn) => fn());
    }
  }
  if (!res.ok) throw new ApiError(res.status, data.error);
  return data;
}

export async function login(tenant, email, password) {
  const data = await api('/api/auth/login', { method: 'POST', body: { tenant, email, password } });
  accessToken = data.accessToken;
  return data;
}

export async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  accessToken = null;
}
