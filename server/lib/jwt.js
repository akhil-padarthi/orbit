import crypto from 'node:crypto';

/**
 * HS256 JSON Web Tokens (RFC 7519) using node:crypto.
 * Only HS256 is accepted on verify, which blocks "alg: none" and algorithm-confusion attacks.
 */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (str) => Buffer.from(str, 'base64url');

export class JwtError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function signJwt(payload, secret, { expiresInSec, issuer, audience } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = {
    ...payload,
    iat: now,
    ...(expiresInSec ? { exp: now + expiresInSec } : {}),
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}

export function verifyJwt(token, secret, { issuer, audience, clockToleranceSec = 5 } = {}) {
  if (typeof token !== 'string') throw new JwtError('malformed', 'Token missing');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed', 'Token malformed');
  const [h, p, s] = parts;

  let header, payload;
  try {
    header = JSON.parse(fromB64url(h).toString('utf8'));
    payload = JSON.parse(fromB64url(p).toString('utf8'));
  } catch {
    throw new JwtError('malformed', 'Token malformed');
  }
  if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new JwtError('bad_alg', 'Unsupported token algorithm');

  const expected = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
  const given = fromB64url(s);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new JwtError('bad_signature', 'Token signature invalid');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now > payload.exp + clockToleranceSec) {
    throw new JwtError('expired', 'Token expired');
  }
  if (typeof payload.nbf === 'number' && now + clockToleranceSec < payload.nbf) {
    throw new JwtError('not_active', 'Token not yet valid');
  }
  if (issuer && payload.iss !== issuer) throw new JwtError('bad_issuer', 'Token issuer invalid');
  if (audience && payload.aud !== audience) throw new JwtError('bad_audience', 'Token audience invalid');
  return payload;
}
