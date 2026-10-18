import { TrustSubject } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { koboToNaira } from '../../lib/kobo';
import { safeSms } from '../../lib/notify';
import { normalizePhone } from '../../lib/phone';
import { contractEvents } from '../apprenticeship/contract.events';
import { cleanRecord, completedCycles } from '../payments/custody.service';
import { allocateDues } from '../settlement/settlement.logic';
import { boardMemberIdsFor, groupIdsOverseenBy, isBoardMemberFor } from './board';
import { computeTrust, isHonestyFlag, onTimeDues, publicView, ratingToPercent, ratio, type TrustInput } from './trust.logic';

type Actor = { id: string; role: string };
const isOversight = (u: Actor) => u.role === 'ADMIN' || u.role === 'BOARD_MEMBER';

// ── Boards (an admin makes them and approves each member) ───────────────────

export async function createBoard(admin: Actor, input: { name: string; community: string }) {
  if (admin.role !== 'ADMIN') throw new HttpError(403, 'Only an admin can create a Trust Board');
  const board = await prisma.trustBoard.create({ data: { name: input.name.trim(), community: input.community.trim(), createdById: admin.id } });
  await audit(admin.id, 'TRUST_BOARD_CREATED', 'TrustBoard', board.id, { community: board.community });
  return board;
}

export async function addBoardMember(admin: Actor, boardId: string, input: { phone: string; title: string }) {
  if (admin.role !== 'ADMIN') throw new HttpError(403, 'Only an admin can add a board member');
  const board = await prisma.trustBoard.findUnique({ where: { id: boardId } });
  if (!board) throw new HttpError(404, 'Board not found');
  const phone = normalizePhone(input.phone, 'NG');
  const user = phone ? await prisma.user.findFirst({ where: { phoneNumber: phone } }) : null;
  if (!user) throw new HttpError(404, 'That person must sign up to CC-ÀJỌ first');
  const m = await prisma.trustBoardMember.upsert({
    where: { boardId_userId: { boardId, userId: user.id } },
    create: { boardId, userId: user.id, title: input.title.trim(), status: 'PENDING', approvedById: null, approvedAt: null },
    update: { title: input.title.trim(), status: 'PENDING', approvedById: null, approvedAt: null },
  });
  await audit(admin.id, 'TRUST_BOARD_MEMBER_ADDED', 'TrustBoardMember', m.id, { boardId, userId: user.id });
  return m;
}

/** Approval is a separate act from adding, and an admin cannot approve themselves onto a board. */
export async function decideBoardMember(admin: Actor, memberId: string, approve: boolean) {
  if (admin.role !== 'ADMIN') throw new HttpError(403, 'Only an admin can approve a board member');
  const m = await prisma.trustBoardMember.findUnique({ where: { id: memberId } });
  if (!m) throw new HttpError(404, 'Member not found');
  if (m.userId === admin.id) throw new HttpError(403, 'You cannot approve yourself');
  const next = approve ? 'APPROVED' : 'REMOVED';
  await prisma.trustBoardMember.update({ where: { id: memberId }, data: { status: next, approvedById: approve ? admin.id : null, approvedAt: approve ? new Date() : null } });
  if (approve) await prisma.user.updateMany({ where: { id: m.userId, role: 'MEMBER' }, data: { role: 'BOARD_MEMBER' } });
  else if ((await prisma.trustBoardMember.count({ where: { userId: m.userId, status: 'APPROVED' } })) === 0) await prisma.user.updateMany({ where: { id: m.userId, role: 'BOARD_MEMBER' }, data: { role: 'MEMBER' } });
  await audit(admin.id, approve ? 'TRUST_BOARD_MEMBER_APPROVED' : 'TRUST_BOARD_MEMBER_REMOVED', 'TrustBoardMember', memberId);
  return prisma.trustBoardMember.findUniqueOrThrow({ where: { id: memberId } });
}

export async function assignGroupToBoard(admin: Actor, boardId: string, groupId: string) {
  if (admin.role !== 'ADMIN') throw new HttpError(403, 'Only an admin can do this');
  if (!(await prisma.trustBoard.findUnique({ where: { id: boardId } }))) throw new HttpError(404, 'Board not found');
  await prisma.communityGroup.update({ where: { id: groupId }, data: { trustBoardId: boardId } });
  await audit(admin.id, 'GROUP_ASSIGNED_TO_BOARD', 'CommunityGroup', groupId, { boardId });
}

export async function listBoards(user: Actor) {
  if (!isOversight(user)) throw new HttpError(403, 'Only an admin or a Trust Board member can see this');
  const boards = await prisma.trustBoard.findMany({ orderBy: { createdAt: 'asc' } });
  const members = await prisma.trustBoardMember.findMany({ where: { boardId: { in: boards.map((b) => b.id) } } });
  const users = await prisma.user.findMany({ where: { id: { in: members.map((m) => m.userId) } }, select: { id: true, fullName: true } });
  return boards.map((b) => ({ id: b.id, name: b.name, community: b.community, members: members.filter((m) => m.boardId === b.id).map((m) => ({ id: m.id, userId: m.userId, name: users.find((u) => u.id === m.userId)?.fullName ?? '—', title: m.title, status: m.status })) }));
}

/** Every group and the board that oversees it, so an admin can assign groups without copying ids. */
export async function listGroupsForAssignment(user: Actor) {
  if (user.role !== 'ADMIN') throw new HttpError(403, 'Only an admin can see this');
  const groups = await prisma.communityGroup.findMany({ select: { id: true, name: true, trustBoardId: true }, orderBy: { name: 'asc' }, take: 500 });
  return groups.map((g) => ({ id: g.id, name: g.name, boardId: g.trustBoardId ?? null }));
}

// ── Guarantors ──────────────────────────────────────────────────────────────

/** A guarantor must be verified by the board or an admin before they can co-sign: someone the community vouches for. */
export async function verifyGuarantor(actor: Actor, userId: string) {
  if (!isOversight(actor)) throw new HttpError(403, 'Only an admin or a Trust Board member can verify a guarantor');
  if (actor.id === userId) throw new HttpError(403, 'You cannot verify yourself');
  if (!(await prisma.user.findUnique({ where: { id: userId } }))) throw new HttpError(404, 'Person not found');
  const rec = await prisma.guarantorRecord.upsert({ where: { userId }, create: { userId, verifiedAt: new Date(), verifiedById: actor.id }, update: { verifiedAt: new Date(), verifiedById: actor.id } });
  await audit(actor.id, 'GUARANTOR_VERIFIED', 'GuarantorRecord', rec.id, { userId });
  return recomputeGuarantor(userId);
}

export async function isVerifiedGuarantor(userId: string): Promise<boolean> {
  const r = await prisma.guarantorRecord.findUnique({ where: { userId } });
  return !!r?.verifiedAt;
}

/** How the agreements a person has guaranteed turned out. Social record only: nothing is staked. */
export async function recomputeGuarantor(userId: string) {
  const cs = await prisma.apprenticeshipContract.findMany({ where: { guarantorId: userId } });
  const started = cs.filter((c) => !['DRAFT', 'PENDING_SIGNATURES'].includes(c.status) || c.startDate);
  const counts = { contractsGuaranteed: started.length, active: cs.filter((c) => c.status === 'ACTIVE' || c.status === 'PAUSED' || c.status === 'COMPLETED_PENDING_SETTLEMENT').length, completed: cs.filter((c) => c.status === 'GRADUATED').length, terminated: cs.filter((c) => c.status === 'TERMINATED' && c.startDate).length };
  return prisma.guarantorRecord.upsert({ where: { userId }, create: { userId, ...counts }, update: counts });
}

// ── Trust score (recomputed on events, cached in TrustScore) ────────────────

async function gather(userId: string, subject: TrustSubject): Promise<TrustInput> {
  const contracts = await prisma.apprenticeshipContract.findMany({ where: subject === 'APPRENTICE' ? { apprenticeId: userId } : { masterId: userId } });
  const started = contracts.filter((c) => c.startDate);
  const ids = started.map((c) => c.id);
  const logs = ids.length ? await prisma.conductLog.findMany({ where: { contractId: { in: ids }, excluded: false } }) : [];
  const contractOf = (id: string) => started.find((c) => c.id === id)!;
  // Defence in depth: only a master's words count about the apprentice and only an apprentice's about the master, so nobody grades themselves.
  const about = logs.filter((l) => (subject === 'APPRENTICE' ? l.ratedParty === 'APPRENTICE' && l.authorId === contractOf(l.contractId).masterId : l.ratedParty === 'MASTER' && l.authorId === contractOf(l.contractId).apprenticeId));
  const ratings = about.map((l) => l.rating);
  const honesty = about.filter((l) => isHonestyFlag(l.category, l.rating)).length;
  const graduated = started.filter((c) => c.status === 'GRADUATED').length;

  if (subject === 'APPRENTICE') {
    const ms = ids.length ? await prisma.contractMilestone.findMany({ where: { contractId: { in: ids } } }) : [];
    const now = new Date();
    const approved = ms.filter((m) => m.status === 'APPROVED').length;
    const pastDueUnapproved = ms.filter((m) => m.status !== 'APPROVED' && m.dueDate && m.dueDate < now).length;
    // Only an apprentice who walked away counts against them; a master ending an agreement does not.
    const leftByApprentice = started.filter((c) => c.status === 'TERMINATED' && c.statusChangedById === userId).length;
    return {
      honestyFlags: honesty,
      components: {
        masterRatings: { value: ratingToPercent(ratings), evidence: ratings.length },
        milestones: { value: ratio(approved, approved + pastDueUnapproved), evidence: approved + pastDueUnapproved },
        completion: { value: ratio(graduated, graduated + leftByApprentice), evidence: graduated + leftByApprentice },
      },
    };
  }
  const terminated = started.filter((c) => c.status === 'TERMINATED').length;
  let onTime = 0, total = 0;
  for (const c of started) {
    const fund = await prisma.settlementFund.findUnique({ where: { contractId: c.id } });
    if (!fund) continue;
    const dues = await prisma.contributionDue.findMany({ where: { fundId: fund.id } });
    const pays = await prisma.fundsEntry.findMany({ where: { purposeType: 'SETTLEMENT_FUND', purposeId: fund.id, type: 'CONTRIBUTION', status: 'CONFIRMED', payerUserId: userId } });
    const r = onTimeDues(dues, pays.map((p) => ({ at: p.createdAt, kobo: p.amountKobo })));
    onTime += r.onTime; total += r.total;
  }
  void allocateDues;
  return {
    honestyFlags: honesty,
    components: {
      apprenticeRatings: { value: ratingToPercent(ratings), evidence: ratings.length },
      onTime: { value: ratio(onTime, total), evidence: total },
      graduation: { value: ratio(graduated, graduated + terminated), evidence: graduated + terminated },
    },
  };
}

export async function recomputeTrust(userId: string, subject: TrustSubject) {
  const r = computeTrust(subject, await gather(userId, subject));
  const data = { score: r.score, tier: r.tier, breakdown: r as unknown as object, honestyFlags: r.honestyFlags, computedAt: new Date() };
  return prisma.trustScore.upsert({ where: { userId_subject: { userId, subject } }, create: { userId, subject, ...data }, update: data });
}

/** Called when anything about an agreement changes. Refreshes both people's scores and the guarantor's record. */
export async function recomputeForContract(contractId: string) {
  const c = await prisma.apprenticeshipContract.findUnique({ where: { id: contractId } });
  if (!c) return;
  await Promise.all([recomputeTrust(c.apprenticeId, 'APPRENTICE'), recomputeTrust(c.masterId, 'MASTER'), recomputeGuarantor(c.guarantorId)]);
}

let registered = false;
/** Wires scores to events. Called once at startup. */
export function registerTrustListeners() {
  if (registered) return;
  registered = true;
  contractEvents.on('changed', (contractId: string) => { recomputeForContract(contractId).catch((e) => console.error('[trust] recompute failed', (e as Error).message)); });
}

/** The public face: a tier and earned badges. No number, no breakdown. */
export async function publicTrust(userId: string) {
  const [scores, badges] = await Promise.all([prisma.trustScore.findMany({ where: { userId } }), prisma.earnedSkillBadge.findMany({ where: { apprenticeId: userId } })]);
  const skills = [...new Set(badges.map((b) => b.skill))];
  const get = (s: TrustSubject) => scores.find((x) => x.subject === s);
  return { asApprentice: get('APPRENTICE') ? publicView(get('APPRENTICE')!, skills) : null, asMaster: get('MASTER') ? publicView(get('MASTER')!, []) : null };
}

const detailed = (s: { subject: TrustSubject; score: number | null; tier: string; breakdown: unknown; honestyFlags: number; computedAt: Date }) => ({ subject: s.subject, score: s.score, tier: s.tier, honestyFlags: s.honestyFlags, breakdown: s.breakdown, computedAt: s.computedAt });

/** My own scores, with the working. Computed fresh the first time so a new person sees UNRATED, not nothing. */
export async function myTrust(user: Actor) {
  const out = [];
  for (const subject of ['APPRENTICE', 'MASTER'] as const) {
    const has = await prisma.apprenticeshipContract.count({ where: subject === 'APPRENTICE' ? { apprenticeId: user.id } : { masterId: user.id } });
    if (!has) continue;
    const cached = await prisma.trustScore.findUnique({ where: { userId_subject: { userId: user.id, subject } } });
    out.push(detailed(cached ?? (await recomputeTrust(user.id, subject))));
  }
  return out;
}

/** The numeric breakdown for someone else is for the Trust Board and admins only, and never for a person they are party to. */
export async function trustForBoard(viewer: Actor, userId: string) {
  if (!isOversight(viewer)) throw new HttpError(403, 'Only an admin or a Trust Board member can see the full breakdown');
  const rows = await prisma.trustScore.findMany({ where: { userId } });
  return rows.map(detailed);
}

// ── Appeals ─────────────────────────────────────────────────────────────────

/** The person a rating is ABOUT can contest it, once. */
export async function appealLog(user: Actor, conductLogId: string, reason: string) {
  if (reason.trim().length < 10) throw new HttpError(400, 'Explain what is wrong with this rating');
  const log = await prisma.conductLog.findUnique({ where: { id: conductLogId } });
  if (!log) throw new HttpError(404, 'Rating not found');
  const c = await prisma.apprenticeshipContract.findUniqueOrThrow({ where: { id: log.contractId } });
  const aboutId = log.ratedParty === 'APPRENTICE' ? c.apprenticeId : c.masterId;
  if (aboutId !== user.id) throw new HttpError(403, 'Only the person a rating is about can appeal it');
  if (log.excluded) throw new HttpError(409, 'This rating has already been removed');
  try {
    const a = await prisma.conductAppeal.create({ data: { conductLogId, contractId: c.id, appellantId: user.id, reason: reason.trim(), resolvedById: null, resolutionNote: null, resolvedAt: null } });
    await audit(user.id, 'CONDUCT_APPEALED', 'ConductAppeal', a.id, { conductLogId });
    for (const id of await boardMemberIdsFor(c.communityGroupId)) { const u = await prisma.user.findUnique({ where: { id } }); await safeSms(u?.phoneNumber, 'ÀJỌ: someone has appealed a conduct rating. It needs the Trust Board to look at it.'); }
    return a;
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'This rating has already been appealed');
    throw e;
  }
}

/** A board member of that community, who is not part of the agreement, decides. Upholding removes the rating from every score. */
export async function resolveAppeal(user: Actor, appealId: string, input: { uphold: boolean; note: string }) {
  if (user.role !== 'BOARD_MEMBER' && user.role !== 'ADMIN') throw new HttpError(403, 'Only the Trust Board or an admin can resolve an appeal');
  if (input.note.trim().length < 5) throw new HttpError(400, 'Write the reason for your decision');
  const a = await prisma.conductAppeal.findUnique({ where: { id: appealId } });
  if (!a) throw new HttpError(404, 'Appeal not found');
  const c = await prisma.apprenticeshipContract.findUniqueOrThrow({ where: { id: a.contractId } });
  if ([c.masterId, c.apprenticeId, c.guarantorId, c.guardianId].includes(user.id)) throw new HttpError(403, 'You are part of this agreement, so you cannot decide this appeal');
  if (user.role === 'BOARD_MEMBER' && !(await isBoardMemberFor(user.id, c.communityGroupId))) throw new HttpError(403, "This is not your community's appeal");
  const done = await prisma.conductAppeal.updateMany({ where: { id: appealId, status: 'OPEN' }, data: { status: input.uphold ? 'UPHELD' : 'DISMISSED', resolvedById: user.id, resolutionNote: input.note.trim(), resolvedAt: new Date() } });
  if (done.count === 0) throw new HttpError(409, 'This appeal was already decided');
  if (input.uphold) await prisma.conductLog.update({ where: { id: a.conductLogId }, data: { excluded: true } });
  await audit(user.id, input.uphold ? 'APPEAL_UPHELD' : 'APPEAL_DISMISSED', 'ConductAppeal', appealId, { note: input.note });
  await recomputeForContract(c.id);
  const who = await prisma.user.findUnique({ where: { id: a.appellantId } });
  await safeSms(who?.phoneNumber, input.uphold ? 'ÀJỌ: the Trust Board upheld your appeal. That rating no longer counts.' : `ÀJỌ: the Trust Board reviewed your appeal and the rating stands. ${input.note.trim().slice(0, 100)}`);
  return prisma.conductAppeal.findUniqueOrThrow({ where: { id: appealId } });
}

// ── Collector profile on group screens (custody-mode record) ────────────────

/** How a group's collector has handled custody money: dispute rate and how quickly they confirm. Visible to the group's members. */
export async function collectorProfile(user: Actor, groupId: string) {
  const group = await prisma.communityGroup.findUnique({ where: { id: groupId } });
  if (!group) throw new HttpError(404, 'Group not found');
  const member = (await prisma.groupMember.count({ where: { groupId, userId: user.id } })) > 0;
  if (!member && !isOversight(user)) throw new HttpError(403, 'Only members of the group can see this');
  const [rec, cycles, kyc] = await Promise.all([cleanRecord(group.adminId), completedCycles(group.adminId), prisma.collectorKyc.findUnique({ where: { userId: group.adminId } })]);
  const collector = await prisma.user.findUnique({ where: { id: group.adminId }, select: { fullName: true } });
  return {
    collector: collector?.fullName ?? '—', fundsMode: group.fundsMode,
    custody: { applies: group.fundsMode === 'COLLECTOR_CUSTODY', tier: kyc?.approvedTier ?? 0 },
    disputeRatePct: (rec.disputeRateBp / 100).toFixed(1), onTimeConfirmationPct: (rec.confirmedWithinBp / 100).toFixed(1), entriesInWindow: rec.total, cleanRecord: rec.clean, completedCycles: cycles,
  };
}

// ── The board's dashboard ───────────────────────────────────────────────────

/** What needs the board's attention in the communities it oversees. */
export async function boardDashboard(user: Actor) {
  if (!isOversight(user)) throw new HttpError(403, 'Only an admin or a Trust Board member can see this');
  const scope = await groupIdsOverseenBy(user);
  const inScope = scope === 'ALL' ? {} : { in: scope };
  const gfilter = scope === 'ALL' ? {} : { communityGroupId: inScope };
  const [masters, stopped, disputes, appeals, guarantors] = await Promise.all([
    prisma.tradeMasterProfile.findMany({ where: { status: 'PENDING' }, orderBy: { appliedAt: 'asc' }, take: 100 }),
    prisma.apprenticeshipContract.findMany({ where: { status: { in: ['PAUSED', 'TERMINATED'] }, ...gfilter }, orderBy: { updatedAt: 'desc' }, take: 100 }),
    prisma.fundsEntry.findMany({ where: { status: 'DISPUTED', ...(scope === 'ALL' ? {} : { groupId: inScope }) }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.conductAppeal.findMany({ where: { status: 'OPEN' }, orderBy: { createdAt: 'asc' }, take: 100 }),
    prisma.guarantorRecord.findMany({ where: { verifiedAt: null }, take: 100 }),
  ]);
  const { boardQueue } = await import('../settlement/settlement.service');
  const q = await boardQueue(user);
  const names = await prisma.user.findMany({ where: { id: { in: [...masters.map((m) => m.userId), ...guarantors.map((g) => g.userId)] } }, select: { id: true, fullName: true } });
  const nm = (id: string) => names.find((n) => n.id === id)?.fullName ?? '—';
  // An appeal about an agreement the viewer is part of, or in another community, is not theirs to see.
  const visibleAppeals = [];
  for (const a of appeals) {
    const c = await prisma.apprenticeshipContract.findUnique({ where: { id: a.contractId } });
    if (!c || [c.masterId, c.apprenticeId, c.guarantorId, c.guardianId].includes(user.id)) continue;
    if (scope !== 'ALL' && !scope.includes(c.communityGroupId)) continue;
    visibleAppeals.push({ id: a.id, contractId: a.contractId, reason: a.reason, createdAt: a.createdAt });
  }
  return {
    pendingMasters: masters.map((m) => ({ userId: m.userId, name: nm(m.userId), tradeCategories: m.tradeCategories, appliedAt: m.appliedAt })),
    pausedOrEnded: stopped.map((c) => ({ id: c.id, status: c.status, reason: c.statusReason, tradeCategory: c.tradeCategory })),
    releaseApprovals: q.releases, missedContributions: q.missedContributions,
    disputedPayments: disputes.map((d) => ({ id: d.id, groupId: d.groupId, type: d.type, amount: koboToNaira(d.amountKobo), note: d.disputeNote, mode: d.fundsMode })),
    appeals: visibleAppeals,
    guarantorsToVerify: guarantors.map((g) => ({ userId: g.userId, name: nm(g.userId) })),
  };
}
