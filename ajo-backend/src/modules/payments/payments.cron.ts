import cron from 'node-cron';
import { prisma } from '../../lib/prisma';
import { safeSms } from '../../lib/notify';
import { disbursementStatus } from '../../services/monnify.service';
import { MonnifyEscrowProvider } from './monnify-escrow.provider';
import { evaluateDowngrade } from './custody.service';

const MIN = 60 * 1000;

/**
 * Daily reconciliation of Monnify against the ledger. Webhooks can be lost, so anything Monnify says is paid but we
 * have not recorded is recorded now (the same idempotent path the webhook uses), stuck disbursements are settled, and
 * any remaining difference is reported to the admins instead of being silently fixed.
 */
export async function reconcileEscrow(now = new Date()) {
  const escrow = new MonnifyEscrowProvider();
  const cutoff = new Date(now.getTime() - 30 * MIN);
  let recorded = 0;
  let settled = 0;

  const open = await prisma.providerTransaction.findMany({ where: { kind: 'COLLECT', status: 'INITIATED', transactionReference: { not: null }, createdAt: { lt: cutoff } }, take: 500 });
  for (const t of open) {
    try {
      if ((await escrow.recordCollected(t.paymentReference, t.transactionReference!)) === 'RECORDED') recorded++;
    } catch (e) {
      console.error('[reconcile] collect', t.paymentReference, (e as Error).message);
    }
  }

  const stuck = await prisma.providerTransaction.findMany({ where: { kind: 'DISBURSE', status: 'DISBURSING', updatedAt: { lt: cutoff } }, take: 500 });
  for (const t of stuck) {
    try {
      const state = await disbursementStatus(t.paymentReference);
      if (state === 'PENDING') continue;
      await escrow.finalizeDisbursement(t.paymentReference, state === 'SUCCESS', state === 'FAILED' ? 'Reported failed on reconciliation' : undefined);
      settled++;
    } catch (e) {
      console.error('[reconcile] disburse', t.paymentReference, (e as Error).message);
    }
  }

  // Differences we cannot explain: a paid transaction with no ledger entry, or a ledger contribution with no paid transaction.
  const paidNoEntry = await prisma.providerTransaction.count({ where: { kind: 'COLLECT', status: 'PAID', fundsEntryId: null } });
  const entries = await prisma.fundsEntry.findMany({ where: { fundsMode: 'ESCROW', type: 'CONTRIBUTION', status: 'CONFIRMED' }, select: { id: true } });
  const linked = await prisma.providerTransaction.count({ where: { kind: 'COLLECT', status: 'PAID', fundsEntryId: { in: entries.map((e) => e.id) } } });
  const entryNoTx = entries.length - linked;
  const mismatches = paidNoEntry + entryNoTx;
  if (mismatches > 0) {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
    for (const a of admins) await safeSms(a.phoneNumber, `ÀJỌ alert: escrow reconciliation found ${mismatches} difference(s) between Monnify and the ledger. Please review.`);
  }
  return { recorded, settled, mismatches };
}

export function startPaymentsCron() {
  // 02:00 daily: reconcile Monnify with the ledger.
  cron.schedule('0 2 * * *', () => reconcileEscrow().catch(console.error));
  // 03:00 daily: schedule a one-tier drop for collectors whose clean record has slipped.
  cron.schedule('0 3 * * *', async () => {
    const collectors = await prisma.collectorKyc.findMany({ where: { approvedTier: { gt: 0 } } });
    for (const c of collectors) await evaluateDowngrade(c.userId).catch(console.error);
  });
}
