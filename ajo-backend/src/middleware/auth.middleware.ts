import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { config } from '../lib/config';

export interface AuthUser {
  id: string;
  role: UserRole;
  phone: string | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return void res.status(401).json({ error: 'Missing token' });
  try {
    const p = jwt.verify(header.slice(7), config.jwtSecret) as { userId: string; role: UserRole; phone?: string | null };
    req.user = { id: p.userId, role: p.role, phone: p.phone ?? null };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export const roleGuard = (roles: UserRole[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) return void res.status(403).json({ error: 'Forbidden for your role' });
  next();
};
