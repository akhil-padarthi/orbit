import { HttpError } from '../lib/http.js';

/** Fixed-window in-memory rate limiter (per process). Use Redis or similar when running several instances. */
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return {
    consume(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      if (entry.count > max) {
        const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
        throw new HttpError(429, 'rate_limited', `Too many attempts. Try again in ${retryAfter}s.`, { retryAfter });
      }
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
