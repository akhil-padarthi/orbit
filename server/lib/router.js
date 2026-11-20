import { HttpError, sendJson, readJsonBody, parseCookies, clientIp } from './http.js';
import { logger } from './logger.js';

/**
 * Minimal Express-style router on top of node:http.
 * Handlers and middleware receive a context object and may throw HttpError.
 * A handler's return value is sent as JSON (status from ctx.status, default 200).
 */
export function createRouter() {
  const routes = [];

  function add(method, pattern, ...handlers) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/\/:([A-Za-z_]+)/g, (_, key) => {
          keys.push(key);
          return '/([^/]+)';
        }) +
        '/?$',
    );
    routes.push({ method, pattern, regex, keys, handlers });
  }

  const api = {
    get: (p, ...h) => add('GET', p, ...h),
    post: (p, ...h) => add('POST', p, ...h),
    put: (p, ...h) => add('PUT', p, ...h),
    patch: (p, ...h) => add('PATCH', p, ...h),
    delete: (p, ...h) => add('DELETE', p, ...h),
    routes,

    /** Mount a group of routes under a prefix with shared middleware. */
    use(prefix, register, ...middleware) {
      const scoped = {};
      for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        scoped[m] = (p, ...h) => api[m](prefix + p, ...middleware, ...h);
      }
      register(scoped);
    },

    /** Try to handle the request; resolves to false when no route matched. */
    async handle(req, res) {
      const url = new URL(req.url, 'http://localhost');
      let pathMatched = false;
      for (const route of routes) {
        const m = route.regex.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (route.method !== req.method) continue;

        const params = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const ctx = {
          req,
          res,
          params,
          query: parseQuery(url.searchParams),
          cookies: parseCookies(req.headers.cookie),
          ip: clientIp(req),
          status: 200,
          headers: {},
          user: null,
          body: {},
        };
        try {
          ctx.body = await readJsonBody(req);
          let result;
          for (const fn of route.handlers) {
            result = await fn(ctx);
          }
          if (!res.writableEnded) sendJson(res, ctx.status, result ?? {}, ctx.headers);
        } catch (err) {
          handleError(res, err, req);
        }
        return true;
      }
      if (pathMatched) {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Method not allowed' } });
        return true;
      }
      return false;
    },
  };
  return api;
}

/** Query string → object; repeated keys (a[]=1&a[]=2) become arrays. */
function parseQuery(params) {
  const q = {};
  for (const [k, v] of params) q[k] = k in q ? [].concat(q[k], v) : v;
  return q;
}

export function handleError(res, err, req) {
  if (res.writableEnded) return;
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // SQLite constraint violations surface as 409s rather than 500s.
  if (typeof err?.message === 'string' && err.message.includes('UNIQUE constraint failed')) {
    sendJson(res, 409, { error: { code: 'conflict', message: 'A record with those details already exists' } });
    return;
  }
  logger.error('Unhandled error', { method: req?.method, url: req?.url, error: err?.stack ?? String(err) });
  sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong' } });
}
