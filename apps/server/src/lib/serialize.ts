import type {
  Announcement, Attendance, ChatMessage, ClassRequest, ClassSession, Folder,
  Invoice, InvoiceLine, Notification, PasswordResetRequest, PayrollBatch,
  PayrollLine, Resource, User,
} from '@prisma/client';
import { fromCents } from './money.js';

/** The public shape of a user. The password hash never leaves this module. */
export function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role.toLowerCase(),
    status: u.status.toLowerCase(),
    locale: u.locale,
    tz: u.timezone,
    subjects: u.subjects.map((s) => s.toLowerCase()),
    hourlyRate: u.hourlyRateCents == null ? undefined : fromCents(u.hourlyRateCents),
    gradeLevel: u.gradeLevel ?? undefined,
    bio: u.bio ?? undefined,
    seeded: u.seeded,
    joinedAt: u.createdAt.toISOString(),
  };
}

export const publicFolder = (f: Folder) => ({
  id: f.id, teacherId: f.teacherId, parentId: f.parentId ?? undefined,
  name: f.name, subject: f.subject.toLowerCase(), createdAt: f.createdAt.toISOString(),
});

export const publicResource = (r: Resource) => ({
  id: r.id, folderId: r.folderId, teacherId: r.teacherId, name: r.name,
  ext: r.ext, bytes: r.bytes, storageKey: r.storageKey, uploadedAt: r.createdAt.toISOString(),
});

export const publicAnnouncement = (a: Announcement) => ({
  id: a.id, authorId: a.authorId, title: a.title, body: a.body,
  audience: a.audience.toLowerCase(), pinned: a.pinned, createdAt: a.createdAt.toISOString(),
});

export const publicRequest = (r: ClassRequest) => ({
  id: r.id, studentId: r.studentId, teacherId: r.teacherId, subject: r.subject.toLowerCase(),
  topic: r.topic, note: r.note ?? '', requestedFor: r.requestedFor.toISOString(),
  minutes: r.minutes, status: r.status.toLowerCase(), createdAt: r.createdAt.toISOString(),
});

export const publicSession = (s: ClassSession) => ({
  id: s.id, requestId: s.requestId ?? null, teacherId: s.teacherId, studentId: s.studentId,
  subject: s.subject.toLowerCase(), topic: s.topic, startsAt: s.startsAt.toISOString(),
  minutes: s.minutes, status: s.status.toLowerCase(),
  joinedAt: s.joinedAt?.toISOString() ?? null, endedAt: s.endedAt?.toISOString() ?? null,
  recordingUrl: s.recordingUrl,
});

export const publicAttendance = (a: Attendance) => ({
  id: a.id, teacherId: a.teacherId, sessionId: a.sessionId,
  scheduledStart: a.scheduledStart.toISOString(),
  clockIn: a.clockIn?.toISOString() ?? null, clockOut: a.clockOut?.toISOString() ?? null,
  minutesLate: a.noShow ? null : a.minutesLate, noShow: a.noShow,
  deduction: fromCents(a.deductionCents),
});

export const publicPayrollLine = (l: PayrollLine) => ({
  teacherId: l.teacherId, sessions: l.sessions, minutes: l.minutes, lateMinutes: l.lateMinutes,
  noShows: l.noShows, gross: fromCents(l.grossCents), deductions: fromCents(l.deductionCents),
  net: fromCents(l.netCents),
});

export const publicBatch = (b: PayrollBatch & { lines?: PayrollLine[] }) => ({
  id: b.id, periodStart: b.periodStart.toISOString(), periodEnd: b.periodEnd.toISOString(),
  status: b.status.toLowerCase(), approvedBy: b.approvedById ?? undefined,
  createdAt: b.createdAt.toISOString(), lines: (b.lines ?? []).map(publicPayrollLine),
});

export const publicInvoice = (i: Invoice & { lines?: InvoiceLine[] }) => ({
  id: i.id, number: i.number, studentId: i.studentId, amount: fromCents(i.amountCents),
  currency: i.currency, status: i.status.toLowerCase(), issuedAt: i.issuedAt.toISOString(),
  dueAt: i.dueAt.toISOString(), paidAt: i.paidAt?.toISOString() ?? undefined,
  stripeId: i.stripeInvoiceId ?? '—',
  lines: (i.lines ?? []).map((l) => ({ label: l.label, amount: fromCents(l.amountCents) })),
});

export const publicNotification = (n: Notification) => ({
  id: n.id, userId: n.userId, type: n.type, title: n.title, body: n.body,
  url: n.url ?? undefined, read: n.readAt != null, createdAt: n.createdAt.toISOString(),
});

export const publicReset = (r: PasswordResetRequest) => ({
  id: r.id, userId: r.userId, email: r.email, status: r.status.toLowerCase(),
  requestedAt: r.requestedAt.toISOString(),
});

export const publicMessage = (m: ChatMessage) => ({
  id: m.id, sessionId: m.sessionId, from: m.senderId, text: m.body, at: m.createdAt.toISOString(),
});
