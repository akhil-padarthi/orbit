import { all, one, run, newId, nowIso } from '../db/database.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { visibleSectionIds, loadSectionFor } from '../lib/rbac.js';
import { badRequest } from '../lib/http.js';
import { validate, z } from '../lib/validate.js';
import { publish, publishToUsers, channel } from '../realtime/hub.js';

const SELECT = `SELECT a.*, u.name AS author_name, u.role AS author_role, s.name AS section_name
  FROM announcements a LEFT JOIN users u ON u.id = a.author_id LEFT JOIN sections s ON s.id = a.section_id`;

const serialize = (a) => ({
  id: a.id, title: a.title, body: a.body, sectionId: a.section_id, sectionName: a.section_name,
  authorId: a.author_id, authorName: a.author_name, authorRole: a.author_role, createdAt: a.created_at,
});

export function registerAnnouncementRoutes(router) {
  router.use('/api/announcements', (r) => {
    r.get('', (ctx) => {
      const ids = visibleSectionIds(ctx.user);
      const params = [ctx.user.tenantId];
      let scope = '';
      if (ids !== null) {
        scope = ` AND (a.section_id IS NULL OR a.section_id IN (${ids.length ? ids.map(() => '?').join(',') : "''"}))`;
        params.push(...ids);
      }
      const rows = all(`${SELECT} WHERE a.tenant_id = ?${scope} ORDER BY a.created_at DESC LIMIT 30`, ...params);
      return { announcements: rows.map(serialize) };
    });

    r.post('', requirePermission('announcements.post'), (ctx) => {
      const input = validate(z.object({
        title: z.string().trim().min(1).max(140),
        body: z.string().trim().min(1).max(4000),
        sectionId: z.string().optional().nullable(),
      }), ctx.body);
      if (!input.sectionId && ctx.user.role !== 'admin') throw badRequest('Teachers must post announcements to one of their sections');
      if (input.sectionId) loadSectionFor(ctx.user, input.sectionId, 'manage');

      const id = newId();
      run('INSERT INTO announcements (id, tenant_id, section_id, author_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, ctx.user.tenantId, input.sectionId ?? null, ctx.user.id, input.title, input.body, nowIso());
      const announcement = serialize(one(`${SELECT} WHERE a.id = ?`, id));
      if (!input.sectionId) {
        publish(channel.tenant(ctx.user.tenantId), 'announcement.created', announcement);
      } else {
        const audience = all(
          `SELECT student_id AS id FROM enrollments WHERE section_id = ?
           UNION SELECT g.parent_id FROM guardianships g JOIN enrollments e ON e.student_id = g.student_id WHERE e.section_id = ?
           UNION SELECT teacher_id FROM sections WHERE id = ?`,
          input.sectionId, input.sectionId, input.sectionId,
        ).map((x) => x.id);
        publishToUsers([...audience, ctx.user.id], 'announcement.created', announcement);
      }
      ctx.status = 201;
      return { announcement };
    });
  }, authenticate);
}
