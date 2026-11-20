import { config } from '../config.js';
import { one } from '../db/database.js';
import { verifyJwt, JwtError } from '../lib/jwt.js';
import { unauthorized, forbidden, HttpError } from '../lib/http.js';
import { hasPermission } from '../lib/rbac.js';

/**
 * Resolve a user from an access token. The user row is re-read on every request so a
 * deactivated account (or a role change) takes effect immediately, and the token's tenant
 * must match the user's tenant.
 */
export function userFromAccessToken(token) {
  let claims;
  try {
    claims = verifyJwt(token, config.jwt.secret, { issuer: config.jwt.issuer, audience: config.jwt.audience });
  } catch (err) {
    if (err instanceof JwtError) {
      throw new HttpError(401, err.code === 'expired' ? 'token_expired' : 'invalid_token', err.message);
    }
    throw err;
  }
  if (claims.typ !== 'access') throw new HttpError(401, 'invalid_token', 'Wrong token type');
  const row = one(
    `SELECT u.id, u.tenant_id, u.role, u.name, u.email, u.status, t.slug AS tenant_slug, t.name AS tenant_name, t.timezone
     FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = ? AND u.tenant_id = ?`,
    claims.sub,
    claims.tid,
  );
  if (!row || row.status !== 'active') throw unauthorized('Account is not active');
  return {
    id: row.id,
    tenantId: row.tenant_id,
    tenantSlug: row.tenant_slug,
    tenantName: row.tenant_name,
    timezone: row.timezone,
    role: row.role,
    name: row.name,
    email: row.email,
  };
}

/** Middleware: require a valid Bearer access token. */
export function authenticate(ctx) {
  const header = ctx.req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) throw unauthorized();
  ctx.user = userFromAccessToken(token);
}

/** Middleware factory: require the user's role to grant a permission. */
export const requirePermission = (permission) => (ctx) => {
  if (!ctx.user) throw unauthorized();
  if (!hasPermission(ctx.user.role, permission)) throw forbidden();
};

/** Middleware factory: restrict to specific roles. */
export const requireRole = (...roles) => (ctx) => {
  if (!ctx.user) throw unauthorized();
  if (!roles.includes(ctx.user.role)) throw forbidden();
};
