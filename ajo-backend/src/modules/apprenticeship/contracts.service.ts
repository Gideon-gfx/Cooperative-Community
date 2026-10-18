import { ApprenticeshipContract, ConductCategory, ContractMilestone, ContractSignature, MilestoneStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { koboToNaira, nairaToKobo } from '../../lib/kobo';
import { safeSms } from '../../lib/notify';
import { normalizePhone } from '../../lib/phone';
import { addMonthsUtc } from '../billing/billing.logic';
import { createDues, shiftDues } from '../settlement/settlement.dues';
import { boardMemberIdsFor } from '../trust/board';
import { emitContractChanged } from './contract.events';
import {
  addDays, categoryAllowed, canMove, dueDateFor, daysBetween, defaultMilestones, distinctParties, graduationEligible, isMinor, MILESTONE_NEXT, missingRoles, ratedPartyFor, roleOf, TENURE_MONTHS, tenureOf, TERMINAL,
} from './contracts.logic';

type Actor = { id: string; role: string };
type Full = ApprenticeshipContract & { signatures: ContractSignature[]; milestones: ContractMilestone[] };
const isOversight = (u: Actor) => u.role === 'ADMIN' || u.role === 'BOARD_MEMBER';

// ── Trade masters ───────────────────────────────────────────────────────────

export async function applyAsMaster(user: Actor, tradeCategories: string[]) {
  const cats = [...new Set(tradeCategories.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  if (!cats.length) throw new HttpError(400, 'Say which trade you teach');
  const existing = await prisma.tradeMasterProfile.findUnique({ where: { userId: user.id } });
  if (existing?.status === 'APPROVED') throw new HttpError(409, 'You are already an approved trade master');
  const profile = await prisma.tradeMasterProfile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, tradeCategories: cats, status: 'PENDING', decidedById: null, decidedAt: null, decisionNote: null },
    update: { tradeCategories: cats, status: 'PENDING', decidedById: null, decidedAt: null, decisionNote: null },
  });
  await audit(user.id, 'MASTER_APPLIED', 'TradeMasterProfile', profile.id, { cats });
  return profile;
}

/** An admin or a Trust Board member approves. They cannot approve themselves. */
export async function decideMaster(actor: Actor, userId: string, approve: boolean, note?: string) {
  if (!isOversight(actor)) throw new HttpError(403, 'Only an admin or a Trust Board member can decide this');
  if (actor.id === userId) throw new HttpError(403, 'You cannot approve yourself');
  const p = await prisma.tradeMasterProfile.findUnique({ where: { userId } });
  if (!p) throw new HttpError(404, 'No application found');
  if (!approve && (note ?? '').trim().length < 3) throw new HttpError(400, 'Say why');
  const done = await prisma.tradeMasterProfile.updateMany({ where: { userId, status: 'PENDING' }, data: { status: approve ? 'APPROVED' : 'REJECTED', decidedById: actor.id, decidedAt: new Date(), decisionNote: note ?? null } });
  if (done.count === 0) throw new HttpError(409, 'This application was already decided');
  // The role label is set when it will not demote anyone: a collector who also teaches keeps being a collector.
  if (approve) await prisma.user.updateMany({ where: { id: userId, role: 'MEMBER' }, data: { role: 'TRADE_MASTER' } });
  await audit(actor.id, approve ? 'MASTER_APPROVED' : 'MASTER_REJECTED', 'TradeMasterProfile', p.id, { userId, note: note ?? null });
  const u = await prisma.user.findUnique({ where: { id: userId } });
  await safeSms(u?.phoneNumber, approve ? 'ÀJỌ: you are approved as a trade master. You can now start an apprenticeship agreement.' : `ÀJỌ: your trade master application was not approved: ${note}`);
  return prisma.tradeMasterProfile.findUniqueOrThrow({ where: { userId } });
}

export async function pendingMasters(actor: Actor) {
  if (!isOversight(actor)) throw new HttpError(403, 'Only an admin or a Trust Board member can see this');
  const rows = await prisma.tradeMasterProfile.findMany({ where: { status: 'PENDING' }, orderBy: { appliedAt: 'asc' } });
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, fullName: true } });
  return rows.map((r) => ({ userId: r.userId, name: users.find((u) => u.id === r.userId)?.fullName ?? '—', tradeCategories: r.tradeCategories, appliedAt: r.appliedAt }));
}

/** A person sets their own date of birth once. It is used only to decide whether a guardian must sign, and is never shown in any contract view. */
export async function setMyDateOfBirth(userId: string, dob: Date) {
  const age = (Date.now() - dob.getTime()) / (365.25 * 86_400_000);
  if (!(age >= 8 && age <= 110)) throw new HttpError(400, 'That date of birth does not look right');
  // MongoDB: a field that was never written is not "null" to Prisma, so both cases are matched.
  const done = await prisma.user.updateMany({ where: { id: userId, OR: [{ dateOfBirth: null }, { dateOfBirth: { isSet: false } }] }, data: { dateOfBirth: dob } });
  if (done.count === 0) throw new HttpError(409, 'Your date of birth is already set. Ask an admin to correct it.');
  await audit(userId, 'DOB_SET', 'User', userId);
}

// ── Creating a contract ─────────────────────────────────────────────────────

async function personByPhone(phone: string, country: string, label: string) {
  const p = normalizePhone(phone, country);
  if (!p) throw new HttpError(400, `The ${label}'s phone number is not valid`);
  const u = await prisma.user.findFirst({ where: { phoneNumber: p } });
  if (!u) throw new HttpError(404, `PERSON_NOT_FOUND: the ${label} must sign up to CC-ÀJỌ first`);
  return u;
}

async function assertMember(groupId: string, userId: string, label: string) {
  if ((await prisma.groupMember.count({ where: { groupId, userId } })) === 0) throw new HttpError(403, `The ${label} must be a member of the group`);
}

export interface CreateContractInput {
  groupId: string;
  tradeCategory: string;
  durationMonths: number;
  monthlyContribution: string | number;
  targetSettlement: string | number;
  monthlyStipend?: string | number;
  termsAndConditions: string;
  apprenticePhone: string;
  guarantorPhone: string;
  guardianPhone?: string;
  milestones?: { title: string; description?: string; dueMonth: number }[];
}

/** The master is always the person asking: never an id from the request body. */
export async function createContract(master: Actor, input: CreateContractInput) {
  const profile = await prisma.tradeMasterProfile.findUnique({ where: { userId: master.id } });
  if (!profile || profile.status !== 'APPROVED') throw new HttpError(403, 'You must be an approved trade master to start an apprenticeship agreement');
  const trade = input.tradeCategory.trim().toLowerCase();
  if (!profile.tradeCategories.includes(trade)) throw new HttpError(403, `You are not approved to teach "${input.tradeCategory}"`);

  const tenure = tenureOf(input.durationMonths);
  if (!tenure) throw new HttpError(400, 'The agreement must run for 6, 9, 12, 18 or 24 months');

  const group = await prisma.communityGroup.findUnique({ where: { id: input.groupId } });
  if (!group) throw new HttpError(404, 'Group not found');
  // The Settlement Fund is held in escrow, so a collector-custody group cannot host an apprenticeship.
  if (group.fundsMode !== 'ESCROW') throw new HttpError(409, 'ESCROW_ONLY: apprenticeship agreements need a group that uses escrow. Collector custody cannot hold a Settlement Fund.');
  await assertMember(group.id, master.id, 'master');

  const apprentice = await personByPhone(input.apprenticePhone, group.country, 'apprentice');
  const guarantor = await personByPhone(input.guarantorPhone, group.country, 'guarantor');
  await assertMember(group.id, guarantor.id, 'guarantor');

  if (!apprentice.dateOfBirth) throw new HttpError(409, 'DOB_REQUIRED: the apprentice must add their date of birth in the app so we know whether a parent or guardian must sign');
  const minor = isMinor(apprentice.dateOfBirth);
  let guardianId: string | null = null;
  if (input.guardianPhone) guardianId = (await personByPhone(input.guardianPhone, group.country, 'parent or guardian')).id;
  if (minor && !guardianId) throw new HttpError(409, 'GUARDIAN_REQUIRED: the apprentice is under 18, so a parent or guardian must be named and must sign');
  if (guardianId) {
    const g = await prisma.user.findUnique({ where: { id: guardianId } });
    if (g?.dateOfBirth && isMinor(g.dateOfBirth)) throw new HttpError(409, 'The parent or guardian must be an adult');
  }
  // Three (or four) different people: nobody signs for themselves in two roles.
  if (!distinctParties([master.id, apprentice.id, guarantor.id, guardianId])) throw new HttpError(409, 'The master, apprentice, guarantor and guardian must all be different people');
  // A guarantor is someone the community vouches for: the Trust Board (or an admin) has verified them.
  const gr = await prisma.guarantorRecord.findUnique({ where: { userId: guarantor.id } });
  if (!gr?.verifiedAt) throw new HttpError(409, 'GUARANTOR_NOT_VERIFIED: the guarantor must first be verified by the Trust Board');

  const monthly = nairaToKobo(input.monthlyContribution);
  const target = nairaToKobo(input.targetSettlement);
  const stipend = input.monthlyStipend === undefined ? null : nairaToKobo(input.monthlyStipend);
  if (input.termsAndConditions.trim().length < 30) throw new HttpError(400, 'Write the terms of the agreement (what each side agrees to)');
  for (const m of input.milestones ?? []) if (m.dueMonth < 1 || m.dueMonth > input.durationMonths) throw new HttpError(400, `A milestone is due in month ${m.dueMonth}, outside the ${input.durationMonths}-month agreement`);

  const contract = await prisma.apprenticeshipContract.create({
    data: {
      masterId: master.id, apprenticeId: apprentice.id, guarantorId: guarantor.id, guardianId, minorApprentice: minor, communityGroupId: group.id, tradeCategory: trade, tenure, durationMonths: input.durationMonths,
      status: 'DRAFT', startDate: null, endDate: null, monthlyContributionKobo: monthly, targetSettlementKobo: target, monthlyStipendKobo: stipend, termsAndConditions: input.termsAndConditions.trim(),
      pausedAt: null, statusReason: null, statusChangedById: null,
      ...(input.milestones?.length ? { milestones: { create: input.milestones.map((m, i) => ({ order: i + 1, title: m.title.trim(), description: m.description?.trim() ?? null, dueMonth: m.dueMonth, dueDate: null })) } } : {}),
    },
  });
  await audit(master.id, 'CONTRACT_CREATED', 'ApprenticeshipContract', contract.id, { tenure, groupId: group.id, minor });
  return contract;
}

async function loadFull(id: string): Promise<Full> {
  const c = await prisma.apprenticeshipContract.findUnique({ where: { id }, include: { signatures: true, milestones: { orderBy: { order: 'asc' } } } });
  if (!c) throw new HttpError(404, 'Agreement not found');
  return c as Full;
}

/** Everything about a contract is private to its parties, plus admins and the Trust Board. */
async function loadForUser(user: Actor, id: string) {
  const c = await loadFull(id);
  const role = roleOf(c, user.id);
  if (!role && !isOversight(user)) throw new HttpError(404, 'Agreement not found');
  return { c, role };
}

export async function editDraft(user: Actor, id: string, patch: Partial<{ termsAndConditions: string; monthlyContribution: string | number; targetSettlement: string | number; monthlyStipend: string | number | null }>) {
  const { c, role } = await loadForUser(user, id);
  if (role !== 'MASTER') throw new HttpError(403, 'Only the master can change the draft');
  if (c.status !== 'DRAFT') throw new HttpError(409, 'Only a draft can be changed. Once it is sent for signatures it is fixed.');
  const data: Record<string, unknown> = {};
  if (patch.termsAndConditions !== undefined) { if (patch.termsAndConditions.trim().length < 30) throw new HttpError(400, 'The terms are too short'); data.termsAndConditions = patch.termsAndConditions.trim(); }
  if (patch.monthlyContribution !== undefined) data.monthlyContributionKobo = nairaToKobo(patch.monthlyContribution);
  if (patch.targetSettlement !== undefined) data.targetSettlementKobo = nairaToKobo(patch.targetSettlement);
  if (patch.monthlyStipend !== undefined) data.monthlyStipendKobo = patch.monthlyStipend === null ? null : nairaToKobo(patch.monthlyStipend);
  return prisma.apprenticeshipContract.update({ where: { id }, data });
}

async function namesOf(ids: (string | null)[]) {
  const users = await prisma.user.findMany({ where: { id: { in: ids.filter((x): x is string => !!x) } }, select: { id: true, fullName: true, phoneNumber: true } });
  return (id: string | null) => users.find((u) => u.id === id);
}

async function notifyParties(c: ApprenticeshipContract, message: string, except?: string) {
  const ids = [c.masterId, c.apprenticeId, c.guarantorId, c.guardianId].filter((x): x is string => !!x && x !== except);
  const users = await prisma.user.findMany({ where: { id: { in: ids } } });
  for (const u of users) await safeSms(u.phoneNumber, message);
}
/** Tells the Trust Board of THIS community (or the platform-wide board if the group has none). */
async function notifyBoard(message: string, groupId?: string | null) {
  const ids = await boardMemberIdsFor(groupId);
  const board = await prisma.user.findMany({ where: { id: { in: ids } } });
  for (const b of board) await safeSms(b.phoneNumber, message);
}

/** The master sends the finished draft to everyone to read and sign. */
export async function submitForSignatures(user: Actor, id: string) {
  const { c, role } = await loadForUser(user, id);
  if (role !== 'MASTER') throw new HttpError(403, 'Only the master can send it for signatures');
  const apprentice = await prisma.user.findUniqueOrThrow({ where: { id: c.apprenticeId } });
  // Age is re-checked now: a birthday while drafting changes who must sign.
  const minor = apprentice.dateOfBirth ? isMinor(apprentice.dateOfBirth) : c.minorApprentice;
  if (minor && !c.guardianId) throw new HttpError(409, 'GUARDIAN_REQUIRED: the apprentice is under 18, so a parent or guardian must be named');
  const done = await prisma.apprenticeshipContract.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'PENDING_SIGNATURES', minorApprentice: minor } });
  if (done.count === 0) throw new HttpError(409, 'This agreement has already been sent');
  await audit(user.id, 'CONTRACT_SENT_FOR_SIGNATURES', 'ApprenticeshipContract', id);
  const master = await prisma.user.findUniqueOrThrow({ where: { id: c.masterId } });
  await notifyParties(c, `ÀJỌ: ${master.fullName} has prepared an apprenticeship agreement for you. Open the app to read it and sign.`, c.masterId);
  return loadFull(id);
}

// ── Signing and activation ──────────────────────────────────────────────────

export interface SignInput { typedName: string; signatureImageUrl: string }

/**
 * Only the person named for a role can sign for it, once. The contract starts only when EVERY required role has signed:
 * checked as a set of roles, so three signatures from the wrong people can never start it.
 */
export async function signContract(user: Actor, id: string, input: SignInput, ctx: { ipAddress: string; userAgent: string }) {
  const { c, role } = await loadForUser(user, id);
  if (!role) throw new HttpError(403, 'You are not a party to this agreement');
  if (c.status !== 'PENDING_SIGNATURES') throw new HttpError(409, c.status === 'DRAFT' ? 'The master has not sent this for signatures yet' : 'This agreement is not waiting for signatures');
  if (input.typedName.trim().length < 2) throw new HttpError(400, 'Type your full name');
  try {
    await prisma.contractSignature.create({ data: { contractId: id, signerRole: role, userId: user.id, typedName: input.typedName.trim(), signatureImageUrl: input.signatureImageUrl, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent.slice(0, 300) } });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'You have already signed this agreement');
    throw e;
  }
  await audit(user.id, 'CONTRACT_SIGNED', 'ApprenticeshipContract', id, { role });
  const activation = await tryActivate(id);
  return { role, ...activation };
}

export type Activation = { activated: boolean; blockedReason?: 'WAITING_FOR_SIGNATURES' | 'ESCROW_ONLY' | 'GUARDIAN_REQUIRED'; waitingFor?: string[] };

/** Starts the contract if everyone has signed and the group still uses escrow. Safe to call repeatedly. */
export async function tryActivate(id: string, now = new Date()): Promise<Activation> {
  const c = await loadFull(id);
  if (c.status === 'ACTIVE') return { activated: true };
  if (c.status !== 'PENDING_SIGNATURES') return { activated: false, blockedReason: 'WAITING_FOR_SIGNATURES' };

  const apprentice = await prisma.user.findUniqueOrThrow({ where: { id: c.apprenticeId } });
  const minor = apprentice.dateOfBirth ? isMinor(apprentice.dateOfBirth, now) : c.minorApprentice;
  if (minor && !c.guardianId) return { activated: false, blockedReason: 'GUARDIAN_REQUIRED' };
  const missing = missingRoles({ guardianId: c.guardianId, minorApprentice: minor }, c.signatures.map((s) => s.signerRole));
  if (missing.length) return { activated: false, blockedReason: 'WAITING_FOR_SIGNATURES', waitingFor: missing };

  // The mode is checked again now: the group may have been switched while people were signing.
  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: c.communityGroupId } });
  if (group.fundsMode !== 'ESCROW') return { activated: false, blockedReason: 'ESCROW_ONLY' };

  const start = now;
  const end = addMonthsUtc(start, c.durationMonths);
  const activated = await prisma.$transaction(async (db) => {
    // The status claim makes a double call a no-op: milestones and the fund are only ever created once.
    const claimed = await db.apprenticeshipContract.updateMany({ where: { id, status: 'PENDING_SIGNATURES' }, data: { status: 'ACTIVE', startDate: start, endDate: end, minorApprentice: minor } });
    if (claimed.count === 0) return false;
    const existing = await db.contractMilestone.findMany({ where: { contractId: id }, orderBy: { order: 'asc' } });
    if (existing.length === 0) {
      for (const m of defaultMilestones(c.durationMonths)) await db.contractMilestone.create({ data: { contractId: id, order: m.order, title: m.title, description: m.description, dueMonth: m.dueMonth, dueDate: dueDateFor(start, m.dueMonth), status: 'NOT_STARTED' } });
    } else {
      for (const m of existing) await db.contractMilestone.update({ where: { id: m.id }, data: { dueDate: dueDateFor(start, m.dueMonth ?? c.durationMonths) } });
    }
    const fund = await db.settlementFund.create({ data: { contractId: id, groupId: c.communityGroupId, status: 'ACCUMULATING', releasedAt: null } });
    // One contribution due per month, paid by the master into the escrowed fund.
    await createDues(db, { contractId: id, fundId: fund.id, start, months: c.durationMonths, monthlyKobo: c.monthlyContributionKobo });
    return true;
  });
  if (!activated) return { activated: true };
  await audit(null, 'CONTRACT_ACTIVATED', 'ApprenticeshipContract', id, { start: start.toISOString(), end: end.toISOString() });
  emitContractChanged(id);
  await notifyParties(c, `ÀJỌ: everyone has signed. Your apprenticeship agreement is now active and runs until ${end.toISOString().slice(0, 10)}.`);
  return { activated: true };
}

// ── Milestones ──────────────────────────────────────────────────────────────

async function loadMilestone(user: Actor, milestoneId: string) {
  const m = await prisma.contractMilestone.findUnique({ where: { id: milestoneId } });
  if (!m) throw new HttpError(404, 'Milestone not found');
  const { c, role } = await loadForUser(user, m.contractId);
  return { m, c, role };
}
function assertMove(m: ContractMilestone, to: MilestoneStatus) {
  if (!canMove(m.status, to)) throw new HttpError(409, `A milestone that is ${m.status.toLowerCase().replace(/_/g, ' ')} cannot become ${to.toLowerCase().replace(/_/g, ' ')}. Allowed next: ${MILESTONE_NEXT[m.status].join(', ').toLowerCase().replace(/_/g, ' ') || 'nothing'}.`);
}

/** The apprentice starts working on a milestone (or goes back to it after a rejection). */
export async function startMilestone(user: Actor, milestoneId: string) {
  const { m, c, role } = await loadMilestone(user, milestoneId);
  if (role !== 'APPRENTICE') throw new HttpError(403, 'Only the apprentice can do this');
  if (c.status !== 'ACTIVE') throw new HttpError(409, 'The agreement is not active');
  assertMove(m, 'IN_PROGRESS');
  const done = await prisma.contractMilestone.updateMany({ where: { id: m.id, status: m.status }, data: { status: 'IN_PROGRESS' } });
  if (done.count === 0) throw new HttpError(409, 'Already changed');
  return prisma.contractMilestone.findUniqueOrThrow({ where: { id: m.id } });
}

export async function submitMilestone(user: Actor, milestoneId: string, input: { evidenceUrl?: string; note?: string }) {
  const { m, c, role } = await loadMilestone(user, milestoneId);
  if (role !== 'APPRENTICE') throw new HttpError(403, 'Only the apprentice can submit their work');
  if (c.status !== 'ACTIVE') throw new HttpError(409, 'The agreement is not active');
  assertMove(m, 'SUBMITTED_FOR_REVIEW');
  const done = await prisma.contractMilestone.updateMany({ where: { id: m.id, status: 'IN_PROGRESS' }, data: { status: 'SUBMITTED_FOR_REVIEW', evidenceUrl: input.evidenceUrl ?? null, submissionNote: input.note ?? null, submittedAt: new Date() } });
  if (done.count === 0) throw new HttpError(409, 'Already changed');
  const master = await prisma.user.findUnique({ where: { id: c.masterId } });
  await safeSms(master?.phoneNumber, `ÀJỌ: your apprentice has submitted "${m.title}" for your review.`);
  return prisma.contractMilestone.findUniqueOrThrow({ where: { id: m.id } });
}

/** Only the contract's own master reviews. A rejection needs a reason; an approval can award a skill badge. */
export async function reviewMilestone(user: Actor, milestoneId: string, input: { approve: boolean; note?: string; badgeSkill?: string }) {
  const { m, c, role } = await loadMilestone(user, milestoneId);
  if (role !== 'MASTER') throw new HttpError(403, 'Only the master of this agreement can review the work');
  if (c.status !== 'ACTIVE') throw new HttpError(409, 'The agreement is not active');
  const to: MilestoneStatus = input.approve ? 'APPROVED' : 'REJECTED';
  assertMove(m, to);
  if (!input.approve && (input.note ?? '').trim().length < 3) throw new HttpError(400, 'Tell the apprentice what to improve');
  const done = await prisma.contractMilestone.updateMany({ where: { id: m.id, status: 'SUBMITTED_FOR_REVIEW' }, data: { status: to, reviewedAt: new Date(), reviewedById: user.id, reviewNote: input.note ?? null } });
  if (done.count === 0) throw new HttpError(409, 'Already reviewed');
  if (input.approve && input.badgeSkill?.trim()) await prisma.earnedSkillBadge.create({ data: { contractId: c.id, milestoneId: m.id, apprenticeId: c.apprenticeId, skill: input.badgeSkill.trim(), awardedById: user.id } });
  await audit(user.id, input.approve ? 'MILESTONE_APPROVED' : 'MILESTONE_REJECTED', 'ContractMilestone', m.id, { note: input.note ?? null });
  const apprentice = await prisma.user.findUnique({ where: { id: c.apprenticeId } });
  await safeSms(apprentice?.phoneNumber, input.approve ? `ÀJỌ: your master approved "${m.title}". Well done!` : `ÀJỌ: your master asked you to improve "${m.title}": ${input.note}`);
  if (input.approve) await refreshCompletion(c.id);
  emitContractChanged(c.id);
  return prisma.contractMilestone.findUniqueOrThrow({ where: { id: m.id } });
}

/** When every milestone is approved the agreement is ready for settlement. With no milestones it can never be. */
export async function refreshCompletion(id: string) {
  const c = await loadFull(id);
  if (c.status !== 'ACTIVE' || !graduationEligible(c.milestones)) return false;
  const done = await prisma.apprenticeshipContract.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'COMPLETED_PENDING_SETTLEMENT' } });
  if (done.count === 0) return false;
  await audit(null, 'CONTRACT_COMPLETED', 'ApprenticeshipContract', id);
  emitContractChanged(id);
  await notifyParties(c, 'ÀJỌ: every milestone is approved. The Settlement Fund is now ready for the release steps.');
  return true;
}

// ── Conduct ─────────────────────────────────────────────────────────────────

/** A master rates the apprentice; the apprentice rates the master. Nobody can grade themselves, and nobody else can rate. */
export async function logConduct(user: Actor, id: string, input: { category: ConductCategory; rating: number; note?: string }) {
  const { c, role } = await loadForUser(user, id);
  const about = role ? ratedPartyFor(role) : null;
  if (!role || !about) throw new HttpError(403, 'Only the master and the apprentice can log conduct');
  if (c.status !== 'ACTIVE' && c.status !== 'PAUSED') throw new HttpError(409, 'Conduct can only be logged while the agreement is running');
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new HttpError(400, 'The rating is 1 to 5');
  if (!categoryAllowed(about, input.category)) throw new HttpError(400, `"${input.category.toLowerCase().replace(/_/g, ' ')}" is not something you can rate ${about === 'MASTER' ? 'a master' : 'an apprentice'} on`);
  const log = await prisma.conductLog.create({ data: { contractId: id, authorId: user.id, ratedParty: about, category: input.category, rating: input.rating, note: input.note?.trim() || null } });
  await audit(user.id, 'CONDUCT_LOGGED', 'ConductLog', log.id, { about, category: input.category, rating: input.rating });
  emitContractChanged(id);
  return log;
}

// ── Pause, resume, terminate ────────────────────────────────────────────────

function assertReason(reason: string) { if (reason.trim().length < 5) throw new HttpError(400, 'Give a reason (at least a short sentence)'); }

export async function pauseContract(user: Actor, id: string, reason: string, now = new Date()) {
  const { c, role } = await loadForUser(user, id);
  if (role !== 'MASTER' && !isOversight(user)) throw new HttpError(403, 'Only the master, an admin or the Trust Board can pause an agreement');
  assertReason(reason);
  const done = await prisma.apprenticeshipContract.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'PAUSED', pausedAt: now, statusReason: reason.trim(), statusChangedById: user.id } });
  if (done.count === 0) throw new HttpError(409, 'Only an active agreement can be paused');
  await audit(user.id, 'CONTRACT_PAUSED', 'ApprenticeshipContract', id, { reason });
  await notifyParties(c, `ÀJỌ: the apprenticeship agreement was paused: ${reason.trim()}`);
  await notifyBoard(`ÀJỌ: an apprenticeship agreement was paused: ${reason.trim().slice(0, 100)}`, c.communityGroupId);
  emitContractChanged(id);
  return loadFull(id);
}

/** Resuming pushes the end date and every unfinished milestone back by the days it was paused. */
export async function resumeContract(user: Actor, id: string, now = new Date()) {
  const { c, role } = await loadForUser(user, id);
  if (role !== 'MASTER' && !isOversight(user)) throw new HttpError(403, 'Only the master, an admin or the Trust Board can resume an agreement');
  if (c.status !== 'PAUSED' || !c.pausedAt || !c.endDate) throw new HttpError(409, 'This agreement is not paused');
  const days = daysBetween(c.pausedAt, now);
  const done = await prisma.apprenticeshipContract.updateMany({ where: { id, status: 'PAUSED' }, data: { status: 'ACTIVE', pausedAt: null, pausedDays: c.pausedDays + days, endDate: addDays(c.endDate, days), statusReason: null, statusChangedById: user.id } });
  if (done.count === 0) throw new HttpError(409, 'Already resumed');
  for (const m of c.milestones.filter((x) => x.status !== 'APPROVED' && x.dueDate)) await prisma.contractMilestone.update({ where: { id: m.id }, data: { dueDate: addDays(m.dueDate!, days) } });
  await shiftDues(id, c.pausedAt, days);
  await audit(user.id, 'CONTRACT_RESUMED', 'ApprenticeshipContract', id, { pausedDays: days });
  await notifyParties(c, `ÀJỌ: the apprenticeship agreement has resumed. Its end date moved by ${days} day${days === 1 ? '' : 's'}.`);
  return loadFull(id);
}

/** Ends an agreement for good. The Settlement Fund goes to forfeit review: nothing is paid out automatically. */
export async function terminateContract(user: Actor, id: string, reason: string) {
  const { c, role } = await loadForUser(user, id);
  if (role !== 'MASTER' && role !== 'APPRENTICE' && !isOversight(user)) throw new HttpError(403, 'Only the master, the apprentice, an admin or the Trust Board can end an agreement');
  assertReason(reason);
  if (TERMINAL.includes(c.status)) throw new HttpError(409, 'This agreement has already ended');
  const started = c.status === 'ACTIVE' || c.status === 'PAUSED' || c.status === 'COMPLETED_PENDING_SETTLEMENT';
  const done = await prisma.apprenticeshipContract.updateMany({ where: { id, status: c.status }, data: { status: 'TERMINATED', statusReason: reason.trim(), statusChangedById: user.id, pausedAt: null } });
  if (done.count === 0) throw new HttpError(409, 'This agreement just changed. Please look again.');
  if (started) await prisma.settlementFund.updateMany({ where: { contractId: id, status: 'ACCUMULATING' }, data: { status: 'FORFEIT_REVIEW' } });
  await audit(user.id, 'CONTRACT_TERMINATED', 'ApprenticeshipContract', id, { reason, byRole: role ?? 'OVERSIGHT' });
  await notifyParties(c, `ÀJỌ: the apprenticeship agreement has ended: ${reason.trim()}`, user.id);
  if (started) await notifyBoard(`ÀJỌ: an apprenticeship agreement was ended: ${reason.trim().slice(0, 100)}. The Settlement Fund needs a decision.`, c.communityGroupId);
  emitContractChanged(id);
  return loadFull(id);
}

// ── Views (never any date of birth) ─────────────────────────────────────────

const naira = (k: bigint | null) => (k === null ? null : koboToNaira(k));

export async function presentContract(c: Full, viewerId: string) {
  const who = await namesOf([c.masterId, c.apprenticeId, c.guarantorId, c.guardianId]);
  const party = (id: string | null) => (id ? { id, name: who(id)?.fullName ?? '—' } : null);
  const ids = viewerId ? roleOf(c, viewerId) : null;
  return {
    id: c.id, status: c.status, statusReason: c.statusReason, tradeCategory: c.tradeCategory, tenure: c.tenure, durationMonths: c.durationMonths, groupId: c.communityGroupId,
    startDate: c.startDate, endDate: c.endDate, pausedDays: c.pausedDays,
    monthlyContribution: naira(c.monthlyContributionKobo), targetSettlement: naira(c.targetSettlementKobo), monthlyStipend: naira(c.monthlyStipendKobo),
    // Principal only: no interest or projected return exists in this product.
    totalPlannedContributions: koboToNaira(c.monthlyContributionKobo * BigInt(c.durationMonths)),
    termsAndConditions: c.termsAndConditions, guardianRequired: !!c.guardianId,
    parties: { master: party(c.masterId), apprentice: party(c.apprenticeId), guarantor: party(c.guarantorId), guardian: party(c.guardianId) },
    myRole: ids,
    signatures: c.signatures.map((s) => ({ role: s.signerRole, typedName: s.typedName, signedAt: s.signedAt })),
    waitingFor: c.status === 'PENDING_SIGNATURES' ? missingRoles(c, c.signatures.map((s) => s.signerRole)) : [],
    milestones: c.milestones.map((m) => ({ id: m.id, order: m.order, title: m.title, description: m.description, dueDate: m.dueDate, status: m.status, submissionNote: m.submissionNote, evidenceUrl: m.evidenceUrl, reviewNote: m.reviewNote })),
  };
}

export async function getContract(user: Actor, id: string) {
  const { c } = await loadForUser(user, id);
  return presentContract(c, user.id);
}

export async function myContracts(user: Actor) {
  const rows = await prisma.apprenticeshipContract.findMany({
    where: { OR: [{ masterId: user.id }, { apprenticeId: user.id }, { guarantorId: user.id }, { guardianId: user.id }] }, orderBy: { createdAt: 'desc' }, take: 100,
    include: { signatures: true, milestones: { orderBy: { order: 'asc' } } },
  });
  return Promise.all(rows.map((c) => presentContract(c as Full, user.id)));
}

export async function conductFor(user: Actor, id: string) {
  const { c, role } = await loadForUser(user, id);
  const logs = await prisma.conductLog.findMany({ where: { contractId: c.id }, orderBy: { createdAt: 'desc' }, take: 200 });
  // Only the parties and oversight can open an agreement at all, so this is already private to them.
  void role;
  return logs.map((l) => ({ id: l.id, about: l.ratedParty, category: l.category, rating: l.rating, note: l.note, createdAt: l.createdAt, mine: l.authorId === user.id }));
}

export { loadForUser, loadFull, TENURE_MONTHS };
