import { WebSocketServer } from 'ws';
import { userFromAccessToken } from '../middleware/auth.js';
import { loadSectionFor } from '../lib/rbac.js';
import { one, all } from '../db/database.js';
import { logger } from '../lib/logger.js';

/**
 * Real-time hub over WebSockets.
 *
 * Protocol (JSON frames):
 *   client → {type:'auth', token}            must be the first frame, within 5 s
 *   server → {type:'ready', user, online}
 *   client → {type:'subscribe', channel:'section:<id>'}   live attendance board (teacher/admin only)
 *   client → {type:'typing', conversationId}
 *   client → {type:'ping'}                   server → {type:'pong'}
 *   server → {type:<event>, data}            pushed events (message.created, attendance.updated, …)
 *
 * Channels: user:<id>, tenant:<id>, section:<id>. Clients never pick tenant or user channels;
 * the server assigns them from the verified token, so events cannot leak across schools.
 */

const AUTH_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 30000;

const subscribers = new Map(); // channel -> Set<ws>
const meta = new Map(); // ws -> { user, channels:Set, alive }
const presence = new Map(); // userId -> connection count
let wss = null;
let heartbeat = null;

export const channel = {
  user: (id) => `user:${id}`,
  tenant: (id) => `tenant:${id}`,
  section: (id) => `section:${id}`,
};

function join(ws, ch) {
  if (!subscribers.has(ch)) subscribers.set(ch, new Set());
  subscribers.get(ch).add(ws);
  meta.get(ws)?.channels.add(ch);
}

function leaveAll(ws) {
  const m = meta.get(ws);
  if (!m) return;
  for (const ch of m.channels) {
    const set = subscribers.get(ch);
    set?.delete(ws);
    if (set && !set.size) subscribers.delete(ch);
  }
  meta.delete(ws);
  if (m.user) {
    const n = (presence.get(m.user.id) ?? 1) - 1;
    if (n <= 0) {
      presence.delete(m.user.id);
      publish(channel.tenant(m.user.tenantId), 'presence', { userId: m.user.id, online: false });
    } else presence.set(m.user.id, n);
  }
}

const send = (ws, obj) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

/** Push an event to everyone subscribed to a channel. */
export function publish(ch, type, data) {
  const set = subscribers.get(ch);
  if (!set) return 0;
  const frame = JSON.stringify({ type, data });
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(frame);
  return set.size;
}

export function publishToUsers(userIds, type, data) {
  for (const id of new Set(userIds.filter(Boolean))) publish(channel.user(id), type, data);
}

export function onlineUserIds(tenantId) {
  const ids = [];
  for (const [ws, m] of meta) if (m.user?.tenantId === tenantId && ws.readyState === ws.OPEN) ids.push(m.user.id);
  return [...new Set(ids)];
}

function handleFrame(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return send(ws, { type: 'error', data: { message: 'Invalid JSON' } });
  }
  const m = meta.get(ws);

  if (!m.user) {
    if (msg.type !== 'auth') return ws.close(4401, 'Authenticate first');
    try {
      const user = userFromAccessToken(msg.token);
      m.user = user;
      clearTimeout(m.authTimer);
      join(ws, channel.user(user.id));
      join(ws, channel.tenant(user.tenantId));
      const first = !presence.has(user.id);
      presence.set(user.id, (presence.get(user.id) ?? 0) + 1);
      send(ws, { type: 'ready', data: { user: { id: user.id, name: user.name, role: user.role }, online: onlineUserIds(user.tenantId) } });
      if (first) publish(channel.tenant(user.tenantId), 'presence', { userId: user.id, online: true });
    } catch (err) {
      send(ws, { type: 'error', data: { code: err.code ?? 'unauthorized', message: err.message } });
      ws.close(4401, 'Unauthorized');
    }
    return;
  }

  switch (msg.type) {
    case 'ping':
      return send(ws, { type: 'pong', data: { t: Date.now() } });
    case 'subscribe': {
      const [kind, id] = String(msg.channel ?? '').split(':');
      if (kind !== 'section' || !id) return send(ws, { type: 'error', data: { message: 'Unknown channel' } });
      try {
        loadSectionFor(m.user, id, 'manage'); // live roster boards are for the section's teacher/admins
        join(ws, channel.section(id));
        return send(ws, { type: 'subscribed', data: { channel: msg.channel } });
      } catch (err) {
        return send(ws, { type: 'error', data: { code: err.code, message: err.message, channel: msg.channel } });
      }
    }
    case 'unsubscribe': {
      const set = subscribers.get(msg.channel);
      if (set && String(msg.channel).startsWith('section:')) {
        set.delete(ws);
        m.channels.delete(msg.channel);
      }
      return;
    }
    case 'typing': {
      const member = one(
        'SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND tenant_id = ?',
        msg.conversationId,
        m.user.id,
        m.user.tenantId,
      );
      if (!member) return;
      const others = all('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?', msg.conversationId, m.user.id);
      publishToUsers(
        others.map((o) => o.user_id),
        'typing',
        { conversationId: msg.conversationId, userId: m.user.id, name: m.user.name },
      );
      return;
    }
    default:
      return send(ws, { type: 'error', data: { message: `Unknown message type: ${msg.type}` } });
  }
}

export function attachRealtime(server) {
  wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
  wss.on('connection', (ws) => {
    const m = { user: null, channels: new Set(), alive: true };
    m.authTimer = setTimeout(() => !m.user && ws.close(4401, 'Authentication timeout'), AUTH_TIMEOUT_MS);
    meta.set(ws, m);
    ws.on('pong', () => (m.alive = true));
    ws.on('message', (raw) => handleFrame(ws, raw));
    ws.on('close', () => {
      clearTimeout(m.authTimer);
      leaveAll(ws);
    });
    ws.on('error', (err) => logger.warn('ws error', { error: err.message }));
  });

  heartbeat = setInterval(() => {
    for (const [ws, m] of meta) {
      if (!m.alive) {
        ws.terminate();
        continue;
      }
      m.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  return wss;
}

export function closeRealtime() {
  clearInterval(heartbeat);
  for (const ws of meta.keys()) ws.terminate();
  subscribers.clear();
  meta.clear();
  presence.clear();
  return new Promise((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
}
