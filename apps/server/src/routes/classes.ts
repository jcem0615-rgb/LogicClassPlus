import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/http-error.js';
import { visibleStudentIds } from '../lib/scope.js';
import {
  canCancel, canReadSession, canReschedule, isGroup, isInRoom, isShortNotice,
  seatsLeft, studentIdsOf, withSeats, type SessionWithSeats,
} from '../lib/sessions.js';
import {
  availabilityProblem, clashesFor, clashError, windowsFor,
  writeIntoFreeSlot, type Attendee,
} from '../lib/scheduling.js';
import { toCents } from '../lib/money.js';
import { publicMessage, publicRequest, publicSession } from '../lib/serialize.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import { notify } from '../services/notifications.js';
import {
  classBookedEmail, classCancelledEmail, classMovedEmail, sendEmail,
} from '../services/email.js';
import { emitToSession, emitToUser } from '../realtime/gateway.js';

export const classesRouter = Router();
classesRouter.use(requireAuth);

const subject = z.enum(['math', 'english']);

/**
 * A parent sees exactly what their children see, and nothing else. Without
 * this they fell into the student branch and queried `studentId: <parentId>`,
 * which returns nothing — wrong rather than leaky, but wrong.
 */
async function studentFilter(me: { id: string; role: string }) {
  if (me.role === 'OWNER') return {};
  if (me.role === 'TEACHER') return { teacherId: me.id };
  const ids = await visibleStudentIds(me as Parameters<typeof visibleStudentIds>[0]);
  return { studentId: { in: ids ?? [] } };
}

/** The same question for sessions, where the student is a seat, not a column. */
async function seatFilter(me: { id: string; role: string }): Promise<Prisma.ClassSessionWhereInput> {
  if (me.role === 'OWNER') return {};
  if (me.role === 'TEACHER') return { teacherId: me.id };
  const ids = await visibleStudentIds(me as Parameters<typeof visibleStudentIds>[0]);
  return { participants: { some: { studentId: { in: ids ?? [] } } } };
}

/* ---------------- is this slot actually free ----------------
   Four routes hand a class a time, and a rule enforced in three of them is
   worse than none: it teaches people to trust a guarantee the fourth quietly
   breaks. Both checks live in `lib/scheduling.ts`; these two wrap them in the
   words each caller needs. */

/** Refuses a slot outside the teacher's declared hours. Silent if they have none. */
async function assertWithinHours(
  teacher: { id: string; name: string; timezone: string },
  slot: { startsAt: Date; minutes: number },
): Promise<void> {
  const problem = availabilityProblem(teacher, slot, await windowsFor(teacher.id));
  if (problem) throw badRequest(problem);
}

/**
 * Refuses a slot this person is already committed to. `who` decides how much
 * the message gives away: somebody is told what their own clash is, and told
 * only that somebody else is busy — a student has no business reading another
 * family's timetable out of an error message.
 */
async function assertFree(
  person: { id: string; name: string; timezone: string },
  slot: { startsAt: Date; minutes: number },
  who: 'you' | 'them',
  excludeSessionId?: string,
): Promise<void> {
  const clashes = await clashesFor({
    userId: person.id,
    slot,
    ...(excludeSessionId ? { excludeSessionId } : {}),
  });
  if (!clashes.length) return;
  throw clashError({ ...person, voice: who }, clashes[0]!);
}

/** The same person, as the booking helper wants them. */
const attendee = (
  person: { id: string; name: string; timezone: string }, voice: 'you' | 'them',
): Attendee => ({ id: person.id, name: person.name, timezone: person.timezone, voice });

/* ---------------- class requests ---------------- */
classesRouter.get('/requests', asyncRoute(async (req, res) => {
  const me = actor(req);
  const where: Prisma.ClassRequestWhereInput = await studentFilter(me);
  const rows = await prisma.classRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ requests: rows.map(publicRequest) });
}));

const createRequest = z.object({
  teacherId: z.string().min(1),
  subject,
  topic: z.string().trim().min(3, 'Describe what you want to work on.').max(160),
  note: z.string().trim().max(600).optional(),
  requestedFor: z.coerce.date(),
  // 15 minutes to 8 hours, in quarter-hour steps: intensives and exam-prep
  // blocks run far longer than a standard lesson.
  minutes: z.number().int().min(15).max(480)
    .refine((m) => m % 15 === 0, 'Book in 15-minute steps.')
    .default(60),
});

classesRouter.post('/requests', requireRole('STUDENT'), validate(createRequest),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const input = req.body as z.infer<typeof createRequest>;
    if (input.requestedFor.getTime() < Date.now()) throw badRequest('Choose a slot in the future.');

    const teacher = await prisma.user.findUnique({ where: { id: input.teacherId } });
    if (!teacher || teacher.role !== 'TEACHER' || teacher.status !== 'ACTIVE') {
      throw notFound('That teacher is not available.');
    }

    /* Checked when the slot is asked for, not only when it is accepted.
       Sending a request into a slot the teacher cannot take means waiting a
       day to be told no, and the answer was knowable immediately. */
    const slot = { startsAt: input.requestedFor, minutes: input.minutes };
    await assertWithinHours(teacher, slot);
    await assertFree(teacher, slot, 'them');
    await assertFree(me, slot, 'you');

    const request = await prisma.classRequest.create({
      data: {
        studentId: me.id, teacherId: teacher.id,
        subject: input.subject === 'math' ? 'MATH' : 'ENGLISH',
        topic: input.topic, note: input.note ?? null,
        requestedFor: input.requestedFor, minutes: input.minutes,
      },
    });

    await notify({
      userId: teacher.id, type: 'class_request', title: 'New class request',
      body: `${me.name} requested ${input.subject} — ${input.topic}.`, url: '/#/classes',
    });
    emitToUser(teacher.id, 'classroom:request', publicRequest(request));

    res.status(201).json({ request: publicRequest(request) });
  }));

classesRouter.patch('/requests/:id', requireRole('TEACHER'),
  validate(z.object({ decision: z.enum(['accept', 'decline']) })),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const { decision } = req.body as { decision: 'accept' | 'decline' };
    const request = await prisma.classRequest.findUnique({ where: { id: String(req.params['id']) } });
    if (!request) throw notFound('That request no longer exists.');
    if (request.teacherId !== me.id) throw forbidden('That request was sent to another teacher.');
    if (request.status !== 'PENDING') throw badRequest('That request has already been answered.');

    if (decision === 'decline') {
      const updated = await prisma.classRequest.update({
        where: { id: request.id }, data: { status: 'DECLINED' },
      });
      await notify({
        userId: request.studentId, type: 'session', title: 'Class request declined',
        body: 'Try another time slot, or a different teacher.', url: '/#/classes',
      });
      res.json({ request: publicRequest(updated) });
      return;
    }

    /* Re-checked at accept time: the request may have sat in the list for a
       day, and the teacher may have filled that hour since. The student's own
       diary too — they may have booked a group seat while waiting.

       Hours are checked out here because they are configuration and do not
       race; the clash check belongs inside the write, because it does. */
    const slot = { startsAt: request.requestedFor, minutes: request.minutes };
    await assertWithinHours(me, slot);
    const asker = await prisma.user.findUniqueOrThrow({ where: { id: request.studentId } });

    // Accepting turns the request into a scheduled session. The student who
    // asked for it becomes its single seat.
    const [updated, session] = await writeIntoFreeSlot({
      slot,
      mustBeFree: [attendee(me, 'you'), attendee(asker, 'them')],
      write: (tx) => Promise.all([
        tx.classRequest.update({ where: { id: request.id }, data: { status: 'ACCEPTED' } }),
        tx.classSession.create({
          data: {
            requestId: request.id, teacherId: request.teacherId,
            subject: request.subject, topic: request.topic,
            startsAt: request.requestedFor, minutes: request.minutes,
            participants: { create: { studentId: request.studentId } },
          },
          include: withSeats,
        }),
      ]),
    });

    await notify({
      userId: request.studentId, type: 'session', title: 'Class accepted',
      body: `${me.name} accepted “${request.topic}”.`, url: `/#/room/${session.id}`,
    });
    // In the inbox as well as the bell: a class is a commitment at a time,
    // and the bell is only seen by someone already looking at the app.
    const student = await prisma.user.findUnique({ where: { id: request.studentId } });
    if (student) {
      void sendEmail(classBookedEmail({
        to: student.email, name: student.name.split(' ')[0] ?? student.name,
        topic: session.topic, startsAt: session.startsAt,
        teacher: me.name, timezone: student.timezone,
      }));
    }
    emitToUser(request.studentId, 'classroom:accepted', publicSession(session));

    res.json({ request: publicRequest(updated), session: publicSession(session) });
  }));

/**
 * Withdrawing a request that has not been answered yet. The other half of
 * cancelling: a student who no longer needs Thursday should not have to wait
 * for a teacher to accept it first and then ask them to call it off.
 */
classesRouter.delete('/requests/:id', requireRole('STUDENT'), asyncRoute(async (req, res) => {
  const me = actor(req);
  const request = await prisma.classRequest.findUnique({ where: { id: String(req.params['id']) } });
  if (!request) throw notFound('That request no longer exists.');
  if (request.studentId !== me.id) throw forbidden('That request is not yours.');
  if (request.status !== 'PENDING') {
    throw badRequest(request.status === 'ACCEPTED'
      ? 'Your teacher already accepted this — cancel the class instead.'
      : 'That request has already been answered.');
  }

  const updated = await prisma.classRequest.update({
    where: { id: request.id }, data: { status: 'CANCELLED' },
  });
  // The teacher may already have it open, so they are told rather than left
  // to accept something that is no longer wanted.
  await notify({
    userId: request.teacherId, type: 'session', title: 'Request withdrawn',
    body: `${me.name} withdrew “${request.topic}”.`, url: '/#/classes',
  });
  emitToUser(request.teacherId, 'classroom:request', publicRequest(updated));

  res.json({ request: publicRequest(updated) });
}));

/* ---------------- sessions ---------------- */
/** A parent reads about classes they are not in, so their view is narrowed. */
async function rosterFilter(me: { id: string; role: string }): Promise<string[] | undefined> {
  if (me.role !== 'PARENT') return undefined;
  return (await visibleStudentIds(me as Parameters<typeof visibleStudentIds>[0])) ?? [];
}

classesRouter.get('/sessions', asyncRoute(async (req, res) => {
  const me = actor(req);
  const where = await seatFilter(me);
  /* Newest first, not oldest. Ordered ascending, the 200-row window filled
     up with the oldest classes on the books, and every consumer of this list
     wants the other end of it: a teacher with 200 lessons behind them stopped
     being sent any of their upcoming ones, so their dashboard said "nothing
     scheduled" while next Tuesday sat in the database. Each caller sorts for
     display anyway. */
  const rows = await prisma.classSession.findMany({
    where, orderBy: { startsAt: 'desc' }, take: 200, include: withSeats,
  });
  const visible = await rosterFilter(me);
  res.json({ sessions: rows.map((s) => publicSession(s, visible)) });
}));

async function sessionForActor(
  req: Parameters<typeof actor>[0], id: string,
): Promise<SessionWithSeats> {
  const me = actor(req);
  const session = await prisma.classSession.findUnique({ where: { id }, include: withSeats });
  if (!session) throw notFound('That session no longer exists.');
  // A parent may read their child's class but never join it, so reading and
  // entering are two different tests — see lib/sessions.ts.
  if (!(await canReadSession(me, session))) {
    throw forbidden('Only the teacher and students in this class can open it.');
  }
  return session;
}

/** Entering the room is narrower than reading the record. */
function assertInRoom(session: SessionWithSeats, me: { id: string; role: string }): void {
  if (me.role === 'OWNER' || isInRoom(session, me.id)) return;
  throw forbidden('Only the teacher and students in this class can enter the room.');
}

classesRouter.get('/sessions/:id', asyncRoute(async (req, res) => {
  const session = await sessionForActor(req, String(req.params['id']));
  const [documents, messages] = await Promise.all([
    prisma.sessionDocument.findMany({ where: { sessionId: session.id } }),
    prisma.chatMessage.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' }, take: 200 }),
  ]);
  res.json({
    session: publicSession(session, await rosterFilter(actor(req))),
    documents: Object.fromEntries(documents.map((d) => [d.kind.toLowerCase(), d.content])),
    messages: messages.map(publicMessage),
  });
}));

/** Entering the room. A teacher entering also opens their attendance record. */
classesRouter.post('/sessions/:id/join', asyncRoute(async (req, res) => {
  const me = actor(req);
  const session = await sessionForActor(req, String(req.params['id']));
  assertInRoom(session, me);
  if (session.status === 'CANCELLED') {
    throw badRequest('That class was cancelled, so there is no room to enter.');
  }
  if (session.status === 'COMPLETED') throw badRequest('That class is already finished.');

  // Booking a seat and turning up are different things, and for a group class
  // the teacher needs to know which students did the second one.
  await prisma.sessionParticipant.updateMany({
    where: { sessionId: session.id, studentId: me.id, joinedAt: null },
    data: { joinedAt: new Date() },
  });

  const updated = await prisma.classSession.update({
    where: { id: session.id },
    data: { status: 'LIVE', joinedAt: session.joinedAt ?? new Date() },
    include: withSeats,
  });
  emitToSession(session.id, 'classroom:state', publicSession(updated));
  res.json({ session: publicSession(updated) });
}));

classesRouter.post('/sessions/:id/leave', asyncRoute(async (req, res) => {
  const session = await sessionForActor(req, String(req.params['id']));
  const updated = session.status === 'LIVE'
    ? await prisma.classSession.update({
      where: { id: session.id }, data: { status: 'SCHEDULED' }, include: withSeats,
    })
    : session;
  res.json({ session: publicSession(updated) });
}));

classesRouter.post('/sessions/:id/complete', requireRole('TEACHER', 'OWNER'),
  validate(z.object({ outcome: z.enum(['completed', 'no_show']).default('completed') })),
  asyncRoute(async (req, res) => {
    const session = await sessionForActor(req, String(req.params['id']));
    const { outcome } = req.body as { outcome: 'completed' | 'no_show' };
    if (session.status === 'CANCELLED') {
      throw badRequest('That class was cancelled, so there is nothing to mark.');
    }
    const now = new Date();

    const updated = await prisma.classSession.update({
      where: { id: session.id },
      data: {
        status: outcome === 'completed' ? 'COMPLETED' : 'NO_SHOW',
        endedAt: now,
      },
      include: withSeats,
    });
    await prisma.attendance.updateMany({
      where: { sessionId: session.id, clockOut: null },
      data: { clockOut: now },
    });
    for (const studentId of studentIdsOf(session)) {
      await notify({
        userId: studentId, type: 'session',
        title: outcome === 'completed' ? 'Class finished' : 'Class marked as a no-show',
        body: `${session.topic} — ${outcome === 'completed' ? 'your teacher marked it complete.' : 'you did not join.'}`,
        url: '/#/classes',
      });
    }
    res.json({ session: publicSession(updated) });
  }));

/* ---------------- calling a class off, and moving it ----------------
   `SessionStatus.CANCELLED` existed from the first migration and nothing
   could set it, so the only way out of a class nobody could attend was to
   leave it on the calendar and not turn up — which is also how it was
   recorded, as a no-show against the teacher.

   The class is never deleted. Its chat, its whiteboard and any invoice lines
   already raised against it hang off that row, and a family arguing about a
   charge needs the record to still exist. */

const cancelInput = z.object({
  reason: z.string().trim().max(300).optional(),
});

classesRouter.post('/sessions/:id/cancel', validate(cancelInput),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const session = await sessionForActor(req, String(req.params['id']));
    const { reason } = req.body as z.infer<typeof cancelInput>;

    if (!canCancel(me, session)) {
      throw forbidden(me.role === 'STUDENT' && isGroup(session)
        ? 'Release your seat instead — a class other students have booked is not '
          + 'yours to cancel.'
        : 'Only the teacher giving this class, or an administrator, can cancel it.');
    }
    if (session.status === 'CANCELLED') throw badRequest('That class has already been cancelled.');
    if (session.status === 'COMPLETED' || session.status === 'NO_SHOW') {
      throw badRequest('That class has already finished.');
    }
    if (session.status === 'LIVE') {
      throw badRequest('That class is in progress — end it from the classroom instead.');
    }

    const now = new Date();
    const shortNotice = isShortNotice(
      { startsAt: session.startsAt, cancelledAt: now }, env.CANCEL_NOTICE_HOURS,
    );

    /* Two facts that make a cancellation somebody's problem rather than a
       tidy-up. Both are reported, not acted on: voiding an invoice and
       striking a timesheet entry are the Owner's decisions, and a route that
       quietly did either would be destroying money either way it chose. */
    const [invoicedLines, clockedIn] = await Promise.all([
      prisma.invoiceLine.count({ where: { sessionId: session.id } }),
      prisma.attendance.findUnique({ where: { sessionId: session.id } }),
    ]);

    const updated = await prisma.$transaction(async (tx) => {
      // The request this class grew from is closed with it, so a student is
      // not left reading "accepted" against a lesson that was called off.
      if (session.requestId) {
        await tx.classRequest.update({
          where: { id: session.requestId }, data: { status: 'CANCELLED' },
        });
      }
      return tx.classSession.update({
        where: { id: session.id },
        data: {
          status: 'CANCELLED', cancelledAt: now, cancelledById: me.id,
          cancelReason: reason ?? null,
        },
        include: withSeats,
      });
    });

    /* Everyone with a stake in the hour, except whoever just cancelled it —
       telling someone their own news is how an inbox stops being read. */
    const tellIds = [...studentIdsOf(session), session.teacherId].filter((id) => id !== me.id);
    const people = await prisma.user.findMany({ where: { id: { in: tellIds } } });
    for (const person of people) {
      await notify({
        userId: person.id, type: 'session', title: 'Class cancelled',
        body: `${session.topic} — called off by ${me.name}.${reason ? ` “${reason}”` : ''}`,
        url: '/#/classes',
      });
      void sendEmail(classCancelledEmail({
        to: person.email, name: person.name.split(' ')[0] ?? person.name,
        topic: session.topic, startsAt: session.startsAt, timezone: person.timezone,
        cancelledBy: me.name, reason: reason ?? null, shortNotice,
        audience: person.id === session.teacherId ? 'teacher' : 'student',
      }));
    }

    // The Owner hears about it only when there is something to decide.
    if (invoicedLines > 0 || clockedIn || shortNotice) {
      const clauses = [
        ...(shortNotice ? [`less than ${env.CANCEL_NOTICE_HOURS}h notice`] : []),
        ...(invoicedLines > 0
          ? [`${invoicedLines} invoice line${invoicedLines === 1 ? '' : 's'} already raised`]
          : []),
        ...(clockedIn ? ['the teacher had already clocked in'] : []),
      ];
      const owners = await prisma.user.findMany({
        where: { role: 'OWNER' }, select: { id: true },
      });
      for (const owner of owners) {
        if (owner.id === me.id) continue;
        await notify({
          userId: owner.id, type: 'session', title: 'Cancelled class needs a look',
          body: `${session.topic} was cancelled by ${me.name} — ${clauses.join(', ')}.`,
          url: '/#/admin',
        });
      }
    }

    emitToSession(session.id, 'classroom:state', publicSession(updated));
    for (const id of tellIds) emitToUser(id, 'classroom:cancelled', publicSession(updated));

    res.json({
      session: publicSession(updated),
      shortNotice,
      /* Surfaced so the person who cancelled sees the consequence on the
         screen where they caused it, rather than discovering it at month end. */
      invoicedLines,
      teacherClockedIn: Boolean(clockedIn),
    });
  }));

const rescheduleInput = z.object({
  startsAt: z.coerce.date(),
  minutes: z.number().int().min(15).max(480)
    .refine((m) => m % 15 === 0, 'Book in 15-minute steps.')
    .optional(),
});

classesRouter.patch('/sessions/:id/schedule', validate(rescheduleInput),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const session = await sessionForActor(req, String(req.params['id']));
    const input = req.body as z.infer<typeof rescheduleInput>;

    if (!canReschedule(me, session)) {
      throw forbidden('Only the teacher giving this class, or an administrator, can move it. '
        + 'Cancel it and ask for another time instead.');
    }
    if (session.status !== 'SCHEDULED') {
      throw badRequest(session.status === 'CANCELLED'
        ? 'That class was cancelled. Open a new one rather than moving this.'
        : 'Only a class that has not started yet can be moved.');
    }
    if (input.startsAt.getTime() < Date.now()) throw badRequest('Choose a slot in the future.');

    const minutes = input.minutes ?? session.minutes;
    if (input.startsAt.getTime() === session.startsAt.getTime() && minutes === session.minutes) {
      throw badRequest('That is the time it is already booked for.');
    }

    /* A clocked-in teacher has a timesheet entry whose lateness was measured
       against the old start time. Moving the class would leave that
       measurement attached to a time that no longer exists, or recompute the
       deduction away — so it is refused rather than guessed at. */
    const clockedIn = await prisma.attendance.findUnique({ where: { sessionId: session.id } });
    if (clockedIn) {
      throw badRequest('The teacher has already clocked in for this class, so moving it would '
        + 'rewrite their timesheet. Cancel it and open a new one.');
    }

    const slot = { startsAt: input.startsAt, minutes };
    const giver = await prisma.user.findUniqueOrThrow({ where: { id: session.teacherId } });
    await assertWithinHours(giver, slot);

    /* Students are reported, not refused. Blocking a move because one of six
       people in a group class is busy that evening would hold the class
       hostage to the person with the fullest diary; they can release their
       seat. The teacher is told who, so the decision is an informed one. */
    const studentClashes: string[] = [];
    for (const studentId of studentIdsOf(session)) {
      const student = await prisma.user.findUnique({ where: { id: studentId } });
      if (!student) continue;
      const clashes = await clashesFor({ userId: studentId, slot, excludeSessionId: session.id });
      if (clashes.length) studentClashes.push(student.name);
    }

    const from = session.startsAt;
    const updated = await writeIntoFreeSlot({
      slot,
      mustBeFree: [attendee(giver, me.id === giver.id ? 'you' : 'them')],
      // The class being moved obviously overlaps where it already is.
      excludeSessionId: session.id,
      write: (tx) => tx.classSession.update({
        where: { id: session.id },
        data: {
          startsAt: input.startsAt, minutes,
          rescheduledFrom: from, rescheduledAt: new Date(),
        },
        include: withSeats,
      }),
    });

    /* Students are told; a group class is not re-opened for booking, because
       the people who took a seat chose this class, not this hour, and the
       ones for whom the new time does not work can release their seat. */
    const tellIds = studentIdsOf(session).filter((id) => id !== me.id);
    const people = await prisma.user.findMany({ where: { id: { in: tellIds } } });
    for (const person of people) {
      await notify({
        userId: person.id, type: 'session', title: 'Class moved',
        body: `${session.topic} — moved by ${me.name}. Check the new time.`,
        url: '/#/classes',
      });
      void sendEmail(classMovedEmail({
        to: person.email, name: person.name.split(' ')[0] ?? person.name,
        topic: session.topic, from, to_: input.startsAt,
        timezone: person.timezone, movedBy: me.name, minutes,
      }));
    }

    emitToSession(session.id, 'classroom:state', publicSession(updated));
    for (const id of tellIds) emitToUser(id, 'classroom:moved', publicSession(updated));

    res.json({ session: publicSession(updated), studentClashes });
  }));

/* ---------------- group classes ----------------
   A private lesson starts with a student asking a particular teacher. A group
   class works the other way round: the teacher opens it with a number of
   seats and a price per seat, and students put themselves in it. That is why
   it does not go through ClassRequest at all — there is nobody to accept. */

const openClass = z.object({
  subject,
  topic: z.string().trim().min(3, 'Give the class a title students will recognise.').max(160),
  startsAt: z.coerce.date(),
  minutes: z.number().int().min(15).max(480)
    .refine((m) => m % 15 === 0, 'Book in 15-minute steps.')
    .default(60),
  // Two is the smallest thing that is a group. The ceiling is a judgement
  // about teaching rather than about software: past a dozen a tutor cannot
  // hear everyone, and the video mesh would be fighting for bandwidth too.
  capacity: z.number().int().min(2, 'A group class needs at least two seats.').max(12),
  seatPrice: z.number().nonnegative().max(10_000),
});

classesRouter.post('/group', requireRole('TEACHER', 'OWNER'), validate(openClass),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const input = req.body as z.infer<typeof openClass>;
    if (input.startsAt.getTime() < Date.now()) throw badRequest('Open the class for a future slot.');

    const slot = { startsAt: input.startsAt, minutes: input.minutes };
    await assertWithinHours(me, slot);

    const session = await writeIntoFreeSlot({
      slot,
      mustBeFree: [attendee(me, 'you')],
      write: (tx) => tx.classSession.create({
        data: {
          teacherId: me.id,
          subject: input.subject === 'math' ? 'MATH' : 'ENGLISH',
          topic: input.topic, startsAt: input.startsAt, minutes: input.minutes,
          capacity: input.capacity, seatPriceCents: toCents(input.seatPrice),
        },
        include: withSeats,
      }),
    });

    res.status(201).json({ session: publicSession(session) });
  }));

/** Group classes a student could still join: future, seats free, not started. */
classesRouter.get('/group/open', asyncRoute(async (req, res) => {
  const me = actor(req);
  const rows = await prisma.classSession.findMany({
    where: {
      capacity: { gt: 1 },
      status: 'SCHEDULED',
      startsAt: { gt: new Date() },
    },
    orderBy: { startsAt: 'asc' },
    take: 100,
    include: withSeats,
  });
  // Full classes are filtered here rather than in SQL: Prisma cannot compare
  // a count against another column, and the alternative is raw SQL for a list
  // that is a hundred rows long at most.
  const open = rows.filter((s) => seatsLeft(s) > 0 || s.participants.some((p) => p.studentId === me.id));
  res.json({ sessions: open.map((s) => publicSession(s)) });
}));

classesRouter.post('/sessions/:id/book', requireRole('STUDENT'), asyncRoute(async (req, res) => {
  const me = actor(req);
  const session = await prisma.classSession.findUnique({
    where: { id: String(req.params['id']) }, include: withSeats,
  });
  if (!session) throw notFound('That class no longer exists.');
  if (session.capacity < 2) throw badRequest('That is a private lesson, not an open class.');
  if (session.status !== 'SCHEDULED') throw badRequest('That class is no longer open for booking.');
  if (session.startsAt.getTime() < Date.now()) throw badRequest('That class has already started.');
  if (session.participants.some((p) => p.studentId === me.id)) {
    throw badRequest('You already have a seat in that class.');
  }
  if (seatsLeft(session) < 1) throw badRequest('That class is full.');

  /* Two things have to hold while the seat is written, and neither check is
     one operation with the insert: the class must still have room — two
     students taking the last seat at once both passed the count above, and
     the unique index on (sessionId, studentId) does not help because they are
     different students — and the student must still be free, because a seat
     is as much of a commitment as a private lesson, and taking one on top of
     a class they already have is how somebody ends up a no-show in an
     attendance record. Both inside one serializable transaction. */
  await writeIntoFreeSlot({
    slot: { startsAt: session.startsAt, minutes: session.minutes },
    mustBeFree: [attendee(me, 'you')],
    write: async (tx) => {
      const taken = await tx.sessionParticipant.count({ where: { sessionId: session.id } });
      if (taken >= session.capacity) throw badRequest('That class is full.');
      await tx.sessionParticipant.create({ data: { sessionId: session.id, studentId: me.id } });
    },
  });

  const updated = await prisma.classSession.findUniqueOrThrow({
    where: { id: session.id }, include: withSeats,
  });

  await notify({
    userId: session.teacherId, type: 'session', title: 'Seat taken',
    body: `${me.name} booked a seat in “${session.topic}” — ${updated.participants.length} of ${session.capacity} filled.`,
    url: '/#/classes',
  });
  const [booker, teacher] = await Promise.all([
    prisma.user.findUnique({ where: { id: me.id } }),
    prisma.user.findUnique({ where: { id: session.teacherId } }),
  ]);
  if (booker) {
    void sendEmail(classBookedEmail({
      to: booker.email, name: booker.name.split(' ')[0] ?? booker.name,
      topic: session.topic, startsAt: session.startsAt,
      teacher: teacher?.name ?? 'your teacher', timezone: booker.timezone,
    }));
  }
  emitToUser(session.teacherId, 'classroom:booked', publicSession(updated));

  res.status(201).json({ session: publicSession(updated) });
}));

classesRouter.delete('/sessions/:id/book', requireRole('STUDENT'), asyncRoute(async (req, res) => {
  const me = actor(req);
  const session = await prisma.classSession.findUnique({
    where: { id: String(req.params['id']) }, include: withSeats,
  });
  if (!session) throw notFound('That class no longer exists.');
  if (session.status !== 'SCHEDULED') throw badRequest('That class has already started.');
  if (!session.participants.some((p) => p.studentId === me.id)) {
    throw badRequest('You do not have a seat in that class.');
  }
  // A private lesson is not a seat to walk out of — dropping the only seat
  // would leave a class with nobody in it. Cancelling it is the right verb,
  // and since this message used to point at a capability nobody had, a
  // student may now do that themselves.
  if (session.capacity < 2) throw badRequest('Cancel the lesson instead of releasing a seat.');

  await prisma.sessionParticipant.deleteMany({
    where: { sessionId: session.id, studentId: me.id },
  });
  const updated = await prisma.classSession.findUniqueOrThrow({
    where: { id: session.id }, include: withSeats,
  });
  emitToUser(session.teacherId, 'classroom:booked', publicSession(updated));
  res.json({ session: publicSession(updated) });
}));

/** Whiteboard strokes, the shared document and saved equations. */
const saveDocument = z.object({
  kind: z.enum(['board', 'document', 'equation', 'annotation']),
  content: z.string().max(2_000_000),
});

classesRouter.put('/sessions/:id/documents', validate(saveDocument), asyncRoute(async (req, res) => {
  const me = actor(req);
  const session = await sessionForActor(req, String(req.params['id']));
  const input = req.body as z.infer<typeof saveDocument>;
  const kind = input.kind.toUpperCase() as 'BOARD' | 'DOCUMENT' | 'EQUATION' | 'ANNOTATION';

  const saved = await prisma.sessionDocument.upsert({
    where: { sessionId_kind: { sessionId: session.id, kind } },
    create: { sessionId: session.id, kind, content: input.content, updatedBy: me.id },
    update: { content: input.content, updatedBy: me.id },
  });
  res.json({ kind: input.kind, updatedAt: saved.updatedAt.toISOString() });
}));

classesRouter.get('/sessions/:id/messages', asyncRoute(async (req, res) => {
  const session = await sessionForActor(req, String(req.params['id']));
  const rows = await prisma.chatMessage.findMany({
    where: { sessionId: session.id }, orderBy: { createdAt: 'asc' }, take: 200,
  });
  res.json({ messages: rows.map(publicMessage) });
}));

/** REST twin of the chat:send socket event, for clients without a live socket. */
classesRouter.post('/sessions/:id/messages',
  validate(z.object({ text: z.string().trim().min(1).max(4000) })),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const session = await sessionForActor(req, String(req.params['id']));
    const { text } = req.body as { text: string };
    const message = await prisma.chatMessage.create({
      data: { sessionId: session.id, senderId: me.id, body: text },
    });
    const wire = publicMessage(message);
    emitToSession(session.id, 'chat:message', wire);
    res.status(201).json({ message: wire });
  }));
