/**
 * Create a new school (tenant) with a campus and its first administrator.
 *
 *   npm run create-tenant -- --slug lincoln --name "Lincoln High School" \
 *     --timezone America/Chicago --admin-email principal@lincoln.org --admin-name "Jo Park" \
 *     --lat 41.88 --lng -87.63 --radius 200
 *
 * Prints a one-time temporary password for the administrator.
 */
import { parseArgs } from 'node:util';
import { config } from '../server/config.js';
import { openDatabase, closeDatabase, one, run, newId, nowIso, tx } from '../server/db/database.js';
import { hashPassword, generateTempPassword } from '../server/lib/password.js';

// Allow negative coordinates like `--lng -87.63` (parseArgs would read "-87.63" as a flag).
const argv = process.argv.slice(2).reduce((out, arg, i, all) => {
  if (/^-\d/.test(arg) && /^--(lat|lng|radius)$/.test(all[i - 1] ?? '')) out[out.length - 1] += `=${arg}`;
  else out.push(arg);
  return out;
}, []);

const { values: a } = parseArgs({
  args: argv,
  options: {
    slug: { type: 'string' },
    name: { type: 'string' },
    timezone: { type: 'string', default: 'America/New_York' },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
    lat: { type: 'string' },
    lng: { type: 'string' },
    radius: { type: 'string', default: '200' },
  },
});

const missing = ['slug', 'name', 'admin-email', 'admin-name', 'lat', 'lng'].filter((k) => !a[k]);
if (missing.length) {
  console.error(`Missing: ${missing.map((m) => `--${m}`).join(', ')}`);
  process.exit(1);
}
if (!/^[a-z0-9-]{2,40}$/.test(a.slug)) {
  console.error('--slug must be 2–40 lowercase letters, digits or dashes');
  process.exit(1);
}
try {
  new Intl.DateTimeFormat('en-US', { timeZone: a.timezone });
} catch {
  console.error(`Unknown time zone: ${a.timezone}`);
  process.exit(1);
}

openDatabase(config.dbFile);
if (one('SELECT 1 AS x FROM tenants WHERE slug = ?', a.slug)) {
  console.error(`A school with code "${a.slug}" already exists`);
  process.exit(1);
}
const password = generateTempPassword();
const hash = await hashPassword(password);
tx(() => {
  const tenantId = newId();
  const now = nowIso();
  run('INSERT INTO tenants (id, slug, name, timezone, created_at) VALUES (?, ?, ?, ?, ?)', tenantId, a.slug, a.name, a.timezone, now);
  run(
    'INSERT INTO campuses (id, tenant_id, name, latitude, longitude, radius_m, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId(), tenantId, a.name, Number(a.lat), Number(a.lng), Number(a.radius), now,
  );
  run(
    `INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'admin', ?, 'active', ?, ?)`,
    newId(), tenantId, a['admin-email'].toLowerCase(), a['admin-name'], hash, now, now,
  );
  // SIS + LMS connections start paused; the admin fills them in under Integrations.
  for (const [kind, provider, url] of [['sis', 'oneroster', 'https://your-sis.example.com'], ['lms', 'canvas', 'https://your-school.instructure.com']]) {
    run(
      `INSERT INTO integrations (id, tenant_id, kind, provider, base_url, client_id, client_secret, enabled, created_at) VALUES (?, ?, ?, ?, ?, '', '', 0, ?)`,
      newId(), tenantId, kind, provider, url, now,
    );
  }
});
closeDatabase();
console.log(`Created ${a.name}.\n  School code: ${a.slug}\n  Admin: ${a['admin-email']}\n  Temporary password: ${password}`);
