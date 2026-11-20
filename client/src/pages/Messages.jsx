import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp, useApi, useEvent, useFormat, ROLE_LABEL } from '../context.jsx';
import { Avatar, Button, Empty, ErrorNote, Link, Loading, Modal } from '../ui.jsx';

export function Messages({ params }) {
  const { user, realtime, navigate } = useApp();
  const { data, error, loading, setData, reload } = useApi('/api/conversations');
  const [online, setOnline] = useState(new Set(realtime?.online ?? []));
  const [picking, setPicking] = useState(false);
  const activeId = params.id;

  useEvent('presence.sync', (ids) => setOnline(new Set(ids)));
  useEvent('presence', () => setOnline(new Set(realtime.online)));
  useEvent('message.created', (m) => {
    setData((d) => {
      if (!d) return d;
      if (!d.conversations.some((c) => c.id === m.conversationId)) {
        reload();
        return d;
      }
      const convs = d.conversations.map((c) =>
        c.id === m.conversationId ? { ...c, lastMessage: m, lastMessageAt: m.createdAt, unread: m.senderId === user.id || c.id === activeId ? 0 : c.unread + 1 } : c,
      );
      convs.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
      return { conversations: convs };
    });
  });
  useEffect(() => {
    if (activeId) setData((d) => (d ? { conversations: d.conversations.map((c) => (c.id === activeId ? { ...c, unread: 0 } : c)) } : d));
  }, [activeId]);

  const active = data?.conversations.find((c) => c.id === activeId);
  const otherOnline = (c) => c.kind === 'direct' && c.members.some((m) => m.id !== user.id && online.has(m.id));

  return (
    <div className={`page messages${activeId ? ' has-active' : ''}`}>
      <aside className="conv-list">
        <div className="conv-head">
          <h1>Messages</h1>
          <Button className="btn-sm" onClick={() => setPicking(true)}>New</Button>
        </div>
        <ErrorNote error={error} />
        {loading && !data ? <Loading /> : null}
        {data?.conversations.length === 0 ? <Empty title="No conversations yet." /> : null}
        <ul>
          {data?.conversations.map((c) => (
            <li key={c.id}>
              <Link to={`/messages/${c.id}`} className={`conv${c.id === activeId ? ' active' : ''}`}>
                <Avatar name={c.kind === 'section' ? `# ${c.title}` : c.title} online={c.kind === 'direct' ? otherOnline(c) : undefined} size={38} />
                <span className="conv-text">
                  <span className="conv-title">{c.kind === 'section' ? `${c.title} class` : c.title}</span>
                  <span className="conv-last">{c.lastMessage ? `${c.lastMessage.senderId === user.id ? 'You' : c.lastMessage.senderName.split(' ')[0]}: ${c.lastMessage.body}` : 'No messages yet'}</span>
                </span>
                {c.unread ? <b className="badge">{c.unread}</b> : null}
              </Link>
            </li>
          ))}
        </ul>
      </aside>
      <section className="thread-col">
        {active ? (
          <Thread key={active.id} conversation={active} online={online} />
        ) : (
          <Empty title="Pick a conversation">Messages arrive instantly. Students can message their teachers and the office; parents can message their children’s teachers.</Empty>
        )}
      </section>
      {picking ? (
        <ContactPicker
          onClose={() => setPicking(false)}
          onPick={async (contact) => {
            const res = await api('/api/conversations', { method: 'POST', body: { userId: contact.id } });
            setPicking(false);
            await reload();
            navigate(`/messages/${res.conversation.id}`);
          }}
        />
      ) : null}
    </div>
  );
}

function Thread({ conversation, online }) {
  const { user, realtime } = useApp();
  const fmt = useFormat();
  const { data, error, setData } = useApi(`/api/conversations/${conversation.id}/messages`);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [typing, setTyping] = useState(null);
  const endRef = useRef(null);
  const lastTyping = useRef(0);
  const typingTimer = useRef(null);

  useEffect(() => {
    api(`/api/conversations/${conversation.id}/read`, { method: 'POST', body: {} }).catch(() => {});
  }, [conversation.id, data?.messages.length]);
  useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView, which React would treat as a cleanup.
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [data?.messages.length, typing]);

  useEvent('message.created', (m) => {
    if (m.conversationId !== conversation.id) return;
    setData((d) => (d && !d.messages.some((x) => x.id === m.id) ? { messages: [...d.messages, m] } : d));
    if (m.senderId !== user.id) setTyping(null);
  });
  useEvent('typing', (t) => {
    if (t.conversationId !== conversation.id) return;
    setTyping(t.name);
    clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => setTyping(null), 3000);
  });

  async function send(e) {
    e.preventDefault();
    const text = body.trim();
    if (!text) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await api(`/api/conversations/${conversation.id}/messages`, { method: 'POST', body: { body: text } });
      setBody('');
      setData((d) => (d && !d.messages.some((x) => x.id === res.message.id) ? { messages: [...d.messages, res.message] } : d));
    } catch (err) {
      setSendError(err);
    } finally {
      setSending(false);
    }
  }

  function onType(e) {
    setBody(e.target.value);
    if (Date.now() - lastTyping.current > 1500) {
      lastTyping.current = Date.now();
      realtime?.send({ type: 'typing', conversationId: conversation.id });
    }
  }

  const others = conversation.members.filter((m) => m.id !== user.id);
  let lastDay = null;
  return (
    <div className="thread">
      <header className="thread-head">
        <Link to="/messages" className="back">‹</Link>
        <div>
          <h2>{conversation.kind === 'section' ? `${conversation.title} class` : conversation.title}</h2>
          <p className="muted small">
            {conversation.kind === 'section'
              ? `${conversation.members.length} members`
              : others.map((o) => `${ROLE_LABEL[o.role]}${online.has(o.id) ? ', online now' : ''}`).join(', ')}
          </p>
        </div>
      </header>
      <ErrorNote error={error} />
      <div className="thread-body" aria-live="polite">
        {!data ? <Loading /> : null}
        {data?.messages.map((m) => {
          const day = fmt.dayKey(m.createdAt);
          const divider = day !== lastDay ? <p className="day-divider" key={`d-${day}`}>{fmt.date(m.createdAt)}</p> : null;
          lastDay = day;
          const mine = m.senderId === user.id;
          return [
            divider,
            <div key={m.id} className={`msg${mine ? ' mine' : ''}`} data-testid="message">
              {!mine && conversation.kind === 'section' ? <span className="msg-author">{m.senderName}</span> : null}
              <p>{m.body}</p>
              <time dateTime={m.createdAt}>{fmt.time(m.createdAt)}</time>
            </div>,
          ];
        })}
        {typing ? <p className="typing">{typing} is typing…</p> : null}
        <div ref={endRef} />
      </div>
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="composer">Message</label>
        <textarea
          id="composer"
          rows={1}
          value={body}
          onChange={onType}
          placeholder="Write a message"
          maxLength={2000}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) send(e);
          }}
        />
        <Button variant="primary" type="submit" busy={sending} disabled={!body.trim()}>Send</Button>
      </form>
      <ErrorNote error={sendError} />
    </div>
  );
}

function ContactPicker({ onClose, onPick }) {
  const { data, error } = useApi('/api/messages/contacts');
  const [q, setQ] = useState('');
  const list = (data?.contacts ?? []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="New message" onClose={onClose}>
      <input className="search" placeholder="Search people you can message" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ErrorNote error={error} />
      <ul className="contacts">
        {list.map((c) => (
          <li key={c.id}>
            <button onClick={() => onPick(c)}>
              <Avatar name={c.name} size={30} /> <span>{c.name}</span> <span className="muted small">{ROLE_LABEL[c.role]}</span>
            </button>
          </li>
        ))}
      </ul>
      {data && !list.length ? <p className="muted">No one matches.</p> : null}
    </Modal>
  );
}
