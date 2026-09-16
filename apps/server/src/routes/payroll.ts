import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest } from '../lib/http-error.js';
import { publicBatch, publicPayrollLine } from '../lib/serialize.js';
import { fromCents } from '../lib/money.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import { figuresFor, runPayroll } from '../services/payroll.js';
import { notify } from '../services/notifications.js';

export const payrollRouter = Router();
payrollRouter.use(requireAuth, requireRole('TEACHER', 'OWNER'));

const period = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** Preview for the current period — nothing is written. */
payrollRouter.get('/preview', validate(period, 'query'), asyncRoute(async (req, res) => {
  const me = actor(req);
  const q = req.query as unknown as z.infer<typeof period>;
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);

  if (me.role === 'OWNER') {
    const lines = await runPayroll(from, to);
    res.json({
      from: from.toISOString(), to: to.toISOString(),
      lines: lines.map((l) => ({
        teacherId: l.teacherId, sessions: l.sessions, minutes: l.minutes,
        lateMinutes: l.lateMinutes, noShows: l.noShows,
        gross: fromCents(l.grossCents), deductions: fromCents(l.deductionCents), net: fromCents(l.netCents),
      })),
      policy: { graceMinutes: env.PAYROLL_GRACE_MINUTES, latePenalty: env.PAYROLL_LATE_PENALTY },
    });
    return;
  }

  const rows = await prisma.attendance.findMany({
    where: { teacherId: me.id, scheduledStart: { gte: from, lte: to } },
    include: { session: { select: { minutes: true } } },
  });
  const figures = figuresFor(me, rows);
  res.json({
    from: from.toISOString(), to: to.toISOString(),
    lines: [{
      teacherId: figures.teacherId, sessions: figures.sessions, minutes: figures.minutes,
      lateMinutes: figures.lateMinutes, noShows: figures.noShows,
      gross: fromCents(figures.grossCents), deductions: fromCents(figures.deductionCents),
      net: fromCents(figures.netCents),
    }],
    policy: { graceMinutes: env.PAYROLL_GRACE_MINUTES, latePenalty: env.PAYROLL_LATE_PENALTY },
  });
}));

payrollRouter.get('/batches', asyncRoute(async (req, res) => {
  const me = actor(req);
  const batches = await prisma.payrollBatch.findMany({
    orderBy: { createdAt: 'desc' }, take: 24,
    include: {
      lines: me.role === 'OWNER' ? true : { where: { teacherId: me.id } },
    },
  });
  res.json({ batches: batches.map(publicBatch) });
}));

/** Generating a batch freezes the figures and notifies every teacher in it. */
payrollRouter.post('/batches', requireRole('OWNER'), validate(period), asyncRoute(async (req, res) => {
  const me = actor(req);
  const input = req.body as z.infer<typeof period>;
  const to = input.to ?? new Date();
  const from = input.from ?? new Date(to.getTime() - 30 * 86_400_000);
  if (from >= to) throw badRequest('The period start must come before the end.');

  const figures = await runPayroll(from, to);
  const batch = await prisma.payrollBatch.create({
    data: {
      periodStart: from, periodEnd: to, status: 'APPROVED', approvedById: me.id,
      lines: {
        create: figures.map((f) => ({
          teacherId: f.teacherId, sessions: f.sessions, minutes: f.minutes,
          lateMinutes: f.lateMinutes, noShows: f.noShows,
          grossCents: f.grossCents, deductionCents: f.deductionCents, netCents: f.netCents,
        })),
      },
    },
    include: { lines: true },
  });

  for (const line of batch.lines) {
    const net = fromCents(line.netCents);
    const deductions = fromCents(line.deductionCents);
    await notify({
      userId: line.teacherId, type: 'payroll', title: 'Payroll approved',
      body: `${env.PAYROLL_CURRENCY} ${net.toFixed(2)} for ${(line.minutes / 60).toFixed(1)} hours`
        + (deductions > 0 ? `, after ${deductions.toFixed(2)} in deductions.` : '.'),
      url: '/#/payroll',
    });
  }

  res.status(201).json({ batch: publicBatch(batch), lines: batch.lines.map(publicPayrollLine) });
}));

payrollRouter.patch('/batches/:id', requireRole('OWNER'),
  validate(z.object({ status: z.enum(['draft', 'approved', 'paid']) })),
  asyncRoute(async (req, res) => {
    const { status } = req.body as { status: 'draft' | 'approved' | 'paid' };
    const batch = await prisma.payrollBatch.update({
      where: { id: String(req.params['id']) },
      data: { status: status.toUpperCase() as 'DRAFT' | 'APPROVED' | 'PAID' },
      include: { lines: true },
    });
    res.json({ batch: publicBatch(batch) });
  }));
