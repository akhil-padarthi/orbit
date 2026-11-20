import { z } from 'zod';
import { badRequest } from './http.js';

export { z };

/** Validate data against a zod schema; throws a 400 with field-level details on failure. */
export function validate(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw badRequest(`Invalid input: ${details.map((d) => (d.path ? `${d.path} — ${d.message}` : d.message)).join('; ')}`, details);
  }
  return result.data;
}

export const isoDateTime = z.string().datetime({ offset: true });
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');
export const id = z.string().min(1).max(64);
