import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { assertGroupMember } from '../../lib/access';
import { objectId } from '../../lib/validators';
import { verifyPin } from '../../lib/security';
import { round2 } from '../../lib/money';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { remainingToPay } from './ajo.logic';
import {
  acceptRules, addManualEntry, confirmReceipt, createAjoPool, decideSwap, exportPoolCsv, poolLedger, recordPayment, recordPayout,
  rejectPayment, requestSwap, respondSwap, verifyContribution,
} from './ajo.service';
import { attestFunds } from '../../services/ledger.service';
import { assertCanStartCycle } from '../billing/billing.service';

export const ajoRouter = Router();
ajoRouter.use(authenticate);

const method = z.enum(['TRANSFER', 'CASH']);

async function loadPool(id: string) {
  const pool = await prisma.ajoPool.findUnique({ where: { id }, include: { group: { select: { id: true, name: true, adminId: true, currency: true, fundsMode: true } } } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  return pool;
}
async function loadPoolForCollector(id: string, userId: string) {
  const pool = await loadPool(id);
  if (pool.group.adminId !== userId) throw new HttpError(403, 'Only the pool collector can do this');
  return pool;
}

async function scheduleView(poolId: string) {
  const schedules = await prisma.ajoRotationSchedule.findMany({
    where: { ajoPoolId: poolId },
    orderBy: { payoutOrder: 'asc' },
    include: { recipient: { select: { id: true, fullName: true } }, contributions: { select: { status: true } } },
  });
  return schedules.map((s) => ({
    id: s.id,
    payoutOrder: s.payoutOrder,
    recipientId: s.recipient.id,
    recipientName: s.recipient.fullName,
    payoutDate: s.payoutDate,
    status: s.status,
    contributionsCount: s.contributions.length,
    verifiedCount: s.contributions.filter((c) => c.status === 'VERIFIED').length,
    receiptUrl: s.receiptUrl,
    netPayout: s.netPayout,
    payoutMethod: s.payoutMethod,
    payoutRef: s.payoutRef,
    paidOutAt: s.paidOutAt,
    recipientConfirmedAt: s.recipientConfirmedAt,
  }));
}

ajoRouter.post('/pools/create', roleGuard(['COLLECTOR', 'ADMIN']), async (req, res) => {
  const b = z
    .object({
      groupId: objectId,
      title: z.string().min(2),
      amountPerMember: z.number().positive(),
      cycleFrequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
      collectorFeePct: z.number().min(0).max(10).default(2),
      memberIds: z.array(objectId).min(2),
      startDate: z.coerce.date(),
      preserveOrder: z.boolean().optional(),
      rulesText: z.string().max(2000).optional(),
      lateFeeAmount: z.number().min(0).optional(),
      graceDays: z.number().int().min(0).max(14).optional(),
      hands: z.record(z.string(), z.number().int().min(1).max(3)).optional(),
      guarantors: z.record(z.string(), objectId).optional(),
    })
    .parse(req.body);
  const { groupId, ...params } = b;
  await assertCanStartCycle(req.user!); // new cycles only: running cycles and members are never blocked
  res.status(201).json({ pool: await createAjoPool(req.user!.id, groupId, params) });
});

/** Everything the member dashboard and notification bell need, in one call. */
ajoRouter.get('/my-pools', async (req, res) => {
  const userId = req.user!.id;
  const pools = await prisma.ajoPool.findMany({
    where: { OR: [{ schedules: { some: { recipientId: userId } } }, { contributions: { some: { contributorId: userId } } }, { group: { adminId: userId } }] },
    include: { group: { select: { name: true, currency: true, adminId: true } }, schedules: { where: { recipientId: userId } } },
  });
  const mine = await prisma.ajoContribution.findMany({
    where: { contributorId: userId, status: { in: ['PENDING', 'LATE', 'MISSED'] } },
    include: { payments: true, schedule: { include: { recipient: { select: { fullName: true } } } }, ajoPool: { select: { title: true, group: { select: { currency: true } } } } },
    orderBy: { dueAt: 'asc' },
  });
  const notifications: Record<string, unknown>[] = [];
  for (const c of mine) {
    const pending = c.payments.filter((p) => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
    const remaining = remainingToPay(c.amount, c.paidAmount, pending);
    if (remaining > 0) {
      notifications.push({ kind: c.status === 'MISSED' ? 'MISSED' : 'DUE', contributionId: c.id, scheduleId: c.scheduleId, poolId: c.ajoPoolId, poolTitle: c.ajoPool.title, recipientName: c.schedule.recipient.fullName, amount: remaining, currency: c.ajoPool.group.currency, dueAt: c.dueAt });
    }
  }
  const toConfirm = await prisma.ajoRotationSchedule.findMany({
    where: { recipientId: userId, status: 'COMPLETED', OR: [{ recipientConfirmedAt: null }, { recipientConfirmedAt: { isSet: false } }] },
    include: { ajoPool: { select: { id: true, title: true } } },
  });
  for (const s of toConfirm) notifications.push({ kind: 'CONFIRM_PAYOUT', scheduleId: s.id, poolId: s.ajoPoolId, poolTitle: s.ajoPool.title, amount: s.netPayout });
  const adminPools = pools.filter((p) => p.group.adminId === userId).map((p) => p.id);
  if (adminPools.length) {
    const ready = await prisma.ajoRotationSchedule.findMany({ where: { ajoPoolId: { in: adminPools }, status: 'READY' }, include: { ajoPool: { select: { title: true } }, recipient: { select: { fullName: true } } } });
    for (const s of ready) notifications.push({ kind: 'PAYOUT_READY', scheduleId: s.id, poolId: s.ajoPoolId, poolTitle: s.ajoPool.title, recipientName: s.recipient.fullName });
    const toVerify = await prisma.contributionPayment.groupBy({ by: ['ajoPoolId'], where: { ajoPoolId: { in: adminPools }, status: 'PENDING' }, _count: { _all: true } });
    for (const g of toVerify) notifications.push({ kind: 'PAYMENTS_TO_VERIFY', poolId: g.ajoPoolId, poolTitle: pools.find((p) => p.id === g.ajoPoolId)?.title, count: g._count._all });
  }
  res.json({
    pools: pools.map((p) => ({
      id: p.id, title: p.title, groupName: p.group.name, currency: p.group.currency, status: p.status, amountPerMember: p.amountPerMember,
      myCollectionDate: p.schedules[0]?.payoutDate ?? null,
      nextDueAt: mine.find((c) => c.ajoPoolId === p.id && c.status === 'PENDING')?.dueAt ?? null,
    })),
    notifications,
  });
});

ajoRouter.get('/pools/:id', async (req, res) => {
  const pool = await loadPool(String(req.params.id));
  await assertGroupMember(pool.groupId, req.user!.id);
  const userId = req.user!.id;
  const [mine, accepted, guarantee, swaps, ledger, openDisputes] = await Promise.all([
    prisma.ajoContribution.findMany({ where: { ajoPoolId: pool.id, contributorId: userId }, include: { payments: true } }),
    prisma.poolAcceptance.findUnique({ where: { ajoPoolId_userId: { ajoPoolId: pool.id, userId } } }),
    prisma.ajoGuarantee.findMany({ where: { ajoPoolId: pool.id } }),
    prisma.turnSwap.findMany({ where: { ajoPoolId: pool.id, status: { in: ['PENDING_PEER', 'PENDING_COLLECTOR'] } } }),
    poolLedger(pool.id),
    prisma.dispute.count({ where: { ajoPoolId: pool.id, status: { in: ['OPEN', 'ESCALATED'] } } }),
  ]);
  res.json({
    pool: { ...pool, isCollector: pool.group.adminId === userId },
    schedule: await scheduleView(pool.id),
    myContributions: mine.map((c) => {
      const pending = c.payments.filter((p) => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
      return { id: c.id, scheduleId: c.scheduleId, amount: c.amount, paidAmount: c.paidAmount, pendingAmount: round2(pending), remaining: remainingToPay(c.amount, c.paidAmount, pending), status: c.status, dueAt: c.dueAt, fineAmount: c.fineAmount };
    }),
    rulesAccepted: !!accepted,
    guarantees: guarantee.length,
    pendingSwaps: swaps.filter((s) => s.requesterId === userId || s.peerId === userId || pool.group.adminId === userId),
    funds: { heldByCollector: ledger.heldByCollector, totalIn: ledger.totalIn, totalOut: ledger.totalOut, stillExpected: ledger.stillExpected, lastAttestation: ledger.lastAttestation },
    openDisputes,
  });
});

ajoRouter.get('/pools/:id/schedule', async (req, res) => {
  const pool = await loadPool(String(req.params.id));
  await assertGroupMember(pool.groupId, req.user!.id);
  res.json({ schedule: await scheduleView(pool.id) });
});

/** Contributions for a turn. The collector sees everyone (with payments to verify); a member sees only their own. */
ajoRouter.get('/schedules/:id/contributions', async (req, res) => {
  const s = await prisma.ajoRotationSchedule.findUnique({ where: { id: String(req.params.id) }, include: { ajoPool: { include: { group: true } } } });
  if (!s) throw new HttpError(404, 'Schedule not found');
  await assertGroupMember(s.ajoPool.groupId, req.user!.id);
  const isCollector = s.ajoPool.group.adminId === req.user!.id;
  const rows = await prisma.ajoContribution.findMany({
    where: { scheduleId: s.id, ...(isCollector ? {} : { contributorId: req.user!.id }) },
    include: { contributor: { select: { id: true, fullName: true, accountType: true } }, payments: { orderBy: { createdAt: 'asc' } } },
  });
  res.json({
    contributions: rows.map((c) => {
      const pending = c.payments.filter((p) => p.status === 'PENDING').reduce((sum, p) => sum + p.amount, 0);
      return {
        id: c.id, contributorId: c.contributor.id, contributorName: c.contributor.fullName, assisted: c.contributor.accountType === 'ASSISTED',
        amount: c.amount, paidAmount: c.paidAmount, remaining: remainingToPay(c.amount, c.paidAmount, pending), status: c.status, dueAt: c.dueAt,
        covered: c.coveredByCollector,
        payments: c.payments.map((p) => ({ id: p.id, amount: p.amount, method: p.method, status: p.status, proofUrl: p.proofUrl, reference: p.reference, createdAt: p.createdAt, rejectReason: p.rejectReason })),
      };
    }),
  });
});

const recordBody = z.object({
  contributionId: objectId.optional(),
  scheduleId: objectId.optional(),
  amount: z.number().positive().optional(),
  method: method.optional(),
  proofUrl: z.string().url().optional(),
  reference: z.string().max(100).optional(),
});

ajoRouter.post('/contributions/record', async (req, res) => {
  const b = recordBody.parse(req.body);
  res.status(201).json(await recordPayment(req.user!, b));
});

/** Collector records a payment for a member (cash handed over, or an assisted account), or covers their share. */
ajoRouter.post('/contributions/record-for', roleGuard(['COLLECTOR', 'ADMIN']), async (req, res) => {
  const b = recordBody.extend({ contributorId: objectId, coverShortfall: z.boolean().optional() }).parse(req.body);
  res.status(201).json(await recordPayment(req.user!, b));
});

ajoRouter.patch('/contributions/:id/verify', roleGuard(['COLLECTOR', 'ADMIN']), async (req, res) => {
  res.json(await verifyContribution(req.user!, String(req.params.id)));
});

ajoRouter.patch('/payments/:id/reject', roleGuard(['COLLECTOR', 'ADMIN']), async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(2).max(200) }).parse(req.body);
  res.json({ payment: await rejectPayment(req.user!, String(req.params.id), reason) });
});

/** Collector pays the recipient themselves (cash or bank transfer), then records it here. Requires their PIN. */
ajoRouter.post('/schedules/:id/payout', roleGuard(['COLLECTOR']), async (req, res) => {
  const b = z.object({ method, reference: z.string().max(100).optional(), proofUrl: z.string().url().optional(), pin: z.string() }).parse(req.body);
  await verifyPin(req.user!.id, b.pin);
  res.json(await recordPayout(req.user!.id, String(req.params.id), b));
});

ajoRouter.post('/schedules/:id/confirm-receipt', async (req, res) => {
  const b = z.object({ received: z.boolean(), note: z.string().max(300).optional() }).parse(req.body);
  res.json(await confirmReceipt(req.user!.id, String(req.params.id), b.received, b.note));
});

ajoRouter.get('/receipts/:scheduleId', async (req, res) => {
  const s = await prisma.ajoRotationSchedule.findUnique({ where: { id: String(req.params.scheduleId) }, include: { ajoPool: { include: { group: true } }, recipient: { select: { fullName: true } } } });
  if (!s) throw new HttpError(404, 'Schedule not found');
  await assertGroupMember(s.ajoPool.groupId, req.user!.id);
  res.json({
    receiptUrl: s.receiptUrl,
    breakdown: {
      poolTitle: s.ajoPool.title, currency: s.ajoPool.group.currency, cycleNumber: s.payoutOrder, recipientName: s.recipient.fullName,
      totalCollected: s.totalCollected, platformFee: s.platformFee, collectorFee: s.collectorFee, netPayout: s.netPayout,
      payoutMethod: s.payoutMethod, payoutRef: s.payoutRef, paidOutAt: s.paidOutAt, recipientConfirmedAt: s.recipientConfirmedAt, status: s.status,
    },
  });
});

// ── Transparency ──
ajoRouter.get('/pools/:id/ledger', async (req, res) => {
  const pool = await loadPool(String(req.params.id));
  await assertGroupMember(pool.groupId, req.user!.id);
  res.json({ currency: pool.group.currency, isCollector: pool.group.adminId === req.user!.id, ...(await poolLedger(pool.id)) });
});

ajoRouter.post('/pools/:id/ledger', roleGuard(['COLLECTOR']), async (req, res) => {
  const b = z.object({ type: z.enum(['FINE_COLLECTED', 'EXPENSE', 'ADJUSTMENT']), direction: z.enum(['IN', 'OUT']).default('IN'), amount: z.number().positive(), note: z.string().min(3).max(200), pin: z.string() }).parse(req.body);
  await verifyPin(req.user!.id, b.pin);
  res.status(201).json({ entry: await addManualEntry(req.user!.id, String(req.params.id), b) });
});

ajoRouter.post('/pools/:id/attest', roleGuard(['COLLECTOR']), async (req, res) => {
  const b = z.object({ declaredAmount: z.number().min(0), note: z.string().max(200).optional(), proofUrl: z.string().url().optional(), pin: z.string() }).parse(req.body);
  await verifyPin(req.user!.id, b.pin);
  const pool = await loadPoolForCollector(String(req.params.id), req.user!.id);
  res.status(201).json(await attestFunds({ ajoPoolId: pool.id }, req.user!.id, pool.groupId, pool.group.currency, b));
});

ajoRouter.post('/pools/:id/accept-rules', async (req, res) => {
  const b = z.object({ userId: objectId.optional() }).parse(req.body ?? {});
  res.json({ acceptance: await acceptRules(req.user!, String(req.params.id), b.userId) });
});

ajoRouter.get('/pools/:id/export.csv', roleGuard(['COLLECTOR']), async (req, res) => {
  const csv = await exportPoolCsv(req.user!.id, String(req.params.id));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ajo-pool-record.csv"');
  res.send('﻿' + csv);
});

// ── Turn swaps ──
ajoRouter.post('/pools/:id/swaps', async (req, res) => {
  const b = z.object({ myScheduleId: objectId, peerScheduleId: objectId, reason: z.string().max(200).optional() }).parse(req.body);
  const pool = await loadPool(String(req.params.id));
  await assertGroupMember(pool.groupId, req.user!.id);
  res.status(201).json({ swap: await requestSwap(req.user!.id, pool.id, b.myScheduleId, b.peerScheduleId, b.reason) });
});
ajoRouter.post('/swaps/:id/respond', async (req, res) => {
  const { accept } = z.object({ accept: z.boolean() }).parse(req.body);
  res.json({ swap: await respondSwap(req.user!.id, String(req.params.id), accept) });
});
ajoRouter.post('/swaps/:id/decide', roleGuard(['COLLECTOR']), async (req, res) => {
  const { approve } = z.object({ approve: z.boolean() }).parse(req.body);
  res.json({ swap: await decideSwap(req.user!.id, String(req.params.id), approve) });
});
