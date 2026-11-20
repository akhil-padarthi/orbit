import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signJwt, verifyJwt } from '../../server/lib/jwt.js';
import { distanceMeters, checkGeofence, offsetCoordinate, isValidCoordinate } from '../../server/lib/geo.js';
import { hashPassword, verifyPassword, generateTempPassword } from '../../server/lib/password.js';
import { zonedToUtc, localDate, dayRangeUtc, addDays, weekday } from '../../server/lib/time.js';
import { createRateLimiter } from '../../server/middleware/rateLimit.js';
import { nextLink } from '../../server/integrations/client.js';
import { summarize } from '../../server/modules/attendance.js';

const SECRET = 'unit-test-secret';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('JWT (HS256)', () => {
  test('round-trips claims and sets iat/exp/iss/aud', () => {
    const token = signJwt({ sub: 'u1', role: 'teacher' }, SECRET, { expiresInSec: 60, issuer: 'orbit', audience: 'app' });
    const claims = verifyJwt(token, SECRET, { issuer: 'orbit', audience: 'app' });
    assert.equal(claims.sub, 'u1');
    assert.equal(claims.role, 'teacher');
    assert.equal(claims.exp - claims.iat, 60);
  });

  test('rejects a tampered payload', () => {
    const token = signJwt({ sub: 'u1', role: 'student' }, SECRET, { expiresInSec: 60 });
    const [h, , s] = token.split('.');
    const forged = `${h}.${b64({ sub: 'u1', role: 'admin', iat: 0, exp: 9999999999 })}.${s}`;
    assert.throws(() => verifyJwt(forged, SECRET), { code: 'bad_signature' });
  });

  test('rejects a token signed with another secret', () => {
    const token = signJwt({ sub: 'u1' }, 'other-secret', { expiresInSec: 60 });
    assert.throws(() => verifyJwt(token, SECRET), { code: 'bad_signature' });
  });

  test('rejects alg "none" tokens', () => {
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u1', exp: 9999999999 })}.`;
    assert.throws(() => verifyJwt(none, SECRET), { code: 'bad_alg' });
  });

  test('rejects expired tokens (beyond clock tolerance)', () => {
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const payload = b64({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 60 });
    const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
    assert.throws(() => verifyJwt(`${header}.${payload}.${sig}`, SECRET), { code: 'expired' });
  });

  test('rejects wrong issuer / audience and malformed input', () => {
    const token = signJwt({ sub: 'u1' }, SECRET, { expiresInSec: 60, issuer: 'x', audience: 'y' });
    assert.throws(() => verifyJwt(token, SECRET, { issuer: 'orbit' }), { code: 'bad_issuer' });
    assert.throws(() => verifyJwt(token, SECRET, { audience: 'app' }), { code: 'bad_audience' });
    assert.throws(() => verifyJwt('not-a-token', SECRET), { code: 'malformed' });
    assert.throws(() => verifyJwt(undefined, SECRET), { code: 'malformed' });
  });
});

describe('geolocation', () => {
  test('haversine distance matches known values', () => {
    // One degree of latitude ≈ 111.2 km.
    assert.ok(Math.abs(distanceMeters(0, 0, 1, 0) - 111195) < 50);
    // Boston → New York ≈ 306 km.
    const d = distanceMeters(42.3601, -71.0589, 40.7128, -74.006);
    assert.ok(d > 300000 && d < 312000, `got ${d}`);
    assert.equal(distanceMeters(10, 10, 10, 10), 0);
  });

  test('offsetCoordinate moves by the requested distance', () => {
    const p = offsetCoordinate(42.35, -71.07, 300, 400);
    assert.ok(Math.abs(distanceMeters(42.35, -71.07, p.latitude, p.longitude) - 500) < 1);
  });

  test('geofence: inside, outside, and edge tolerance capped at 30 m', () => {
    const fence = { latitude: 42.35, longitude: -71.07, radius_m: 200 };
    const at = (m, accuracy) => ({ ...offsetCoordinate(42.35, -71.07, m, 0), accuracy });
    assert.equal(checkGeofence(at(50, 10), fence).inside, true);
    assert.equal(checkGeofence(at(215, 20), fence).inside, true); // within 200 + 20
    assert.equal(checkGeofence(at(215, 5), fence).inside, false); // 200 + 5 < 215
    assert.equal(checkGeofence(at(260, 100), fence).inside, false); // tolerance capped at 30
    assert.equal(checkGeofence(at(1500, 10), fence).distance, 1500);
  });

  test('coordinate validation', () => {
    assert.equal(isValidCoordinate(91, 0), false);
    assert.equal(isValidCoordinate(0, 181), false);
    assert.equal(isValidCoordinate(NaN, 0), false);
    assert.equal(isValidCoordinate(-33.9, 151.2), true);
  });
});

describe('passwords', () => {
  test('scrypt hash verifies only the right password and is salted', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('correct horse', a), true);
    assert.equal(await verifyPassword('wrong', a), false);
    assert.equal(await verifyPassword('x', null), false);
  });

  test('temporary passwords look like word-word-123', () => {
    assert.match(generateTempPassword(), /^[a-z]+-[a-z]+-\d{3}$/);
  });
});

describe('time zones', () => {
  test('wall-clock → UTC handles DST on both sides', () => {
    assert.equal(zonedToUtc('2026-01-15', '08:00', 'America/New_York').toISOString(), '2026-01-15T13:00:00.000Z'); // EST
    assert.equal(zonedToUtc('2026-07-15', '08:00', 'America/New_York').toISOString(), '2026-07-15T12:00:00.000Z'); // EDT
    assert.equal(zonedToUtc('2026-07-15', '08:00', 'America/Chicago').toISOString(), '2026-07-15T13:00:00.000Z');
  });

  test('local date and day ranges', () => {
    assert.equal(localDate(new Date('2026-11-20T03:30:00Z'), 'America/New_York'), '2026-11-19');
    const r = dayRangeUtc('2026-11-20', 'America/New_York');
    assert.equal(r.start, '2026-11-20T05:00:00.000Z');
    assert.equal(r.end, '2026-11-21T05:00:00.000Z');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(weekday('2026-11-20'), 5);
  });
});

describe('misc', () => {
  test('rate limiter blocks after max and resets', () => {
    const rl = createRateLimiter({ windowMs: 60000, max: 2 });
    rl.consume('k');
    rl.consume('k');
    assert.throws(() => rl.consume('k'), { status: 429 });
    rl.reset('k');
    assert.doesNotThrow(() => rl.consume('k'));
  });

  test('Link header parsing (Canvas pagination)', () => {
    assert.equal(nextLink('<https://x/api/v1/c?page=2>; rel="next", <https://x/api/v1/c?page=5>; rel="last"'), 'https://x/api/v1/c?page=2');
    assert.equal(nextLink('<https://x/api/v1/c?page=5>; rel="last"'), null);
    assert.equal(nextLink(null), null);
  });

  test('attendance rate excludes excused and counts late as attended', () => {
    const s = summarize([{ status: 'present', n: 8 }, { status: 'late', n: 1 }, { status: 'absent', n: 1 }, { status: 'excused', n: 5 }]);
    assert.equal(s.rate, 90);
    assert.equal(s.total, 15);
    assert.equal(summarize([{ status: 'excused', n: 2 }]).rate, null);
  });
});
