import { all, one, run, newId, nowIso } from '../db/database.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { ROLES, visibleStudentIds, messagingContacts } from '../lib/rbac.js';
import { notFound, badRequest, conflict } from '../lib/http.js';
import { validate, z } from '../lib/validate.js';
import { hashPassword, generateTempPassword } from '../lib/password.js';

function serializeUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    status: u.status,
    gradeLevel: u.grade_level,
    externalId: u.external_id,
    lmsLinked: Boolean(u.lms_user_id),
    children: u.children ?? undefined,
    guardians: u.guardians ?? undefined,
    createdAt: u.created_at,
  };
}

const USER_SELECT = `
  SELECT u.*,
    (SELECT GROUP_CONCAT(s.name, ', ') FROM guardianships g JOIN users s ON s.id = g.student_id WHERE g.parent_id = u.id) AS children,
    (SELECT GROUP_CONCAT(p.name, ', ') FROM guardianships g JOIN users p ON p.id = g.parent_id WHERE g.student_id = u.id) AS guardians
  FROM users u`;

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(ROLES),
  gradeLevel: z.string().trim().max(10).optional().nullable(),
  password: z.string().min(8).max(200).optional(),
});

export function registerUserRoutes(router) {
  router.use('/api', (r) => {
    r.get('/users', requirePermission('users.read'), (ctx) => {
      const u = ctx.user;
      const params = [u.tenantId];
      let where = 'u.tenant_id = ?';
      if (u.role === 'teacher') {
        // Teachers see staff plus the students/guardians connected to their sections.
        const ids = [...new Set([...messagingContacts(u).map((c) => c.id), ...visibleStudentIds(u), u.id])];
        where += ` AND u.id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
      }
      if (ctx.query.role) {
        where += ' AND u.role = ?';
        params.push(ctx.query.role);
      }
      if (ctx.query.status) {
        where += ' AND u.status = ?';
        params.push(ctx.query.status);
      }
      if (ctx.query.search) {
        where += ' AND (u.name LIKE ? OR u.email LIKE ?)';
        const q = `%${ctx.query.search}%`;
        params.push(q, q);
      }
      const rows = all(`${USER_SELECT} WHERE ${where} ORDER BY CASE u.role WHEN 'admin' THEN 0 WHEN 'teacher' THEN 1 WHEN 'student' THEN 2 ELSE 3 END, u.name LIMIT 500`, ...params);
      return { users: rows.map(serializeUser) };
    });

    r.post('/users', requirePermission('users.manage'), async (ctx) => {
      const input = validate(createSchema, ctx.body);
      if (one('SELECT 1 AS x FROM users WHERE tenant_id = ? AND email = ?', ctx.user.tenantId, input.email)) throw conflict('Someone in this school already uses that email');
      const tempPassword = input.password ? null : generateTempPassword();
      const id = newId();
      const now = nowIso();
      run(
        `INSERT INTO users (id, tenant_id, email, name, role, password_hash, status, grade_level, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        id, ctx.user.tenantId, input.email, input.name, input.role, await hashPassword(input.password ?? tempPassword),
        input.role === 'student' ? input.gradeLevel ?? null : null, now, now,
      );
      ctx.status = 201;
      return { user: serializeUser(one(`${USER_SELECT} WHERE u.id = ?`, id)), tempPassword };
    });

    r.patch('/users/:id', requirePermission('users.manage'), (ctx) => {
      const target = one('SELECT * FROM users WHERE id = ? AND tenant_id = ?', ctx.params.id, ctx.user.tenantId);
      if (!target) throw notFound('User');
      const input = validate(z.object({
        name: z.string().trim().min(1).max(120).optional(),
        role: z.enum(ROLES).optional(),
        status: z.enum(['active', 'inactive']).optional(),
        gradeLevel: z.string().trim().max(10).optional().nullable(),
      }), ctx.body);
      if (target.id === ctx.user.id && ((input.role && input.role !== 'admin') || input.status === 'inactive')) {
        throw badRequest('You cannot remove your own admin access');
      }
      if (input.status === 'active' && !target.password_hash) throw badRequest('Set a password (reset password) before activating this account');
      run(
        'UPDATE users SET name = ?, role = ?, status = ?, grade_level = ?, updated_at = ? WHERE id = ?',
        input.name ?? target.name, input.role ?? target.role, input.status ?? target.status,
        input.gradeLevel !== undefined ? input.gradeLevel : target.grade_level, nowIso(), target.id,
      );
      if (input.status === 'inactive' || (input.role && input.role !== target.role)) {
        run('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?', nowIso(), target.id);
      }
      return { user: serializeUser(one(`${USER_SELECT} WHERE u.id = ?`, target.id)) };
    });

    // Issue a one-time temporary password (also activates SIS-invited accounts).
    r.post('/users/:id/reset-password', requirePermission('users.manage'), async (ctx) => {
      const target = one('SELECT * FROM users WHERE id = ? AND tenant_id = ?', ctx.params.id, ctx.user.tenantId);
      if (!target) throw notFound('User');
      const tempPassword = generateTempPassword();
      run(
        `UPDATE users SET password_hash = ?, status = CASE WHEN status = 'invited' THEN 'active' ELSE status END, updated_at = ? WHERE id = ?`,
        await hashPassword(tempPassword), nowIso(), target.id,
      );
      run('UPDATE refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE user_id = ?', nowIso(), target.id);
      return { tempPassword, user: serializeUser(one(`${USER_SELECT} WHERE u.id = ?`, target.id)) };
    });

    r.post('/guardianships', requirePermission('users.manage'), (ctx) => {
      const { parentId, studentId } = validate(z.object({ parentId: z.string(), studentId: z.string() }), ctx.body);
      const parent = one("SELECT id FROM users WHERE id = ? AND tenant_id = ? AND role = 'parent'", parentId, ctx.user.tenantId);
      const student = one("SELECT id FROM users WHERE id = ? AND tenant_id = ? AND role = 'student'", studentId, ctx.user.tenantId);
      if (!parent || !student) throw notFound('Parent or student');
      const res = run('INSERT OR IGNORE INTO guardianships (tenant_id, parent_id, student_id) VALUES (?, ?, ?)', ctx.user.tenantId, parentId, studentId);
      ctx.status = res.changes ? 201 : 200;
      return { ok: true };
    });

    r.delete('/guardianships/:parentId/:studentId', requirePermission('users.manage'), (ctx) => {
      const res = run('DELETE FROM guardianships WHERE parent_id = ? AND student_id = ? AND tenant_id = ?', ctx.params.parentId, ctx.params.studentId, ctx.user.tenantId);
      if (!res.changes) throw notFound('Guardianship');
      return { ok: true };
    });
  }, authenticate);
}
