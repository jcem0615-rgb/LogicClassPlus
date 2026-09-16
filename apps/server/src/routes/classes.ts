import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/http-error.js';
import { publicMessage, publicRequest, publicSession } from '../lib/serialize.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import { notify } from '../services/notifications.js';
import { emitToSession, emitToUser } from '../realtime/gateway.js';

export const classesRouter = Router();
classesRouter.use(requireAuth);

const subject = z.enum(['math', 'english']);

/* ---------------- class requests ---------------- */
classesRouter.get('/requests', asyncRoute(async (req, res) => {
  const me = actor(req);
  const where: Prisma.ClassRequestWhereInput =
    me.role === 'OWNER' ? {} : me.role === 'TEACHER' ? { teacherId: me.id } : { studentId: me.id };
  const rows = await prisma.classRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json({ requests: rows.map(publicRequest) });
}));

const createRequest = z.object({
  teacherId: z.string().min(1),
  subject,
  topic: z.string().trim().min(3, 'Describe what you want to work on.').max(160),
  note: z.string().trim().max(600).optional(),
  requestedFor: z.coerce.date(),
  minutes: z.union([z.literal(30), z.literal(45), z.literal(60), z.literal(90)]).default(60),
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
    const [updated, session] = await prisma.$transaction([
      prisma.classRequest.update({ where: { id: request.id }, data: { status: 'ACCEPTED' } }),
      prisma.classSession.create({
        data: {
          requestId: request.id, teacherId: request.teacherId, studentId: request.studentId,
          subject: request.subject, topic: request.topic,
          startsAt: request.requestedFor, minutes: request.minutes,
        },
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
classesRouter.get('/sessions', asyncRoute(async (req, res) => {
  const me = actor(req);
  const where: Prisma.ClassSessionWhereInput =
    me.role === 'OWNER' ? {} : me.role === 'TEACHER' ? { teacherId: me.id } : { studentId: me.id };
  const rows = await prisma.classSession.findMany({ where, orderBy: { startsAt: 'asc' }, take: 200 });
  res.json({ sessions: rows.map(publicSession) });
}));

async function sessionForActor(req: Parameters<typeof actor>[0], id: string) {
  const me = actor(req);
  const session = await prisma.classSession.findUnique({ where: { id } });
  if (!session) throw notFound('That session no longer exists.');
  if (me.role !== 'OWNER' && session.teacherId !== me.id && session.studentId !== me.id) {
    throw forbidden('Only the teacher and student in this session can open it.');
  }
  return session;
}

classesRouter.get('/sessions/:id', asyncRoute(async (req, res) => {
  const session = await sessionForActor(req, String(req.params['id']));
  const [documents, messages] = await Promise.all([
    prisma.sessionDocument.findMany({ where: { sessionId: session.id } }),
    prisma.chatMessage.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' }, take: 200 }),
  ]);
  res.json({
    session: publicSession(session),
    documents: Object.fromEntries(documents.map((d) => [d.kind.toLowerCase(), d.content])),
    messages: messages.map(publicMessage),
  });
}));

/** Entering the room. A teacher entering also opens their attendance record. */
classesRouter.post('/sessions/:id/join', asyncRoute(async (req, res) => {
  const me = actor(req);
  const session = await sessionForActor(req, String(req.params['id']));
  if (session.status === 'COMPLETED' || session.status === 'CANCELLED') {
    throw badRequest('That class is already finished.');
  }

  const updated = await prisma.classSession.update({
    where: { id: session.id },
    data: { status: 'LIVE', joinedAt: session.joinedAt ?? new Date() },
  });
  emitToSession(session.id, 'classroom:state', publicSession(updated));
  res.json({ session: publicSession(updated) });
  void me;
}));

classesRouter.post('/sessions/:id/leave', asyncRoute(async (req, res) => {
  const session = await sessionForActor(req, String(req.params['id']));
  const updated = session.status === 'LIVE'
    ? await prisma.classSession.update({ where: { id: session.id }, data: { status: 'SCHEDULED' } })
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
    });
    await prisma.attendance.updateMany({
      where: { sessionId: session.id, clockOut: null },
      data: { clockOut: now },
    });
    await notify({
      userId: session.studentId, type: 'session',
      title: outcome === 'completed' ? 'Class finished' : 'Class marked as a no-show',
      body: `${session.topic} — ${outcome === 'completed' ? 'your teacher marked it complete.' : 'you did not join.'}`,
      url: '/#/classes',
    });
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
