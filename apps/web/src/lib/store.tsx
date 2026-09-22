'use client';

/**
 * Application state: who is signed in, and everything the screens read.
 *
 * One hydration pulls each collection the current role is allowed to see, and
 * mutations re-hydrate rather than patching locally — the server is the
 * authority on what a role may see, and a locally patched cache drifts from it.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { api, ApiError, setToken, getToken } from './api';
import { connectSocket, disconnectSocket, on } from './socket';
import type {
  Announcement, AttendanceRow, ClassRequest, ClassSession, Folder, Invoice,
  Notification, PayrollBatch, PayrollPolicy, ResetRequest, Resource, User,
} from './types';

export interface Toast {
  id: number; kind: 'ok' | 'warn' | 'err'; title: string; body?: string;
}

interface State {
  ready: boolean;
  user: User | null;
  users: User[];
  folders: Folder[];
  resources: Resource[];
  announcements: Announcement[];
  requests: ClassRequest[];
  sessions: ClassSession[];
  attendance: AttendanceRow[];
  payroll: PayrollBatch[];
  invoices: Invoice[];
  notifications: Notification[];
  resets: ResetRequest[];
  policy: PayrollPolicy;
  toasts: Toast[];
}

const emptyState: State = {
  ready: false, user: null, users: [], folders: [], resources: [], announcements: [],
  requests: [], sessions: [], attendance: [], payroll: [], invoices: [],
  notifications: [], resets: [], policy: { graceMinutes: 5, latePenalty: 1.5 }, toasts: [],
};

interface Store extends State {
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<User>;
  signOut: () => Promise<void>;
  toast: (kind: Toast['kind'], title: string, body?: string) => void;
  dismissToast: (id: number) => void;
  /** Runs a mutation, re-hydrates, and reports failure as a toast. */
  run: <T,>(action: () => Promise<T>, success?: { title: string; body?: string }) => Promise<T | null>;
  userById: (id: string) => User;
  unread: number;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(emptyState);
  const toastId = useRef(0);

  const toast = useCallback((kind: Toast['kind'], title: string, body?: string) => {
    const id = (toastId.current += 1);
    setState((s) => ({ ...s, toasts: [...s.toasts, { id, kind, title, body }] }));
    setTimeout(() => {
      setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
  }, []);

  const hydrate = useCallback(async (): Promise<void> => {
    const { user } = await api.me();

    const [folders, announcements, requests, sessions, notifications] = await Promise.all([
      api.folders().then((r) => r.folders).catch(() => []),
      api.announcements().then((r) => r.announcements).catch(() => []),
      api.requests().then((r) => r.requests).catch(() => []),
      api.sessions().then((r) => r.sessions).catch(() => []),
      api.notifications().then((r) => r.notifications).catch(() => []),
    ]);

    const resourceLists = await Promise.all(
      folders.map((f) => api.resources(f.id).then((r) => r.resources).catch(() => [])));

    const [users, attendanceResult, payroll, invoices, resets] = await Promise.all([
      api.users().then((r) => r.users).catch(() => []),
      user.role === 'student'
        ? Promise.resolve({ attendance: [], policy: { graceMinutes: 5, latePenalty: 1.5 } })
        : api.attendance().catch(() => ({ attendance: [], policy: { graceMinutes: 5, latePenalty: 1.5 } })),
      user.role === 'student' ? Promise.resolve([]) : api.payrollBatches().then((r) => r.batches).catch(() => []),
      user.role === 'teacher' ? Promise.resolve([]) : api.invoices().then((r) => r.invoices).catch(() => []),
      user.role === 'owner' ? api.resetRequests().then((r) => r.resets).catch(() => []) : Promise.resolve([]),
    ]);

    setState((s) => ({
      ...s, ready: true, user, users, folders,
      resources: resourceLists.flat(),
      announcements, requests, sessions,
      attendance: attendanceResult.attendance,
      policy: attendanceResult.policy,
      payroll, invoices, resets, notifications,
    }));
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) return;
    try { await hydrate(); }
    catch (err) {
      if ((err as ApiError).status === 401) {
        setToken('');
        disconnectSocket();
        setState({ ...emptyState, ready: true });
      }
    }
  }, [hydrate]);

  /* boot */
  useEffect(() => {
    if (!getToken()) { setState((s) => ({ ...s, ready: true })); return; }
    void (async () => {
      try {
        await hydrate();
        connectSocket();
      } catch {
        setToken('');
        setState({ ...emptyState, ready: true });
      }
    })();
  }, [hydrate]);

  /* realtime */
  useEffect(() => {
    if (!state.user) return undefined;
    const offNotification = on<Notification>('notification:new', (note) => {
      setState((s) => ({ ...s, notifications: [note, ...s.notifications] }));
      toast('ok', note.title, note.body);
    });
    const offRequest = on('classroom:request', () => { void refresh(); });
    const offAccepted = on('classroom:accepted', () => { void refresh(); });
    return () => { offNotification(); offRequest(); offAccepted(); };
  }, [state.user, refresh, toast]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { token, user } = await api.login(email, password);
    setToken(token);
    await hydrate();
    connectSocket();
    return user;
  }, [hydrate]);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setToken('');
    disconnectSocket();
    setState({ ...emptyState, ready: true });
  }, []);

  const run = useCallback(async <T,>(
    action: () => Promise<T>, success?: { title: string; body?: string },
  ): Promise<T | null> => {
    try {
      const result = await action();
      await refresh();
      if (success) toast('ok', success.title, success.body);
      return result;
    } catch (err) {
      toast('err', 'That did not work', (err as Error).message);
      return null;
    }
  }, [refresh, toast]);

  const userById = useCallback((id: string): User => (
    state.users.find((u) => u.id === id)
    ?? { id, name: 'Unknown', email: '', role: 'student', status: 'active',
         locale: 'en-US', tz: 'UTC', subjects: [], joinedAt: new Date().toISOString() }
  ), [state.users]);

  const value = useMemo<Store>(() => ({
    ...state,
    refresh, signIn, signOut, toast, dismissToast, run, userById,
    unread: state.notifications.filter((n) => !n.read).length,
  }), [state, refresh, signIn, signOut, toast, dismissToast, run, userById]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside StoreProvider');
  return store;
}
