import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middleware/auth.middleware';

export const pushRouter = Router();
pushRouter.use(authenticate);

const tokenBody = z.object({
  token: z.string().regex(/^(?:Expo|Exponent)PushToken\[[^\]]+\]$/, 'Invalid Expo push token'),
});

pushRouter.post('/token', async (req, res) => {
  const { token } = tokenBody.parse(req.body);
  await prisma.pushToken.upsert({
    where: { token },
    create: { token, userId: req.user!.id },
    update: { userId: req.user!.id },
  });
  res.status(204).end();
});

pushRouter.delete('/token', async (req, res) => {
  const { token } = tokenBody.parse(req.body);
  await prisma.pushToken.deleteMany({ where: { token, userId: req.user!.id } });
  res.status(204).end();
});
