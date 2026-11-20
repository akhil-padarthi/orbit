import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

/** Tiny history-API router. */
export function useRouter() {
  const [path, setPath] = useState(location.pathname + location.search);
  useEffect(() => {
    const onPop = () => setPath(location.pathname + location.search);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to, { replace = false } = {}) => {
    if (to === location.pathname + location.search) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  return { path, navigate };
}

export function matchRoute(pattern, pathname) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  const m = re.exec(pathname);
  if (!m) return null;
  return Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
}

/** Subscribe to a realtime event for the lifetime of a component. */
export function useEvent(type, handler) {
  const { realtime } = useApp();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => realtime?.on(type, (d) => ref.current(d)), [realtime, type]);
}

/** Fetch JSON from the API; returns { data, error, loading, reload, setData }. */
export function useApi(path, query, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const key = path ? path + JSON.stringify(query ?? {}) : null;
  const reload = useCallback(async () => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await api(path, { query });
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState({ data: null, error, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
  useEffect(() => {
    reload();
  }, [reload]);
  const setData = (fn) => setState((s) => ({ ...s, data: typeof fn === 'function' ? fn(s.data) : fn }));
  return { ...state, reload, setData };
}

// ---- formatting (always in the school's time zone) ---------------------------
export function useFormat() {
  const { user } = useApp();
  const timeZone = user?.tenant?.timezone ?? 'UTC';
  return {
    timeZone,
    time: (iso) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)),
    date: (iso) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso)),
    longDate: (iso) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(iso)),
    dayKey: (iso) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)),
    hour: () => Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(new Date())),
  };
}

export function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const STATUS_LABEL = { present: 'Present', late: 'Late', absent: 'Absent', excused: 'Excused' };
export const ROLE_LABEL = { admin: 'Administrator', teacher: 'Teacher', student: 'Student', parent: 'Parent' };
