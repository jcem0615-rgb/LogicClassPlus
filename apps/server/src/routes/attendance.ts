import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/http-error.js';
import { publicAttendance } from '../lib/serialize.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import { deductionForCents } from '../services/payroll.js';

export const attendanceRouter = Router();
attendanceRouter.use(requireAuth, requireRole('TEACHER', 'OWNER'));

attendanceRouter.get('/', asyncRoute(async (req, res) => {
  const me = actor(req);
  const where: Prisma.AttendanceWhereInput = me.role === 'OWNER' ? {} : { teacherId: me.id };
  const rows = await prisma.attendance.findMany({
    where, orderBy: { scheduledStart: 'desc' }, take: 200,
    include: { session: { select: { topic: true, minutes: true } } },
  });
  res.json({
    attendance: rows.map((r) => ({
      ...publicAttendance(r),
      topic: r.session?.topic ?? '—',
      sessionMinutes: r.session?.minutes ?? 60,
    })),
    policy: {
      graceMinutes: env.PAYROLL_GRACE_MINUTES,
      latePenalty: env.PAYROLL_LATE_PENALTY,
      currency: env.PAYROLL_CURRENCY,
    },
  });
}));

attendanceRouter.post('/clock-in', requireRole('TEACHER'),
  validate(z.object({ sessionId: z.string().min(1) })),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const { sessionId } = req.body as { sessionId: string };
    const session = await prisma.classSession.findUnique({ where: { id: sessionId } });
    if (!session) throw notFound('That session no longer exists.');
    if (session.teacherId !== me.id) throw forbidden('That session belongs to another teacher.');

    const existing = await prisma.attendance.findUnique({ where: { sessionId } });
    if (existing) throw conflict('You have already clocked in for that session.');

    const now = new Date();
    const minutesLate = Math.max(0, Math.round((now.getTime() - session.startsAt.getTime()) / 60_000));
    const deductionCents = deductionForCents(
      { minutesLate, noShow: false }, session.minutes, me.hourlyRateCents ?? 0,
    );

    const record = await prisma.attendance.create({
      data: {
        teacherId: me.id, sessionId, scheduledStart: session.startsAt,
        clockIn: now, minutesLate, deductionCents,
      },
    });
    res.status(201).json({
      attendance: publicAttendance(record),
      graceMinutes: env.PAYROLL_GRACE_MINUTES,
    });
  }));

attendanceRouter.post('/:id/clock-out', requireRole('TEACHER'), asyncRoute(async (req, res) => {
  const me = actor(req);
  const record = await prisma.attendance.findUnique({ where: { id: String(req.params['id']) } });
  if (!record) throw notFound('That record no longer exists.');
  if (record.teacherId !== me.id) throw forbidden('That record is not yours.');
  if (record.clockOut) throw badRequest('You have already clocked out of that session.');

  const updated = await prisma.attendance.update({
    where: { id: record.id }, data: { clockOut: new Date() },
  });
  res.json({ attendance: publicAttendance(updated) });
}));

/** Marking a no-show forfeits the whole session fee. */
attendanceRouter.post('/no-show', requireRole('TEACHER', 'OWNER'),
  validate(z.object({ sessionId: z.string().min(1) })),
  asyncRoute(async (req, res) => {
    const me = actor(req);
    const { sessionId } = req.body as { sessionId: string };
    const session = await prisma.classSession.findUnique({ where: { id: sessionId } });
    if (!session) throw notFound('That session no longer exists.');
    if (me.role === 'TEACHER' && session.teacherId !== me.id) throw forbidden('Not your session.');

    const teacher = await prisma.user.findUniqueOrThrow({ where: { id: session.teacherId } });
    const deductionCents = deductionForCents(
      { minutesLate: 0, noShow: true }, session.minutes, teacher.hourlyRateCents ?? 0,
    );

    const record = await prisma.attendance.upsert({
      where: { sessionId },
      create: {
        teacherId: session.teacherId, sessionId, scheduledStart: session.startsAt,
        noShow: true, deductionCents,
      },
      update: { noShow: true, deductionCents },
    });
    await prisma.classSession.update({ where: { id: sessionId }, data: { status: 'NO_SHOW' } });
    res.json({ attendance: publicAttendance(record) });
  }));
