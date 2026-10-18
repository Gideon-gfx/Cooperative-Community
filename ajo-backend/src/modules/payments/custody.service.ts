import { FundsPurpose } from '@prisma/client';
import { assertGateOpen, decisions, tierConfig } from '../../config/decisions';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { koboToNaira } from '../../lib/kobo';
import { enforceCustodyConsentAtCycleStart, hasSigned } from '../consent/consent.service';
import { deriveTotals } from './funds-provider';

// ── Verification ────────────────────────────────────────────────────────────
// No biometric, face, selfie or liveness data, ever. Raw BVN/NIN numbers are used for one provider call and
// then dropped: only the provider's reference and the outcome are kept.

export interface KycResult { verified: boolean; nameMatch: boolean; providerRef: string }
export interface KycProvider {
  /** Looks up an ID with the provider and compares the name and phone on record. The id number is never returned or stored. */
  verifyIdentity(input: { kind: 'BVN' | 'NIN'; idNumber: string; fullName: string; phoneNumber: string }): Promise<KycResult>;
}

/** Sandbox stand-in. Accepts any 11-digit number, and fails the name match for numbers ending in 000 so both paths can be tested. */
export class StubKycProvider implements KycProvider {
  async verifyIdentity(i: { kind: 'BVN' | 'NIN'; idNumber: string }): Promise<KycResult> {
    const ok = /^\d{11}$/.test(i.idNumber);
    return { verified: ok, nameMatch: ok && !i.idNumber.endsWith('000'), providerRef: `stub-${i.kind.toLowerCase()}-${Date.now().toString(36)}` };
  }
}
export const kycProvider: KycProvider = new StubKycProvider();

export async function verifyCollectorIdentity(userId: string, kind: 'BVN' | 'NIN', idNumber: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.phoneNumber) throw new HttpError(400, 'Add a phone number before identity verification');
  const r = await kycProvider.verifyIdentity({ kind, idNumber, fullName: user.fullName, phoneNumber: user.phoneNumber });
  if (!r.verified) throw new HttpError(422, `That ${kind} could not be verified`);
  const flags = kind === 'BVN' ? { bvnVerified: true } : { ninVerified: true };
  const kyc = await prisma.collectorKyc.upsert({
    where: { userId },
    update: { ...flags, nameMatch: r.nameMatch, providerRef: r.providerRef, verifiedAt: new Date() },
    create: { userId, ...flags, nameMatch: r.nameMatch, providerRef: r.providerRef, verifiedAt: new Date() },
  });
  // The id number is deliberately NOT in the audit meta.
  await audit(userId, 'KYC_CHECKED', 'CollectorKyc', kyc.id, { kind, nameMatch: r.nameMatch });
  if (!r.nameMatch) throw new HttpError(422, `The name on that ${kind} does not match your account name`);
  return kyc;
}

// ── Clean record, tiers, downgrade ──────────────────────────────────────────

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** Dispute rate under 2% and 95%+ of entries confirmed within 48h, over the trailing window. A new collector with no entries is clean. */
export async function cleanRecord(collectorUserId: string, now = new Date()) {
  const accounts = await prisma.facilitatorAccount.findMany({ where: { userId: collectorUserId }, select: { id: true } });
  const since = new Date(now.getTime() - decisions.clean.windowDays * DAY);
  const rows = await prisma.fundsEntry.findMany({
    where: { facilitatorAccountId: { in: accounts.map((a) => a.id) }, type: 'CONTRIBUTION', createdAt: { gte: since } },
    select: { status: true, createdAt: true, facilitatorConfirmedAt: true },
  });
  const total = rows.length;
  if (total === 0) return { clean: true, total, disputeRateBp: 0, confirmedWithinBp: 10_000 };
  const disputed = rows.filter((r) => r.status === 'DISPUTED').length;
  const within = rows.filter((r) => r.facilitatorConfirmedAt && r.facilitatorConfirmedAt.getTime() - r.createdAt.getTime() <= decisions.clean.confirmWithinHours * HOUR).length;
  const disputeRateBp = Math.round((disputed * 10_000) / total);
  const confirmedWithinBp = Math.round((within * 10_000) / total);
  return { clean: disputeRateBp < decisions.clean.maxDisputeRateBp && confirmedWithinBp >= decisions.clean.minConfirmedWithinBp, total, disputeRateBp, confirmedWithinBp };
}

export async function completedCycles(collectorUserId: string): Promise<number> {
  return prisma.ajoPool.count({ where: { status: 'COMPLETED', group: { adminId: collectorUserId } } });
}

type Kyc = NonNullable<Awaited<ReturnType<typeof prisma.collectorKyc.findUnique>>>;

/** The highest tier this collector's verification, history and endorsements currently qualify for. */
export function eligibleTier(kyc: Kyc | null, cycles: number, clean: boolean): number {
  if (!kyc) return 0;
  let best = 0;
  for (const t of decisions.custodyTiers) {
    const ok =
      kyc.bvnVerified && kyc.nameMatch &&
      (!t.needsNin || kyc.ninVerified) && (!t.needsAddress || kyc.addressAttested) && (!t.needsBoardEndorsement || kyc.boardEndorsed) &&
      (!t.needsEntityDocs || (kyc.entityCertVerified && kyc.licenseDocsVerified && !!kyc.entityAccountName)) &&
      cycles >= t.minCleanCycles && (t.tier === 1 || clean);
    if (ok) best = t.tier;
    else break;
  }
  return best;
}

export async function requestTierUpgrade(userId: string, tier: number) {
  if (!tierConfig(tier)) throw new HttpError(400, 'Unknown tier');
  const kyc = await prisma.collectorKyc.findUnique({ where: { userId } });
  if (!kyc || tier <= kyc.approvedTier) throw new HttpError(409, 'Choose a higher tier than your current one');
  return prisma.collectorKyc.update({ where: { userId }, data: { requestedTier: tier } });
}

/** Upgrades are never automatic: an admin reviews, and the collector must already qualify. */
export async function approveTier(adminId: string, userId: string, tier: number) {
  const kyc = await prisma.collectorKyc.findUnique({ where: { userId } });
  if (!kyc) throw new HttpError(404, 'This collector has not started verification');
  const { clean } = await cleanRecord(userId);
  const best = eligibleTier(kyc, await completedCycles(userId), clean);
  if (tier > best) throw new HttpError(409, `This collector only qualifies for tier ${best} right now`);
  if (tier <= kyc.approvedTier) throw new HttpError(409, 'Already at or above that tier');
  const done = await prisma.collectorKyc.update({ where: { userId }, data: { approvedTier: tier, requestedTier: null, pendingTier: null, tierChangedAt: new Date() } });
  await audit(adminId, 'CUSTODY_TIER_APPROVED', 'CollectorKyc', kyc.id, { userId, from: kyc.approvedTier, to: tier });
  return done;
}

/** If the clean-record thresholds are breached, schedule a one-tier drop for the start of the next cycle. */
export async function evaluateDowngrade(userId: string, now = new Date()) {
  const kyc = await prisma.collectorKyc.findUnique({ where: { userId } });
  if (!kyc || kyc.approvedTier === 0 || kyc.pendingTier !== null) return kyc;
  const { clean } = await cleanRecord(userId, now);
  if (clean) return kyc;
  await audit(null, 'CUSTODY_DOWNGRADE_SCHEDULED', 'CollectorKyc', kyc.id, { userId, from: kyc.approvedTier, to: kyc.approvedTier - 1 });
  return prisma.collectorKyc.update({ where: { userId }, data: { pendingTier: kyc.approvedTier - 1 } });
}

/** Called when a new cycle starts. Cycles already running finish at their old tier; new ones use the dropped tier. */
export async function applyPendingTier(userId: string) {
  const kyc = await prisma.collectorKyc.findUnique({ where: { userId } });
  if (!kyc || kyc.pendingTier === null) return kyc;
  await audit(null, 'CUSTODY_DOWNGRADE_APPLIED', 'CollectorKyc', kyc.id, { userId, to: kyc.pendingTier });
  return prisma.collectorKyc.update({ where: { userId }, data: { approvedTier: kyc.pendingTier, pendingTier: null, tierChangedAt: new Date() } });
}

// ── Custody guards ──────────────────────────────────────────────────────────

/** Money a group's collector holds right now: confirmed balance plus declared payments still waiting for confirmation. */
export async function heldKobo(groupId: string): Promise<bigint> {
  const t = await deriveTotals({ groupId, fundsMode: 'COLLECTOR_CUSTODY' });
  const pending = await prisma.fundsEntry.aggregate({ where: { groupId, fundsMode: 'COLLECTOR_CUSTODY', type: 'CONTRIBUTION', status: 'DECLARED' }, _sum: { amountKobo: true } });
  return t.balance + (pending._sum.amountKobo ?? 0n);
}

export async function collectorHeldKobo(collectorUserId: string): Promise<bigint> {
  const groups = await prisma.communityGroup.findMany({ where: { adminId: collectorUserId, fundsMode: 'COLLECTOR_CUSTODY' }, select: { id: true } });
  let total = 0n;
  for (const g of groups) total += await heldKobo(g.id);
  return total;
}

/** The Settlement Fund is escrow-only: a custody group can never hold it. */
export function assertEscrowOnly(purpose: FundsPurpose, group: { fundsMode: string }) {
  if (purpose === 'SETTLEMENT_FUND' && group.fundsMode !== 'ESCROW') throw new HttpError(409, 'The Settlement Fund is escrow-only. This group must use escrow for it.');
}

/**
 * Enforced on every custody contribution: gates, registration, collector tier, the per-group cap, the collector's
 * aggregate cap, and (tier 3) that the receiving account is in the registered entity's name.
 */
export async function assertCustodyContribution(i: { group: { id: string; adminId: string; fundsMode: string; registrationStatus: string }; facilitatorAccountId?: string; amountKobo: bigint }) {
  const { group } = i;
  if (group.fundsMode !== 'COLLECTOR_CUSTODY') throw new HttpError(409, 'This group uses escrow, not collector custody');
  assertGateOpen('CONSENT_DOCS_APPROVED');
  if (group.registrationStatus === 'UNREGISTERED') throw new HttpError(409, 'Collector custody needs the group to be registered or in the process of registering');
  const kyc = await prisma.collectorKyc.findUnique({ where: { userId: group.adminId } });
  const tier = kyc ? tierConfig(kyc.approvedTier) : undefined;
  if (!tier) throw new HttpError(409, 'This collector is not verified for custody. The group must use escrow.');

  if ((await heldKobo(group.id)) + i.amountKobo > tier.maxPerGroupKobo) {
    throw new HttpError(409, `This would take the group above the ₦${koboToNaira(tier.maxPerGroupKobo)} custody limit for tier ${tier.tier}. Use escrow for amounts this size.`);
  }
  if ((await collectorHeldKobo(group.adminId)) + i.amountKobo > tier.maxPerCollectorKobo) {
    throw new HttpError(409, `This would take the collector above the ₦${koboToNaira(tier.maxPerCollectorKobo)} limit they may hold across all groups.`);
  }
  if (tier.entityAccountOnly && i.facilitatorAccountId) {
    const account = await prisma.facilitatorAccount.findUnique({ where: { id: i.facilitatorAccountId } });
    if (!kyc?.entityAccountName || !account || account.accountName.trim().toLowerCase() !== kyc.entityAccountName.trim().toLowerCase()) {
      throw new HttpError(409, "At tier 3 the receiving bank account must be in the registered cooperative's name, not a personal account.");
    }
  }
}

// ── Mode switching ──────────────────────────────────────────────────────────

/** A switch is only a REQUEST. It takes effect at the start of the next cycle (applyPendingFundsMode). A group is never mixed-mode. */
export async function requestFundsMode(actor: { id: string; role: string }, groupId: string, target: 'ESCROW' | 'COLLECTOR_CUSTODY') {
  const group = await prisma.communityGroup.findUnique({ where: { id: groupId } });
  if (!group) throw new HttpError(404, 'Group not found');
  if (group.adminId !== actor.id && actor.role !== 'ADMIN') throw new HttpError(403, 'Only the group collector or an admin can change the funds mode');
  if (target === group.fundsMode && !group.pendingFundsMode) throw new HttpError(409, `This group already uses ${target === 'ESCROW' ? 'escrow' : 'collector custody'}`);

  if (target === 'COLLECTOR_CUSTODY') {
    assertGateOpen('CONSENT_DOCS_APPROVED');
    if (group.registrationStatus === 'UNREGISTERED') throw new HttpError(409, 'Collector custody needs the group to be registered or in the process of registering');
    const kyc = await prisma.collectorKyc.findUnique({ where: { userId: group.adminId } });
    if (!kyc || kyc.approvedTier < 1) throw new HttpError(409, 'The collector must pass verification before custody can be enabled');
    // The collector signs the agreement (with the comprehension check) before custody can even be requested.
    if (!(await hasSigned(group.adminId, 'CUSTODY_COLLECTOR_AGREEMENT', group.id))) throw new HttpError(409, 'The collector must sign the custody agreement first');
  }
  const updated = await prisma.communityGroup.update({ where: { id: groupId }, data: { pendingFundsMode: target === group.fundsMode ? null : target } });
  await audit(actor.id, 'FUNDS_MODE_REQUESTED', 'CommunityGroup', groupId, { from: group.fundsMode, to: target });
  return updated;
}

/** Called when a new cycle starts. Only then does a requested mode (and any scheduled tier drop) take effect. */
export async function applyPendingFundsMode(groupId: string) {
  const group = await prisma.communityGroup.findUnique({ where: { id: groupId } });
  if (!group) return null;
  await applyPendingTier(group.adminId);
  if (!group.pendingFundsMode) return group;
  const updated = await prisma.communityGroup.update({ where: { id: groupId }, data: { fundsMode: group.pendingFundsMode, pendingFundsMode: null, fundsModeLockedUntil: null } });
  await audit(null, 'FUNDS_MODE_APPLIED', 'CommunityGroup', groupId, { from: group.fundsMode, to: group.pendingFundsMode });
  // Going to custody: every member must have signed the disclosure. Those who have not leave the group now, at the cycle boundary.
  if (group.pendingFundsMode === 'COLLECTOR_CUSTODY') await enforceCustodyConsentAtCycleStart(groupId);
  return updated;
}

// ── Pilot limits ────────────────────────────────────────────────────────────

/** Until at least one group is REGISTERED the pilot is capped (default 5 groups, 30 members each). */
export async function assertPilotLimits(i: { newGroup?: boolean; groupId?: string }) {
  if ((await prisma.communityGroup.count({ where: { registrationStatus: 'REGISTERED' } })) > 0) return;
  if (i.newGroup && (await prisma.communityGroup.count()) >= decisions.pilot.maxGroups) {
    throw new HttpError(409, `The pilot is limited to ${decisions.pilot.maxGroups} groups until a pilot group is registered.`);
  }
  if (i.groupId && (await prisma.groupMember.count({ where: { groupId: i.groupId } })) >= decisions.pilot.maxMembersPerGroup) {
    throw new HttpError(409, `The pilot is limited to ${decisions.pilot.maxMembersPerGroup} members per group until a pilot group is registered.`);
  }
}
