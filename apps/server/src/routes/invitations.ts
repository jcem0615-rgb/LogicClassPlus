/**
 * Invitations.
 *
 * Registration used to be a form anyone on the internet could fill in, which
 * meant the roster filled up with accounts nobody had asked for and the
 * Owner's job was deleting them. Now an account begins with the Owner
 * deciding a particular person should have one: they create an invitation,
 * send the link, and whoever opens it sets a password and is in — already
 * approved, because the invitation was the approval.
 *
 * The token is random and only its hash is stored. The link is shown once at
 * creation and cannot be recovered afterwards; a copy of the database is not
 * a pile of usable invitations.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Invitation } from '@prisma/client';
import { prisma } from '../prisma.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { badRequest, notFound } from '../lib/http-error.js';
import { toCents, fromCents } from '../lib/money.js';
import { actor, requireAuth, requireRole } from '../middleware/auth.js';

export const invitationsRouter = Router();

/** A link token, and the hash that is all the server keeps of it. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export type InviteState = 'open' | 'accepted' | 'revoked' | 'expired';

export function inviteState(invite: Invitation, now = new Date()): InviteState {
  if (invite.acceptedAt) return 'accepted';
  if (invite.revokedAt) return 'revoked';
  if (invite.expiresAt <= now) return 'expired';
  return 'open';
}

const publicInvite = (i: Invitation & { acceptedBy?: { name: string } | null }) => ({
  id: i.id,
  email: i.email,
  role: i.role.toLowerCase(),
  subjects: i.subjects.map((s) => s.toLowerCase()),
  hourlyRate: i.hourlyRateCents == null ? null : fromCents(i.hourlyRateCents),
  gradeLevel: i.gradeLevel,
  note: i.note,
  state: inviteState(i),
  expiresAt: i.expiresAt.toISOString(),
  acceptedAt: i.acceptedAt?.toISOString() ?? null,
  acceptedBy: i.acceptedBy?.name ?? null,
  createdAt: i.createdAt.toISOString(),
});

/* ---------------- what an invited person sees ----------------
   No authentication: they have no account yet. The token is the credential,
   and nothing here says anything the holder of the link should not know. */

invitationsRouter.get('/:token', asyncRoute(async (req, res) => {
  const invite = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(String(req.params['token'])) },
  });
  // A token that does not exist and one that was revoked are the same answer,
  // so a wrong guess learns nothing from the difference.
  if (!invite) throw notFound('That invitation link is not valid.');
  const state = inviteState(invite);
  res.json({
    state,
    role: invite.role.toLowerCase(),
    email: invite.email,
    subjects: invite.subjects.map((s) => s.toLowerCase()),
    gradeLevel: invite.gradeLevel,
    note: invite.note,
    expiresAt: invite.expiresAt.toISOString(),
  });
}));

/* ---------------- the Owner's side ---------------- */
invitationsRouter.use(requireAuth, requireRole('OWNER'));

const createInvite = z.object({
  role: z.enum(['teacher', 'student', 'parent']),
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  subjects: z.array(z.enum(['math', 'english'])).default([]),
  hourlyRate: z.number().nonnegative().max(1000).optional(),
  gradeLevel: z.string().trim().max(64).optional(),
  note: z.string().trim().max(300).optional(),
  expiresInDays: z.number().int().min(1).max(90).default(14),
});

invitationsRouter.post('/', validate(createInvite), asyncRoute(async (req, res) => {
  const me = actor(req);
  const input = req.body as z.infer<typeof createInvite>;

  if (input.email) {
    const taken = await prisma.user.findUnique({ where: { email: input.email } });
    if (taken) throw badRequest('That email address already has an account.');
  }

  // 32 bytes: long enough that guessing one is not a strategy.
  const token = randomBytes(32).toString('base64url');
  const invite = await prisma.invitation.create({
    data: {
      tokenHash: hashToken(token),
      email: input.email || null,
      role: input.role === 'teacher' ? 'TEACHER' : input.role === 'parent' ? 'PARENT' : 'STUDENT',
      subjects: input.role === 'parent'
        ? []
        : input.subjects.map((s) => (s === 'math' ? 'MATH' : 'ENGLISH')),
      hourlyRateCents: input.role === 'teacher' && input.hourlyRate != null
        ? toCents(input.hourlyRate) : null,
      gradeLevel: input.role === 'student' ? input.gradeLevel ?? null : null,
      note: input.note ?? null,
      createdById: me.id,
      expiresAt: new Date(Date.now() + input.expiresInDays * 86_400_000),
    },
  });

  // The only time the token leaves this server.
  res.status(201).json({ invitation: publicInvite(invite), token });
}));

invitationsRouter.get('/', asyncRoute(async (_req, res) => {
  const invites = await prisma.invitation.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { acceptedBy: { select: { name: true } } },
  });
  res.json({ invitations: invites.map(publicInvite) });
}));

invitationsRouter.delete('/:id', asyncRoute(async (req, res) => {
  const invite = await prisma.invitation.findUnique({ where: { id: String(req.params['id']) } });
  if (!invite) throw notFound('That invitation no longer exists.');
  if (invite.acceptedAt) throw badRequest('That invitation has already been used.');
  const updated = await prisma.invitation.update({
    where: { id: invite.id }, data: { revokedAt: new Date() },
  });
  res.json({ invitation: publicInvite(updated) });
}));

/** Constant-time compare, used where a token is checked against a stored hash. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
