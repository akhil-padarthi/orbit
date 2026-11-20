import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const isProd = env.NODE_ENV === 'production';

if (isProd && !env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

export const config = {
  appName: 'Orbit',
  root,
  isProd,
  port: Number(env.PORT ?? 4000),
  host: env.HOST ?? '0.0.0.0',
  // Public URL of this server; used to reach the bundled mock SIS/LMS providers.
  publicUrl: env.PUBLIC_URL ?? null,
  dbFile: env.DB_FILE ?? path.join(root, 'data', 'orbit.db'),
  clientDir: path.join(root, 'client', 'dist'),

  jwt: {
    // A random per-boot secret in development means tokens die on restart, which is fine locally.
    secret: env.JWT_SECRET ?? crypto.randomBytes(32).toString('hex'),
    issuer: 'orbit',
    audience: 'orbit-app',
    accessTtlSec: Number(env.ACCESS_TOKEN_TTL ?? 15 * 60),
    refreshTtlSec: Number(env.REFRESH_TOKEN_TTL ?? 7 * 24 * 60 * 60),
  },

  attendance: {
    opensBeforeStartMin: 10, // check-in window opens 10 min before a session starts
    lateAfterMin: 5, // checking in more than 5 min after start counts as late
    maxAccuracyM: 100, // reject GPS fixes less precise than this
  },

  jobs: {
    pollMs: Number(env.JOB_POLL_MS ?? 250),
    baseBackoffMs: Number(env.JOB_BACKOFF_MS ?? 2000),
  },

  // Demo mode exposes a location simulator in the UI and mounts the mock SIS/LMS servers.
  demoMode: env.DEMO_MODE ? env.DEMO_MODE === 'true' : !isProd,
  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
};
