/** The shapes the API returns. These mirror apps/server/src/lib/serialize.ts. */

export type Role = 'owner' | 'teacher' | 'student';
export type Subject = 'math' | 'english';
export type UserStatus = 'active' | 'pending' | 'suspended';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  locale: string;
  tz: string;
  subjects: Subject[];
  hourlyRate?: number;
  gradeLevel?: string;
  bio?: string;
  seeded?: boolean;
  joinedAt: string;
}

export interface Folder {
  id: string; teacherId: string; name: string; subject: Subject;
  createdAt: string; fileCount?: number;
}

export interface Resource {
  id: string; folderId: string; teacherId: string; name: string;
  ext: string; bytes: number; uploadedAt: string;
}

export interface Announcement {
  id: string; authorId: string; title: string; body: string;
  audience: 'all' | 'teachers' | 'students'; pinned: boolean; createdAt: string;
}

export type RequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export interface ClassRequest {
  id: string; studentId: string; teacherId: string; subject: Subject;
  topic: string; note: string; requestedFor: string; minutes: number;
  status: RequestStatus; createdAt: string;
}

export type SessionStatus = 'scheduled' | 'live' | 'completed' | 'no_show' | 'cancelled';

export interface ClassSession {
  id: string; requestId: string | null; teacherId: string; studentId: string;
  subject: Subject; topic: string; startsAt: string; minutes: number;
  status: SessionStatus; joinedAt: string | null; endedAt: string | null;
  recordingUrl: string | null;
}

export interface AttendanceRow {
  id: string; teacherId: string; sessionId: string; scheduledStart: string;
  clockIn: string | null; clockOut: string | null;
  minutesLate: number | null; noShow: boolean; deduction: number;
  topic?: string; sessionMinutes?: number;
}

export interface PayrollLine {
  teacherId: string; sessions: number; minutes: number; lateMinutes: number;
  noShows: number; gross: number; deductions: number; net: number;
}

export interface PayrollBatch {
  id: string; periodStart: string; periodEnd: string;
  status: 'draft' | 'approved' | 'paid'; createdAt: string; lines: PayrollLine[];
}

export interface Invoice {
  id: string; number: string; studentId: string; amount: number; currency: string;
  status: 'draft' | 'open' | 'paid' | 'void'; issuedAt: string; dueAt: string;
  paidAt?: string; stripeId: string; lines: Array<{ label: string; amount: number }>;
}

export interface Notification {
  id: string; userId: string; type: string; title: string; body: string;
  url?: string; read: boolean; createdAt: string;
}

export interface ResetRequest {
  id: string; userId: string; email: string;
  status: 'pending' | 'approved' | 'rejected'; requestedAt: string;
}

export interface ChatMessage {
  id: string; sessionId: string; from: string; text: string; at: string;
}

export interface PayrollPolicy { graceMinutes: number; latePenalty: number; currency?: string }

export interface PhonemeScore { phoneme: string; accuracy: number | null }
export interface WordScore {
  word: string; accuracy: number | null; errorType: string; phonemes: PhonemeScore[];
}
export interface Assessment {
  recognizedText: string;
  scores: {
    accuracy: number | null; fluency: number | null; completeness: number | null;
    pronunciation: number | null; prosody: number | null;
  };
  words: WordScore[];
  durationSeconds: number | null;
  provider: string;
}

export interface SpeechStatus {
  configured: boolean; reason: string | null; language?: string; provider?: string;
}

export interface SfuCredentials {
  available: boolean; url?: string; token?: string; room?: string;
  canRecord?: boolean; reason?: string;
}

export interface RecordingEstimate {
  minutes: number; preset: string; bytes: number; configured: boolean;
  reason: string | null;
  presets: Record<string, { label: string; bytes: number }>;
}

export interface Health {
  ok: boolean;
  integrations: { stripe: boolean; webPush: boolean; s3: boolean; recording: boolean; speech: boolean };
  policy: { uploadMaxBytes: number; payrollGraceMinutes: number; payrollLatePenalty: number; currency: string };
}
