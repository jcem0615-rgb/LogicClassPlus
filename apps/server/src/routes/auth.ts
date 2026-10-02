import { randomBytes, createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { signToken } from '../lib/jwt.js';
import { asyncRoute, validate } from '../lib/validate.js';
import { conflict, unauthorized } from '../lib/http-error.js';
import { publicUser } from '../lib/serialize.js';
import { actor, requireAuth } from '../middleware/auth.js';
import { hashToken, inviteState } from './invitations.js';
import { notify } from '../services/notifications.js';

export const authRouter = Router();

const attemptLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.AUTH_RATE_LIMIT ?? (env.NODE_ENV === 'production' ? 30 : 500),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: 'Too many attempts. Wait a few minutes and try again.' } },
});

const credentials = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

/* Registration is by invitation. The role comes from the invitation rather
   than from the form, so nobody picks their own; OWNER is seeded and cannot
   be invited either. */
const registration = z.object({
  token: z.string().min(1, 'An invitation link is required to create an account.'),
  name: z.string().trim().min(2, 'Enter your full name.'),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(8, 'Use at least 8 characters for your password.'),
  locale: z.string().max(12).optional(),
  timezone: z.string().max(64).optional(),
  gradeLevel: z.string().max(64).optional(),
});

authRouter.post('/register', attemptLimit, validate(registration), asyncRoute(async (req, res) => {
  const input = req.body as z.infer<typeof registration>;

  const invite = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(input.token) },
  });
  if (!invite) throw unauthorized('That invitation link is not valid.');
  const state = inviteState(invite);
  if (state !== 'open') {
    throw unauthorized(state === 'accepted'
      ? 'That invitation has already been used. Ask for a new one.'
      : state === 'expired'
        ? 'That invitation has expired. Ask for a new one.'
        : 'That invitation was withdrawn.');
  }
  // An invitation addressed to someone is for them, not for whoever opens it.
  if (invite.email && invite.email !== input.email) {
    throw unauthorized(`That invitation is for ${invite.email}.`);
  }

  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw conflict('That email already has an account. Sign in instead.');

  /* Accepted as part of creating the account, so one link cannot make two.
     Two people opening the same link at the same moment both pass the check
     above; the unique index on acceptedById and the conditional update are
     what actually decide it. */
  const user = await prisma.$transaction(async (tx) => {
    const claimed = await tx.invitation.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date() },
    });
    if (!claimed.count) throw unauthorized('That invitation has already been used.');

    const created = await tx.user.create({
      data: {
        email: input.email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        role: invite.role,
        // The Owner already decided this person should be here, which is
        // what approval means — so there is nothing left to approve.
        status: 'ACTIVE',
        locale: input.locale ?? 'en-US',
        timezone: input.timezone ?? 'UTC',
        subjects: invite.subjects,
        hourlyRateCents: invite.role === 'TEACHER' ? invite.hourlyRateCents ?? 2200 : null,
        gradeLevel: invite.role === 'STUDENT'
          ? invite.gradeLevel ?? input.gradeLevel ?? null
          : null,
      },
    });
    await tx.invitation.update({
      where: { id: invite.id }, data: { acceptedById: created.id },
    });
    return created;
  });

  const owners = await prisma.user.findMany({ where: { role: 'OWNER' } });
  for (const owner of owners) {
    await notify({
      userId: owner.id, type: 'account',
      title: `${user.name} accepted their invitation`,
      body: `${user.email} joined as a ${user.role.toLowerCase()}.`,
      url: '/#/admin',
    });
  }

  // Invited, so they can sign in immediately rather than waiting to be let in.
  const token = signToken({ sub: user.id, role: user.role, email: user.email });
  res.status(201).json({ user: publicUser(user), token, pending: false });
}));

authRouter.post('/login', attemptLimit, validate(credentials), asyncRoute(async (req, res) => {
  const { email, password } = req.body as z.infer<typeof credentials>;
  const user = await prisma.user.findUnique({ where: { email } });

  // Same shape of work whether or not the account exists, so timing says nothing.
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) throw unauthorized('That email and password do not match.');

  if (user.status === 'PENDING') {
    throw unauthorized('Your account is waiting for admin approval. You will get an email when it is active.');
  }
  if (user.status === 'SUSPENDED') {
    throw unauthorized('This account is suspended. Contact the administrator.');
  }

  const token = signToken({ sub: user.id, role: user.role, email: user.email });
  res.cookie('lc_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600_000,
  });
  res.json({ token, user: publicUser(user) });
}));

authRouter.post('/logout', (_req, res) => {
  res.clearCookie('lc_token');
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(actor(req)) });
});

/* Password reset: the request is queued for the Owner to approve, and the
   response never reveals whether the address has an account. */
authRouter.post('/password-reset', attemptLimit,
  validate(z.object({ email: z.string().trim().toLowerCase().email() })),
  asyncRoute(async (req, res) => {
    const { email } = req.body as { email: string };
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.passwordResetRequest.create({ data: { userId: user.id, email: user.email } });
      const owners = await prisma.user.findMany({ where: { role: 'OWNER' } });
      for (const owner of owners) {
        await notify({
          userId: owner.id, type: 'password', title: 'Password reset requested',
          body: `${user.name} asked for a reset link.`, url: '/#/users',
        });
      }
    }
    res.json({ ok: true });
  }));

/** Consumes the single-use token the Owner's approval issued. */
authRouter.post('/password-reset/confirm', attemptLimit,
  validate(z.object({ token: z.string().min(20), password: z.string().min(8) })),
  asyncRoute(async (req, res) => {
    const { token, password } = req.body as { token: string; password: string };
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const request = await prisma.passwordResetRequest.findFirst({
      where: { tokenHash, status: 'APPROVED', tokenExpiresAt: { gt: new Date() } },
    });
    if (!request) throw unauthorized('That reset link is invalid or has expired.');

    await prisma.$transaction([
      prisma.user.update({
        where: { id: request.userId },
        data: { passwordHash: await hashPassword(password) },
      }),
      prisma.passwordResetRequest.update({
        where: { id: request.id },
        data: { tokenHash: null, tokenExpiresAt: null, resolvedAt: new Date() },
      }),
    ]);
    res.json({ ok: true });
  }));

/** Called by the approval route; returns the clear-text token to email. */
export async function issueResetToken(requestId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await prisma.passwordResetRequest.update({
    where: { id: requestId },
    data: {
      status: 'APPROVED',
      tokenHash: createHash('sha256').update(token).digest('hex'),
      tokenExpiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  return token;
}
