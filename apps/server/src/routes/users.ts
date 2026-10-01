import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, notFound } from '../lib/http-error.js';
import { publicReset, publicUser } from '../lib/serialize.js';
import { childrenOf } from '../lib/scope.js';
import { toCents } from '../lib/money.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import { notify } from '../services/notifications.js';
import { issueResetToken } from './auth.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const idParam = z.object({ id: z.string().min(1) });

/**
 * Who can see whom. A student never receives another student's record, and
 * teachers only see the students they actually teach.
 */
usersRouter.get('/', asyncRoute(async (req, res) => {
  const me = actor(req);
  if (me.role === 'OWNER') {
    const users = await prisma.user.findMany({ orderBy: [{ role: 'asc' }, { createdAt: 'asc' }] });
    res.json({ users: users.map(publicUser) });
    return;
  }
  const owners = await prisma.user.findMany({ where: { role: 'OWNER' } });

  if (me.role === 'STUDENT') {
    const teachers = await prisma.user.findMany({
      where: { role: 'TEACHER', status: 'ACTIVE' },
      orderBy: { name: 'asc' },
    });
    res.json({ users: [...teachers, ...owners, me].map(publicUser) });
    return;
  }
  if (me.role === 'PARENT') {
    const children = await childrenOf(me.id);
    const childIds = children.map((c) => c.id);
    const taught = await prisma.classSession.findMany({
      where: { studentId: { in: childIds } }, select: { teacherId: true }, distinct: ['teacherId'],
    });
    const teachers = await prisma.user.findMany({
      where: { id: { in: taught.map((t) => t.teacherId) } }, orderBy: { name: 'asc' },
    });
    res.json({ users: [...children, ...teachers, ...owners, me].map(publicUser) });
    return;
  }

  const sessions = await prisma.classSession.findMany({
    where: { teacherId: me.id }, select: { studentId: true }, distinct: ['studentId'],
  });
  const requests = await prisma.classRequest.findMany({
    where: { teacherId: me.id }, select: { studentId: true }, distinct: ['studentId'],
  });
  const ids = [...new Set([...sessions, ...requests].map((s) => s.studentId))];
  const students = await prisma.user.findMany({ where: { id: { in: ids } }, orderBy: { name: 'asc' } });
  res.json({ users: [...students, ...owners, me].map(publicUser) });
}));

usersRouter.patch('/:id/approve', requireRole('OWNER'), validate(idParam, 'params'),
  asyncRoute(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw notFound('That account no longer exists.');
    if (user.status === 'ACTIVE') throw badRequest('That account is already active.');

    const updated = await prisma.user.update({ where: { id }, data: { status: 'ACTIVE' } });
    await notify({
      userId: id, type: 'account', title: 'Your account is approved',
      body: 'You can sign in and start using LogicClass+.',
    });
    res.json({ user: publicUser(updated) });
  }));

usersRouter.patch('/:id/status', requireRole('OWNER'),
  validate(idParam, 'params'), validate(z.object({ status: z.enum(['active', 'suspended']) })),
  asyncRoute(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    const { status } = req.body as { status: 'active' | 'suspended' };
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('That account no longer exists.');
    if (target.role === 'OWNER') throw badRequest('The owner account cannot be suspended.');

    const updated = await prisma.user.update({
      where: { id }, data: { status: status === 'active' ? 'ACTIVE' : 'SUSPENDED' },
    });
    res.json({ user: publicUser(updated) });
  }));

usersRouter.delete('/:id', requireRole('OWNER'), validate(idParam, 'params'),
  asyncRoute(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('That account no longer exists.');
    if (target.role === 'OWNER') throw badRequest('The owner account cannot be deleted.');
    if (target.status === 'ACTIVE') {
      throw badRequest('Suspend the account before deleting it, so nothing is removed by accident.');
    }
    await prisma.user.delete({ where: { id } });
    res.json({ ok: true });
  }));

const profile = z.object({
  name: z.string().trim().min(2).optional(),
  locale: z.string().max(12).optional(),
  timezone: z.string().max(64).optional(),
  bio: z.string().max(400).optional(),
  hourlyRate: z.number().min(0).max(1000).optional(),
});

usersRouter.patch('/me', validate(profile), asyncRoute(async (req, res) => {
  const me = actor(req);
  const input = req.body as z.infer<typeof profile>;
  // Only a teacher has a rate, and only the owner or the teacher themselves may set it.
  const rate = input.hourlyRate != null && me.role === 'TEACHER'
    ? { hourlyRateCents: toCents(input.hourlyRate) } : {};
  const updated = await prisma.user.update({
    where: { id: me.id },
    data: {
      ...(input.name ? { name: input.name } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
      ...(input.bio != null ? { bio: input.bio } : {}),
      ...rate,
    },
  });
  res.json({ user: publicUser(updated) });
}));

/* The literal routes above must stay above this one: Express matches in order,
   and `/:id` would otherwise swallow PATCH /users/me. */
/* ---------------- admin edits to another account ---------------- */

const adminEdit = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  subjects: z.array(z.enum(['math', 'english'])).max(2).optional(),
  /** Teacher pay, in whole currency units. Payroll multiplies this by minutes taught. */
  hourlyRate: z.number().min(0).max(1000).optional(),
  gradeLevel: z.string().trim().max(40).nullable().optional(),
  timezone: z.string().max(64).optional(),
});

/**
 * The Owner editing someone else's record.
 *
 * Deliberately narrow: no role changes, no status changes and no password.
 * Status has its own route with its own guard rails, and a role change would
 * silently re-point every row that hangs off it — a teacher's sessions and
 * payroll lines do not survive becoming a student.
 */
usersRouter.patch('/:id', requireRole('OWNER'), validate(idParam, 'params'),
  validate(adminEdit), asyncRoute(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    const input = req.body as z.infer<typeof adminEdit>;
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('No such account.');

    if (input.hourlyRate != null && target.role !== 'TEACHER') {
      throw badRequest('Only a teacher has a pay rate.');
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.subjects
          ? { subjects: input.subjects.map((x) => x.toUpperCase() as 'MATH' | 'ENGLISH') }
          : {}),
        ...(input.hourlyRate != null ? { hourlyRateCents: toCents(input.hourlyRate) } : {}),
        ...(input.gradeLevel !== undefined ? { gradeLevel: input.gradeLevel } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
      },
    });
    res.json({ user: publicUser(updated) });
  }));

/* ---------------- guardians ---------------- */

/** The children of the signed-in parent. */
usersRouter.get('/children', requireRole('PARENT', 'OWNER'), asyncRoute(async (req, res) => {
  const me = actor(req);
  res.json({ children: (await childrenOf(me.id)).map(publicUser) });
}));

/** One parent's children, for the Owner's assignment dialog. */
usersRouter.get('/:id/children', requireRole('OWNER'), validate(idParam, 'params'),
  asyncRoute(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    res.json({ children: (await childrenOf(id)).map(publicUser) });
  }));

const linkBody = z.object({ studentId: z.string().min(1) });

/**
 * The Owner attaches a student to a parent.
 *
 * Only the Owner: a guardian link exposes a child's timetable and invoices,
 * so it is granted deliberately rather than claimed by whoever knows an
 * email address.
 */
usersRouter.post('/:id/children', requireRole('OWNER'), validate(idParam, 'params'),
  validate(linkBody), asyncRoute(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    const { studentId } = req.body as z.infer<typeof linkBody>;

    const [parent, student] = await Promise.all([
      prisma.user.findUnique({ where: { id } }),
      prisma.user.findUnique({ where: { id: studentId } }),
    ]);
    if (!parent || parent.role !== 'PARENT') throw badRequest('That account is not a parent.');
    if (!student || student.role !== 'STUDENT') throw badRequest('That account is not a student.');

    await prisma.guardian.upsert({
      where: { parentId_studentId: { parentId: id, studentId } },
      create: { parentId: id, studentId },
      update: {},
    });
    await notify({
      userId: id, type: 'account',
      title: 'A student was linked to your account',
      body: `You can now follow ${student.name}'s classes and invoices.`,
      url: '/#/dashboard',
    });
    res.json({ children: (await childrenOf(id)).map(publicUser) });
  }));

usersRouter.delete('/:id/children/:studentId', requireRole('OWNER'),
  validate(z.object({ id: z.string().min(1), studentId: z.string().min(1) }), 'params'),
  asyncRoute(async (req, res) => {
    const { id, studentId } = req.params as { id: string; studentId: string };
    await prisma.guardian.deleteMany({ where: { parentId: id, studentId } });
    res.json({ children: (await childrenOf(id)).map(publicUser) });
  }));

/* ---------------- password reset queue ---------------- */
usersRouter.get('/reset-requests', requireRole('OWNER'), asyncRoute(async (_req, res) => {
  const rows = await prisma.passwordResetRequest.findMany({ orderBy: { requestedAt: 'desc' }, take: 50 });
  res.json({ resets: rows.map(publicReset) });
}));

usersRouter.patch('/reset-requests/:id', requireRole('OWNER'),
  validate(idParam, 'params'), validate(z.object({ decision: z.enum(['approve', 'reject']) })),
  asyncRoute(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParam>;
    const { decision } = req.body as { decision: 'approve' | 'reject' };
    const request = await prisma.passwordResetRequest.findUnique({ where: { id } });
    if (!request) throw notFound('That request no longer exists.');
    if (request.status !== 'PENDING') throw badRequest('That request has already been handled.');

    if (decision === 'reject') {
      const updated = await prisma.passwordResetRequest.update({
        where: { id },
        data: { status: 'REJECTED', resolvedAt: new Date(), resolvedById: actor(req).id },
      });
      res.json({ reset: publicReset(updated) });
      return;
    }

    const token = await issueResetToken(id);
    await prisma.passwordResetRequest.update({
      where: { id }, data: { resolvedById: actor(req).id },
    });
    await notify({
      userId: request.userId, type: 'password', title: 'Reset link sent',
      body: 'Check your inbox — the link works once and expires in 30 minutes.',
    });
    const updated = await prisma.passwordResetRequest.findUniqueOrThrow({ where: { id } });
    // The mailer sends this link; it is returned here so the flow is testable end to end.
    res.json({ reset: publicReset(updated), resetLink: `/#/reset?token=${token}` });
  }));
