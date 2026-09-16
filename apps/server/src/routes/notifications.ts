import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { publicNotification } from '../lib/serialize.js';
import { actor, requireAuth } from '../middleware/auth.js';
import { pushPublicKey } from '../services/push.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get('/', asyncRoute(async (req, res) => {
  const me = actor(req);
  const [rows, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: me.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.notification.count({ where: { userId: me.id, readAt: null } }),
  ]);
  res.json({ notifications: rows.map(publicNotification), unread });
}));

notificationsRouter.post('/read', asyncRoute(async (req, res) => {
  const me = actor(req);
  await prisma.notification.updateMany({
    where: { userId: me.id, readAt: null }, data: { readAt: new Date() },
  });
  res.json({ ok: true });
}));

/* ---------------- Web Push subscriptions ---------------- */
notificationsRouter.get('/push-key', (_req, res) => {
  const key = pushPublicKey();
  res.json({ publicKey: key, configured: key != null });
});

const subscription = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

notificationsRouter.post('/subscribe', validate(subscription), asyncRoute(async (req, res) => {
  const me = actor(req);
  const input = req.body as z.infer<typeof subscription>;
  await prisma.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: {
      userId: me.id, endpoint: input.endpoint,
      p256dh: input.keys.p256dh, auth: input.keys.auth,
      userAgent: req.headers['user-agent'] ?? null,
    },
    update: { userId: me.id, p256dh: input.keys.p256dh, auth: input.keys.auth },
  });
  res.status(201).json({ ok: true });
}));

notificationsRouter.post('/unsubscribe', validate(z.object({ endpoint: z.string().url() })),
  asyncRoute(async (req, res) => {
    const { endpoint } = req.body as { endpoint: string };
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: actor(req).id } });
    res.json({ ok: true });
  }));
