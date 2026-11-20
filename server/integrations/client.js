/**
 * HTTP client for external SIS/LMS APIs:
 *  - OAuth 2.0 client-credentials grant (RFC 6749 §4.4) with token caching
 *  - request timeouts
 *  - transient errors (network, 429, 5xx) surface as retryable; 4xx as permanent
 */
import crypto from 'node:crypto';
import { PermanentJobError } from '../jobs/queue.js';

let internalOrigin = 'http://127.0.0.1:4000';
export function setInternalOrigin(origin) {
  internalOrigin = origin;
}

/** Relative base URLs ("/mock/…") point at this server — used for the bundled demo providers. */
export function resolveBaseUrl(baseUrl) {
  return baseUrl.startsWith('/') ? internalOrigin + baseUrl : baseUrl.replace(/\/+$/, '');
}

const tokenCache = new Map(); // key -> { token, expiresAt }

export class ApiClient {
  constructor({ baseUrl, clientId, clientSecret, tokenPath = '/oauth/token', timeoutMs = 10000 }) {
    this.baseUrl = resolveBaseUrl(baseUrl);
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenPath = tokenPath;
    this.timeoutMs = timeoutMs;
  }

  async #fetch(url, init) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new Error(`Could not reach ${new URL(url).host}: ${err.cause?.code ?? err.name ?? err.message}`);
    }
    return res;
  }

  /** Cache key includes a hash of the secret so changed credentials never reuse an old token. */
  get cacheKey() {
    return `${this.baseUrl}|${this.clientId}|${crypto.createHash('sha256').update(this.clientSecret).digest('hex').slice(0, 16)}`;
  }

  async token() {
    const key = this.cacheKey;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
    const res = await this.#fetch(this.baseUrl + this.tokenPath, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (res.status === 401 || res.status === 400) throw new PermanentJobError('Integration credentials were rejected (check client ID and secret)');
    if (!res.ok) throw new Error(`Token endpoint returned HTTP ${res.status}`);
    const body = await res.json();
    tokenCache.set(key, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  /** Make an authenticated request; returns { body, headers }. */
  async request(method, path, { query, json } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else if (v != null) url.searchParams.set(k, v);
    }
    const doFetch = async () =>
      this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Accept: 'application/json',
          ...(json ? { 'Content-Type': 'application/json' } : {}),
        },
        body: json ? JSON.stringify(json) : undefined,
      });
    let res = await doFetch();
    if (res.status === 401) {
      tokenCache.delete(this.cacheKey); // token revoked/expired early: refresh once
      res = await doFetch();
    }
    if (res.status === 429 || res.status >= 500) throw new Error(`${method} ${url.pathname} failed with HTTP ${res.status}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PermanentJobError(`${method} ${url.pathname} failed with HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const body = res.status === 204 ? null : await res.json();
    return { body, headers: res.headers };
  }
}

/** Parse an RFC 8288 Link header and return the rel="next" URL, if any. */
export function nextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}
