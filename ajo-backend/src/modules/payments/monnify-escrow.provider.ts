import { FundsEntry } from '@prisma/client';
import crypto from 'crypto';
import { assertGateOpen } from '../../config/decisions';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { koboToNaira } from '../../lib/kobo';
import { safeSms } from '../../lib/notify';
import * as monnify from '../../services/monnify.service';
import { computeWaterfall } from './fee-engine';
import { AdjustmentInput, CollectInput, CollectResult, deriveTotals, entryRef, FundsFilter, FundsProvider, pendingOutKobo, RefundInput, ReleaseInput, Totals } from './funds-provider';
import { commissionBpFor } from './platform-config';

const newRef = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
const payerEmail = (userId: string) => `payer+${userId}@cc-ajo.app`;

export type CollectOutcome = 'RECORDED' | 'DUPLICATE' | 'UNKNOWN' | 'NOT_PAID' | 'AMOUNT_MISMATCH';

/**
 * ESCROW: Monnify collects the contribution, the app tracks it in the ledger, and money only leaves by a Monnify
 * disbursement after the approvals the caller requires. Production use is gated until Monnify confirms pooled funds.
 */
export class MonnifyEscrowProvider implements FundsProvider {
  readonly mode = 'ESCROW' as const;

  totals(filter: FundsFilter): Promise<Totals> {
    return deriveTotals({ ...filter, fundsMode: 'ESCROW' });
  }

  async collect(i: CollectInput): Promise<CollectResult> {
    assertGateOpen('MONNIFY_POOLING_APPROVED');
    if (i.amountKobo <= 0n) throw new HttpError(400, 'Amount must be greater than zero');
    const charge = i.chargeKobo ?? i.amountKobo;
    const paymentReference = newRef('CCA');
    await prisma.providerTransaction.create({
      data: { kind: 'COLLECT', paymentReference, groupId: i.groupId, purposeType: i.purposeType, purposeId: i.purposeId, payerUserId: i.payerUserId, amountKobo: i.amountKobo, fundsEntryId: null },
    });
    try {
      const init = await monnify.initializeTransaction(Number(koboToNaira(charge)), i.payerName ?? 'CC-ÀJỌ member', payerEmail(i.payerUserId), paymentReference, { purpose: i.purposeType, purposeId: i.purposeId, groupId: i.groupId });
      await prisma.providerTransaction.update({ where: { paymentReference }, data: { checkoutUrl: init.checkoutUrl, transactionReference: init.transactionReference } });
      return { kind: 'CHECKOUT', checkoutUrl: init.checkoutUrl, paymentReference };
    } catch (e) {
      await prisma.providerTransaction.update({ where: { paymentReference }, data: { status: 'FAILED', lastError: (e as Error).message.slice(0, 300) } });
      throw new HttpError(502, 'The payment service could not start this payment. Please try again.');
    }
  }

  /**
   * The ONE place a Monnify payment becomes a ledger entry. Called by the webhook and by the reconciliation job, so it
   * must be safe to call twice: the PENDING→PAID status guard means a payment is only ever recorded once. The amount and
   * status are re-checked with Monnify directly, never trusted from the webhook body alone.
   */
  async recordCollected(paymentReference: string, transactionReference: string): Promise<CollectOutcome> {
    const tx = await prisma.providerTransaction.findUnique({ where: { paymentReference } });
    if (!tx || tx.kind !== 'COLLECT') return 'UNKNOWN';
    if (tx.status === 'PAID') return 'DUPLICATE';

    const live = await monnify.verifyTransaction(transactionReference);
    if (String(live.paymentStatus).toUpperCase() !== 'PAID') return 'NOT_PAID';
    const paidKobo = BigInt(Math.round(Number(live.amountPaid) * 100));
    // Compare with what we asked for (the charge may include a payer-borne gateway fee, so we accept >= contribution).
    if (paidKobo < tx.amountKobo) {
      await prisma.providerTransaction.update({ where: { id: tx.id }, data: { status: 'FAILED', lastError: `AMOUNT_MISMATCH paid ${paidKobo} < ${tx.amountKobo}`, transactionReference } });
      await this.alertAdmins(`a Monnify payment ${paymentReference} was for less than the contribution. Please review it.`);
      return 'AMOUNT_MISMATCH';
    }

    const bp = await commissionBpFor(tx.purposeType);
    const wf = computeWaterfall({ gross: koboToNaira(tx.amountKobo), platformBp: bp });
    const commissionKobo = BigInt(wf.platformCommission.mul(100).toFixed(0));

    const recorded = await prisma.$transaction(async (db) => {
      const claimed = await db.providerTransaction.updateMany({ where: { id: tx.id, status: 'INITIATED' }, data: { status: 'PAID', transactionReference } });
      if (claimed.count === 0) return null;
      const entry = await db.fundsEntry.create({
        data: {
          groupId: tx.groupId, fundsMode: 'ESCROW', type: 'CONTRIBUTION', purposeType: tx.purposeType, purposeId: tx.purposeId, payerUserId: tx.payerUserId,
          amountKobo: tx.amountKobo, providerRef: transactionReference, bankReference: paymentReference, status: 'CONFIRMED', facilitatorConfirmedAt: new Date(),
        },
      });
      if (commissionKobo > 0n) {
        // The commission is applied ONCE, here. It stays PENDING until the cycle completes (see commission.service).
        await db.fundsEntry.create({
          data: {
            groupId: tx.groupId, fundsMode: 'ESCROW', type: 'COMMISSION', purposeType: tx.purposeType, purposeId: tx.purposeId, payerUserId: tx.payerUserId,
            amountKobo: commissionKobo, relatedEntryId: entry.id, providerRef: transactionReference, status: 'CONFIRMED', facilitatorConfirmedAt: new Date(),
          },
        });
        await db.commissionAccrual.create({ data: { groupId: tx.groupId, purposeType: tx.purposeType, purposeId: tx.purposeId, fundsEntryId: entry.id, payerUserId: tx.payerUserId, amountKobo: commissionKobo } });
      }
      await db.providerTransaction.update({ where: { id: tx.id }, data: { fundsEntryId: entry.id } });
      return entry;
    });
    if (!recorded) return 'DUPLICATE';

    await audit(tx.payerUserId, 'ESCROW_PAYMENT_RECORDED', 'FundsEntry', recorded.id, { amountKobo: tx.amountKobo.toString(), commissionKobo: commissionKobo.toString() });
    if (tx.purposeType === 'SETTLEMENT_FUND') {
      const f = await prisma.settlementFund.findUnique({ where: { id: tx.purposeId } });
      if (f) (await import('../apprenticeship/contract.events')).emitContractChanged(f.contractId);
    }
    const payer = await prisma.user.findUnique({ where: { id: tx.payerUserId } });
    await safeSms(payer?.phoneNumber, `ÀJỌ receipt ${entryRef(recorded.id)}: ₦${koboToNaira(tx.amountKobo)} received, of which ₦${wf.platformCommission.toFixed(2)} is the platform fee. Your money is held in escrow by the payment partner.`);
    return 'RECORDED';
  }

  async confirm(): Promise<FundsEntry> {
    throw new HttpError(409, 'Escrow payments are confirmed automatically when the payment partner reports them');
  }
  async dispute(entryId: string, disputerId: string, note: string): Promise<FundsEntry> {
    const entry = await prisma.fundsEntry.findUnique({ where: { id: entryId } });
    if (!entry) throw new HttpError(404, 'Entry not found');
    if (entry.fundsMode !== 'ESCROW') throw new HttpError(409, 'Not an escrow entry');
    if (entry.payerUserId !== disputerId) throw new HttpError(403, 'Only the payer can dispute this');
    if (entry.type !== 'CONTRIBUTION' || entry.status !== 'CONFIRMED') throw new HttpError(409, 'Only a confirmed contribution can be disputed');
    // A dispute flags the entry; it does not move money. Admins and the Trust Board decide what happens next.
    const done = await prisma.fundsEntry.updateMany({ where: { id: entry.id, status: 'CONFIRMED' }, data: { status: 'DISPUTED', disputeNote: note } });
    if (done.count === 0) throw new HttpError(409, 'This entry was already handled');
    await audit(disputerId, 'FUNDS_DISPUTED', 'FundsEntry', entry.id, { note });
    await this.alertAdmins(`a payment (${entryRef(entry.id)}) was disputed: ${note}`, true);
    return prisma.fundsEntry.findUniqueOrThrow({ where: { id: entry.id } });
  }

  async release(i: ReleaseInput): Promise<FundsEntry> {
    assertGateOpen('MONNIFY_POOLING_APPROVED');
    if (i.amountKobo <= 0n) throw new HttpError(400, 'Amount must be greater than zero');
    if (!i.destination) throw new HttpError(400, 'A verified destination account is required');
    const scope = { groupId: i.groupId, purposeType: i.purposeType, purposeId: i.purposeId };
    const { balance } = await this.totals(scope);
    const available = balance - (await pendingOutKobo(scope));
    if (i.amountKobo > available) throw new HttpError(409, `Only ₦${koboToNaira(available < 0n ? 0n : available)} is available to release`);
    return this.disburse({ type: 'RELEASE', ...scope, actorId: i.actorId, payeeUserId: i.recipientUserId, amountKobo: i.amountKobo, destination: i.destination, note: i.note });
  }

  async refund(i: RefundInput): Promise<FundsEntry> {
    assertGateOpen('MONNIFY_POOLING_APPROVED');
    const original = await prisma.fundsEntry.findUnique({ where: { id: i.entryId } });
    if (!original || original.type !== 'CONTRIBUTION' || original.fundsMode !== 'ESCROW' || original.status !== 'CONFIRMED') throw new HttpError(409, 'Only a confirmed escrow contribution can be refunded');
    const already = await prisma.fundsEntry.findFirst({ where: { type: 'REFUND', relatedEntryId: original.id, status: { in: ['DECLARED', 'CONFIRMED'] } } });
    if (already) throw new HttpError(409, 'This contribution has already been refunded');
    const payer = await prisma.user.findUnique({ where: { id: original.payerUserId } });
    if (!payer?.bankAccountNo || !payer.bankCode) throw new HttpError(409, 'The member needs to add their bank account before a refund can be sent');
    // Full contribution, commission included.
    return this.disburse({
      type: 'REFUND', groupId: original.groupId!, purposeType: original.purposeType, purposeId: original.purposeId, actorId: i.actorId, payeeUserId: original.payerUserId,
      amountKobo: original.amountKobo, destination: { bankCode: payer.bankCode, accountNumber: payer.bankAccountNo }, note: i.reason, relatedEntryId: original.id,
    });
  }

  private async disburse(d: {
    type: 'RELEASE' | 'REFUND'; groupId: string; purposeType: FundsEntry['purposeType']; purposeId: string; actorId: string; payeeUserId: string; amountKobo: bigint;
    destination: { bankCode: string; accountNumber: string }; note?: string; relatedEntryId?: string;
  }): Promise<FundsEntry> {
    const paymentReference = newRef(d.type === 'REFUND' ? 'CCF' : 'CCR');
    // DECLARED until Monnify says the money left. Counted as "pending out" so it cannot be double-spent meanwhile.
    const entry = await prisma.fundsEntry.create({
      data: {
        groupId: d.groupId, fundsMode: 'ESCROW', type: d.type, purposeType: d.purposeType, purposeId: d.purposeId, payerUserId: d.actorId, counterpartyUserId: d.payeeUserId,
        amountKobo: d.amountKobo, providerRef: paymentReference, note: d.note, relatedEntryId: d.relatedEntryId,
      },
    });
    await prisma.providerTransaction.create({
      data: { kind: 'DISBURSE', paymentReference, groupId: d.groupId, purposeType: d.purposeType, purposeId: d.purposeId, payerUserId: d.actorId, payeeUserId: d.payeeUserId, amountKobo: d.amountKobo, status: 'DISBURSING', fundsEntryId: entry.id },
    });
    await audit(d.actorId, d.type === 'REFUND' ? 'ESCROW_REFUND_STARTED' : 'ESCROW_RELEASE_STARTED', 'FundsEntry', entry.id, { amountKobo: d.amountKobo.toString() });

    const r = await monnify.initiateSingleTransfer({
      amountNaira: koboToNaira(d.amountKobo), reference: paymentReference, narration: `ÀJỌ ${d.type.toLowerCase()} ${entryRef(entry.id)}`,
      bankCode: d.destination.bankCode, accountNumber: d.destination.accountNumber,
    });
    await prisma.providerTransaction.update({ where: { paymentReference }, data: { attempts: { increment: 1 }, lastError: r.state === 'FAILED' ? r.message?.slice(0, 300) : null } });
    if (r.state === 'SUCCESS') await this.finalizeDisbursement(paymentReference, true);
    else if (r.state === 'FAILED') await this.finalizeDisbursement(paymentReference, false, r.message);
    // PENDING: the disbursement webhook or the reconciliation job settles it.
    return prisma.fundsEntry.findUniqueOrThrow({ where: { id: entry.id } });
  }

  /** Settles a disbursement exactly once. Success confirms the entry; failure reverses it and alerts the admins loudly. */
  async finalizeDisbursement(paymentReference: string, ok: boolean, reason?: string): Promise<'DONE' | 'DUPLICATE' | 'UNKNOWN'> {
    const tx = await prisma.providerTransaction.findUnique({ where: { paymentReference } });
    if (!tx || tx.kind !== 'DISBURSE' || !tx.fundsEntryId) return 'UNKNOWN';
    const claimed = await prisma.providerTransaction.updateMany({ where: { id: tx.id, status: 'DISBURSING' }, data: { status: ok ? 'DISBURSED' : 'DISBURSE_FAILED', lastError: ok ? null : reason?.slice(0, 300) } });
    if (claimed.count === 0) return 'DUPLICATE';
    const entry = await prisma.fundsEntry.findUniqueOrThrow({ where: { id: tx.fundsEntryId } });
    if (ok) {
      await prisma.fundsEntry.updateMany({ where: { id: entry.id, status: 'DECLARED' }, data: { status: 'CONFIRMED', facilitatorConfirmedAt: new Date() } });
      if (entry.type === 'REFUND' && entry.relatedEntryId) await this.reverseCommissionFor(entry.relatedEntryId);
      const to = await prisma.user.findUnique({ where: { id: tx.payeeUserId ?? '' } });
      await safeSms(to?.phoneNumber, `ÀJỌ: ₦${koboToNaira(tx.amountKobo)} was sent to your bank account. Ref ${entryRef(entry.id)}.`);
    } else {
      await prisma.fundsEntry.updateMany({ where: { id: entry.id, status: 'DECLARED' }, data: { status: 'REVERSED', disputeNote: reason?.slice(0, 300) } });
      await this.alertAdmins(`a ${entry.type.toLowerCase()} of ₦${koboToNaira(tx.amountKobo)} FAILED (${entryRef(entry.id)}): ${reason ?? 'unknown reason'}. The money is still in escrow.`, true);
    }
    await audit(null, ok ? 'ESCROW_DISBURSED' : 'ESCROW_DISBURSE_FAILED', 'FundsEntry', entry.id, { reason: reason ?? null });
    // A Settlement Fund release finishing (or failing) completes the graduation. Loaded lazily: that module uses this one.
    if (entry.type === 'RELEASE' && entry.purposeType === 'SETTLEMENT_FUND') {
      try { await (await import('../settlement/settlement.service')).onDisbursementSettled(entry, ok, reason); } catch (e) { console.error('[settlement] could not record the release outcome', (e as Error).message); }
    }
    return 'DONE';
  }

  /** A fully refunded contribution takes its commission with it: the platform keeps nothing from a dissolved pool. */
  private async reverseCommissionFor(contributionId: string) {
    await prisma.fundsEntry.updateMany({ where: { type: 'COMMISSION', relatedEntryId: contributionId, status: 'CONFIRMED' }, data: { status: 'REVERSED' } });
    await prisma.commissionAccrual.updateMany({ where: { fundsEntryId: contributionId, status: { in: ['PENDING', 'EARNED'] } }, data: { status: 'REFUNDED', refundedAt: new Date() } });
  }

  async adjust(i: AdjustmentInput): Promise<FundsEntry> {
    if (i.amountKobo === 0n) throw new HttpError(400, 'An adjustment cannot be zero');
    if (i.note.trim().length < 5) throw new HttpError(400, 'Explain the adjustment');
    const original = await prisma.fundsEntry.findUnique({ where: { id: i.entryId } });
    if (!original) throw new HttpError(404, 'Entry not found');
    const entry = await prisma.fundsEntry.create({
      data: {
        groupId: original.groupId, fundsMode: original.fundsMode, type: 'ADJUSTMENT', purposeType: original.purposeType, purposeId: original.purposeId, payerUserId: i.adminId,
        amountKobo: i.amountKobo, note: i.note.trim(), relatedEntryId: original.id, status: 'CONFIRMED', facilitatorConfirmedAt: new Date(), facilitatorConfirmedById: i.adminId,
      },
    });
    await audit(i.adminId, 'FUNDS_ADJUSTED', 'FundsEntry', entry.id, { corrects: original.id, amountKobo: i.amountKobo.toString() });
    return entry;
  }

  private async alertAdmins(message: string, includeBoard = false) {
    const people = await prisma.user.findMany({ where: { role: { in: includeBoard ? ['ADMIN', 'BOARD_MEMBER'] : ['ADMIN'] } } });
    for (const a of people) await safeSms(a.phoneNumber, `ÀJỌ alert: ${message}`);
  }
}
