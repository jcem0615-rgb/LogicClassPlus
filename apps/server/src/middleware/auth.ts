import type { NextFunction, Request, Response } from 'express';
import type { Role, User } from '@prisma/client';
import { prisma } from '../prisma.js';
import { verifyToken } from '../lib/jwt.js';
import { forbidden, unauthorized } from '../lib/http-error.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

function tokenFrom(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.['lc_token'];
  return cookie ?? null;
}

/** Populates req.user when a valid token is present. Never rejects. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = tokenFrom(req);
  if (!token) { next(); return; }
  const payload = verifyToken(token);
  if (!payload) { next(); return; }
  const user = await prisma.user.findUnique({ where: { id: payload.sub } });
  if (user && user.status === 'ACTIVE') req.user = user;
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) { next(unauthorized()); return; }
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) { next(unauthorized()); return; }
    if (!roles.includes(req.user.role)) {
      next(forbidden(`This action is limited to: ${roles.join(', ').toLowerCase()}.`));
      return;
    }
    next();
  };
}

/** The signed-in user, for handlers mounted behind requireAuth. */
export function actor(req: Request): User {
  if (!req.user) throw unauthorized();
  return req.user;
}
