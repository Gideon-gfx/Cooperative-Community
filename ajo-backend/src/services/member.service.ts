import { prisma } from '../lib/prisma';
import { remainingToPay } from '../modules/ajo/ajo.logic';
import { getLedger } from './ledger.service';

/** A member's money picture across all pools: what they owe next, when they collect, and what the collector holds. */
export async function getMemberSummary(userId: string) {
  const [contribs, turns] = await Promise.all([
    prisma.ajoContribution.findMany({
      where: { contributorId: userId, status: { in: ['PENDING', 'LATE', 'MISSED'] }, ajoPool: { status: 'ACTIVE' } },
      include: { payments: true, ajoPool: { include: { group: { select: { currency: true } } } }, schedule: { include: { recipient: { select: { fullName: true } } } } },
      orderBy: { dueAt: 'asc' },
    }),
    prisma.ajoRotationSchedule.findMany({
      where: { recipientId: userId, status: { in: ['SCHEDULED', 'READY'] }, ajoPool: { status: 'ACTIVE' } },
      include: { ajoPool: { include: { group: { select: { currency: true } } } } },
      orderBy: { payoutDate: 'asc' },
    }),
  ]);
  const due = contribs
    .map((c) => {
      const pending = c.payments.filter((p) => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
      return { contributionId: c.id, poolId: c.ajoPoolId, pool: c.ajoPool.title, currency: c.ajoPool.group.currency, remaining: remainingToPay(c.amount, c.paidAmount, pending), dueAt: c.dueAt, recipient: c.schedule.recipient.fullName };
    })
    .filter((d) => d.remaining > 0);

  const poolIds = [...new Set([...contribs.map((c) => c.ajoPoolId), ...turns.map((t) => t.ajoPoolId)])];
  const pools = await prisma.ajoPool.findMany({ where: { id: { in: poolIds } }, include: { group: { select: { currency: true } } } });
  const funds = await Promise.all(
    pools.map(async (p) => {
      const l = await getLedger({ ajoPoolId: p.id });
      return { poolId: p.id, pool: p.title, currency: p.group.currency, held: l.heldByCollector, totalIn: l.totalIn, totalOut: l.totalOut };
    }),
  );
  return {
    due,
    turns: turns.map((t) => ({ poolId: t.ajoPoolId, pool: t.ajoPool.title, currency: t.ajoPool.group.currency, amount: t.ajoPool.amountPerMember * (t.ajoPool.totalMembers - 1), date: t.payoutDate })),
    funds,
  };
}
