import { session, refreshSession } from './api.js';

/**
 * WebSocket client: authenticates with the current access token, reconnects with
 * exponential backoff, re-subscribes to section channels, and tracks presence.
 */
export class RealtimeClient {
  constructor() {
    this.handlers = new Map();
    this.channels = new Set();
    this.online = new Set();
    this.status = 'connecting';
    this.attempt = 0;
    this.closed = false;
    this.ws = null;
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  emit(type, data) {
    this.handlers.get(type)?.forEach((fn) => fn(data));
    this.handlers.get('*')?.forEach((fn) => fn({ type, data }));
  }

  setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: session.token }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'ready') {
        this.attempt = 0;
        this.online = new Set(msg.data.online);
        this.setStatus('live');
        for (const ch of this.channels) ws.send(JSON.stringify({ type: 'subscribe', channel: ch }));
        this.emit('presence.sync', [...this.online]);
      } else if (msg.type === 'presence') {
        if (msg.data.online) this.online.add(msg.data.userId);
        else this.online.delete(msg.data.userId);
      }
      this.emit(msg.type, msg.data);
    };
    ws.onclose = async (event) => {
      if (this.closed) return;
      this.setStatus('reconnecting');
      if (event.code === 4401) await refreshSession().catch(() => {});
      const delay = Math.min(1000 * 2 ** this.attempt++, 15000);
      setTimeout(() => this.connect(), delay);
    };
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  subscribe(channel) {
    this.channels.add(channel);
    this.send({ type: 'subscribe', channel });
    return () => {
      this.channels.delete(channel);
      this.send({ type: 'unsubscribe', channel });
    };
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}
