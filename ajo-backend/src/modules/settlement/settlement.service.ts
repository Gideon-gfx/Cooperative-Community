import { ContributionDue, FundsEntry, SettlementFund, SettlementRelease, DestinationKind } from '@prisma/client';
import { decisions } from '../../config/decisions';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { koboToNaira, nairaToKobo } from '../../lib/kobo';
import { safeSmsAndEmail } from '../../lib/notify';
import { toCsv } from '../../services/ledger.service';
import * as monnify from '../../services/monnify.service';
import { graduationEligible } from '../apprenticeship/contracts.logic';
import { loadForUser } from '../apprenticeship/contracts.service';
import { daysUntil, nextReminder } from '../billing/billing.logic';
import { deriveTotals, pendingOutKobo } from '../payments/funds-provider';
import { MonnifyEscrowProvider } from '../payments/monnify-escrow.provider';
import { contribute } from '../payments/payments.service';
import { nameSimilarity } from '../records/records.logic';
import { boardMemberIdsFor, groupIdsOverseenBy, isBoardMemberFor } from '../trust/board';
import { emitContractChanged } from '../apprenticeship/contract.events';
import { allocateDues, decide, destinationConfirmed, hasConflict, isActiveRelease, isMissed, NAME_MATCH_MIN, owedSoFar } from './settlement.logic';

type Actor = { id: string; role: string };
const isOversight = (u: Actor) => u.role === 'ADMIN' || u.role === 'BOARD_MEMBER';
const PURPOSE = 'SETTLEMENT_FUND' as const;

// ── The fund and its derived totals ─────────────────────────────────────────

export async function fundOf(contractId: string): Promise<SettlementFund> {
  const f = await prisma.settlementFund.findUnique({ where: { contractId } });
  if (!f) throw new HttpError(404, 'This agreement has no Settlement Fund yet: it is created when the agreement starts');
  return f;
}

/**
 * Everything is derived from CONFIRMED ledger rows: money in from the master, money in from the community, what is
 * still pending at the payment partner, and what has gone out. Nothing is stored, so nothing can drift.
 */
export async function fundTotals(fund: SettlementFund, masterId: string) {
  const [byPayer, all, pending] = await Promise.all([
    prisma.fundsEntry.groupBy({ by: ['payerUserId'], where: { purposeType: PURPOSE, purposeId: fund.id, type: 'CONTRIBUTION', status: 'CONFIRMED' }, _sum: { amountKobo: true } }),
    deriveTotals({ purposeType: PURPOSE, purposeId: fund.id }),
    prisma.providerTransaction.aggregate({ where: { kind: 'COLLECT', status: 'INITIATED', purposeType: PURPOSE, purposeId: fund.id }, _sum: { amountKobo: true } }),
  ]);
  const masterConfirmed = byPayer.filter((r) => r.payerUserId === masterId).reduce((s, r) => s + (r._sum.amountKobo ?? 0n), 0n);
  const communityMatch = byPayer.filter((r) => r.payerUserId !== masterId).reduce((s, r) => s + (r._sum.amountKobo ?? 0n), 0n);
  return {
    masterConfirmed, communityMatch, contributionsTotal: masterConfirmed + communityMatch,
    pendingKobo: pending._sum.amountKobo ?? 0n, releasesKobo: all.releases, refundsKobo: all.refunds, balanceKobo: all.balance,
  };
}

export async function duesFor(fund: SettlementFund, masterId: string, now = new Date()) {
  const dues = await prisma.contributionDue.findMany({ where: { fundId: fund.id }, orderBy: { number: 'asc' } });
  const t = await fundTotals(fund, masterId);
  return { dues, states: allocateDues(dues, t.masterConfirmed, now), totals: t };
}

// ── Contributing (through escrow) ───────────────────────────────────────────

/**
 * The master pays the monthly contribution; any group member can add a community match. Both go through the same escrow
 * checkout. Nothing counts until the payment partner confirms it.
 */
export async function contributeToFund(user: Actor, contractId: string, input: { amount?: string | number; asMatch?: boolean }) {
  const { c } = await loadForUser(user, contractId);
  if (c.status !== 'ACTIVE') throw new HttpError(409, 'Contributions can only be made while the agreement is active');
  const fund = await fundOf(contractId);
  if (fund.status !== 'ACCUMULATING') throw new HttpError(409, 'This fund is no longer accepting contributions');
  const isMaster = c.masterId === user.id;
  if (!isMaster && !input.asMatch) throw new HttpError(403, 'Only the master pays the monthly contribution. To add a community match, say it is a match.');

  let amount: string | number;
  if (isMaster && !input.asMatch) {
    const { states, totals } = await duesFor(fund, c.masterId);
    const planned = c.monthlyContributionKobo * BigInt(c.durationMonths);
    const left = planned - totals.masterConfirmed;
    if (left <= 0n) throw new HttpError(409, 'All the planned contributions have been paid');
    const next = states.find((s) => s.remainingKobo > 0n);
    const kobo = input.amount === undefined ? (next?.remainingKobo ?? c.monthlyContributionKobo) : nairaToKobo(input.amount);
    if (kobo > left) throw new HttpError(409, `That is more than the ₦${koboToNaira(left)} still planned`);
    amount = koboToNaira(kobo);
  } else {
    if (input.amount === undefined) throw new HttpError(400, 'Say how much you want to add');
    amount = koboToNaira(nairaToKobo(input.amount));
  }
  // The same path as every escrow payment: terms accepted, member of the group, escrow-only enforced, fee preview, checkout.
  return contribute(user, { groupId: c.communityGroupId, purposeType: PURPOSE, purposeId: fund.id, amount });
}

// ── Reminders and flags ─────────────────────────────────────────────────────

const REMINDER_TEXT = (n: number, amount: string) => (n > 0 ? `ÀJỌ: your Settlement Fund contribution of ₦${amount} is due in ${n} days.` : n === 0 ? `ÀJỌ: your Settlement Fund contribution of ₦${amount} is due today.` : `ÀJỌ: your Settlement Fund contribution of ₦${amount} is ${-n} days late. Please pay it in the app.`);

/**
 * Daily at 08:00 WAT: a reminder 3 days before a month falls due, on the day, and 2 days late. A contribution that is two
 * days late and unpaid is FLAGGED for the Trust Board. A flag never touches anyone's money.
 */
export async function runSettlementReminders(now = new Date()) {
  const funds = await prisma.settlementFund.findMany({ where: { status: 'ACCUMULATING' } });
  const out = { reminded: 0, flagged: 0 };
  for (const fund of funds) {
    const c = await prisma.apprenticeshipContract.findUnique({ where: { id: fund.contractId } });
    if (!c || c.status !== 'ACTIVE') continue; // a paused agreement owes nothing until it resumes
    const { dues, states } = await duesFor(fund, c.masterId, now);
    const master = await prisma.user.findUnique({ where: { id: c.masterId } });
    for (const s of states) {
      if (s.remainingKobo === 0n) continue;
      const due = dues.find((d) => d.number === s.number)!;
      const r = nextReminder(daysUntil(due.dueDate, now), due.remindersSent, decisions.settlement.reminderDays);
      if (r) {
        const claimed = await prisma.contributionDue.updateMany({ where: { id: due.id, remindersSent: { equals: due.remindersSent } }, data: { remindersSent: [...due.remindersSent, ...r.markSent.filter((d) => !due.remindersSent.includes(d))] } });
        if (claimed.count > 0) {
          out.reminded++;
          const message = REMINDER_TEXT(r.send, koboToNaira(s.remainingKobo));
          await safeSmsAndEmail(master?.phoneNumber, master?.email, 'Settlement Fund contribution reminder', message);
        }
      }
      if (isMissed(s, now) && !due.flaggedAt) {
        const claimed = await prisma.contributionDue.updateMany({ where: { id: due.id, flaggedAt: null }, data: { flaggedAt: now } });
        if (claimed.count > 0) { out.flagged++; await audit(null, 'CONTRIBUTION_MISSED_FLAGGED', 'ContributionDue', due.id, { contractId: c.id, number: due.number }); emitContractChanged(c.id); }
      }
    }
  }
  return out;
}

// ── Release: preconditions ──────────────────────────────────────────────────

export async function releasePreconditions(contractId: string) {
  const c = await prisma.apprenticeshipContract.findUniqueOrThrow({ where: { id: contractId }, include: { milestones: true } });
  const fund = await fundOf(contractId);
  const unmet: string[] = [];
  if (c.status !== 'COMPLETED_PENDING_SETTLEMENT') unmet.push('The apprenticeship is not finished yet.');
  if (!graduationEligible(c.milestones)) unmet.push('Every milestone must be approved, and there must be at least one.');
  if (fund.status !== 'ACCUMULATING' && fund.status !== 'READY_FOR_RELEASE') unmet.push(`The fund is ${fund.status.toLowerCase().replace(/_/g, ' ')}.`);
  const disputed = await prisma.fundsEntry.count({ where: { purposeType: PURPOSE, purposeId: fund.id, status: 'DISPUTED' } });
  if (disputed > 0) unmet.push('A payment into this fund is under dispute. It must be resolved first.');
  const t = await fundTotals(fund, c.masterId);
  if (t.balanceKobo <= 0n) unmet.push('There is no confirmed money in the fund to release.');
  const open = await prisma.settlementRelease.findFirst({ where: { fundId: fund.id, status: { in: ['AWAITING_DESTINATION', 'AWAITING_CONFIRMATION', 'AWAITING_APPROVALS', 'DISBURSING'] } } });
  if (open) unmet.push('A release is already in progress.');
  return { c, fund, unmet, balanceKobo: t.balanceKobo };
}

/** The Trust Board of this fund's community (or the platform-wide board if its group has none). */
async function notifyBoard(message: string, groupId?: string | null) {
  const board = await prisma.user.findMany({ where: { id: { in: await boardMemberIdsFor(groupId) } } });
  for (const b of board) await safeSmsAndEmail(b.phoneNumber, b.email, 'Settlement Fund update', message);
}

/** Starts the release: the fund becomes READY_FOR_RELEASE and the Trust Board is told. */
export async function openRelease(user: Actor, contractId: string) {
  const { c, role } = await loadForUser(user, contractId);
  if (role !== 'MASTER' && role !== 'APPRENTICE' && !isOversight(user)) throw new HttpError(403, 'Only the master, the apprentice, an admin or the Trust Board can start the release');
  const p = await releasePreconditions(contractId);
  if (p.unmet.length) throw new HttpError(409, p.unmet.join(' '));
  // The claim is the guard: two people pressing the button cannot open two releases.
  if (p.fund.status === 'ACCUMULATING') {
    const done = await prisma.settlementFund.updateMany({ where: { id: p.fund.id, status: 'ACCUMULATING' }, data: { status: 'READY_FOR_RELEASE' } });
    if (done.count === 0) throw new HttpError(409, 'The release was just started by someone else');
  }
  const r = await prisma.settlementRelease.create({ data: { fundId: p.fund.id, contractId, status: 'AWAITING_DESTINATION', openedById: user.id, approvalsRequired: decisions.settlement.approvalsRequired, fundsEntryId: null } });
  await audit(user.id, 'RELEASE_OPENED', 'SettlementRelease', r.id, { from: 'ACCUMULATING', to: 'READY_FOR_RELEASE', balanceKobo: p.balanceKobo.toString() });
  const apprentice = await prisma.user.findUnique({ where: { id: c.apprenticeId } });
  const message = 'ÀJỌ: your Settlement Fund is ready to be released. Open the app and say where it should go.';
  await safeSmsAndEmail(apprentice?.phoneNumber, apprentice?.email, 'Settlement Fund ready for release', message);
  await notifyBoard('ÀJỌ: a Settlement Fund is ready for release. It will need your approval once the graduate has confirmed where the money goes.', c.communityGroupId);
  return r;
}

async function loadRelease(user: Actor, releaseId: string) {
  const r = await prisma.settlementRelease.findUnique({ where: { id: releaseId } });
  if (!r) throw new HttpError(404, 'Release not found');
  const { c, role } = await loadForUser(user, r.contractId);
  return { r, c, role };
}

// ── Release: destination, confirmed by the graduate ─────────────────────────

/** The graduate says where the money should go. The BANK tells us whose account it is. */
export async function proposeDestination(user: Actor, releaseId: string, input: { kind: DestinationKind; bankCode: string; accountNumber: string; note?: string }) {
  const { r, c, role } = await loadRelease(user, releaseId);
  if (role !== 'APPRENTICE') throw new HttpError(403, 'Only the graduate chooses where their money goes');
  if (r.status !== 'AWAITING_DESTINATION' && r.status !== 'AWAITING_CONFIRMATION') throw new HttpError(409, 'The destination can no longer be changed');
  if (!/^\d{10}$/.test(input.accountNumber)) throw new HttpError(400, 'The account number must be 10 digits');
  if (input.kind !== 'GRADUATE' && (input.note ?? '').trim().length < 3) throw new HttpError(400, 'Say what this payment is for (the supplier or landlord, and why)');
  let accountName: string;
  try {
    accountName = (await monnify.validateBankAccount(input.accountNumber, input.bankCode)).accountName;
  } catch {
    throw new HttpError(422, 'The bank could not confirm that account. Check the number and the bank, and try again.');
  }
  const apprentice = await prisma.user.findUniqueOrThrow({ where: { id: c.apprenticeId } });
  const mismatch = input.kind === 'GRADUATE' && nameSimilarity(accountName, apprentice.fullName) < NAME_MATCH_MIN;
  const done = await prisma.settlementRelease.updateMany({
    where: { id: r.id, status: { in: ['AWAITING_DESTINATION', 'AWAITING_CONFIRMATION'] } },
    data: { status: 'AWAITING_CONFIRMATION', destinationKind: input.kind, bankCode: input.bankCode, accountNumber: input.accountNumber, accountName, destinationNote: input.note?.trim() ?? null, nameMismatch: mismatch, graduateConfirmedAt: null, guardianConfirmedAt: null },
  });
  if (done.count === 0) throw new HttpError(409, 'The release just changed. Please look again.');
  await audit(user.id, 'RELEASE_DESTINATION_PROPOSED', 'SettlementRelease', r.id, { kind: input.kind, accountName, nameMismatch: mismatch });
  return prisma.settlementRelease.findUniqueOrThrow({ where: { id: r.id } });
}

/** The graduate (and a guardian, if the agreement has one) confirms the destination the bank returned. Only then can the board approve. */
export async function confirmDestination(user: Actor, releaseId: string) {
  const { r, c, role } = await loadRelease(user, releaseId);
  if (role !== 'APPRENTICE' && role !== 'PARENT_GUARDIAN') throw new HttpError(403, 'Only the graduate' + (c.guardianId ? ' and their guardian' : '') + ' can confirm the destination');
  if (r.status !== 'AWAITING_CONFIRMATION') throw new HttpError(409, 'There is no destination waiting to be confirmed');
  const field = role === 'APPRENTICE' ? 'graduateConfirmedAt' : 'guardianConfirmedAt';
  await prisma.settlementRelease.updateMany({ where: { id: r.id, status: 'AWAITING_CONFIRMATION' }, data: { [field]: new Date() } });
  const fresh = await prisma.settlementRelease.findUniqueOrThrow({ where: { id: r.id } });
  await audit(user.id, 'RELEASE_DESTINATION_CONFIRMED', 'SettlementRelease', r.id, { by: role });
  if (destinationConfirmed(fresh, c.guardianId)) {
    const done = await prisma.settlementRelease.updateMany({ where: { id: r.id, status: 'AWAITING_CONFIRMATION' }, data: { status: 'AWAITING_APPROVALS' } });
    if (done.count > 0) await notifyBoard(`ÀJỌ: a Settlement Fund release to ${fresh.accountName ?? 'a confirmed account'} needs your approval (${fresh.approvalsRequired} members must approve).`, c.communityGroupId);
  }
  return prisma.settlementRelease.findUniqueOrThrow({ where: { id: r.id } });
}

// ── Release: Trust Board approvals, then the disbursement ───────────────────

/**
 * Two different Trust Board members approve, signed in as themselves: there is no shared token. Anyone with a stake in the
 * agreement is barred. Two rejections stop it. The moment the second approval lands, the money is sent.
 */
export async function approveRelease(user: Actor, releaseId: string, input: { approve: boolean; note?: string }) {
  if (user.role !== 'BOARD_MEMBER') throw new HttpError(403, 'Only a Trust Board member can approve a release');
  const { r, c } = await loadRelease(user, releaseId);
  if (hasConflict(user.id, c)) throw new HttpError(403, 'You are part of this agreement, so you cannot approve its release');
  if (!(await isBoardMemberFor(user.id, c.communityGroupId))) throw new HttpError(403, "You are not on this community's Trust Board");
  if (r.status !== 'AWAITING_APPROVALS') throw new HttpError(409, 'This release is not waiting for approval');
  if (!input.approve && (input.note ?? '').trim().length < 3) throw new HttpError(400, 'Say why you are not approving');
  try {
    await prisma.releaseApproval.create({ data: { releaseId: r.id, approverId: user.id, approve: input.approve, note: input.note?.trim() ?? null } });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'You have already voted on this release');
    throw e;
  }
  await audit(user.id, input.approve ? 'RELEASE_APPROVED_BY' : 'RELEASE_REJECTED_BY', 'SettlementRelease', r.id, { note: input.note ?? null });
  const votes = await prisma.releaseApproval.findMany({ where: { releaseId: r.id } });
  const outcome = decide(votes, r.approvalsRequired, decisions.settlement.rejectionsToStop);
  if (outcome === 'REJECTED') {
    const done = await prisma.settlementRelease.updateMany({ where: { id: r.id, status: 'AWAITING_APPROVALS' }, data: { status: 'REJECTED' } });
    if (done.count > 0) {
      await audit(null, 'RELEASE_REJECTED', 'SettlementRelease', r.id, { from: 'AWAITING_APPROVALS', to: 'REJECTED' });
      const apprentice = await prisma.user.findUnique({ where: { id: c.apprenticeId } });
      const message = 'ÀJỌ: the Trust Board did not approve this release. Open the app to see why and to start again.';
      await safeSmsAndEmail(apprentice?.phoneNumber, apprentice?.email, 'Settlement Fund release was not approved', message);
    }
    return { status: 'REJECTED' as const };
  }
  if (outcome === 'APPROVED') return { status: 'DISBURSING' as const, ...(await executeRelease(r.id, user.id)) };
  return { status: 'AWAITING_APPROVALS' as const, approvals: votes.filter((v) => v.approve).length, required: r.approvalsRequired };
}

/**
 * Sends the money. Guarded three ways against a double release: the claim that moves AWAITING_APPROVALS → DISBURSING can
 * succeed only once, the amount is whatever is confirmed in the fund right now minus anything already going out, and
 * the payment partner de-duplicates on our reference.
 */
export async function executeRelease(releaseId: string, actorId: string) {
  const r0 = await prisma.settlementRelease.findUniqueOrThrow({ where: { id: releaseId } });
  const claimed = await prisma.settlementRelease.updateMany({ where: { id: releaseId, status: 'AWAITING_APPROVALS' }, data: { status: 'DISBURSING' } });
  if (claimed.count === 0) throw new HttpError(409, 'This release is already being sent or has finished');
  const fund = await prisma.settlementFund.findUniqueOrThrow({ where: { id: r0.fundId } });
  const c = await prisma.apprenticeshipContract.findUniqueOrThrow({ where: { id: r0.contractId } });
  const revert = (reason: string) => prisma.settlementRelease.update({ where: { id: releaseId }, data: { status: 'AWAITING_APPROVALS', failureReason: reason.slice(0, 300) } });
  try {
    if (!r0.bankCode || !r0.accountNumber) throw new HttpError(409, 'No confirmed destination');
    const scope = { groupId: fund.groupId, purposeType: PURPOSE, purposeId: fund.id };
    const available = (await deriveTotals(scope)).balance - (await pendingOutKobo(scope));
    if (available <= 0n) throw new HttpError(409, 'There is no confirmed money left to release');
    const entry = await new MonnifyEscrowProvider().release({
      ...scope, actorId, recipientUserId: c.apprenticeId, amountKobo: available, note: r0.destinationNote ?? `Settlement Fund release to ${r0.destinationKind?.toLowerCase()}`,
      destination: { bankCode: r0.bankCode, accountNumber: r0.accountNumber, accountName: r0.accountName ?? undefined },
    });
    // The hook may already have finished it (an immediate success): only fill in what is still pending.
    await prisma.settlementRelease.updateMany({ where: { id: releaseId, status: 'DISBURSING' }, data: { amountKobo: available, fundsEntryId: entry.id } });
    await audit(actorId, 'RELEASE_DISBURSEMENT_STARTED', 'SettlementRelease', releaseId, { amountKobo: available.toString(), from: 'AWAITING_APPROVALS', to: 'DISBURSING' });
    return { amount: koboToNaira(available), entryId: entry.id };
  } catch (e) {
    // Nothing was sent: put it back so someone can try again once the cause is fixed.
    await revert((e as Error).message);
    throw e;
  }
}

/** Anyone on the board (not conflicted) or an admin can re-run an approved release that could not start, for example while escrow was gated. */
export async function retryRelease(user: Actor, releaseId: string) {
  if (user.role !== 'BOARD_MEMBER' && user.role !== 'ADMIN') throw new HttpError(403, 'Only the Trust Board or an admin can retry a release');
  const { r, c } = await loadRelease(user, releaseId);
  if (hasConflict(user.id, c)) throw new HttpError(403, 'You are part of this agreement');
  if (user.role === 'BOARD_MEMBER' && !(await isBoardMemberFor(user.id, c.communityGroupId))) throw new HttpError(403, "You are not on this community's Trust Board");
  if (r.status !== 'AWAITING_APPROVALS') throw new HttpError(409, 'Nothing to retry');
  const votes = await prisma.releaseApproval.findMany({ where: { releaseId } });
  if (decide(votes, r.approvalsRequired, decisions.settlement.rejectionsToStop) !== 'APPROVED') throw new HttpError(409, 'The release has not been approved yet');
  return executeRelease(releaseId, user.id);
}

/**
 * Called when Monnify reports the disbursement. Success completes the release, marks the fund RELEASED and graduates
 * the apprentice, once. Failure marks the release FAILED and leaves the money in the fund.
 */
export async function onDisbursementSettled(entry: Pick<FundsEntry, 'id' | 'purposeId' | 'amountKobo'>, ok: boolean, reason?: string) {
  const r = await prisma.settlementRelease.findFirst({ where: { fundId: entry.purposeId, status: 'DISBURSING' } });
  if (!r) return false;
  const claimed = await prisma.settlementRelease.updateMany({ where: { id: r.id, status: 'DISBURSING' }, data: ok ? { status: 'RELEASED', fundsEntryId: entry.id, amountKobo: entry.amountKobo } : { status: 'FAILED', failureReason: (reason ?? 'The payment could not be completed').slice(0, 300) } });
  if (claimed.count === 0) return false;
  const c = await prisma.apprenticeshipContract.findUniqueOrThrow({ where: { id: r.contractId } });
  const parties = await prisma.user.findMany({ where: { id: { in: [c.masterId, c.apprenticeId, c.guarantorId] } } });
  if (ok) {
    await prisma.settlementFund.updateMany({ where: { id: r.fundId, status: 'READY_FOR_RELEASE' }, data: { status: 'RELEASED', releasedAt: new Date() } });
    await prisma.apprenticeshipContract.updateMany({ where: { id: c.id, status: 'COMPLETED_PENDING_SETTLEMENT' }, data: { status: 'GRADUATED' } });
    await audit(null, 'RELEASE_COMPLETED', 'SettlementRelease', r.id, { from: 'DISBURSING', to: 'RELEASED', amountKobo: entry.amountKobo.toString(), contract: 'GRADUATED' });
    const message = `ÀJỌ: ₦${koboToNaira(entry.amountKobo)} from the Settlement Fund has been sent. Congratulations to the graduate!`;
    for (const p of parties) await safeSmsAndEmail(p.phoneNumber, p.email, 'Settlement Fund released', message);
  } else {
    await audit(null, 'RELEASE_FAILED', 'SettlementRelease', r.id, { reason: reason ?? null });
    await notifyBoard(`ÀJỌ: a Settlement Fund release FAILED: ${(reason ?? 'unknown reason').slice(0, 100)}. The money is still in the fund. A new release can be started.`, c.communityGroupId);
  }
  emitContractChanged(c.id);
  return true;
}

export async function cancelRelease(user: Actor, releaseId: string) {
  const { r, role } = await loadRelease(user, releaseId);
  if (role !== 'APPRENTICE' && role !== 'MASTER' && !isOversight(user)) throw new HttpError(403, 'Only the master, the graduate, an admin or the Trust Board can cancel a release');
  if (!isActiveRelease(r.status) || r.status === 'DISBURSING') throw new HttpError(409, 'This release can no longer be cancelled');
  const done = await prisma.settlementRelease.updateMany({ where: { id: r.id, status: { in: ['AWAITING_DESTINATION', 'AWAITING_CONFIRMATION', 'AWAITING_APPROVALS'] } }, data: { status: 'CANCELLED' } });
  if (done.count === 0) throw new HttpError(409, 'This release just changed');
  await audit(user.id, 'RELEASE_CANCELLED', 'SettlementRelease', r.id, { from: r.status, to: 'CANCELLED' });
}

export async function currentRelease(user: Actor, contractId: string) {
  await loadForUser(user, contractId);
  const fund = await fundOf(contractId);
  const r = await prisma.settlementRelease.findFirst({ where: { fundId: fund.id }, orderBy: { createdAt: 'desc' } });
  if (!r) return null;
  const votes = await prisma.releaseApproval.findMany({ where: { releaseId: r.id } });
  return presentRelease(r, votes);
}

export const presentRelease = (r: SettlementRelease, votes: { approverId: string; approve: boolean; note: string | null }[]) => ({
  id: r.id, status: r.status, destinationKind: r.destinationKind, bankCode: r.bankCode, accountNumber: r.accountNumber ? `••••••${r.accountNumber.slice(-4)}` : null, accountName: r.accountName, nameMismatch: r.nameMismatch,
  note: r.destinationNote, graduateConfirmed: !!r.graduateConfirmedAt, guardianConfirmed: !!r.guardianConfirmedAt, approvalsRequired: r.approvalsRequired,
  approvals: votes.filter((v) => v.approve).length, rejections: votes.filter((v) => !v.approve).length, amount: r.amountKobo == null ? null : koboToNaira(r.amountKobo), failureReason: r.failureReason,
});

/** For the Trust Board: releases waiting on a vote (never ones the viewer has a stake in), and missed contributions. */
export async function boardQueue(user: Actor) {
  if (!isOversight(user)) throw new HttpError(403, 'Only the Trust Board or an admin can see this');
  const scope = await groupIdsOverseenBy(user);
  const waiting = await prisma.settlementRelease.findMany({ where: { status: 'AWAITING_APPROVALS' }, orderBy: { createdAt: 'asc' }, take: 100 });
  const releases = [];
  for (const r of waiting) {
    const c = await prisma.apprenticeshipContract.findUnique({ where: { id: r.contractId } });
    // Only communities this member oversees, and never an agreement they are part of.
    if (!c || hasConflict(user.id, c) || (scope !== 'ALL' && !scope.includes(c.communityGroupId))) continue;
    const votes = await prisma.releaseApproval.findMany({ where: { releaseId: r.id } });
    releases.push({ ...presentRelease(r, votes), contractId: r.contractId, iVoted: votes.some((v) => v.approverId === user.id) });
  }
  const missed = await prisma.contributionDue.findMany({ where: { flaggedAt: { not: null } }, orderBy: { dueDate: 'asc' }, take: 200 });
  return { releases, missedContributions: missed.map((d) => ({ contractId: d.contractId, number: d.number, dueDate: d.dueDate, amount: koboToNaira(d.amountKobo), flaggedAt: d.flaggedAt })) };
}

// ── Statements ──────────────────────────────────────────────────────────────

export async function statement(user: Actor, contractId: string, now = new Date()) {
  const { c } = await loadForUser(user, contractId);
  const fund = await fundOf(contractId);
  const { states, totals } = await duesFor(fund, c.masterId, now);
  const release = await currentRelease(user, contractId);
  const planned = c.monthlyContributionKobo * BigInt(c.durationMonths);
  return {
    contractId, fundId: fund.id, fundStatus: fund.status, contractStatus: c.status,
    // Only what was paid in. There is no interest, yield or projected return anywhere in this product.
    totals: {
      masterContributions: koboToNaira(totals.masterConfirmed), communityMatch: koboToNaira(totals.communityMatch), contributionsTotal: koboToNaira(totals.contributionsTotal),
      pending: koboToNaira(totals.pendingKobo), released: koboToNaira(totals.releasesKobo), refunded: koboToNaira(totals.refundsKobo), balance: koboToNaira(totals.balanceKobo),
      plannedContributions: koboToNaira(planned), stillPlanned: koboToNaira(planned - totals.masterConfirmed > 0n ? planned - totals.masterConfirmed : 0n), owedSoFar: koboToNaira(owedSoFar(states, now)),
    },
    dues: states.map((s) => ({ number: s.number, dueDate: s.dueDate.toISOString().slice(0, 10), amount: koboToNaira(s.amountKobo), paid: koboToNaira(s.paidKobo), remaining: koboToNaira(s.remainingKobo), status: s.status })),
    release,
  };
}

export async function statementCsv(user: Actor, contractId: string) {
  const s = await statement(user, contractId);
  const { c } = await loadForUser(user, contractId);
  const fund = await fundOf(contractId);
  const entries = await prisma.fundsEntry.findMany({ where: { purposeType: PURPOSE, purposeId: fund.id, status: 'CONFIRMED' }, orderBy: { createdAt: 'asc' } });
  const names = await prisma.user.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.payerUserId))] } }, select: { id: true, fullName: true } });
  return toCsv([
    ['Settlement Fund statement', contractId], ['Fund status', s.fundStatus], [],
    ['Month', 'Due date', 'Amount (NGN)', 'Paid (NGN)', 'Remaining (NGN)', 'Status'], ...s.dues.map((d) => [d.number, d.dueDate, d.amount, d.paid, d.remaining, d.status]), [],
    ['Date', 'Type', 'From', 'Amount (NGN)', 'Source'],
    ...entries.map((e) => [e.createdAt.toISOString().slice(0, 10), e.type, names.find((n) => n.id === e.payerUserId)?.fullName ?? '—', koboToNaira(e.amountKobo), e.payerUserId === c.masterId ? 'Master' : 'Community match']), [],
    ['Master contributions', s.totals.masterContributions], ['Community match', s.totals.communityMatch], ['Released', s.totals.released], ['Balance', s.totals.balance],
  ]);
}

export type { ContributionDue };
