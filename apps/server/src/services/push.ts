import webpush from 'web-push';
import { env, isPushConfigured } from '../env.js';
import { prisma } from '../prisma.js';

let ready = false;
function configure(): boolean {
  if (ready) return true;
  if (!isPushConfigured()) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  ready = true;
  return true;
}

export function pushPublicKey(): string | null {
  return isPushConfigured() ? env.VAPID_PUBLIC_KEY! : null;
}

/** Best-effort Web Push. Subscriptions the browser has dropped are pruned. */
export async function sendPush(
  userId: string,
  payload: { title: string; body: string; url?: string },
): Promise<void> {
  if (!configure()) return;
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
        }
      }
    }),
  );
}
