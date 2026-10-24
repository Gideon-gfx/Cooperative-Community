import { CampaignKind, PaymentMethod } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { assertGroupMember } from '../../lib/access';
import { audit } from '../../lib/audit';
import { naira, safeSmsAndEmail } from '../../lib/notify';
import { round2 } from '../../lib/money';
import { addEntry } from '../../services/ledger.service';

const ASO_OCCASIONS = ['WEDDING', 'BURIAL', 'BIRTHDAY', 'NAMING', 'OTHER'] as const;
const HELP_OCCASIONS = ['MEDICAL', 'SCHOOL', 'RENT', 'BURIAL', 'OTHER'] as const;
const OTHER_OCCASIONS = ['COMMUNITY', 'RELIGIOUS', 'FESTIVAL', 'OTHER'] as const;
export const occasionsFor = (kind: CampaignKind) => (kind === 'ASO_EBI' ? ASO_OCCASIONS : kind === 'HELP' ? HELP_OCCASIONS : OTHER_OCCASIONS);

export async function loadCampaign(id: string) {
  const c = await prisma.campaign.findUnique({ where: { id }, include: { options: true } });
  if (!c) throw new HttpError(404, 'Contribution not found');
  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: c.groupId }, select: { id: true, name: true, currency: true, adminId: true, fundsMode: true } });
  const host = await prisma.user.findUniqueOrThrow({ where: { id: c.hostId }, select: { id: true, fullName: true, phoneNumber: true, email: true } });
  return { ...c, group, host };
}
export type LoadedCampaign = Awaited<ReturnType<typeof loadCampaign>>;

export function assertHost(c: LoadedCampaign, userId: string) {
  if (c.hostId !== userId) throw new HttpError(403, 'Only the host can do this');
}

export interface CreateInput {
  groupId: string;
  kind: CampaignKind;
  occasion: string;
  occasionLabel?: string;
  title: string;
  description?: string;
  eventDate?: Date;
  venue?: string;
  partAmount?: number;
  targetAmount?: number;
  targetPeople?: number;
  recipientName?: string;
  recipientNote?: string;
  recipientUserId?: string;
  closesAt?: Date;
  options?: { label: string; note?: string }[];
}

/** Anyone in a group can start a contribution. The host then holds the money and records it, like a collector. */
export async function createCampaign(hostId: string, b: CreateInput) {
  await assertGroupMember(b.groupId, hostId);
  if (!(occasionsFor(b.kind) as readonly string[]).includes(b.occasion)) throw new HttpError(400, 'Unknown occasion for this kind of contribution');
  if (b.kind === 'ASO_EBI') {
    if (!b.partAmount || b.partAmount <= 0) throw new HttpError(400, 'Set how much each person pays');
    if (!b.options?.length) throw new HttpError(400, 'Add at least one outfit choice');
  } else if (b.kind === 'HELP' && !b.recipientName) {
    throw new HttpError(400, 'Say who the help is for');
  }
  if (b.recipientUserId) await assertGroupMember(b.groupId, b.recipientUserId);

  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: b.groupId } });
  const { options, occasionLabel, ...rest } = b;
  const label = occasionLabel?.trim();
  const campaign = await prisma.campaign.create({
    data: { ...rest, hostId, occasionLabel: b.occasion === 'OTHER' && label ? label : undefined, ...(options?.length ? { options: { create: options } } : {}) },
    include: { options: true },
  });
  await prisma.groupMessage.create({
    data: {
      groupId: b.groupId,
      senderId: hostId,
      messageType: 'SYSTEM',
      content:
        b.kind === 'ASO_EBI'
          ? `🧵 New matching outfit: ${b.title}. Your part is ${naira(b.partAmount!, group.currency)}. The host holds the money; every payment is shown in the ledger.`
          : b.kind === 'OTHER'
            ? `📣 New collection: ${b.title}. The host holds the money; every gift is shown in the ledger.`
            : `❤️ New collection to help ${b.recipientName}: ${b.title}. The host holds the money; every gift and every delivery is shown in the ledger.`,
    },
  });
  await audit(hostId, 'CAMPAIGN_CREATED', 'Campaign', campaign.id, { kind: b.kind });
  return campaign;
}

/** Verified money plus how many different people have given. */
export async function progressOf(campaignId: string) {
  const gifts = await prisma.campaignGift.findMany({ where: { campaignId, status: 'VERIFIED' }, select: { userId: true, kind: true, amount: true } });
  return {
    paidPeople: new Set(gifts.map((g) => g.userId)).size,
    raised: round2(gifts.filter((g) => g.kind === 'MONEY').reduce((s, g) => s + g.amount, 0)),
    foodPledges: gifts.filter((g) => g.kind === 'FOOD').length,
  };
}

export interface GiftInput {
  kind: 'MONEY' | 'FOOD';
  optionId?: string;
  amount?: number;
  foodNote?: string;
  method?: PaymentMethod;
  proofUrl?: string;
  reference?: string;
  forUserId?: string;
}

const receiptNo = (id: string) => `CA-${id.slice(-6).toUpperCase()}`;

/** A member pays their part or pledges food. The host can also record a gift for someone (cash, or no smartphone). */
export async function giveGift(actorId: string, campaignId: string, b: GiftInput) {
  const c = await loadCampaign(campaignId);
  if (c.status !== 'OPEN') throw new HttpError(409, 'This contribution is closed');
  if (c.closesAt && c.closesAt < new Date()) throw new HttpError(409, 'This contribution has closed');
  await assertGroupMember(c.groupId, actorId);
  const giverId = b.forUserId ?? actorId;
  if (giverId !== actorId) {
    assertHost(c, actorId);
    await assertGroupMember(c.groupId, giverId);
  }
  const hostRecords = giverId !== actorId;

  let amount = 0;
  let optionId: string | undefined;
  if (b.kind === 'MONEY') {
    if (c.kind === 'ASO_EBI') {
      // Everyone pays the host's price once and picks an outfit.
      if (!b.optionId || !c.options.some((o) => o.id === b.optionId)) throw new HttpError(400, 'Choose an outfit');
      optionId = b.optionId;
      amount = c.partAmount!;
      const already = await prisma.campaignGift.findFirst({ where: { campaignId, userId: giverId, kind: 'MONEY', status: { in: ['PENDING', 'VERIFIED'] } } });
      if (already) throw new HttpError(409, 'Already paid or waiting for the host to confirm');
    } else {
      if (!b.amount || b.amount <= 0) throw new HttpError(400, 'Enter an amount');
      amount = round2(b.amount);
    }
  } else {
    if (!b.foodNote || b.foodNote.trim().length < 2) throw new HttpError(400, 'Say what food you will give');
  }

  const gift = await prisma.campaignGift.create({
    data: {
      campaignId, userId: giverId, kind: b.kind, optionId, amount, foodNote: b.foodNote?.trim(),
      method: b.kind === 'MONEY' ? b.method ?? 'TRANSFER' : undefined,
      proofUrl: b.proofUrl, reference: b.reference, recordedById: actorId,
    },
  });
  await audit(actorId, 'GIFT_RECORDED', 'CampaignGift', gift.id, { campaignId, kind: b.kind, amount });
  if (hostRecords) return { gift: await verifyGift(actorId, gift.id) };
  const message = `A member gave ${b.kind === 'MONEY' ? naira(amount, c.group.currency) : b.foodNote} to "${c.title}". Please confirm it in ÀJỌ app.`;
  await safeSmsAndEmail(c.host.phoneNumber, c.host.email, `Gift recorded for "${c.title}"`, message);
  return { gift };
}

async function loadGift(id: string) {
  const g = await prisma.campaignGift.findUnique({ where: { id } });
  if (!g) throw new HttpError(404, 'Gift not found');
  const c = await loadCampaign(g.campaignId);
  const giver = await prisma.user.findUniqueOrThrow({ where: { id: g.userId }, select: { fullName: true, phoneNumber: true, email: true } });
  return { g, c, giver };
}

export async function verifyGift(hostId: string, giftId: string) {
  const { g, c, giver } = await loadGift(giftId);
  assertHost(c, hostId);
  if (g.userId === hostId && g.recordedById === hostId) throw new HttpError(403, 'You cannot confirm your own gift');
  if (g.status !== 'PENDING') throw new HttpError(409, 'Only waiting gifts can be confirmed');
  const done = await prisma.campaignGift.update({ where: { id: g.id }, data: { status: 'VERIFIED', verifiedById: hostId, verifiedAt: new Date(), receiptNo: receiptNo(g.id) } });
  if (g.kind === 'MONEY') {
    await addEntry({ campaignId: c.id }, 'IN', 'CONTRIBUTION', g.amount, hostId, `${giver.fullName} · ${(g.method ?? 'TRANSFER').toLowerCase()}`, g.id);
  }
  await audit(hostId, 'GIFT_VERIFIED', 'CampaignGift', g.id, { amount: g.amount });
  const message = `${c.host.fullName} confirmed your ${g.kind === 'MONEY' ? naira(g.amount, c.group.currency) : g.foodNote} for "${c.title}". Receipt ${done.receiptNo}. Thank you!`;
  await safeSmsAndEmail(giver.phoneNumber, giver.email, `Gift confirmed for "${c.title}"`, message);
  return done;
}

export async function rejectGift(hostId: string, giftId: string, reason: string) {
  const { g, c, giver } = await loadGift(giftId);
  assertHost(c, hostId);
  if (g.status !== 'PENDING') throw new HttpError(409, 'Only waiting gifts can be rejected');
  const done = await prisma.campaignGift.update({ where: { id: g.id }, data: { status: 'REJECTED', rejectReason: reason, verifiedById: hostId, verifiedAt: new Date() } });
  await audit(hostId, 'GIFT_REJECTED', 'CampaignGift', g.id, { reason });
  const message = `${c.host.fullName} could not confirm your gift to "${c.title}": ${reason}. Please contact them.`;
  await safeSmsAndEmail(giver.phoneNumber, giver.email, `Gift not confirmed for "${c.title}"`, message);
  return done;
}

/** Host ticks off that the fabric (or food) was handed over, so everyone sees the share-out list. */
export async function markCollected(hostId: string, giftId: string, collected: boolean) {
  const { g, c } = await loadGift(giftId);
  assertHost(c, hostId);
  if (g.status !== 'VERIFIED') throw new HttpError(409, 'Only confirmed gifts can be handed over');
  return prisma.campaignGift.update({ where: { id: g.id }, data: { collectedAt: collected ? new Date() : null } });
}

/** Host says the money and/or food reached the person it was for. Closes the collection. */
export async function recordDelivery(hostId: string, campaignId: string, b: { amount?: number; note?: string; proofUrl?: string }) {
  const c = await loadCampaign(campaignId);
  assertHost(c, hostId);
  if (c.kind !== 'HELP') throw new HttpError(400, 'Only help collections have a delivery');
  if (c.status === 'COMPLETED' || c.status === 'CANCELLED') throw new HttpError(409, 'Already finished');
  if (!b.amount && !b.note) throw new HttpError(400, 'Say how much was paid or what was delivered');
  if (b.amount) await addEntry({ campaignId }, 'OUT', 'PAYOUT', b.amount, hostId, `Paid to ${c.recipientName}${b.note ? ` · ${b.note}` : ''}`);
  const done = await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'COMPLETED', deliveredAt: new Date(), deliveredAmount: b.amount, deliveryNote: b.note, deliveryProofUrl: b.proofUrl, recipientConfirmedAt: null },
  });
  await prisma.groupMessage.create({
    data: { groupId: c.groupId, senderId: hostId, messageType: 'SYSTEM', content: `✅ Help reached ${c.recipientName}${b.amount ? `: ${naira(b.amount, c.group.currency)}` : ''}${b.note ? ` · ${b.note}` : ''}. Open "${c.title}" to see the record.` },
  });
  if (c.recipientUserId) {
    const r = await prisma.user.findUnique({ where: { id: c.recipientUserId } });
    const message = `${c.host.fullName} says help from "${c.title}" has reached you. Please confirm in ÀJỌ app.`;
    await safeSmsAndEmail(r?.phoneNumber, r?.email, `Help delivery from "${c.title}"`, message);
  }
  await audit(hostId, 'CAMPAIGN_DELIVERED', 'Campaign', c.id, { amount: b.amount });
  return done;
}

export async function confirmDelivery(userId: string, campaignId: string, received: boolean, note?: string) {
  const c = await loadCampaign(campaignId);
  if (c.recipientUserId !== userId) throw new HttpError(403, 'Only the person this help is for can confirm it');
  if (!c.deliveredAt) throw new HttpError(409, 'No delivery has been recorded yet');
  if (received) {
    await prisma.campaign.update({ where: { id: c.id }, data: { recipientConfirmedAt: new Date() } });
    await prisma.groupMessage.create({ data: { groupId: c.groupId, messageType: 'SYSTEM', content: `🤝 ${c.recipientName} confirmed the help from "${c.title}" arrived.` } });
    await audit(userId, 'CAMPAIGN_CONFIRMED', 'Campaign', c.id);
    return { status: 'CONFIRMED' as const };
  }
  await prisma.dispute.create({
    data: { groupId: c.groupId, campaignId: c.id, raisedById: userId, kind: 'PAYOUT_NOT_RECEIVED', description: note || `${c.recipientName} says the help from "${c.title}" has not arrived.` },
  });
  await prisma.groupMessage.create({ data: { groupId: c.groupId, messageType: 'SYSTEM', content: `⚠️ ${c.recipientName} says help from "${c.title}" has NOT arrived. The host must resolve this.` } });
  const message = `${c.recipientName} says help from "${c.title}" has NOT arrived. Please resolve it in ÀJỌ app.`;
  await safeSmsAndEmail(c.host.phoneNumber, c.host.email, `Delivery dispute for "${c.title}"`, message);
  await audit(userId, 'CAMPAIGN_DISPUTED', 'Campaign', c.id);
  return { status: 'DISPUTED' as const };
}

export async function setStatus(hostId: string, campaignId: string, status: 'CLOSED' | 'OPEN' | 'CANCELLED') {
  const c = await loadCampaign(campaignId);
  assertHost(c, hostId);
  if (c.status === 'COMPLETED') throw new HttpError(409, 'Already finished');
  if (status === 'CANCELLED') {
    const held = await prisma.ledgerEntry.groupBy({ by: ['direction'], where: { campaignId }, _sum: { amount: true } });
    const net = round2((held.find((h) => h.direction === 'IN')?._sum.amount ?? 0) - (held.find((h) => h.direction === 'OUT')?._sum.amount ?? 0));
    if (net > 0) throw new HttpError(409, `Refund the ${naira(net, c.group.currency)} you still hold (record it in the ledger) before cancelling`);
  }
  await audit(hostId, `CAMPAIGN_${status}`, 'Campaign', campaignId);
  return prisma.campaign.update({ where: { id: campaignId }, data: { status } });
}
