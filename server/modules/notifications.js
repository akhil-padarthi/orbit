import { all, one, run, newId, nowIso } from '../db/database.js';
import { publishToUsers } from '../realtime/hub.js';
import { authenticate } from '../middleware/auth.js';
import { notFound } from '../lib/http.js';

/** Persist a notification for each user and push it live. */
export function notify(tenantId, userIds, { kind, title, body = null, link = null }) {
  const created = [];
  for (const userId of new Set(userIds.filter(Boolean))) {
    const n = { id: newId(), tenantId, userId, kind, title, body, link, readAt: null, createdAt: nowIso() };
    run(
      `INSERT INTO notifications (id, tenant_id, user_id, kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      n.id, tenantId, userId, kind, title, body, link, n.createdAt,
    );
    publishToUsers([userId], 'notification', n);
    created.push(n);
  }
  return created;
}

const serialize = (r) => ({
  id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, readAt: r.read_at, createdAt: r.created_at,
});

export function registerNotificationRoutes(router) {
  router.use('/api/notifications', (r) => {
    r.get('', (ctx) => {
      const rows = all(
        'SELECT * FROM notifications WHERE user_id = ? AND tenant_id = ? ORDER BY created_at DESC LIMIT 50',
        ctx.user.id, ctx.user.tenantId,
      );
      const unread = one('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', ctx.user.id).n;
      return { notifications: rows.map(serialize), unread };
    });
    r.post('/read-all', (ctx) => {
      run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), ctx.user.id);
      return { ok: true };
    });
    r.post('/:id/read', (ctx) => {
      const res = run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?', nowIso(), ctx.params.id, ctx.user.id);
      if (!res.changes) throw notFound('Notification');
      return { ok: true };
    });
  }, authenticate);
}
