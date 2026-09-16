import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../env.js';

export interface TokenPayload {
  sub: string;
  role: Role;
  email: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded === 'string') return null;
    const { sub, role, email } = decoded as jwt.JwtPayload & Partial<TokenPayload>;
    if (!sub || !role || !email) return null;
    return { sub, role, email };
  } catch {
    return null;
  }
}
