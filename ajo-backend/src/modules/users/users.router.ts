import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { authenticate } from '../../middleware/auth.middleware';
import { getCollectorStats, getTrust } from '../../services/trust.service';

export const usersRouter = Router();
usersRouter.use(authenticate);

/** Trust summary of someone you share a group with (so you can judge new pool-mates and collectors). */
usersRouter.get('/:id/trust', async (req, res) => {
  const targetId = String(req.params.id);
  if (targetId !== req.user!.id) {
    const mine = await prisma.groupMember.findMany({ where: { userId: req.user!.id }, select: { groupId: true } });
    const shared = await prisma.groupMember.findFirst({ where: { userId: targetId, groupId: { in: mine.map((m) => m.groupId) } } });
    if (!shared) throw new HttpError(403, 'You can only see people in your groups');
  }
  const user = await prisma.user.findUnique({ where: { id: targetId }, select: { id: true, fullName: true, role: true } });
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user, trust: await getTrust(targetId), collector: user.role === 'COLLECTOR' ? await getCollectorStats(targetId) : null });
});
