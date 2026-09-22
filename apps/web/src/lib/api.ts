/**
 * Typed client for the LogicClass+ API.
 *
 * The token lives in localStorage rather than a cookie the browser sends
 * automatically: the API is a separate origin, and an explicit Authorization
 * header keeps CSRF off the table entirely.
 */
import type {
  Announcement, Assessment, AttendanceRow, ChatMessage, ClassRequest, ClassSession,
  Folder, Health, Invoice, Notification, PayrollBatch, PayrollLine, PayrollPolicy,
  RecordingEstimate, ResetRequest, Resource, SfuCredentials, SpeechStatus, Subject, User,
} from './types';

const TOKEN_KEY = 'logicclass.token';

export const apiUrl = (): string =>
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';

export function getToken(): string {
  if (typeof window === 'undefined') return '';
  try { return window.localStorage.getItem(TOKEN_KEY) ?? ''; } catch { return ''; }
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    token ? window.localStorage.setItem(TOKEN_KEY, token)
          : window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* private window */ }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = 'error') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${apiUrl()}/api${path}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const error = (body as { error?: { message?: string; code?: string } } | null)?.error;
    throw new ApiError(error?.message ?? `Request failed (${res.status})`, res.status, error?.code);
  }
  return body as T;
}

const get = <T,>(path: string) => request<T>(path);
const post = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) });
const put = <T,>(path: string, body?: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) });
const del = <T,>(path: string) => request<T>(path, { method: 'DELETE' });

export const api = {
  health: () => get<Health>('/health'),

  /* auth */
  login: (email: string, password: string) =>
    post<{ token: string; user: User }>('/auth/login', { email, password }),
  register: (input: {
    name: string; email: string; password: string;
    role: 'teacher' | 'student'; subjects: Subject[]; timezone?: string;
  }) => post<{ user: User; pending: boolean }>('/auth/register', input),
  logout: () => post<{ ok: true }>('/auth/logout'),
  me: () => get<{ user: User }>('/auth/me'),
  requestPasswordReset: (email: string) => post<{ ok: true }>('/auth/password-reset', { email }),

  /* people */
  users: () => get<{ users: User[] }>('/users'),
  approveUser: (id: string) => patch<{ user: User }>(`/users/${id}/approve`),
  setUserStatus: (id: string, status: 'active' | 'suspended') =>
    patch<{ user: User }>(`/users/${id}/status`, { status }),
  deleteUser: (id: string) => del<{ ok: true }>(`/users/${id}`),
  saveProfile: (input: {
    name?: string; locale?: string; timezone?: string; bio?: string; hourlyRate?: number;
  }) => patch<{ user: User }>('/users/me', input),
  resetRequests: () => get<{ resets: ResetRequest[] }>('/users/reset-requests'),
  resolveReset: (id: string, decision: 'approve' | 'reject') =>
    patch<{ reset: ResetRequest; resetLink?: string }>(`/users/reset-requests/${id}`, { decision }),

  /* library */
  folders: () => get<{ folders: Folder[] }>('/library/folders'),
  createFolder: (name: string, subject: Subject) =>
    post<{ folder: Folder }>('/library/folders', { name, subject }),
  resources: (folderId: string) =>
    get<{ resources: Resource[] }>(`/library/folders/${folderId}/resources`),
  uploadTicket: (input: { folderId: string; filename: string; bytes: number; mimeType?: string }) =>
    post<{ ticket: { storageKey: string; uploadUrl: string | null; driver: 's3' | 'local' } }>(
      '/library/uploads', input),
  uploadLocal: (storageKey: string, dataBase64: string) =>
    post<{ ok: true }>('/library/uploads/local', { storageKey, dataBase64 }),
  commitResource: (input: {
    folderId: string; filename: string; bytes: number; storageKey: string; mimeType?: string;
  }) => post<{ resource: Resource }>('/library/resources', input),
  resourceUrl: (id: string) =>
    get<{ url: string | null; expiresIn: number }>(`/library/resources/${id}/url`),
  deleteResource: (id: string) => del<{ ok: true }>(`/library/resources/${id}`),

  /* announcements */
  announcements: () => get<{ announcements: Announcement[] }>('/announcements'),
  postAnnouncement: (input: {
    title: string; body: string; audience: 'all' | 'teachers' | 'students'; pinned: boolean;
  }) => post<{ announcement: Announcement; notified: number }>('/announcements', input),
  deleteAnnouncement: (id: string) => del<{ ok: true }>(`/announcements/${id}`),

  /* classes */
  requests: () => get<{ requests: ClassRequest[] }>('/classes/requests'),
  createRequest: (input: {
    teacherId: string; subject: Subject; topic: string; note?: string;
    requestedFor: string; minutes: number;
  }) => post<{ request: ClassRequest }>('/classes/requests', input),
  decideRequest: (id: string, decision: 'accept' | 'decline') =>
    patch<{ request: ClassRequest; session?: ClassSession }>(`/classes/requests/${id}`, { decision }),
  sessions: () => get<{ sessions: ClassSession[] }>('/classes/sessions'),
  session: (id: string) => get<{
    session: ClassSession; documents: Record<string, string>; messages: ChatMessage[];
  }>(`/classes/sessions/${id}`),
  joinSession: (id: string) => post<{ session: ClassSession }>(`/classes/sessions/${id}/join`),
  leaveSession: (id: string) => post<{ session: ClassSession }>(`/classes/sessions/${id}/leave`),
  completeSession: (id: string, outcome: 'completed' | 'no_show') =>
    post<{ session: ClassSession }>(`/classes/sessions/${id}/complete`, { outcome }),
  saveDocument: (id: string, kind: 'board' | 'document' | 'equation' | 'annotation', content: string) =>
    put<{ kind: string; updatedAt: string }>(`/classes/sessions/${id}/documents`, { kind, content }),
  sendMessage: (id: string, text: string) =>
    post<{ message: ChatMessage }>(`/classes/sessions/${id}/messages`, { text }),

  /* attendance & payroll */
  attendance: () => get<{ attendance: AttendanceRow[]; policy: PayrollPolicy }>('/attendance'),
  clockIn: (sessionId: string) =>
    post<{ attendance: AttendanceRow; graceMinutes: number }>('/attendance/clock-in', { sessionId }),
  clockOut: (id: string) => post<{ attendance: AttendanceRow }>(`/attendance/${id}/clock-out`),
  markNoShow: (sessionId: string) =>
    post<{ attendance: AttendanceRow }>('/attendance/no-show', { sessionId }),
  payrollPreview: () =>
    get<{ from: string; to: string; lines: PayrollLine[]; policy: PayrollPolicy }>('/payroll/preview'),
  payrollBatches: () => get<{ batches: PayrollBatch[] }>('/payroll/batches'),
  runPayroll: () => post<{ batch: PayrollBatch; lines: PayrollLine[] }>('/payroll/batches'),

  /* billing */
  invoices: () => get<{ invoices: Invoice[]; stripeConfigured: boolean }>('/billing/invoices'),
  payInvoice: (id: string) =>
    post<{ mode: 'stripe' | 'unconfigured'; clientSecret?: string; message?: string }>(
      `/billing/invoices/${id}/pay`),
  remindInvoice: (id: string) => post<{ ok: true }>(`/billing/invoices/${id}/remind`),
  settleInvoice: (id: string) => post<{ invoice: Invoice }>(`/billing/invoices/${id}/settle`),

  /* notifications */
  notifications: () => get<{ notifications: Notification[]; unread: number }>('/notifications'),
  markNotificationsRead: () => post<{ ok: true }>('/notifications/read'),
  pushKey: () => get<{ publicKey: string | null; configured: boolean }>('/notifications/push-key'),
  subscribePush: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    post<{ ok: true }>('/notifications/subscribe', { endpoint, keys }),

  /* realtime & media */
  iceServers: () => get<{ iceServers: RTCIceServer[]; turnConfigured: boolean }>('/realtime/ice'),
  sfu: async (sessionId: string): Promise<SfuCredentials> => {
    try {
      const r = await get<{ url: string; token: string; room: string; canRecord: boolean }>(
        `/realtime/sfu/${sessionId}`);
      return { available: true, ...r };
    } catch (err) {
      return { available: false, reason: (err as ApiError).message };
    }
  },

  /* recording */
  recordingEstimate: (minutes: number) =>
    get<RecordingEstimate>(`/recordings/estimate?minutes=${minutes}`),
  startRecording: (sessionId: string) =>
    post<{ egressId: string; estimatedBytes: number; preset: string }>(`/recordings/${sessionId}/start`),
  stopRecording: (sessionId: string) =>
    post<{ ok: true; note: string }>(`/recordings/${sessionId}/stop`),
  recordingUsage: () => get<{
    recordings: number; totalBytes: number; totalHours: number;
    last30DaysBytes: number; projectedAnnualBytes: number; preset: string;
  }>('/recordings/usage'),

  /* pronunciation */
  speechStatus: () => get<SpeechStatus>('/speech/status'),
  assess: (input: { referenceText: string; audioBase64: string; sessionId?: string }) =>
    post<Assessment & { attempt: { id: string; createdAt: string } }>('/speech/assess', input),
  attempts: (params: { sessionId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.sessionId) query.set('sessionId', params.sessionId);
    if (params.limit) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return get<{ attempts: Array<{
      id: string; referenceText: string; scores: Assessment['scores']; createdAt: string;
    }> }>(`/speech/attempts${suffix ? `?${suffix}` : ''}`);
  },
};

export type { PayrollLine };
