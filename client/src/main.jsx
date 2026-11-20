import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import './styles.css';
import { refreshSession, session, logout as apiLogout, api } from './api.js';
import { RealtimeClient } from './realtime.js';
import { AppContext, useRouter, matchRoute, useApp, ROLE_LABEL, timeAgo } from './context.jsx';
import { Link, Avatar, Loading } from './ui.jsx';
import { Icon, Logo } from './brand.jsx';
import { Login } from './pages/Login.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { Schedule } from './pages/Schedule.jsx';
import { SessionPage } from './pages/Session.jsx';
import { Attendance } from './pages/Attendance.jsx';
import { Requests } from './pages/Requests.jsx';
import { Messages } from './pages/Messages.jsx';
import { People } from './pages/People.jsx';
import { Integrations } from './pages/Integrations.jsx';
import { Campus } from './pages/Campus.jsx';

const NAV = [
  { to: '/', label: 'Today', roles: ['admin', 'teacher', 'student', 'parent'], icon: 'sun' },
  { to: '/schedule', label: 'Schedule', roles: ['admin', 'teacher', 'student', 'parent'], icon: 'calendar' },
  { to: '/attendance', label: 'Attendance', roles: ['admin', 'teacher', 'student', 'parent'], icon: 'check' },
  { to: '/requests', label: 'Requests', roles: ['admin', 'teacher', 'student', 'parent'], icon: 'inbox', badge: 'requests' },
  { to: '/messages', label: 'Messages', roles: ['admin', 'teacher', 'student', 'parent'], icon: 'chat', badge: 'messages' },
  { to: '/people', label: 'People', roles: ['admin', 'teacher'], icon: 'people' },
  { to: '/integrations', label: 'Integrations', roles: ['admin'], icon: 'sync' },
  { to: '/campus', label: 'Campus', roles: ['admin'], icon: 'pin' },
];

const ROUTES = [
  ['/', Dashboard],
  ['/schedule', Schedule],
  ['/sessions/:id', SessionPage],
  ['/attendance', Attendance],
  ['/requests', Requests],
  ['/messages', Messages],
  ['/messages/:id', Messages],
  ['/people', People],
  ['/integrations', Integrations],
  ['/campus', Campus],
];

function App() {
  const { path, navigate } = useRouter();
  const [user, setUser] = useState(undefined); // undefined = restoring session
  const [realtime, setRealtime] = useState(null);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    refreshSession().then((d) => setUser(d.user)).catch(() => setUser(null));
    return session.onExpired(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    const rt = new RealtimeClient();
    rt.connect();
    setRealtime(rt);
    return () => {
      rt.close();
      setRealtime(null);
    };
  }, [user?.id]);

  const toast = useCallback((text, tone = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t.slice(-3), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setUser(null);
    navigate('/', { replace: true });
  }, [navigate]);

  const ctx = useMemo(() => ({ user, setUser, realtime, navigate, path, toast, signOut }), [user, realtime, navigate, path, toast, signOut]);

  if (user === undefined) return <div className="boot"><Loading label="Opening Orbit…" /></div>;

  return (
    <AppContext.Provider value={ctx}>
      {user ? <Shell /> : <Login />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

function Shell() {
  const { user, path, realtime, toast, signOut } = useApp();
  const [status, setStatus] = useState(realtime?.status ?? 'connecting');
  const [badges, setBadges] = useState({ messages: 0, requests: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = path.split('?')[0];

  const loadBadges = useCallback(async () => {
    try {
      const [conv, req] = await Promise.all([
        api('/api/conversations'),
        user.role === 'admin' || user.role === 'teacher' ? api('/api/requests', { query: { scope: 'to_decide' } }) : Promise.resolve({ requests: [] }),
      ]);
      setBadges({ messages: conv.conversations.reduce((n, c) => n + c.unread, 0), requests: req.requests.length });
    } catch {
      /* badges are best-effort */
    }
  }, [user.role]);

  useEffect(() => {
    loadBadges();
  }, [loadBadges, pathname]);

  useEffect(() => {
    if (!realtime) return;
    setStatus(realtime.status);
    const offs = [
      realtime.on('status', setStatus),
      realtime.on('message.created', (m) => {
        if (m.senderId !== user.id && !pathname.startsWith(`/messages/${m.conversationId}`)) {
          toast(`${m.senderName}: ${m.body.slice(0, 80)}`, 'message');
        }
        loadBadges();
      }),
      realtime.on('request.updated', loadBadges),
      realtime.on('announcement.created', (a) => a.authorId !== user.id && toast(`📣 ${a.title}`, 'info')),
    ];
    return () => offs.forEach((off) => off());
  }, [realtime, pathname, loadBadges]);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  let Page = null;
  let params = {};
  for (const [pattern, Component] of ROUTES) {
    const m = matchRoute(pattern, pathname);
    if (m) {
      Page = Component;
      params = m;
      break;
    }
  }
  const navItem = NAV.find((n) => n.to === '/' + pathname.split('/')[1]);
  const allowed = !navItem || navItem.roles.includes(user.role) || pathname.startsWith('/sessions/');

  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <Logo light />
          <p className="school">{user.tenant.name}</p>
        </div>
        <nav aria-label="Main">
          {NAV.filter((n) => n.roles.includes(user.role)).map((n) => {
            const active = n.to === '/' ? pathname === '/' : pathname.startsWith(n.to);
            const count = n.badge ? badges[n.badge] : 0;
            return (
              <Link key={n.to} to={n.to} className={`nav-link${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}>
                <Icon name={n.icon} />
                <span>{n.to === '/requests' && user.role === 'student' ? 'Flex & requests' : n.to === '/requests' && user.role === 'parent' ? 'Excuses' : n.label}</span>
                {count ? <b className="badge" aria-label={`${count} new`}>{count}</b> : null}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-user">
          <Avatar name={user.name} size={34} />
          <div>
            <p className="who">{user.name}</p>
            <p className="role">{ROLE_LABEL[user.role]}</p>
          </div>
          <button className="signout" onClick={signOut}>Sign out</button>
        </div>
      </aside>

      <div className="main-col">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu">
            <Icon name="menu" />
          </button>
          <span className="mobile-logo"><Logo /></span>
          <span className={`conn conn-${status}`} title={status === 'live' ? 'Real-time updates are on' : 'Reconnecting to live updates'}>
            <i /> {status === 'live' ? 'Live' : 'Reconnecting…'}
          </span>
          <Notifications />
        </header>
        <main className="content" id="main">
          {Page && allowed ? <Page params={params} /> : <div className="page"><h1>Not available</h1><p className="muted">This page isn’t part of your account.</p></div>}
        </main>
      </div>
    </div>
  );
}

function Notifications() {
  const { realtime, toast, navigate } = useApp();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ notifications: [], unread: 0 });
  const load = useCallback(() => api('/api/notifications').then(setData).catch(() => {}), []);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!realtime) return;
    return realtime.on('notification', (n) => {
      setData((d) => ({ notifications: [n, ...d.notifications].slice(0, 50), unread: d.unread + 1 }));
      toast(n.title, 'info');
    });
  }, [realtime, toast]);

  return (
    <div className="notif">
      <button className="icon-btn bell" onClick={() => setOpen((o) => !o)} aria-label={`Notifications${data.unread ? `, ${data.unread} unread` : ''}`} aria-expanded={open}>
        <Icon name="bell" />
        {data.unread ? <b className="dot-badge">{data.unread > 9 ? '9+' : data.unread}</b> : null}
      </button>
      {open ? (
        <div className="notif-panel">
          <div className="notif-head">
            <strong>Notifications</strong>
            {data.unread ? (
              <button className="text-btn" onClick={() => api('/api/notifications/read-all', { method: 'POST', body: {} }).then(load)}>Mark all read</button>
            ) : null}
          </div>
          {data.notifications.length ? (
            <ul>
              {data.notifications.map((n) => (
                <li key={n.id} className={n.readAt ? '' : 'unread'}>
                  <button
                    onClick={() => {
                      setOpen(false);
                      if (!n.readAt) api(`/api/notifications/${n.id}/read`, { method: 'POST', body: {} }).then(load);
                      if (n.link) navigate(n.link);
                    }}
                  >
                    <span className="n-title">{n.title}</span>
                    {n.body ? <span className="n-body">{n.body}</span> : null}
                    <span className="n-time">{timeAgo(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted pad">You’re all caught up.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
