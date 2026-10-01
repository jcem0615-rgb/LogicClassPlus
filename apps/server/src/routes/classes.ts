import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/http-error.js';
import { visibleStudentIds } from '../lib/scope.js';
import {
  canReadSession, isInRoom, seatsLeft, studentIdsOf, withSeats,
  type SessionWithSeats,
} from '../lib/sessions.js';
import { toCents } from '../lib/money.js';
import { publicMessage, publicRequest, publicSession } from '../lib/serialize.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import { notify } from '../services/notifications.js';
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

    // Accepting turns the request into a scheduled session in one transaction.
    // The student who asked for it becomes its single seat.
    const [updated, session] = await prisma.$transaction([
      prisma.classRequest.update({ where: { id: request.id }, data: { status: 'ACCEPTED' } }),
      prisma.classSession.create({
        data: {
          requestId: request.id, teacherId: request.teacherId,
          subject: request.subject, topic: request.topic,
          startsAt: request.requestedFor, minutes: request.minutes,
          participants: { create: { studentId: request.studentId } },
        },
        include: withSeats,
      }),
    ]);

    await notify({
      userId: request.studentId, type: 'session', title: 'Class accepted',
      body: `${me.name} accepted “${request.topic}”.`, url: `/#/room/${session.id}`,
    });
    emitToUser(request.studentId, 'classroom:accepted', publicSession(session));

    res.json({ request: publicRequest(updated), session: publicSession(session) });
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
  const rows = await prisma.classSession.findMany({
    where, orderBy: { startsAt: 'asc' }, take: 200, include: withSeats,
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
  if (session.status === 'COMPLETED' || session.status === 'CANCELLED') {
    throw badRequest('That class is already finished.');
  }

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

    const session = await prisma.classSession.create({
      data: {
        teacherId: me.id,
        subject: input.subject === 'math' ? 'MATH' : 'ENGLISH',
        topic: input.topic, startsAt: input.startsAt, minutes: input.minutes,
        capacity: input.capacity, seatPriceCents: toCents(input.seatPrice),
      },
      include: withSeats,
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

  /* The check above and the insert below are not one operation, so two
     students taking the last seat at the same moment would both pass it. The
     unique index on (sessionId, studentId) does not help — they are different
     students. Counting inside the transaction and failing there does. */
  try {
    await prisma.$transaction(async (tx) => {
      const taken = await tx.sessionParticipant.count({ where: { sessionId: session.id } });
      if (taken >= session.capacity) throw badRequest('That class is full.');
      await tx.sessionParticipant.create({ data: { sessionId: session.id, studentId: me.id } });
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    // Serializable conflicts surface as a write conflict, which in this
    // transaction can only mean the other booking won the race.
    if ((err as { code?: string }).code === 'P2034') throw badRequest('That class is full.');
    throw err;
  }

  const updated = await prisma.classSession.findUniqueOrThrow({
    where: { id: session.id }, include: withSeats,
  });

  await notify({
    userId: session.teacherId, type: 'session', title: 'Seat taken',
    body: `${me.name} booked a seat in “${session.topic}” — ${updated.participants.length} of ${session.capacity} filled.`,
    url: '/#/classes',
  });
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
  // A private lesson is not a seat a student can walk out of: cancelling it is
  // the teacher's business, and dropping the only seat would leave a class
  // with nobody in it.
  if (session.capacity < 2) throw badRequest('Ask your teacher to cancel a private lesson.');

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
