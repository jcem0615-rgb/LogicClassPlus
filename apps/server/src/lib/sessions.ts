/**
 * Who is in a class.
 *
 * A session used to carry one `studentId`, so "is this person in it" was a
 * field comparison written out at each call site — the gateway, the REST
 * guard, the speech routes and the realtime token all had their own copy.
 * With seats there is a list to check instead, and six copies of a list
 * membership test is six chances to forget the teacher, or the Owner, or to
 * let a parent into a room they may only read about. It is answered here.
 */
import { prisma } from '../prisma.js';
import type { ClassSession, Role, SessionParticipant } from '@prisma/client';
import { canSeeStudent } from './scope.js';

export interface Actor { id: string; role: Role }

export type SessionWithSeats = ClassSession & { participants: SessionParticipant[] };

/** Include clause that gives a session its seats, oldest booking first. */
export const withSeats = {
  participants: { orderBy: { bookedAt: 'asc' } },
} satisfies { participants: { orderBy: { bookedAt: 'asc' } } };

export const studentIdsOf = (s: SessionWithSeats): string[] =>
  s.participants.map((p) => p.studentId);

export const seatsLeft = (s: SessionWithSeats): number =>
  Math.max(0, s.capacity - s.participants.length);

export const isGroup = (s: Pick<ClassSession, 'capacity'>): boolean => s.capacity > 1;

/** Teacher or a booked student. This is the test for entering the room. */
export function isInRoom(s: SessionWithSeats, userId: string): boolean {
  return s.teacherId === userId || s.participants.some((p) => p.studentId === userId);
}

/**
 * May this actor open the session's record? Wider than `isInRoom`: the Owner
 * sees everything and a parent may read a class their child is sitting in —
 * but neither of those is the same as being allowed into the room, which is
 * why the two tests are separate functions rather than one with a flag.
 */
export async function canReadSession(me: Actor, s: SessionWithSeats): Promise<boolean> {
  if (me.role === 'OWNER' || isInRoom(s, me.id)) return true;
  if (me.role !== 'PARENT') return false;
  for (const id of studentIdsOf(s)) {
    if (await canSeeStudent(me, id)) return true;
  }
  return false;
}

/** The room gate, for the socket layer where only an id is in hand. */
export async function canEnterRoom(me: Actor, sessionId: string): Promise<boolean> {
  if (me.role === 'OWNER') return true;
  const session = await prisma.classSession.findUnique({
    where: { id: sessionId },
    select: { teacherId: true, participants: { select: { studentId: true } } },
  });
  if (!session) return false;
  return session.teacherId === me.id || session.participants.some((p) => p.studentId === me.id);
}

/** Everyone to tell when something happens to a class: its students. */
export async function studentIdsIn(sessionId: string): Promise<string[]> {
  const rows = await prisma.sessionParticipant.findMany({
    where: { sessionId }, select: { studentId: true },
  });
  return rows.map((r) => r.studentId);
}

/* ---------------- calling a class off, and moving it ----------------
   Who may do either is not the same question as who may read the class or
   enter its room, so it gets its own pair of tests rather than another flag
   on `canReadSession`. */

export type Cancellable = Pick<ClassSession, 'teacherId' | 'capacity'> & {
  participants: Array<Pick<SessionParticipant, 'studentId'>>;
};

/**
 * The teacher who is giving the class, the Owner, or — on a private lesson —
 * the student whose lesson it is. A student in a *group* class releases their
 * seat instead: one of six people walking out should not end the class for
 * the other five, and `DELETE /sessions/:id/book` is how they leave.
 */
export function canCancel(me: Actor, s: Cancellable): boolean {
  if (me.role === 'OWNER') return true;
  if (me.role === 'TEACHER') return s.teacherId === me.id;
  if (me.role === 'STUDENT') {
    return !isGroup(s) && s.participants.some((p) => p.studentId === me.id);
  }
  // A parent may read their child's class. Calling it off is somebody else's
  // decision — theirs to ask for, not to make.
  return false;
}

/** Moving a class is the teacher's or the Owner's; a student cancels and asks again. */
export const canReschedule = (me: Actor, s: Pick<ClassSession, 'teacherId'>): boolean =>
  me.role === 'OWNER' || (me.role === 'TEACHER' && s.teacherId === me.id);

/**
 * Was this called off late enough to have cost somebody their afternoon?
 * Derived rather than stored: the window is configuration, and a stored
 * boolean would be wrong the moment the Owner changed it.
 */
export function isShortNotice(
  s: Pick<ClassSession, 'startsAt' | 'cancelledAt'>, windowHours: number,
): boolean {
  if (!s.cancelledAt) return false;
  return s.startsAt.getTime() - s.cancelledAt.getTime() < windowHours * 3_600_000;
}
