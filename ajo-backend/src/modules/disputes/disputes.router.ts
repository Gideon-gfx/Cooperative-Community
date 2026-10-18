import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { assertGroupMember } from '../../lib/access';
import { audit } from '../../lib/audit';
import { safeSms } from '../../lib/notify';
import { objectId } from '../../lib/validators';
import { authenticate } from '../../middleware/auth.middleware';

export const disputesRouter = Router();
disputesRouter.use(authenticate);

disputesRouter.post('/', async (req, res) => {
  const b = z
    .object({
      groupId: objectId, ajoPoolId: objectId.optional(), scheduleId: objectId.optional(), foodPoolId: objectId.optional(),
      kind: z.enum(['PAYOUT_NOT_RECEIVED', 'PAYMENT_NOT_RECORDED', 'WRONG_AMOUNT', 'FOOD_QUALITY', 'FOOD_SHORTFALL', 'COLLECTOR_CONDUCT', 'OTHER']),
      description: z.string().min(5).max(600),
    })
    .parse(req.body);
  await assertGroupMember(b.groupId, req.user!.id);
  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: b.groupId }, include: { admin: true } });
  const dispute = await prisma.dispute.create({ data: { ...b, raisedById: req.user!.id } });
  await safeSms(group.admin.phoneNumber, `A member raised a dispute in "${group.name}": ${b.kind.replace(/_/g, ' ').toLowerCase()}. Please review it in ÀJỌ app.`);
  await audit(req.user!.id, 'DISPUTE_RAISED', 'Dispute', dispute.id, { kind: b.kind });
  res.status(201).json({ dispute });
});

/** Collector sees every dispute in their group; a member sees their own; a platform admin sees escalated ones everywhere. */
disputesRouter.get('/', async (req, res) => {
  const q = z.object({ groupId: objectId.optional() }).parse(req.query);
  const me = req.user!;
  let where;
  if (q.groupId) {
    const group = await prisma.communityGroup.findUnique({ where: { id: q.groupId } });
    if (!group) throw new HttpError(404, 'Group not found');
    await assertGroupMember(q.groupId, me.id);
    where = group.adminId === me.id || me.role === 'ADMIN' ? { groupId: q.groupId } : { groupId: q.groupId, raisedById: me.id };
  } else if (me.role === 'ADMIN') where = { status: 'ESCALATED' as const };
  else where = { raisedById: me.id };
  const disputes = await prisma.dispute.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  const names = await prisma.user.findMany({ where: { id: { in: disputes.map((d) => d.raisedById) } }, select: { id: true, fullName: true } });
  res.json({ disputes: disputes.map((d) => ({ ...d, raisedByName: names.find((n) => n.id === d.raisedById)?.fullName })) });
});

/** Any group member involved can take a dispute above the collector, to the platform admin. */
disputesRouter.post('/:id/escalate', async (req, res) => {
  const d = await prisma.dispute.findUnique({ where: { id: String(req.params.id) } });
  if (!d) throw new HttpError(404, 'Dispute not found');
  if (d.raisedById !== req.user!.id) throw new HttpError(403, 'Only the person who raised it can escalate');
  if (d.status === 'RESOLVED') throw new HttpError(409, 'Already resolved');
  const updated = await prisma.dispute.update({ where: { id: d.id }, data: { status: 'ESCALATED' } });
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
  for (const a of admins) await safeSms(a.phoneNumber, 'ÀJỌ: a dispute was escalated and needs review.');
  await audit(req.user!.id, 'DISPUTE_ESCALATED', 'Dispute', d.id);
  res.json({ dispute: updated });
});

disputesRouter.patch('/:id/resolve', async (req, res) => {
  const { resolution } = z.object({ resolution: z.string().min(3).max(600) }).parse(req.body);
  const d = await prisma.dispute.findUnique({ where: { id: String(req.params.id) } });
  if (!d) throw new HttpError(404, 'Dispute not found');
  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: d.groupId } });
  const isAdmin = req.user!.role === 'ADMIN';
  if (group.adminId !== req.user!.id && !isAdmin) throw new HttpError(403, 'Only the collector or a platform admin can resolve this');
  // Once escalated, the collector can no longer close their own dispute.
  if (d.status === 'ESCALATED' && !isAdmin) throw new HttpError(403, 'This dispute was escalated to a platform admin');
  const updated = await prisma.dispute.update({ where: { id: d.id }, data: { status: 'RESOLVED', resolution, resolvedById: req.user!.id, resolvedAt: new Date() } });
  // A disputed payout goes back to the recipient to confirm again.
  if (d.scheduleId) await prisma.ajoRotationSchedule.updateMany({ where: { id: d.scheduleId, status: 'DISPUTED' }, data: { status: 'COMPLETED', recipientConfirmedAt: null } });
  const raiser = await prisma.user.findUnique({ where: { id: d.raisedById } });
  await safeSms(raiser?.phoneNumber, `Your ÀJỌ dispute was resolved: ${resolution}`);
  await audit(req.user!.id, 'DISPUTE_RESOLVED', 'Dispute', d.id);
  res.json({ dispute: updated });
});
