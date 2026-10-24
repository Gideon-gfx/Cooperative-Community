import { CycleFrequency, PaymentMethod } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { assertGroupAdmin } from '../../lib/access';
import { naira, safeSmsAndEmail } from '../../lib/notify';
import { safePush } from '../../services/push.service';
import { round2 } from '../../lib/money';
import { audit } from '../../lib/audit';
import { config } from '../../lib/config';
import { generateAjoReceipt } from '../../services/receipt.service';
import { addEntry, getLedger, toCsv } from '../../services/ledger.service';
import { calculateAjoFees, DAY_MS, expandSlots, nextMemberStatus, overdueAfterGrace, payoutDateFor, remainingToPay, shuffle } from './ajo.logic';
import { earnCommission } from '../payments/commission.service';
import { applyPendingFundsMode } from '../payments/custody.service';
export interface CreateAjoPoolParams {
  title: string;
  amountPerMember: number;
  cycleFrequency: CycleFrequency;
  collectorFeePct: number;
  memberIds: string[];
  startDate: Date;
  /** When true, memberIds is the pre-agreed payout order instead of being shuffled. */
  preserveOrder?: boolean;
  rulesText?: string;
  lateFeeAmount?: number;
  graceDays?: number;
  /** memberId -> number of "hands" (shares). A 2-hand member contributes double and collects twice. */
  hands?: Record<string, number>;
  /** defaulterId -> guarantorId. Required for members currently flagged DEFAULTER. */
  guarantors?: Record<string, string>;
}

const fmtDate = (d: Date) => d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });

async function loadContribution(id: string) {
  const c = await prisma.ajoContribution.findUnique({
    where: { id },
    include: {
      schedule: { include: { recipient: true } },
      contributor: true,
      payments: true,
      ajoPool: { include: { group: { include: { admin: true } } } },
    },
  });
  if (!c) throw new HttpError(404, 'Contribution not found');
  return c;
}

// ── POOL CREATION ────────────────────────────────────────────────

export async function createAjoPool(adminId: string, groupId: string, params: CreateAjoPoolParams) {
  const group = await assertGroupAdmin(groupId, adminId);
  // A new cycle is the only moment a requested funds mode (or a scheduled custody tier drop) takes effect.
  await applyPendingFundsMode(groupId);
  const memberIds = [...new Set(params.memberIds)];
  if (memberIds.length < 2) throw new HttpError(400, 'An Àjọ pool needs at least 2 members');

  const memberships = await prisma.groupMember.findMany({ where: { groupId, userId: { in: memberIds } } });
  if (memberships.length !== memberIds.length) throw new HttpError(400, 'All members must belong to the group');

  const users = await prisma.user.findMany({ where: { id: { in: memberIds } } });
  const guarantors = params.guarantors ?? {};
  for (const u of users.filter((x) => x.memberStatus === 'DEFAULTER')) {
    const g = guarantors[u.id];
    const guarantor = users.find((x) => x.id === g);
    if (!guarantor || guarantor.memberStatus !== 'CLEAN') {
      throw new HttpError(400, `${u.fullName} is flagged as a defaulter. Choose a member in good standing as their guarantor.`);
    }
  }
  const hands = params.hands ?? {};
  for (const [id, h] of Object.entries(hands)) {
    if (!memberIds.includes(id) || !Number.isInteger(h) || h < 1 || h > 3) throw new HttpError(400, 'Hands must be 1–3 and belong to pool members');
  }

  const base = params.preserveOrder ? memberIds : shuffle(memberIds);
  const slots = params.preserveOrder ? expandSlots(base, hands) : shuffle(expandSlots(base, hands));
  const graceDays = params.graceDays ?? 1;

  const pool = await prisma.$transaction(async (tx) => {
    const created = await tx.ajoPool.create({
      data: {
        groupId,
        title: params.title,
        amountPerMember: params.amountPerMember,
        cycleFrequency: params.cycleFrequency,
        collectorFeePct: params.collectorFeePct,
        platformFeePct: config.ajoPlatformFeeRate * 100,
        totalMembers: memberIds.length,
        startDate: params.startDate,
        rulesText: params.rulesText,
        lateFeeAmount: params.lateFeeAmount ?? 0,
        graceDays,
      },
    });
    for (let i = 0; i < slots.length; i++) {
      const payoutDate = payoutDateFor(params.startDate, params.cycleFrequency, i + 1);
      const dueAt = new Date(Math.max(payoutDate.getTime() - 2 * DAY_MS, params.startDate.getTime()));
      const schedule = await tx.ajoRotationSchedule.create({
        data: { ajoPoolId: created.id, recipientId: slots[i], payoutOrder: i + 1, payoutDate },
      });
      await tx.ajoContribution.createMany({
        data: memberIds
          .filter((id) => id !== slots[i])
          .map((contributorId) => ({
            ajoPoolId: created.id,
            scheduleId: schedule.id,
            contributorId,
            amount: params.amountPerMember * (hands[contributorId] ?? 1),
            dueAt,
          })),
      });
    }
    const guaranteed = Object.entries(guarantors).filter(([m]) => memberIds.includes(m));
    if (guaranteed.length) {
      await tx.ajoGuarantee.createMany({ data: guaranteed.map(([memberId, guarantorId]) => ({ ajoPoolId: created.id, memberId, guarantorId })) });
    }
    return created;
  });

  const full = await prisma.ajoPool.findUniqueOrThrow({
    where: { id: pool.id },
    include: { schedules: { orderBy: { payoutOrder: 'asc' }, include: { recipient: { select: { id: true, fullName: true, phoneNumber: true } } } } },
  });
  const firstDue = new Date(Math.max(full.schedules[0].payoutDate.getTime() - 2 * DAY_MS, params.startDate.getTime()));
  for (const u of users) {
    const mine = full.schedules.filter((s) => s.recipientId === u.id).map((s) => fmtDate(s.payoutDate)).join(', ');
    const message =
      `Your Àjọ pool ${params.title} is ready! You collect on ${mine}. Contribute ${naira(params.amountPerMember * (hands[u.id] ?? 1), group.currency)} by ${fmtDate(firstDue)}. Your collector holds the money and every payment is shown in the app.`;
    await safeSmsAndEmail(
      u.phoneNumber,
      u.email,
      `Your ÀJỌ pool "${params.title}" is ready`,
      message,
    );
  }
  await prisma.groupMessage.create({
    data: { groupId: group.id, messageType: 'SYSTEM', content: `🔄 New Àjọ pool "${params.title}" started with ${memberIds.length} members.${params.rulesText ? ' Please read and accept the pool rules.' : ''}` },
  });
  await audit(adminId, 'POOL_CREATED', 'AjoPool', pool.id, { members: memberIds.length });
  return full;
}

// ── PAYMENTS ─────────────────────────────────────────────────────

export interface RecordPaymentInput {
  contributionId?: string;
  scheduleId?: string;
  contributorId?: string;
  /** Defaults to everything still unpaid. Smaller amounts are instalments. */
  amount?: number;
  method?: PaymentMethod;
  proofUrl?: string;
  reference?: string;
  /** Collector only: mark the share as paid out of their own pocket. */
  coverShortfall?: boolean;
}

/**
 * A member (or their collector, for cash / assisted accounts) records a payment.
 * - Member-recorded payments wait as PENDING until the collector confirms they received the money.
 * - Collector-recorded payments for someone else are confirmed immediately: the collector is the one holding the cash.
 */
export async function recordPayment(actor: { id: string; role: string }, input: RecordPaymentInput) {
  let contribution;
  if (input.contributionId) contribution = await loadContribution(input.contributionId);
  else {
    if (!input.scheduleId) throw new HttpError(400, 'contributionId or scheduleId is required');
    const found = await prisma.ajoContribution.findUnique({
      where: { scheduleId_contributorId: { scheduleId: input.scheduleId, contributorId: input.contributorId ?? actor.id } },
    });
    if (!found) throw new HttpError(404, 'No contribution due for this cycle');
    contribution = await loadContribution(found.id);
  }
  const pool = contribution.ajoPool;
  const isCollector = pool.group.adminId === actor.id;
  const forSomeoneElse = actor.id !== contribution.contributorId;
  if (forSomeoneElse && !isCollector) throw new HttpError(403, 'Only the collector can record a payment for someone else');
  if (contribution.status === 'VERIFIED') throw new HttpError(409, 'This contribution is already fully paid');
  if (input.coverShortfall && !(isCollector && forSomeoneElse)) throw new HttpError(403, 'Only the collector can cover a member\'s share');

  const pending = contribution.payments.filter((p) => p.status === 'PENDING').reduce((s, p) => s + p.amount, 0);
  const remaining = remainingToPay(contribution.amount, contribution.paidAmount, pending);
  const amount = round2(input.amount ?? remaining);
  if (!(amount > 0) || amount > remaining + 0.001) throw new HttpError(400, `Amount must be between 0 and ${remaining}`);

  const autoVerify = isCollector && forSomeoneElse;
  const payment = await prisma.contributionPayment.create({
    data: {
      contributionId: contribution.id,
      ajoPoolId: pool.id,
      amount,
      method: input.coverShortfall ? 'CASH' : input.method ?? 'TRANSFER',
      proofUrl: input.proofUrl,
      reference: input.coverShortfall ? 'COVERED_BY_COLLECTOR' : input.reference,
      recordedById: actor.id,
      ...(autoVerify ? { status: 'VERIFIED', verifiedById: actor.id, verifiedAt: new Date() } : {}),
    },
  });
  await audit(actor.id, autoVerify ? 'PAYMENT_RECORDED_VERIFIED' : 'PAYMENT_RECORDED', 'ContributionPayment', payment.id, { amount, contributor: contribution.contributorId });

  if (autoVerify) {
    await addEntry({ ajoPoolId: pool.id }, 'IN', 'CONTRIBUTION', amount, actor.id,
      `${contribution.contributor.fullName} · ${payment.method.toLowerCase()}${input.coverShortfall ? ' · covered by collector' : ''}`, payment.id);
    if (input.coverShortfall) await prisma.ajoContribution.update({ where: { id: contribution.id }, data: { coveredByCollector: true } });
    const done = await settleContribution(contribution.id);
    if (autoVerify && !input.coverShortfall) {
      const message = `Your collector ${pool.group.admin.fullName} recorded ${naira(amount, pool.group.currency)} (${payment.method.toLowerCase()}) from you for ${pool.title}. Receipt code: ${payment.id.slice(-6).toUpperCase()}.`;
      await safeSmsAndEmail(contribution.contributor.phoneNumber, contribution.contributor.email, 'ÀJỌ payment recorded', message);
    }
    return { payment, contributionVerified: done.verified, readyForPayout: done.readyForPayout };
  }
  if (contribution.dueAt < new Date()) await prisma.ajoContribution.update({ where: { id: contribution.id }, data: { status: 'LATE' } });
  const message = `${contribution.contributor.fullName} says they paid ${naira(amount, pool.group.currency)} for ${pool.title} cycle ${contribution.schedule.payoutOrder}. Confirm in ÀJỌ app once you receive it.`;
  await safeSmsAndEmail(pool.group.admin.phoneNumber, pool.group.admin.email, 'Payment needs verification', message);
  await safePush(pool.group.adminId, {
    title: 'Payment to verify',
    body: 'A member reported a contribution. Open ÀJỌ to verify it.',
    data: { kind: 'PAYMENTS_TO_VERIFY', poolId: pool.id },
  });
  return { payment, contributionVerified: false, readyForPayout: false };
}

/** Recomputes verified totals for a contribution; marks it VERIFIED when fully paid and the schedule READY when all are. */
async function settleContribution(contributionId: string) {
  const c = await loadContribution(contributionId);
  const verifiedPayments = c.payments.filter((p) => p.status === 'VERIFIED');
  const paid = round2(verifiedPayments.reduce((s, p) => s + p.amount, 0));
  const fully = paid >= c.amount - 0.001;
  const last = verifiedPayments.reduce<Date | null>((d, p) => (!d || p.createdAt > d ? p.createdAt : d), null);
  const wasLate = !!last && last.getTime() > c.dueAt.getTime() + c.ajoPool.graceDays * DAY_MS;
  await prisma.ajoContribution.update({
    where: { id: c.id },
    data: fully ? { paidAmount: paid, status: 'VERIFIED', verifiedAt: new Date(), wasLate: wasLate || c.coveredByCollector } : { paidAmount: paid },
  });
  const readyForPayout = fully ? await markReadyIfComplete(c.scheduleId) : false;
  return { verified: fully, readyForPayout };
}

async function markReadyIfComplete(scheduleId: string): Promise<boolean> {
  const outstanding = await prisma.ajoContribution.count({ where: { scheduleId, status: { not: 'VERIFIED' } } });
  if (outstanding > 0) return false;
  const claimed = await prisma.ajoRotationSchedule.updateMany({ where: { id: scheduleId, status: 'SCHEDULED' }, data: { status: 'READY' } });
  if (claimed.count === 0) return false;
  const s = await prisma.ajoRotationSchedule.findUniqueOrThrow({ where: { id: scheduleId }, include: { recipient: true, ajoPool: { include: { group: { include: { admin: true } } } } } });
  const message = `All payments for ${s.ajoPool.title} cycle ${s.payoutOrder} are confirmed. Pay ${s.recipient.fullName} and record the payout in ÀJỌ app.`;
  await safeSmsAndEmail(s.ajoPool.group.admin.phoneNumber, s.ajoPool.group.admin.email, 'Payout is ready', message);
  await safePush(s.ajoPool.group.adminId, {
    title: 'Payout ready',
    body: 'All contributions are confirmed. Open ÀJỌ to record the payout.',
    data: { kind: 'PAYOUT_READY', poolId: s.ajoPoolId },
  });
  return true;
}

/** Collector confirms they received the money for every pending payment on a contribution. */
export async function verifyContribution(verifier: { id: string; role: string }, contributionId: string) {
  const c = await loadContribution(contributionId);
  if (c.ajoPool.group.adminId !== verifier.id && verifier.role !== 'ADMIN') throw new HttpError(403, 'Only the pool collector can verify contributions');
  // A collector cannot confirm their own payments: someone else (a platform admin) must.
  if (c.contributorId === verifier.id && verifier.role !== 'ADMIN') throw new HttpError(403, 'You cannot verify your own payment');
  const pending = c.payments.filter((p) => p.status === 'PENDING');
  if (pending.length === 0) throw new HttpError(400, 'There is no pending payment to verify');

  for (const p of pending) {
    await prisma.contributionPayment.update({ where: { id: p.id }, data: { status: 'VERIFIED', verifiedById: verifier.id, verifiedAt: new Date() } });
    await addEntry({ ajoPoolId: c.ajoPoolId }, 'IN', 'CONTRIBUTION', p.amount, verifier.id, `${c.contributor.fullName} · ${p.method.toLowerCase()}`, p.id);
  }
  await audit(verifier.id, 'PAYMENTS_VERIFIED', 'AjoContribution', c.id, { count: pending.length });
  const done = await settleContribution(c.id);
  const message = `Your collector confirmed your Àjọ payment${done.verified ? '. You are fully paid for this cycle. Thank you!' : '. A balance is still due.'}`;
  await safeSmsAndEmail(c.contributor.phoneNumber, c.contributor.email, 'ÀJỌ payment confirmed', message);
  const fresh = await prisma.ajoContribution.findUniqueOrThrow({ where: { id: c.id } });
  return { contribution: fresh, payoutReady: done.readyForPayout };
}

export async function rejectPayment(verifier: { id: string; role: string }, paymentId: string, reason: string) {
  const p = await prisma.contributionPayment.findUnique({ where: { id: paymentId } });
  if (!p) throw new HttpError(404, 'Payment not found');
  const c = await loadContribution(p.contributionId);
  if (c.ajoPool.group.adminId !== verifier.id && verifier.role !== 'ADMIN') throw new HttpError(403, 'Only the pool collector can reject a payment');
  if (p.status !== 'PENDING') throw new HttpError(409, 'Only pending payments can be rejected');
  const updated = await prisma.contributionPayment.update({ where: { id: p.id }, data: { status: 'REJECTED', rejectReason: reason, verifiedById: verifier.id, verifiedAt: new Date() } });
  await audit(verifier.id, 'PAYMENT_REJECTED', 'ContributionPayment', p.id, { reason });
  const message = `Your collector could not confirm your ${naira(p.amount, c.ajoPool.group.currency)} payment: ${reason}. Please contact them.`;
  await safeSmsAndEmail(c.contributor.phoneNumber, c.contributor.email, 'Payment was not confirmed', message);
  return updated;
}

// ── PAYOUT (collector pays recipient, then records it) ───────────

export async function recordPayout(collectorId: string, scheduleId: string, input: { method: PaymentMethod; reference?: string; proofUrl?: string }) {
  const s = await prisma.ajoRotationSchedule.findUnique({
    where: { id: scheduleId },
    include: { recipient: true, contributions: true, ajoPool: { include: { group: { include: { admin: true } } } } },
  });
  if (!s) throw new HttpError(404, 'Schedule not found');
  const pool = s.ajoPool;
  if (pool.group.adminId !== collectorId) throw new HttpError(403, 'Only the pool collector can record a payout');
  if (s.status !== 'READY') throw new HttpError(409, s.status === 'SCHEDULED' ? 'Not all contributions are confirmed yet' : 'Payout already recorded');
  if (input.method === 'TRANSFER' && !input.reference && !input.proofUrl) throw new HttpError(400, 'Add a transfer reference or a screenshot as proof');

  const totalCollected = round2(s.contributions.reduce((sum, c) => sum + c.paidAmount, 0));
  const { platformFee, collectorFee, netPayout } = calculateAjoFees(totalCollected, pool.platformFeePct, pool.collectorFeePct);
  const paidOutAt = new Date();

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.ajoRotationSchedule.updateMany({ where: { id: scheduleId, status: 'READY' }, data: { status: 'COMPLETED' } });
    if (claimed.count === 0) throw new HttpError(409, 'Payout already recorded');
    await tx.ajoRotationSchedule.update({
      where: { id: scheduleId },
      data: { totalCollected, platformFee, collectorFee, netPayout, payoutMethod: input.method, payoutRef: input.reference, payoutProofUrl: input.proofUrl, paidOutAt },
    });
    const entry = (type: 'PAYOUT' | 'COLLECTOR_FEE' | 'EXPENSE', amount: number, note: string) =>
      amount > 0 ? tx.ledgerEntry.create({ data: { ajoPoolId: pool.id, direction: 'OUT', type, amount, note, refId: scheduleId, createdById: collectorId } }) : null;
    await entry('PAYOUT', netPayout, `Payout to ${s.recipient.fullName} (cycle ${s.payoutOrder}) · ${input.method.toLowerCase()}${input.reference ? ' · ' + input.reference : ''}`);
    await entry('COLLECTOR_FEE', collectorFee, `Collector fee (cycle ${s.payoutOrder})`);
    await entry('EXPENSE', platformFee, `ÀJỌ service fee (cycle ${s.payoutOrder})`);
  });
  await audit(collectorId, 'PAYOUT_RECORDED', 'AjoRotationSchedule', scheduleId, { netPayout, method: input.method });

  let receiptUrl: string | null = null;
  try {
    receiptUrl = await generateAjoReceipt({
      poolTitle: pool.title, cycleNumber: s.payoutOrder, recipientName: s.recipient.fullName, totalCollected, platformFee, collectorFee, netPayout,
      monnifyRef: input.reference ?? `ÀJỌ-${scheduleId.slice(-8).toUpperCase()}`, payoutDate: paidOutAt, groupName: pool.group.name,
    });
    await prisma.ajoRotationSchedule.update({ where: { id: scheduleId }, data: { receiptUrl } });
  } catch (e) {
    console.error('[ajo] receipt generation failed', (e as Error).message);
  }

  const cur = pool.group.currency;
  await prisma.groupMessage.create({
    data: { groupId: pool.groupId, messageType: 'RECEIPT', refId: scheduleId, content: `✅ ${s.recipient.fullName} was paid ${naira(netPayout, cur)} from "${pool.title}" (cycle ${s.payoutOrder}). Waiting for them to confirm.` },
  });

  const all = await prisma.ajoRotationSchedule.findMany({ where: { ajoPoolId: pool.id }, orderBy: { payoutOrder: 'asc' }, include: { recipient: true } });
  const next = all.find((x) => x.status !== 'COMPLETED' && x.id !== scheduleId);
  await prisma.ajoPool.update({ where: { id: pool.id }, data: { currentCycleIndex: s.payoutOrder, ...(next ? {} : { status: 'COMPLETED' }) } });
  // The pool finished successfully: commission taken on its contributions is now earned.
  if (!next) await earnCommission('AJO', pool.id, collectorId);

  const recipientMessage = `Your collector ${pool.group.admin.fullName} says they paid you ${naira(netPayout, cur)} for ${pool.title} (${input.method.toLowerCase()}). Reply CONFIRM if you received it, or NOTYET if not. You can also use the app.`;
  await safeSmsAndEmail(s.recipient.phoneNumber, s.recipient.email, 'ÀJỌ payout recorded', recipientMessage);
  await safePush(s.recipientId, {
    title: 'Confirm your payout',
    body: 'Your collector recorded a payout. Open ÀJỌ to confirm whether you received it.',
    data: { kind: 'CONFIRM_PAYOUT', poolId: pool.id },
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(all.map((x) => x.recipientId))] } } });
  const tail = next ? `Next: ${next.recipient.fullName} on ${fmtDate(next.payoutDate)}.` : 'This pool is now complete.';
  for (const u of users) if (u.id !== s.recipientId) {
    const message = `${s.recipient.fullName} has been paid their Àjọ collection. ${tail}`;
    await safeSmsAndEmail(u.phoneNumber, u.email, 'ÀJỌ pool payout update', message);
  }
  return { totalCollected, platformFee, collectorFee, netPayout, receiptUrl };
}

/** The recipient confirms (or disputes) that they really received the money. */
export async function confirmReceipt(userId: string, scheduleId: string, received: boolean, note?: string) {
  const s = await prisma.ajoRotationSchedule.findUnique({ where: { id: scheduleId }, include: { recipient: true, ajoPool: { include: { group: { include: { admin: true } } } } } });
  if (!s) throw new HttpError(404, 'Schedule not found');
  if (s.recipientId !== userId) throw new HttpError(403, 'Only the recipient can confirm this payout');
  if (s.status !== 'COMPLETED' && s.status !== 'DISPUTED') throw new HttpError(409, 'No payout has been recorded yet');
  const pool = s.ajoPool;
  if (received) {
    await prisma.ajoRotationSchedule.update({ where: { id: s.id }, data: { status: 'COMPLETED', recipientConfirmedAt: new Date() } });
    await prisma.groupMessage.create({ data: { groupId: pool.groupId, messageType: 'SYSTEM', content: `🤝 ${s.recipient.fullName} confirmed they received their Àjọ payout (cycle ${s.payoutOrder}).` } });
    await audit(userId, 'PAYOUT_CONFIRMED', 'AjoRotationSchedule', s.id);
    return { status: 'COMPLETED' as const };
  }
  await prisma.ajoRotationSchedule.update({ where: { id: s.id }, data: { status: 'DISPUTED', recipientConfirmedAt: null } });
  await prisma.dispute.create({
    data: { groupId: pool.groupId, ajoPoolId: pool.id, scheduleId: s.id, raisedById: userId, kind: 'PAYOUT_NOT_RECEIVED', description: note || `${s.recipient.fullName} says they have not received their payout.` },
  });
  await prisma.groupMessage.create({ data: { groupId: pool.groupId, messageType: 'SYSTEM', content: `⚠️ A recipient says they have not received a recorded payout (cycle ${s.payoutOrder}). The collector must resolve this.` } });
  const message = `${s.recipient.fullName} says they have NOT received the ${pool.title} payout you recorded. Please resolve it in ÀJỌ app.`;
  await safeSmsAndEmail(pool.group.admin.phoneNumber, pool.group.admin.email, 'ÀJỌ payout dispute', message);
  await audit(userId, 'PAYOUT_DISPUTED', 'AjoRotationSchedule', s.id);
  return { status: 'DISPUTED' as const };
}

// ── DEFAULTERS ───────────────────────────────────────────────────

/**
 * Flags unpaid contributions that are past due + the pool's grace period as MISSED and escalates the member's status.
 * Anyone who has recorded a payment (even one still awaiting the collector's confirmation) is never flagged.
 */
export async function flagDefaulter(scheduleId: string) {
  const candidates = await prisma.ajoContribution.findMany({
    where: { scheduleId, status: 'PENDING', payments: { none: {} }, dueAt: { lt: new Date() } },
    include: { contributor: true, schedule: { include: { recipient: true } }, ajoPool: { include: { group: { include: { admin: true } } } } },
  });
  const overdue = candidates.filter((c) => overdueAfterGrace(c.dueAt, c.ajoPool.graceDays));
  for (const c of overdue) {
    const claimed = await prisma.ajoContribution.updateMany({ where: { id: c.id, status: 'PENDING' }, data: { status: 'MISSED', fineAmount: c.ajoPool.lateFeeAmount } });
    if (claimed.count === 0) continue;
    const newStatus = nextMemberStatus(c.contributor.memberStatus);
    await prisma.user.update({ where: { id: c.contributorId }, data: { memberStatus: newStatus } });
    const cur = c.ajoPool.group.currency;
    const fine = c.ajoPool.lateFeeAmount > 0 ? ` A late fee of ${naira(c.ajoPool.lateFeeAmount, cur)} applies.` : '';
    const memberMessage = `URGENT: You missed your Àjọ contribution of ${naira(c.amount, cur)} for ${c.schedule.recipient.fullName}'s cycle. Pay your collector now to avoid removal from future pools.${fine}`;
    await safeSmsAndEmail(c.contributor.phoneNumber, c.contributor.email, 'Missed ÀJỌ contribution', memberMessage);
    await safePush(c.contributorId, {
      title: 'Missed contribution',
      body: 'A contribution is overdue. Open ÀJỌ to review it.',
      data: { kind: 'MISSED', poolId: c.ajoPoolId },
    });
    await prisma.groupMessage.create({ data: { groupId: c.ajoPool.groupId, messageType: 'SYSTEM', content: '⚠️ A member has missed their contribution for this cycle. The Collector has been notified.' } });
    const adminMessage = `${c.contributor.fullName} missed their Àjọ contribution of ${naira(c.amount, cur)} in "${c.ajoPool.title}" (${newStatus}).`;
    await safeSmsAndEmail(c.ajoPool.group.admin.phoneNumber, c.ajoPool.group.admin.email, 'Member missed a contribution', adminMessage);
    await audit(null, 'CONTRIBUTION_MISSED', 'AjoContribution', c.id, { member: c.contributorId });
  }
  return overdue.length;
}

// ── TRANSPARENCY HELPERS ─────────────────────────────────────────

export async function poolLedger(poolId: string) {
  const [ledger, outstanding] = await Promise.all([
    getLedger({ ajoPoolId: poolId }),
    prisma.ajoContribution.findMany({ where: { ajoPoolId: poolId, status: { not: 'VERIFIED' } }, select: { amount: true, paidAmount: true } }),
  ]);
  return { ...ledger, stillExpected: round2(outstanding.reduce((s, c) => s + (c.amount - c.paidAmount), 0)) };
}

export async function addManualEntry(collectorId: string, poolId: string, input: { type: 'FINE_COLLECTED' | 'EXPENSE' | 'ADJUSTMENT'; direction: 'IN' | 'OUT'; amount: number; note: string }) {
  const pool = await prisma.ajoPool.findUnique({ where: { id: poolId }, include: { group: true } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  if (pool.group.adminId !== collectorId) throw new HttpError(403, 'Only the pool collector can add ledger entries');
  const direction = input.type === 'FINE_COLLECTED' ? 'IN' : input.type === 'EXPENSE' ? 'OUT' : input.direction;
  const entry = await addEntry({ ajoPoolId: poolId }, direction, input.type, input.amount, collectorId, input.note);
  await prisma.groupMessage.create({
    data: { groupId: pool.groupId, senderId: collectorId, messageType: 'SYSTEM', content: `📒 Ledger note: ${direction === 'IN' ? '+' : '−'}${naira(input.amount, pool.group.currency)} · ${input.note}` },
  });
  await audit(collectorId, 'LEDGER_ENTRY', 'AjoPool', poolId, { type: input.type, amount: input.amount });
  return entry;
}

export async function acceptRules(actor: { id: string }, poolId: string, userId?: string) {
  const pool = await prisma.ajoPool.findUnique({ where: { id: poolId }, include: { group: true } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  const target = userId ?? actor.id;
  if (target !== actor.id && pool.group.adminId !== actor.id) throw new HttpError(403, 'Only the collector can accept on behalf of a member');
  const inPool = await prisma.ajoContribution.findFirst({ where: { ajoPoolId: poolId, contributorId: target } });
  if (!inPool) throw new HttpError(404, 'That member is not in this pool');
  return prisma.poolAcceptance.upsert({
    where: { ajoPoolId_userId: { ajoPoolId: poolId, userId: target } },
    create: { ajoPoolId: poolId, userId: target, acceptedById: actor.id },
    update: {},
  });
}

export async function exportPoolCsv(collectorId: string, poolId: string): Promise<string> {
  const pool = await prisma.ajoPool.findUnique({ where: { id: poolId }, include: { group: true } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  if (pool.group.adminId !== collectorId) throw new HttpError(403, 'Only the pool collector can export');
  const [payments, entries, schedules] = await Promise.all([
    prisma.contributionPayment.findMany({ where: { ajoPoolId: poolId }, orderBy: { createdAt: 'asc' } }),
    prisma.ledgerEntry.findMany({ where: { ajoPoolId: poolId }, orderBy: { createdAt: 'asc' } }),
    prisma.ajoRotationSchedule.findMany({ where: { ajoPoolId: poolId }, orderBy: { payoutOrder: 'asc' }, include: { recipient: true } }),
  ]);
  const contributions = await prisma.ajoContribution.findMany({ where: { ajoPoolId: poolId }, include: { contributor: true } });
  const nameOf = new Map(contributions.map((c) => [c.id, c.contributor.fullName]));
  return toCsv([
    [`Pool`, pool.title, `Group`, pool.group.name],
    [],
    ['LEDGER'], ['Date', 'Direction', 'Type', 'Amount', 'Note'],
    ...entries.map((e) => [e.createdAt.toISOString(), e.direction, e.type, e.amount, e.note]),
    [],
    ['PAYMENTS'], ['Date', 'Member', 'Amount', 'Method', 'Status', 'Reference'],
    ...payments.map((p) => [p.createdAt.toISOString(), nameOf.get(p.contributionId), p.amount, p.method, p.status, p.reference]),
    [],
    ['PAYOUTS'], ['Cycle', 'Recipient', 'Date', 'Status', 'Net payout', 'Collector fee', 'Method', 'Reference', 'Recipient confirmed'],
    ...schedules.map((s) => [s.payoutOrder, s.recipient.fullName, s.payoutDate.toISOString(), s.status, s.netPayout, s.collectorFee, s.payoutMethod, s.payoutRef, s.recipientConfirmedAt?.toISOString()]),
  ]);
}

// ── TURN SWAPS ───────────────────────────────────────────────────

async function swappable(scheduleId: string) {
  const s = await prisma.ajoRotationSchedule.findUnique({ where: { id: scheduleId }, include: { recipient: true } });
  if (!s) throw new HttpError(404, 'Turn not found');
  if (s.status !== 'SCHEDULED') throw new HttpError(409, 'Only turns that have not started can be swapped');
  const paid = await prisma.contributionPayment.count({ where: { contribution: { scheduleId } } });
  if (paid > 0) throw new HttpError(409, 'Payments have already been recorded for one of these turns');
  return s;
}

export async function requestSwap(userId: string, poolId: string, myScheduleId: string, peerScheduleId: string, reason?: string) {
  const [mine, theirs] = await Promise.all([swappable(myScheduleId), swappable(peerScheduleId)]);
  if (mine.ajoPoolId !== poolId || theirs.ajoPoolId !== poolId) throw new HttpError(400, 'Both turns must be in this pool');
  if (mine.recipientId !== userId) throw new HttpError(403, 'You can only swap your own turn');
  if (theirs.recipientId === userId) throw new HttpError(400, 'Pick another member\'s turn');
  const swap = await prisma.turnSwap.create({ data: { ajoPoolId: poolId, requesterId: userId, peerId: theirs.recipientId, scheduleAId: mine.id, scheduleBId: theirs.id, reason } });
  const message = `${mine.recipient.fullName} asks to swap Àjọ turns with you (${fmtDate(mine.payoutDate)} ↔ ${fmtDate(theirs.payoutDate)}). Open the app to accept or decline.`;
  await safeSmsAndEmail(theirs.recipient.phoneNumber, theirs.recipient.email, 'ÀJỌ turn swap request', message);
  return swap;
}

export async function respondSwap(userId: string, swapId: string, accept: boolean) {
  const swap = await prisma.turnSwap.findUnique({ where: { id: swapId } });
  if (!swap) throw new HttpError(404, 'Swap request not found');
  if (swap.peerId !== userId) throw new HttpError(403, 'This request is not for you');
  if (swap.status !== 'PENDING_PEER') throw new HttpError(409, 'Already answered');
  const updated = await prisma.turnSwap.update({ where: { id: swapId }, data: { status: accept ? 'PENDING_COLLECTOR' : 'REJECTED' } });
  if (accept) {
    const pool = await prisma.ajoPool.findUniqueOrThrow({ where: { id: swap.ajoPoolId }, include: { group: { include: { admin: true } } } });
    const message = `Two members of ${pool.title} agreed to swap Àjọ turns. Please approve or decline in ÀJỌ app.`;
    await safeSmsAndEmail(pool.group.admin.phoneNumber, pool.group.admin.email, 'ÀJỌ turn swap needs review', message);
  }
  return updated;
}

export async function decideSwap(collectorId: string, swapId: string, approve: boolean) {
  const swap = await prisma.turnSwap.findUnique({ where: { id: swapId } });
  if (!swap) throw new HttpError(404, 'Swap request not found');
  const pool = await prisma.ajoPool.findUniqueOrThrow({ where: { id: swap.ajoPoolId }, include: { group: true } });
  if (pool.group.adminId !== collectorId) throw new HttpError(403, 'Only the collector can decide a swap');
  if (swap.status !== 'PENDING_COLLECTOR') throw new HttpError(409, 'This request is not waiting for you');
  if (!approve) return prisma.turnSwap.update({ where: { id: swapId }, data: { status: 'REJECTED' } });

  const [a, b] = await Promise.all([swappable(swap.scheduleAId), swappable(swap.scheduleBId)]);
  await prisma.$transaction(async (tx) => {
    // Recipients trade slots. Contribution rows must follow: a recipient never pays into their own cycle.
    for (const [slot, oldR, newR] of [[a, a.recipientId, b.recipientId], [b, b.recipientId, a.recipientId]] as const) {
      const outgoing = await tx.ajoContribution.findUniqueOrThrow({ where: { scheduleId_contributorId: { scheduleId: slot.id, contributorId: newR } } });
      await tx.ajoContribution.delete({ where: { id: outgoing.id } });
      // The old recipient now pays into this cycle, at their own per-cycle amount.
      const theirOwn = await tx.ajoContribution.findFirst({ where: { ajoPoolId: pool.id, contributorId: oldR } });
      await tx.ajoContribution.create({ data: { ajoPoolId: pool.id, scheduleId: slot.id, contributorId: oldR, amount: theirOwn?.amount ?? pool.amountPerMember, dueAt: outgoing.dueAt } });
      await tx.ajoRotationSchedule.update({ where: { id: slot.id }, data: { recipientId: newR } });
    }
    await tx.turnSwap.update({ where: { id: swapId }, data: { status: 'APPROVED' } });
  });
  await prisma.groupMessage.create({ data: { groupId: pool.groupId, messageType: 'SYSTEM', content: `🔁 Two members swapped Àjọ turns in "${pool.title}". The schedule has been updated.` } });
  await audit(collectorId, 'TURN_SWAP_APPROVED', 'TurnSwap', swapId);
  const [aa, bb] = await Promise.all([prisma.user.findUnique({ where: { id: a.recipientId } }), prisma.user.findUnique({ where: { id: b.recipientId } })]);
  for (const u of [aa, bb]) {
    const message = `Your Àjọ turn swap in ${pool.title} was approved. Check your new collection date in the app.`;
    await safeSmsAndEmail(u?.phoneNumber, u?.email, 'ÀJỌ turn swap approved', message);
  }
  return prisma.turnSwap.findUniqueOrThrow({ where: { id: swapId } });
}

// ── WEEKLY DIGEST ────────────────────────────────────────────────

/** One short SMS line per active pool: where the money is and who is next. Sent weekly to every member. */
export async function buildDigests() {
  const pools = await prisma.ajoPool.findMany({ where: { status: 'ACTIVE' }, include: { group: true } });
  const out: { userId: string; phone: string | null; email: string | null; lang: string; line: string }[] = [];
  for (const p of pools) {
    const [ledger, current] = await Promise.all([
      getLedger({ ajoPoolId: p.id }),
      prisma.ajoRotationSchedule.findFirst({ where: { ajoPoolId: p.id, status: { in: ['SCHEDULED', 'READY'] } }, orderBy: { payoutOrder: 'asc' }, include: { contributions: { select: { status: true } }, recipient: true } }),
    ]);
    if (!current) continue;
    const paid = current.contributions.filter((c) => c.status === 'VERIFIED').length;
    const members = await prisma.user.findMany({ where: { ajoContributions: { some: { ajoPoolId: p.id } } } });
    for (const u of members) {
      if (!u.phoneNumber && !u.email) continue;
      out.push({
        userId: u.id, phone: u.phoneNumber, email: u.email, lang: u.preferredLanguage,
        line: `${p.title}: collector holds ${naira(ledger.heldByCollector, p.group.currency)}. ${paid}/${current.contributions.length} paid this cycle. Next: ${current.recipient.fullName} on ${fmtDate(current.payoutDate)}.`,
      });
    }
  }
  return out;
}
