import { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { HttpError } from '../lib/errors';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  if (err instanceof ZodError) return void res.status(400).json({ error: 'Validation failed', details: err.issues });
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return void res.status(409).json({ error: 'Already exists' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
}
