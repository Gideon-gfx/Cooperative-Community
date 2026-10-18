import { prisma } from '../lib/prisma';
import { computeTrustScore } from '../modules/ajo/ajo.logic';

export async function getTrust(userId: string) {
  const [verifiedRows, missed, completedPools] = await Promise.all([
    prisma.ajoContribution.findMany({ where: { contributorId: userId, status: 'VERIFIED' }, select: { wasLate: true, coveredByCollector: true } }),
    prisma.ajoContribution.count({ where: { contributorId: userId, status: 'MISSED' } }),
    prisma.ajoPool.count({ where: { status: 'COMPLETED', contributions: { some: { contributorId: userId } } } }),
  ]);
  // A share the collector had to cover counts against the member exactly like a missed one.
  const covered = verifiedRows.filter((r) => r.coveredByCollector).length;
  const paid = verifiedRows.filter((r) => !r.coveredByCollector);
  const late = paid.filter((r) => r.wasLate).length;
  return computeTrustScore({ verified: paid.length, onTime: paid.length - late, late, missed: missed + covered, completedPools });
}

/** Collector reputation: how many groups/cycles they have run and how many payouts members confirmed. */
export async function getCollectorStats(userId: string) {
  const groups = await prisma.communityGroup.findMany({ where: { adminId: userId }, select: { id: true } });
  const groupIds = groups.map((g) => g.id);
  const [completedPayouts, confirmedPayouts, openDisputes, user] = await Promise.all([
    prisma.ajoRotationSchedule.count({ where: { status: 'COMPLETED', ajoPool: { groupId: { in: groupIds } } } }),
    prisma.ajoRotationSchedule.count({ where: { recipientConfirmedAt: { not: null }, ajoPool: { groupId: { in: groupIds } } } }),
    prisma.dispute.count({ where: { groupId: { in: groupIds }, status: { in: ['OPEN', 'ESCALATED'] } } }),
    prisma.user.findUnique({ where: { id: userId }, select: { collectorApproved: true } }),
  ]);
  return { verified: !!user?.collectorApproved, groups: groupIds.length, completedPayouts, confirmedPayouts, openDisputes };
}
