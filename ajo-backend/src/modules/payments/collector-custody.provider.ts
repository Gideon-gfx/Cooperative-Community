import { FundsEntry } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { koboToNaira } from '../../lib/kobo';
import { safeSms } from '../../lib/notify';
import { accrueCustodyCommission } from '../billing/billing.service';
import { commissionBpFor } from './platform-config';
import { computeWaterfall } from './fee-engine';
import { AdjustmentInput, CollectInput, CollectResult, deriveTotals, entryRef, FundsFilter, FundsProvider, pendingOutKobo, RefundInput, ReleaseInput, Totals } from './funds-provider';

/**
 * COLLECTOR_CUSTODY: the member pays the collector's own bank account. The app only records the payer's declaration,
 * the facilitator's confirmation and the receipt. It never moves money. Group caps, tiers and consent are enforced
 * by payments.service before any call reaches here.
 */
export class CollectorCustodyProvider implements FundsProvider {
  readonly mode = 'COLLECTOR_CUSTODY' as const;

  totals(filter: FundsFilter): Promise<Totals> {
    return deriveTotals({ ...filter, fundsMode: 'COLLECTOR_CUSTODY' });
  }

  async collect(i: CollectInput): Promise<CollectResult> {
    if (i.amountKobo <= 0n) throw new HttpError(400, 'Amount must be greater than zero');
    if (!i.facilitatorAccountId) throw new HttpError(400, 'Choose the facilitator account you paid');
    if (!i.proofImageUrl && !i.bankReference) throw new HttpError(400, 'Add a payment proof photo or the bank reference');
    const account = await prisma.facilitatorAccount.findUnique({ where: { id: i.facilitatorAccountId } });
    if (!account) throw new HttpError(404, 'Facilitator account not found');
    if (!account.isVerifiedByAdmin) throw new HttpError(409, 'This facilitator account has not been verified yet');
    if (account.userId === i.payerUserId) throw new HttpError(403, 'A facilitator cannot declare a payment to themselves');
    const entry = await prisma.fundsEntry.create({
      data: {
        groupId: i.groupId, fundsMode: 'COLLECTOR_CUSTODY', type: 'CONTRIBUTION', purposeType: i.purposeType, purposeId: i.purposeId, payerUserId: i.payerUserId,
        facilitatorAccountId: account.id, amountKobo: i.amountKobo, bankReference: i.bankReference, proofImageUrl: i.proofImageUrl,
        // Written as explicit nulls: the 48h chase filters on `null`, which on MongoDB does not match a field that was never set.
        reminderSentAt: null, escalatedAt: null,
      },
    });
    await audit(i.payerUserId, 'FUNDS_DECLARED', 'FundsEntry', entry.id, { amountKobo: i.amountKobo.toString(), purpose: i.purposeType });
    const facilitator = await prisma.user.findUnique({ where: { id: account.userId } });
    await safeSms(facilitator?.phoneNumber, `ÀJỌ: a member says they paid ₦${koboToNaira(i.amountKobo)} to your account. Please confirm or dispute it in the app. Ref ${entryRef(entry.id)}.`);
    return { kind: 'DECLARED', entry };
  }

  private async load(entryId: string) {
    const entry = await prisma.fundsEntry.findUnique({ where: { id: entryId }, include: { account: true } });
    if (!entry) throw new HttpError(404, 'Entry not found');
    return entry;
  }

  /** Who must confirm an entry, and who is told. The person who declared it can never be the confirmer. */
  private parties(entry: FundsEntry & { account: { userId: string } | null }) {
    if (entry.type === 'CONTRIBUTION') {
      if (!entry.account) throw new HttpError(409, 'This entry has no facilitator account');
      return { confirmer: entry.account.userId, notify: entry.payerUserId };
    }
    if (entry.type === 'RELEASE' || entry.type === 'REFUND') return { confirmer: entry.counterpartyUserId, notify: entry.payerUserId };
    throw new HttpError(409, 'This kind of entry is recorded already confirmed');
  }

  async confirm(entryId: string, confirmerId: string) {
    const entry = await this.load(entryId);
    if (entry.fundsMode !== 'COLLECTOR_CUSTODY') throw new HttpError(409, 'Escrow payments are confirmed automatically');
    const { confirmer, notify } = this.parties(entry);
    if (confirmerId === entry.payerUserId) throw new HttpError(403, 'You cannot confirm your own payment');
    if (confirmerId !== confirmer) throw new HttpError(403, 'Only the other party can confirm this');
    if (entry.status !== 'DECLARED') throw new HttpError(409, 'This entry is not waiting for confirmation');
    // The status guard makes a double tap or a race a no-op, never a double count. The amount is never touched.
    const done = await prisma.fundsEntry.updateMany({
      where: { id: entry.id, status: 'DECLARED' },
      data: { status: 'CONFIRMED', facilitatorConfirmedAt: new Date(), facilitatorConfirmedById: confirmerId },
    });
    if (done.count === 0) throw new HttpError(409, 'This entry was already handled');
    await audit(confirmerId, 'FUNDS_CONFIRMED', 'FundsEntry', entry.id, { amountKobo: entry.amountKobo.toString() });
    let feeLine = '';
    if (entry.type === 'CONTRIBUTION' && entry.account) {
      // Commission accrues here too (billed to the collector once the cycle completes), and the receipt shows it.
      const confirmed = await prisma.fundsEntry.findUniqueOrThrow({ where: { id: entry.id } });
      await accrueCustodyCommission(confirmed, entry.account.userId);
      const fee = computeWaterfall({ gross: koboToNaira(entry.amountKobo), platformBp: await commissionBpFor(entry.purposeType) }).platformCommission;
      if (fee.gt(0)) feeLine = ` Platform fee on this payment: ₦${fee.toFixed(2)}, invoiced to your collector.`;
    }
    // A confirmed refund of a contribution takes its commission with it.
    if (entry.type === 'REFUND' && entry.relatedEntryId) {
      await prisma.commissionAccrual.updateMany({ where: { fundsEntryId: entry.relatedEntryId, status: { in: ['PENDING', 'EARNED'] } }, data: { status: 'REFUNDED', refundedAt: new Date() } });
    }
    const who = await prisma.user.findUnique({ where: { id: notify } });
    await safeSms(who?.phoneNumber, `ÀJỌ receipt ${entryRef(entry.id)}: ₦${koboToNaira(entry.amountKobo)} was confirmed.${feeLine} Your money is paid directly to your group's collector. CC-ÀJỌ only records it and does not hold it.`);
    return prisma.fundsEntry.findUniqueOrThrow({ where: { id: entry.id } });
  }

  async dispute(entryId: string, disputerId: string, note: string) {
    const entry = await this.load(entryId);
    const { confirmer, notify } = this.parties(entry);
    if (disputerId === entry.payerUserId) throw new HttpError(403, 'You cannot dispute your own payment');
    if (disputerId !== confirmer) throw new HttpError(403, 'Only the other party can dispute this');
    if (entry.status !== 'DECLARED') throw new HttpError(409, 'This entry is not waiting for confirmation');
    const done = await prisma.fundsEntry.updateMany({ where: { id: entry.id, status: 'DECLARED' }, data: { status: 'DISPUTED', disputeNote: note } });
    if (done.count === 0) throw new HttpError(409, 'This entry was already handled');
    await audit(disputerId, 'FUNDS_DISPUTED', 'FundsEntry', entry.id, { note });
    const who = await prisma.user.findUnique({ where: { id: notify } });
    await safeSms(who?.phoneNumber, `ÀJỌ: your payment ${entryRef(entry.id)} of ₦${koboToNaira(entry.amountKobo)} was disputed: ${note}. Please contact them.`);
    // Admins and the Trust Board hear about every dispute.
    const watchers = await prisma.user.findMany({ where: { role: { in: ['ADMIN', 'BOARD_MEMBER'] } } });
    for (const w of watchers) await safeSms(w.phoneNumber, `ÀJỌ: a payment of ₦${koboToNaira(entry.amountKobo)} (${entryRef(entry.id)}) was disputed. Please review it.`);
    return prisma.fundsEntry.findUniqueOrThrow({ where: { id: entry.id } });
  }

  async release(i: ReleaseInput) {
    if (i.amountKobo <= 0n) throw new HttpError(400, 'Amount must be greater than zero');
    const account = i.facilitatorAccountId ? await prisma.facilitatorAccount.findUnique({ where: { id: i.facilitatorAccountId } }) : null;
    if (!account || account.userId !== i.actorId) throw new HttpError(403, 'This is not your facilitator account');
    if (i.recipientUserId === i.actorId) throw new HttpError(403, 'You cannot release money to yourself');
    // Never pay out more than has been confirmed in, counting payouts still waiting for the recipient.
    const scope = { groupId: i.groupId, purposeType: i.purposeType, purposeId: i.purposeId };
    const { balance } = await this.totals(scope);
    const available = balance - (await pendingOutKobo(scope));
    if (i.amountKobo > available) throw new HttpError(409, `Only ₦${koboToNaira(available < 0n ? 0n : available)} of confirmed money is available to release`);
    const entry = await prisma.fundsEntry.create({
      data: {
        groupId: i.groupId, fundsMode: 'COLLECTOR_CUSTODY', type: 'RELEASE', purposeType: i.purposeType, purposeId: i.purposeId, payerUserId: i.actorId,
        counterpartyUserId: i.recipientUserId, facilitatorAccountId: account.id, amountKobo: i.amountKobo, bankReference: i.bankReference, proofImageUrl: i.proofImageUrl, note: i.note,
      },
    });
    await audit(i.actorId, 'FUNDS_RELEASE_RECORDED', 'FundsEntry', entry.id, { amountKobo: i.amountKobo.toString() });
    const to = await prisma.user.findUnique({ where: { id: i.recipientUserId } });
    await safeSms(to?.phoneNumber, `ÀJỌ: your collector says they paid you ₦${koboToNaira(i.amountKobo)}. Please confirm in the app that you received it. Ref ${entryRef(entry.id)}.`);
    return entry;
  }

  /** The collector says they paid a contribution back, in full. The payer then confirms they received it. */
  async refund(i: RefundInput) {
    const original = await this.load(i.entryId);
    if (original.type !== 'CONTRIBUTION' || original.status !== 'CONFIRMED') throw new HttpError(409, 'Only a confirmed contribution can be refunded');
    if (!original.account || original.account.userId !== i.actorId) throw new HttpError(403, 'Only the collector who received it can refund it');
    const existing = await prisma.fundsEntry.findFirst({ where: { type: 'REFUND', relatedEntryId: original.id, status: { in: ['DECLARED', 'CONFIRMED'] } } });
    if (existing) throw new HttpError(409, 'This contribution has already been refunded');
    const entry = await prisma.fundsEntry.create({
      data: {
        groupId: original.groupId, fundsMode: 'COLLECTOR_CUSTODY', type: 'REFUND', purposeType: original.purposeType, purposeId: original.purposeId, payerUserId: i.actorId,
        counterpartyUserId: original.payerUserId, facilitatorAccountId: original.facilitatorAccountId, amountKobo: original.amountKobo, relatedEntryId: original.id,
        bankReference: i.bankReference, proofImageUrl: i.proofImageUrl, note: i.reason,
      },
    });
    await audit(i.actorId, 'FUNDS_REFUND_RECORDED', 'FundsEntry', entry.id, { relatedEntryId: original.id });
    const to = await prisma.user.findUnique({ where: { id: original.payerUserId } });
    await safeSms(to?.phoneNumber, `ÀJỌ: your collector says they refunded ₦${koboToNaira(original.amountKobo)}. Please confirm in the app that you received it. Ref ${entryRef(entry.id)}.`);
    return entry;
  }

  async adjust(i: AdjustmentInput) {
    if (i.amountKobo === 0n) throw new HttpError(400, 'An adjustment cannot be zero');
    if (i.note.trim().length < 5) throw new HttpError(400, 'Explain the adjustment');
    const original = await prisma.fundsEntry.findUnique({ where: { id: i.entryId } });
    if (!original) throw new HttpError(404, 'Entry not found');
    const entry = await prisma.fundsEntry.create({
      data: {
        groupId: original.groupId, fundsMode: original.fundsMode, type: 'ADJUSTMENT', purposeType: original.purposeType, purposeId: original.purposeId, payerUserId: i.adminId,
        facilitatorAccountId: original.facilitatorAccountId, amountKobo: i.amountKobo, note: i.note.trim(), relatedEntryId: original.id,
        status: 'CONFIRMED', facilitatorConfirmedAt: new Date(), facilitatorConfirmedById: i.adminId,
      },
    });
    await audit(i.adminId, 'FUNDS_ADJUSTED', 'FundsEntry', entry.id, { corrects: original.id, amountKobo: i.amountKobo.toString() });
    return entry;
  }
}
