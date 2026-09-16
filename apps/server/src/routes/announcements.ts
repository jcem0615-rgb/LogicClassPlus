import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { notFound } from '../lib/http-error.js';
import { publicAnnouncement } from '../lib/serialize.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';
import { notify } from '../services/notifications.js';

export const announcementsRouter = Router();
announcementsRouter.use(requireAuth);

announcementsRouter.get('/', asyncRoute(async (req, res) => {
  const me = actor(req);
  const audience = me.role === 'TEACHER' ? ['ALL', 'TEACHERS'] as const
    : me.role === 'STUDENT' ? ['ALL', 'STUDENTS'] as const
    : ['ALL', 'TEACHERS', 'STUDENTS'] as const;

  const rows = await prisma.announcement.findMany({
    where: { audience: { in: [...audience] } },
    orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    take: 50,
  });
  res.json({ announcements: rows.map(publicAnnouncement) });
}));

const post = z.object({
  title: z.string().trim().min(3, 'Give the announcement a title.').max(160),
  body: z.string().trim().min(3, 'Write the message.').max(4000),
  audience: z.enum(['all', 'teachers', 'students']).default('all'),
  pinned: z.boolean().default(false),
});

announcementsRouter.post('/', requireRole('OWNER'), validate(post), asyncRoute(async (req, res) => {
  const me = actor(req);
  const input = req.body as z.infer<typeof post>;
  const audience = input.audience.toUpperCase() as 'ALL' | 'TEACHERS' | 'STUDENTS';

  const announcement = await prisma.announcement.create({
    data: { authorId: me.id, title: input.title, body: input.body, audience, pinned: input.pinned },
  });

  const recipients = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      id: { not: me.id },
      ...(audience === 'TEACHERS' ? { role: 'TEACHER' as const } : {}),
      ...(audience === 'STUDENTS' ? { role: 'STUDENT' as const } : {}),
    },
    select: { id: true },
  });
  for (const r of recipients) {
    await notify({
      userId: r.id, type: 'announcement', title: input.title,
      body: input.body.slice(0, 140), url: '/#/announcements',
    });
  }

  res.status(201).json({ announcement: publicAnnouncement(announcement), notified: recipients.length });
}));

announcementsRouter.delete('/:id', requireRole('OWNER'), asyncRoute(async (req, res) => {
  const found = await prisma.announcement.findUnique({ where: { id: String(req.params['id']) } });
  if (!found) throw notFound('That announcement no longer exists.');
  await prisma.announcement.delete({ where: { id: found.id } });
  res.json({ ok: true });
}));
