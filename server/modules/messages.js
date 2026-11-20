import { all, one, run, newId, nowIso, tx } from '../db/database.js';
import { publishToUsers } from '../realtime/hub.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { messagingContacts, canMessage } from '../lib/rbac.js';
import { notFound, forbidden, badRequest } from '../lib/http.js';
import { validate, z } from '../lib/validate.js';

/**
 * Ensure a section has a class channel whose members are its teacher + enrolled students.
 * Called whenever enrollment changes (manual, SIS sync, or an approved flex request).
 */
export function ensureSectionConversation(tenantId, sectionId) {
  const section = one('SELECT id, name, teacher_id FROM sections WHERE id = ? AND tenant_id = ?', sectionId, tenantId);
  if (!section) return null;
  let conv = one("SELECT id FROM conversations WHERE section_id = ? AND kind = 'section'", sectionId);
  if (!conv) {
    conv = { id: newId() };
    run(`INSERT INTO conversations (id, tenant_id, kind, section_id, title, created_by, created_at) VALUES (?, ?, 'section', ?, ?, ?, ?)`,
      conv.id, tenantId, sectionId, section.name, section.teacher_id, nowIso());
  } else {
    run('UPDATE conversations SET title = ? WHERE id = ?', section.name, conv.id);
  }
  const wanted = new Set(all('SELECT student_id FROM enrollments WHERE section_id = ?', sectionId).map((r) => r.student_id));
  if (section.teacher_id) wanted.add(section.teacher_id);
  const current = new Set(all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', conv.id).map((r) => r.user_id));
  for (const id of wanted) {
    if (!current.has(id)) run('INSERT INTO conversation_members (conversation_id, user_id, tenant_id) VALUES (?, ?, ?)', conv.id, id, tenantId);
  }
  for (const id of current) {
    if (!wanted.has(id)) run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conv.id, id);
  }
  return conv.id;
}

function membership(user, conversationId) {
  const conv = one('SELECT * FROM conversations WHERE id = ? AND tenant_id = ?', conversationId, user.tenantId);
  if (!conv) throw notFound('Conversation');
  const member = one('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, user.id);
  if (!member) throw forbidden('You are not part of this conversation');
  return { conv, member };
}

function serializeMessage(m) {
  return { id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, senderName: m.sender_name, senderRole: m.sender_role, body: m.body, createdAt: m.created_at };
}

function conversationSummary(user, conv) {
  const members = all(
    `SELECT u.id, u.name, u.role FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? ORDER BY u.name`,
    conv.id,
  );
  const last = one(
    `SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m LEFT JOIN users u ON u.id = m.sender_id
     WHERE m.conversation_id = ? ORDER BY m.created_at DESC LIMIT 1`,
    conv.id,
  );
  const me = one('SELECT last_read_at FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conv.id, user.id);
  const unread = one(
    `SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND (sender_id IS NULL OR sender_id != ?) AND created_at > COALESCE(?, '')`,
    conv.id, user.id, me?.last_read_at ?? null,
  ).n;
  const others = members.filter((m) => m.id !== user.id);
  return {
    id: conv.id,
    kind: conv.kind,
    sectionId: conv.section_id,
    title: conv.kind === 'section' ? conv.title : others.map((o) => o.name).join(', ') || 'Just you',
    members,
    lastMessage: last ? serializeMessage(last) : null,
    lastMessageAt: conv.last_message_at,
    unread,
  };
}

const sendSchema = z.object({ body: z.string().trim().min(1, 'Message cannot be empty').max(2000) });

export function registerMessageRoutes(router) {
  router.use('/api', (r) => {
    r.get('/messages/contacts', (ctx) => ({ contacts: messagingContacts(ctx.user) }));

    r.get('/conversations', (ctx) => {
      const convs = all(
        `SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE cm.user_id = ? AND c.tenant_id = ? ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
        ctx.user.id, ctx.user.tenantId,
      );
      return { conversations: convs.map((c) => conversationSummary(ctx.user, c)) };
    });

    r.post('/conversations', (ctx) => {
      const { userId } = validate(z.object({ userId: z.string().min(1) }), ctx.body);
      if (userId === ctx.user.id) throw badRequest('You cannot start a conversation with yourself');
      const other = one('SELECT id FROM users WHERE id = ? AND tenant_id = ?', userId, ctx.user.tenantId);
      if (!other) throw notFound('User');
      if (!canMessage(ctx.user, userId)) throw forbidden('School policy does not allow messaging this person');

      const existing = one(
        `SELECT c.* FROM conversations c
         WHERE c.kind = 'direct' AND c.tenant_id = ?
           AND (SELECT COUNT(*) FROM conversation_members WHERE conversation_id = c.id) = 2
           AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?)
           AND EXISTS (SELECT 1 FROM conversation_members WHERE conversation_id = c.id AND user_id = ?)`,
        ctx.user.tenantId, ctx.user.id, userId,
      );
      if (existing) return { conversation: conversationSummary(ctx.user, existing) };

      const id = newId();
      tx(() => {
        run(`INSERT INTO conversations (id, tenant_id, kind, created_by, created_at) VALUES (?, ?, 'direct', ?, ?)`, id, ctx.user.tenantId, ctx.user.id, nowIso());
        for (const uid of [ctx.user.id, userId]) {
          run('INSERT INTO conversation_members (conversation_id, user_id, tenant_id) VALUES (?, ?, ?)', id, uid, ctx.user.tenantId);
        }
      });
      ctx.status = 201;
      return { conversation: conversationSummary(ctx.user, one('SELECT * FROM conversations WHERE id = ?', id)) };
    });

    r.get('/conversations/:id/messages', (ctx) => {
      membership(ctx.user, ctx.params.id);
      const limit = Math.min(Number(ctx.query.limit) || 50, 200);
      const rows = all(
        `SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m LEFT JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = ? AND m.created_at < COALESCE(?, '9999') ORDER BY m.created_at DESC LIMIT ?`,
        ctx.params.id, ctx.query.before ?? null, limit,
      );
      return { messages: rows.reverse().map(serializeMessage) };
    });

    r.post('/conversations/:id/messages', requirePermission('messages.send'), (ctx) => {
      const { conv } = membership(ctx.user, ctx.params.id);
      const { body } = validate(sendSchema, ctx.body);
      const members = all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', conv.id).map((m) => m.user_id);
      if (conv.kind === 'direct') {
        // Re-check policy: relationships change (e.g. a student moves sections).
        const others = members.filter((id) => id !== ctx.user.id);
        if (!others.some((id) => canMessage(ctx.user, id))) throw forbidden('School policy no longer allows this conversation');
      }
      const message = { id: newId(), created_at: nowIso() };
      tx(() => {
        run('INSERT INTO messages (id, tenant_id, conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          message.id, ctx.user.tenantId, conv.id, ctx.user.id, body, message.created_at);
        run('UPDATE conversations SET last_message_at = ? WHERE id = ?', message.created_at, conv.id);
        run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', message.created_at, conv.id, ctx.user.id);
      });
      const payload = serializeMessage({
        ...message, conversation_id: conv.id, sender_id: ctx.user.id, sender_name: ctx.user.name, sender_role: ctx.user.role, body,
      });
      publishToUsers(members, 'message.created', payload);
      ctx.status = 201;
      return { message: payload };
    });

    r.post('/conversations/:id/read', (ctx) => {
      membership(ctx.user, ctx.params.id);
      run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', nowIso(), ctx.params.id, ctx.user.id);
      return { ok: true };
    });
  }, authenticate);
}
