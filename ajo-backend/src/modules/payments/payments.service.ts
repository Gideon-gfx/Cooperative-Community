import { FundsPurpose } from '@prisma/client';
import { decisions } from '../../config/decisions';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { assertGroupMember } from '../../lib/access';
import { modeBadge, noticeFor } from '../../lib/constants';
import { nairaToKobo } from '../../lib/kobo';
import { computeWaterfall, pctOf, waterfallToJson } from './fee-engine';
import { getFundsProvider } from './funds-provider';
import { getPlatformConfig } from './platform-config';
import { hasSigned } from '../consent/consent.service';
import { assertCustodyContribution, assertEscrowOnly } from './custody.service';

/** The "what you will pay" screen. Same engine that splits the money later, so the preview can never drift from the receipt. */
export async function previewFees(i: { amount: string | number; purposeType: FundsPurpose; collectorFeePct?: number; transportFee?: string | number }) {
  const cfg = await getPlatformConfig();
  const gross = nairaToKobo(i.amount);
  const grossNaira = (Number(gross) / 100).toFixed(2);
  const platformBp = i.purposeType === 'SETTLEMENT_FUND' ? cfg.settlementCommissionBp : cfg.platformCommissionBp;
  const w = computeWaterfall({
    gross: grossNaira, platformBp,
    collectorFee: i.collectorFeePct ? pctOf(grossNaira, i.collectorFeePct) : 0,
    transportFee: i.transportFee ?? 0,
    gatewayFee: pctOf(grossNaira, decisions.gatewayFeeBp / 100),
    gatewayFeeBearer: cfg.gatewayFeeBearer,
  });
  return { waterfall: waterfallToJson(w), platformCommissionBp: platformBp, gatewayFeeBearer: cfg.gatewayFeeBearer, raw: w };
}

/** Nobody pays in without having accepted the terms, and nobody pays a custody collector without signing the custody disclosure. */
export async function assertConsents(userId: string, group: { id: string; fundsMode: string }) {
  if (!(await hasSigned(userId, 'PLATFORM_TERMS'))) throw new HttpError(403, 'CONSENT_REQUIRED: please read and accept the terms of use before paying');
  if (group.fundsMode === 'COLLECTOR_CUSTODY' && !(await hasSigned(userId, 'CUSTODY_MEMBER_DISCLOSURE', group.id))) {
    throw new HttpError(403, 'CONSENT_REQUIRED: please read and sign the collector-custody disclosure before paying this group');
  }
}

export interface ContributeInput {
  groupId: string;
  purposeType: FundsPurpose;
  purposeId: string;
  amount: string | number;
  facilitatorAccountId?: string;
  bankReference?: string;
  proofImageUrl?: string;
}

/** The single entry point for paying into a group. Picks the provider from the group's mode and enforces every safeguard first. */
export async function contribute(user: { id: string }, b: ContributeInput) {
  await assertGroupMember(b.groupId, user.id);
  const group = await prisma.communityGroup.findUnique({ where: { id: b.groupId } });
  if (!group) throw new HttpError(404, 'Group not found');
  assertEscrowOnly(b.purposeType, group);
  await assertConsents(user.id, group);
  const amountKobo = nairaToKobo(b.amount);

  const preview = await previewFees({ amount: b.amount, purposeType: b.purposeType });
  if (group.fundsMode === 'COLLECTOR_CUSTODY') {
    if (group.adminId === user.id) throw new HttpError(403, 'A collector cannot declare a payment into their own group');
    await assertCustodyContribution({ group, facilitatorAccountId: b.facilitatorAccountId, amountKobo });
    if (b.facilitatorAccountId) {
      const account = await prisma.facilitatorAccount.findUnique({ where: { id: b.facilitatorAccountId } });
      if (account && account.userId !== group.adminId) throw new HttpError(403, "That account does not belong to this group's collector");
    }
  }

  const payer = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  const provider = await getFundsProvider(group.fundsMode);
  const result = await provider.collect({
    groupId: group.id, payerUserId: user.id, purposeType: b.purposeType, purposeId: b.purposeId, amountKobo,
    chargeKobo: nairaToKobo(preview.raw.payerTotal.toFixed(2)), payerName: payer.fullName,
    facilitatorAccountId: b.facilitatorAccountId, bankReference: b.bankReference, proofImageUrl: b.proofImageUrl,
  });
  return { mode: group.fundsMode, badge: modeBadge(group.fundsMode), notice: noticeFor(group.fundsMode), waterfall: preview.waterfall, result };
}
