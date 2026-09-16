import type { Notification } from '@prisma/client';
import { prisma } from '../prisma.js';
import { publicNotification } from '../lib/serialize.js';
import { emitToUser } from '../realtime/gateway.js';
import { sendPush } from './push.js';

export interface NotifyInput {
  userId: string;
  type: string;
  title: string;
  body: string;
  url?: string;
}

/**
 * One call fans a notification out three ways: persisted for the bell,
 * pushed down the user's socket for the in-app banner, and delivered as a
 * Web Push message for anyone who is not currently connected.
 */
export async function notify(input: NotifyInput): Promise<Notification> {
  const record = await prisma.notification.create({
    data: {
      userId: input.userId, type: input.type, title: input.title,
      body: input.body, url: input.url ?? null,
    },
  });
  emitToUser(input.userId, 'notification:new', publicNotification(record));
  void sendPush(input.userId, { title: input.title, body: input.body, url: input.url });
  return record;
}

export async function notifyMany(inputs: NotifyInput[]): Promise<void> {
  for (const input of inputs) await notify(input);
}
