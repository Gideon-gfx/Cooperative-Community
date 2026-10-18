import { FundsPurpose } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { getFundsProvider } from './funds-provider';

/**
 * Commission lifecycle for escrow contributions.
 *   PENDING  - taken when the contribution is confirmed (see MonnifyEscrowProvider.recordCollected)
 *   EARNED   - only when the cycle/pool completes successfully
 *   REFUNDED - the pool was dissolved: every contribution is refunded in FULL, commission included
 */
export async function earnCommission(purposeType: FundsPurpose, purposeId: string, actorId: string | null): Promise<number> {
  const r = await prisma.commissionAccrual.updateMany({ where: { purposeType, purposeId, status: 'PENDING' }, data: { status: 'EARNED', earnedAt: new Date() } });
  if (r.count > 0) await audit(actorId, 'COMMISSION_EARNED', purposeType, purposeId, { accruals: r.count });
  return r.count;
}

/** A pool that never completes (dissolved) owes no commission: anything still pending is cancelled and counted as refunded. */
export async function voidPendingCommission(purposeType: FundsPurpose, purposeId: string): Promise<number> {
  const r = await prisma.commissionAccrual.updateMany({ where: { purposeType, purposeId, status: 'PENDING' }, data: { status: 'REFUNDED', refundedAt: new Date() } });
  return r.count;
}

/**
 * Dissolves a pool: refunds every confirmed contribution in full through the group's provider. For escrow, each refund
 * reverses its own commission when the bank confirms it, so the platform keeps nothing from a dissolved pool.
 */
export async function dissolvePurpose(input: { groupId: string; purposeType: FundsPurpose; purposeId: string; actorId: string; reason?: string }) {
  const group = await prisma.communityGroup.findUnique({ where: { id: input.groupId } });
  if (!group) throw new HttpError(404, 'Group not found');
  const provider = await getFundsProvider(group.fundsMode);
  const contributions = await prisma.fundsEntry.findMany({ where: { groupId: group.id, purposeType: input.purposeType, purposeId: input.purposeId, type: 'CONTRIBUTION', status: 'CONFIRMED' } });
  const refunded: string[] = [];
  const failed: { entryId: string; error: string }[] = [];
  for (const c of contributions) {
    try {
      const r = await provider.refund({ entryId: c.id, actorId: input.actorId, reason: input.reason ?? 'Pool dissolved' });
      refunded.push(r.id);
    } catch (e) {
      // One member without bank details must not stop everyone else's refund.
      if (e instanceof HttpError && e.status === 409 && /already been refunded/.test(e.message)) continue;
      failed.push({ entryId: c.id, error: (e as Error).message });
    }
  }
  await audit(input.actorId, 'PURPOSE_DISSOLVED', input.purposeType, input.purposeId, { refunded: refunded.length, failed: failed.length });
  return { refunded: refunded.length, failed };
}
