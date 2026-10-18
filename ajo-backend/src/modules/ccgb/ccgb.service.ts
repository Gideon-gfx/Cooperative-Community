import { FoodPaymentKind } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { config } from '../../lib/config';
import { naira, safeSms } from '../../lib/notify';
import { round2 } from '../../lib/money';
import { audit } from '../../lib/audit';
import { addEntry } from '../../services/ledger.service';
import { earnCommission, voidPendingCommission } from '../payments/commission.service';
import { calculateTransportFee, findNearestActiveTransporter } from './ccgb.logistics';

/** Below this share of the ordered weight, a delivery is treated as short and the supplier balance is reduced. */
export const SHORTFALL_TOLERANCE = 0.98;

export interface Tally { productId: string; votes: number; unitPrice: number }

/** Highest votes wins; ties are broken by the lowest unit price. */
export function pickWinner(tallies: Tally[]): Tally | null {
  if (tallies.length === 0) return null;
  return [...tallies].sort((a, b) => b.votes - a.votes || a.unitPrice - b.unitPrice)[0];
}

/** How many whole units the budget buys at the locked price, and what is left over. */
export function sizeOrder(netBudget: number, unitPrice: number, kgPerUnit: number) {
  const units = Math.floor(netBudget / unitPrice);
  const orderAmount = round2(units * unitPrice);
  return { units, orderAmount, orderKg: round2(units * kgPerUnit), leftover: round2(netBudget - orderAmount) };
}

/** Most the collector may still pay the supplier given what has arrived (a short delivery reduces the balance). */
export function supplierPayable(orderAmount: number, orderKg: number, receivedKg: number | null): number {
  if (receivedKg == null || orderKg <= 0) return orderAmount;
  return receivedKg >= orderKg * SHORTFALL_TOLERANCE ? orderAmount : round2(orderAmount * (receivedKg / orderKg));
}

async function poolWithGroup(poolId: string) {
  const pool = await prisma.foodPool.findUnique({ where: { id: poolId }, include: { group: { include: { admin: true } } } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  return pool;
}
async function asCollector(poolId: string, userId: string) {
  const pool = await poolWithGroup(poolId);
  if (pool.group.adminId !== userId) throw new HttpError(403, 'Only the pool collector can do this');
  return pool;
}

export async function getVoteTallies(poolId: string) {
  const grouped = await prisma.foodPollVote.groupBy({ by: ['productId'], where: { poolId }, _count: { _all: true } });
  const products = await prisma.ccgbProduct.findMany({ where: { id: { in: grouped.map((g) => g.productId) } }, include: { supplier: { select: { businessName: true } } } });
  return grouped
    .map((g) => {
      const p = products.find((x) => x.id === g.productId)!;
      return { productId: g.productId, name: p.name, supplier: p.supplier.businessName, unitPrice: p.unitPrice, votes: g._count._all };
    })
    .sort((a, b) => b.votes - a.votes);
}

// ── JOIN / VERIFY / VOTE ─────────────────────────────────────────

export async function joinFoodPool(userId: string, poolId: string, proofUrl: string, shares = 1) {
  const pool = await poolWithGroup(poolId);
  if (!Number.isInteger(shares) || shares < 1 || shares > 10) throw new HttpError(400, 'Shares must be between 1 and 10');
  const isGroupMember = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId: pool.groupId, userId } } });
  if (!isGroupMember) throw new HttpError(403, 'Join the group before joining its food pool');
  if (await prisma.foodPoolMember.findUnique({ where: { poolId_userId: { poolId, userId } } })) throw new HttpError(409, 'You have already joined this pool');
  if (pool.status !== 'COLLECTING' || pool.liveWindowEnd < new Date()) throw new HttpError(400, 'This pool is no longer accepting members');
  if (pool.currentMembers >= pool.targetMembers) throw new HttpError(400, 'This pool is full');

  const member = await prisma.$transaction(async (tx) => {
    let m;
    try {
      m = await tx.foodPoolMember.create({ data: { poolId, userId, proofOfPaymentUrl: proofUrl, shares } });
    } catch (e: any) {
      if (e.code === 'P2002') throw new HttpError(409, 'You have already joined this pool');
      throw e;
    }
    await tx.foodPool.update({ where: { id: poolId }, data: { currentMembers: { increment: 1 } } });
    return m;
  });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const cur = pool.group.currency;
  await safeSms(user.phoneNumber, `You joined the food pool in ${pool.group.name} (${shares} share${shares > 1 ? 's' : ''}, ${naira(pool.contributionAmt * shares, cur)}). Your collector holds the money and will confirm it. Voting opens once confirmed.`);
  await safeSms(pool.group.admin.phoneNumber, `${user.fullName} joined your food pool and says they paid. Please confirm in ÀJỌ app once you receive it.`);
  return member;
}

export async function verifyFoodPayment(actor: { id: string; role: string }, memberId: string) {
  const member = await prisma.foodPoolMember.findUnique({ where: { id: memberId }, include: { pool: { include: { group: true } }, user: true } });
  if (!member) throw new HttpError(404, 'Pool member not found');
  if (actor.role !== 'ADMIN' && member.pool.group.adminId !== actor.id) throw new HttpError(403, 'Only the pool collector or an admin can verify payments');
  if (member.userId === actor.id && actor.role !== 'ADMIN') throw new HttpError(403, 'You cannot verify your own payment');
  if (member.isPaidVerified) throw new HttpError(409, 'Already verified');
  if (member.pool.status !== 'COLLECTING') throw new HttpError(400, 'This pool is no longer collecting');
  const amount = member.pool.contributionAmt * member.shares;
  const claimed = await prisma.foodPoolMember.updateMany({ where: { id: memberId, isPaidVerified: false }, data: { isPaidVerified: true } });
  if (claimed.count === 0) throw new HttpError(409, 'Already verified');
  await prisma.foodPool.update({ where: { id: member.poolId }, data: { totalFund: { increment: amount } } });
  await addEntry({ foodPoolId: member.poolId }, 'IN', 'FOOD_PAYMENT', amount, actor.id, `${member.user.fullName} · ${member.shares} share${member.shares > 1 ? 's' : ''}`, member.id);
  await audit(actor.id, 'FOOD_PAYMENT_VERIFIED', 'FoodPoolMember', memberId, { amount });
  await safeSms(member.user.phoneNumber, 'Payment confirmed by your collector! You can now vote for food items in your pool.');
  return prisma.foodPoolMember.findUniqueOrThrow({ where: { id: memberId } });
}

export async function voteFoodItem(userId: string, poolId: string, productId: string) {
  const pool = await prisma.foodPool.findUnique({ where: { id: poolId } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  if (pool.status !== 'COLLECTING') throw new HttpError(400, 'Voting is closed for this pool');
  const member = await prisma.foodPoolMember.findUnique({ where: { poolId_userId: { poolId, userId } } });
  if (!member) throw new HttpError(403, 'You are not in this pool');
  if (!member.isPaidVerified) throw new HttpError(403, 'Your payment has not been confirmed yet');
  if (member.hasVoted) throw new HttpError(409, 'You have already voted');
  const product = await prisma.ccgbProduct.findUnique({ where: { id: productId }, include: { supplier: true } });
  if (!product || !product.isAvailable || !product.supplier.isAdminApproved) throw new HttpError(400, 'Product is not available for voting');

  await prisma.$transaction([
    prisma.foodPollVote.create({ data: { poolId, productId, userId } }),
    prisma.foodPoolMember.update({ where: { id: member.id }, data: { hasVoted: true } }),
  ]);
  return getVoteTallies(poolId);
}

// ── LOCK ─────────────────────────────────────────────────────────

export async function lockAndProcessPool(poolId: string) {
  const pool = await prisma.foodPool.findUnique({
    where: { id: poolId },
    include: { group: { include: { admin: true } }, members: { include: { user: true } } },
  });
  if (!pool) throw new HttpError(404, 'Pool not found');
  if (pool.status !== 'COLLECTING') throw new HttpError(409, 'Pool is not in the collecting stage');

  const tallies = await getVoteTallies(poolId);
  const winner = pickWinner(tallies.map((x) => ({ productId: x.productId, votes: x.votes, unitPrice: x.unitPrice })));
  if (!winner) throw new HttpError(400, 'No votes have been cast yet');
  const product = await prisma.ccgbProduct.findUniqueOrThrow({ where: { id: winner.productId }, include: { supplier: { include: { user: true } } } });

  // The hub's coordinates are taken from the collector's saved location.
  const hub = pool.group.admin;
  const driver = hub.locationLat != null && hub.locationLng != null ? await findNearestActiveTransporter(hub.locationLat, hub.locationLng, prisma) : null;
  const { locationLat: sLat, locationLng: sLng } = product.supplier;
  const transportFee =
    sLat != null && sLng != null && hub.locationLat != null && hub.locationLng != null
      ? calculateTransportFee(sLat, sLng, hub.locationLat, hub.locationLng)
      : config.transportBaseFee;

  const totalFund = pool.totalFund;
  const platformFee = round2(totalFund * config.ccgbPlatformFeeRate);
  const netFoodBudget = round2(totalFund - transportFee - platformFee);
  if (netFoodBudget <= 0) throw new HttpError(400, 'Pool fund is too small to cover transport and fees');
  const order = sizeOrder(netFoodBudget, product.unitPrice, product.kgWeightPerUnit);
  if (order.units < 1) throw new HttpError(400, 'Pool fund cannot buy even one unit of the winning product');

  const locked = await prisma.foodPool.updateMany({
    where: { id: poolId, status: 'COLLECTING' },
    data: {
      winningProductId: product.id, driverId: driver?.id ?? null, transportFee, platformFee, netFoodBudget, status: 'LOCKED',
      lockedUnitPrice: product.unitPrice, orderUnits: order.units, orderKg: order.orderKg, leftoverAmt: order.leftover,
    },
  });
  if (locked.count === 0) throw new HttpError(409, 'Pool was locked by another process');

  await prisma.foodPurchaseOrder.create({
    data: { poolId, supplierId: product.supplierId, productId: product.id, orderAmount: order.orderAmount, transportFee, driverId: driver?.id ?? null },
  });
  await audit(null, 'FOOD_POOL_LOCKED', 'FoodPool', poolId, { winner: product.id, units: order.units });

  const cur = pool.group.currency;
  const deposit = round2(order.orderAmount * (pool.supplierDepositPct / 100));
  await safeSms(product.supplier.user.phoneNumber, `New bulk order: ${order.units} × ${product.name} at ${naira(product.unitPrice, cur)} (locked price), total ${naira(order.orderAmount, cur)}. Collector ${pool.group.admin.fullName} will pay a deposit of ${naira(deposit, cur)}, the rest after delivery is checked.`);
  if (driver) {
    await safeSms(driver.phoneNumber, `New ÀJỌ delivery job. Pickup from ${product.supplier.businessName}. Deliver to ${pool.communityHubAddr ?? 'the community hub'}. Fee: ${naira(transportFee, cur)}, paid by the collector after delivery. Take a photo as proof.`);
  }
  for (const m of pool.members) {
    await safeSms(m.user.phoneNumber, `Your food pool is locked! ${product.name} won the vote. Collection point: ${pool.communityHubAddr ?? 'to be announced'}. Pick a collection time in the app.`);
  }
  await prisma.groupMessage.create({
    data: {
      groupId: pool.groupId,
      messageType: 'SYSTEM',
      content: `🔒 Food pool locked. Winner: ${product.name} (${winner.votes} votes) from ${product.supplier.businessName}. Price locked at ${naira(product.unitPrice, cur)} per unit. Order: ${order.units} units (${order.orderKg} kg) for ${naira(order.orderAmount, cur)}. Transport ${naira(transportFee, cur)}. Left over: ${naira(order.leftover, cur)} (shared back to members). Collection point: ${pool.communityHubAddr ?? 'TBA'}.`,
    },
  });
  return { winnerProductId: product.id, transportFee, platformFee, netFoodBudget, driverId: driver?.id ?? null, ...order };
}

// ── DELIVERY / PAYMENTS ──────────────────────────────────────────

export async function confirmDelivery(driverId: string, poolId: string, input: { proofUrl: string; receivedKg?: number }) {
  const pool = await prisma.foodPool.findUnique({ where: { id: poolId }, include: { members: { include: { user: true } }, driver: true, group: true } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  if (pool.driverId !== driverId) throw new HttpError(403, 'You are not the assigned driver for this pool');
  if (pool.status !== 'LOCKED' && pool.status !== 'DISPATCHED') throw new HttpError(400, 'Pool is not awaiting delivery');
  if (!input.proofUrl) throw new HttpError(400, 'A delivery photo is required');

  const done = await prisma.foodPool.updateMany({
    where: { id: poolId, status: { in: ['LOCKED', 'DISPATCHED'] } },
    data: { status: 'DELIVERED', deliveredAt: new Date(), deliveryProofUrl: input.proofUrl, receivedKg: input.receivedKg ?? pool.orderKg },
  });
  if (done.count === 0) throw new HttpError(409, 'Delivery already confirmed');
  await prisma.foodPurchaseOrder.update({ where: { poolId }, data: { status: 'DELIVERED' } });
  // Delivered: commission taken on this pool's contributions is now earned.
  await earnCommission('CCGB', poolId, driverId);

  // Leftover from rounding down to whole units goes back to members in proportion to their shares.
  const verified = pool.members.filter((m) => m.isPaidVerified);
  const totalShares = verified.reduce((s, m) => s + m.shares, 0);
  if (pool.leftoverAmt > 0 && totalShares > 0) {
    for (const m of verified) {
      const share = Math.floor((pool.leftoverAmt * m.shares) / totalShares);
      if (share > 0) await prisma.foodPoolMember.update({ where: { id: m.id }, data: { refundDue: share } });
    }
  }

  const short = pool.orderKg != null && input.receivedKg != null && input.receivedKg < pool.orderKg * SHORTFALL_TOLERANCE;
  const cur = pool.group.currency;
  if (short) {
    await prisma.dispute.create({
      data: { groupId: pool.groupId, foodPoolId: poolId, raisedById: pool.group.adminId, kind: 'FOOD_SHORTFALL', description: `Ordered ${pool.orderKg} kg but only ${input.receivedKg} kg was delivered. Supplier balance is reduced to match.` },
    });
  }
  await prisma.groupMessage.create({
    data: { groupId: pool.groupId, messageType: 'SYSTEM', content: short ? `📦 Delivered, but short: ${input.receivedKg} kg of ${pool.orderKg} kg ordered. The supplier will only be paid for what arrived.` : `📦 Food delivered to ${pool.communityHubAddr ?? 'the hub'}. Pick your collection time and collect your share.` },
  });
  for (const m of pool.members) await safeSms(m.user.phoneNumber, `Your food order has been delivered to ${pool.communityHubAddr ?? 'the hub'}. Come collect your share!`);
  await audit(driverId, 'FOOD_DELIVERED', 'FoodPool', poolId, { receivedKg: input.receivedKg ?? null, short });
  return { status: 'DELIVERED' as const, short, supplierPayable: supplierPayable(pool.netFoodBudget, pool.orderKg ?? 0, input.receivedKg ?? null), cur };
}

/** The collector records a payment THEY made out of the pool's money. Rules protect members: deposit cap, balance only after delivery. */
export async function recordFoodPayment(collectorId: string, poolId: string, input: { kind: Exclude<FoodPaymentKind, 'REFUND'>; amount: number; reference?: string; proofUrl?: string }) {
  const pool = await asCollector(poolId, collectorId);
  if (!input.reference && !input.proofUrl) throw new HttpError(400, 'Add a reference or a screenshot as proof');
  const order = await prisma.foodPurchaseOrder.findUnique({ where: { poolId }, include: { pool: { include: { winningProduct: { include: { supplier: true } } } } } });
  if (!order) throw new HttpError(400, 'The pool has not been locked yet');
  const paid = await prisma.foodPayment.groupBy({ by: ['kind'], where: { poolId }, _sum: { amount: true } });
  const sum = (k: FoodPaymentKind) => paid.find((p) => p.kind === k)?._sum.amount ?? 0;
  const supplierPaid = sum('SUPPLIER_DEPOSIT') + sum('SUPPLIER_BALANCE');
  const cur = pool.group.currency;
  let toUserId: string | undefined;

  if (input.kind === 'SUPPLIER_DEPOSIT') {
    const cap = round2(order.orderAmount * (pool.supplierDepositPct / 100));
    if (sum('SUPPLIER_DEPOSIT') + input.amount > cap + 0.001) throw new HttpError(400, `The deposit cannot exceed ${naira(cap, cur)} (${pool.supplierDepositPct}% of the order)`);
    toUserId = order.pool.winningProduct?.supplier.userId;
  } else if (input.kind === 'SUPPLIER_BALANCE') {
    if (pool.status !== 'DELIVERED') throw new HttpError(400, 'The balance is only paid after delivery is confirmed');
    const payable = supplierPayable(order.orderAmount, pool.orderKg ?? 0, pool.receivedKg);
    if (supplierPaid + input.amount > payable + 0.001) throw new HttpError(400, `You can pay the supplier at most ${naira(payable, cur)} in total for what was delivered`);
    toUserId = order.pool.winningProduct?.supplier.userId;
  } else {
    if (pool.status !== 'DELIVERED') throw new HttpError(400, 'The driver is paid after delivery is confirmed');
    if (sum('DRIVER_FEE') + input.amount > pool.transportFee + 0.001) throw new HttpError(400, `The driver fee is ${naira(pool.transportFee, cur)}`);
    toUserId = pool.driverId ?? undefined;
  }
  const payment = await prisma.foodPayment.create({ data: { poolId, kind: input.kind, amount: input.amount, toUserId, reference: input.reference, proofUrl: input.proofUrl, recordedById: collectorId } });
  await addEntry({ foodPoolId: poolId }, 'OUT', input.kind === 'DRIVER_FEE' ? 'DRIVER_PAYMENT' : 'SUPPLIER_PAYMENT', input.amount, collectorId, `${input.kind.replace(/_/g, ' ').toLowerCase()}${input.reference ? ' · ' + input.reference : ''}`, payment.id);
  const to = toUserId ? await prisma.user.findUnique({ where: { id: toUserId } }) : null;
  await safeSms(to?.phoneNumber, `Your collector recorded a payment of ${naira(input.amount, cur)} to you for the ÀJỌ food order (${input.kind.replace(/_/g, ' ').toLowerCase()}). If you did not receive it, tell the collector.`);
  await prisma.groupMessage.create({ data: { groupId: pool.groupId, senderId: collectorId, messageType: 'SYSTEM', content: `💸 Collector recorded ${input.kind.replace(/_/g, ' ').toLowerCase()}: ${naira(input.amount, cur)}.` } });
  await audit(collectorId, 'FOOD_PAYMENT_RECORDED', 'FoodPool', poolId, { kind: input.kind, amount: input.amount });
  return payment;
}

/** Collector records a refund (dissolved pool, or a member's share of the leftover) they handed back. */
export async function recordRefund(collectorId: string, poolId: string, memberId: string, input: { reference?: string; proofUrl?: string }) {
  const pool = await asCollector(poolId, collectorId);
  const member = await prisma.foodPoolMember.findUnique({ where: { id: memberId }, include: { user: true } });
  if (!member || member.poolId !== poolId) throw new HttpError(404, 'Member not found in this pool');
  if (member.refundDue <= 0 || member.refundedAt) throw new HttpError(409, 'Nothing to refund for this member');
  if (!input.reference && !input.proofUrl) throw new HttpError(400, 'Add a reference or a screenshot as proof');
  const claimed = await prisma.foodPoolMember.updateMany({ where: { id: memberId, OR: [{ refundedAt: null }, { refundedAt: { isSet: false } }] }, data: { refundedAt: new Date() } });
  if (claimed.count === 0) throw new HttpError(409, 'Already refunded');
  await prisma.foodPayment.create({ data: { poolId, kind: 'REFUND', amount: member.refundDue, toUserId: member.userId, reference: input.reference, proofUrl: input.proofUrl, recordedById: collectorId } });
  await addEntry({ foodPoolId: poolId }, 'OUT', 'REFUND', member.refundDue, collectorId, `Refund to ${member.user.fullName}`, memberId);
  await safeSms(member.user.phoneNumber, `Your collector recorded a refund of ${naira(member.refundDue, pool.group.currency)} to you. If you did not receive it, tell them or raise a dispute in ÀJỌ app.`);
  await audit(collectorId, 'FOOD_REFUND_RECORDED', 'FoodPoolMember', memberId, { amount: member.refundDue });
  return { refunded: member.refundDue };
}

export async function dissolveFoodPool(poolId: string) {
  const pool = await prisma.foodPool.findUnique({ where: { id: poolId }, include: { members: { include: { user: true } }, group: { include: { admin: true } } } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  const claimed = await prisma.foodPool.updateMany({ where: { id: poolId, status: 'COLLECTING' }, data: { status: 'DISSOLVED' } });
  if (claimed.count === 0) throw new HttpError(409, 'Pool cannot be dissolved in its current state');
  await voidPendingCommission('CCGB', poolId);

  // Only confirmed payers have money with the collector, so only they are owed a refund.
  const refundable = pool.members.filter((m) => m.isPaidVerified);
  const cur = pool.group.currency;
  for (const m of refundable) {
    const amount = pool.contributionAmt * m.shares;
    await prisma.foodPoolMember.update({ where: { id: m.id }, data: { refundDue: amount } });
    await safeSms(m.user.phoneNumber, `Your food pool was dissolved (not enough members). Your collector ${pool.group.admin.fullName} will refund ${naira(amount, cur)}. You will get an SMS when they record it.`);
  }
  if (refundable.length) await safeSms(pool.group.admin.phoneNumber, `Your food pool was dissolved. You owe ${refundable.length} member refund(s). Pay them and record each one in ÀJỌ app.`);
  await prisma.groupMessage.create({ data: { groupId: pool.groupId, messageType: 'SYSTEM', content: '❌ This food pool did not reach its target and was dissolved. The collector will refund everyone who paid.' } });
  return { refunded: refundable.length, owed: refundable.length };
}

// ── PICKUP SLOTS / COLLECTION / RATINGS ──────────────────────────

export async function createSlots(collectorId: string, poolId: string, slots: { startsAt: Date; endsAt: Date; capacity: number }[]) {
  await asCollector(poolId, collectorId);
  for (const s of slots) if (s.endsAt <= s.startsAt) throw new HttpError(400, 'A slot must end after it starts');
  await prisma.foodPickupSlot.createMany({ data: slots.map((s) => ({ poolId, ...s })) });
  return prisma.foodPickupSlot.findMany({ where: { poolId }, orderBy: { startsAt: 'asc' } });
}

export async function bookSlot(userId: string, poolId: string, slotId: string) {
  const [member, slot] = await Promise.all([
    prisma.foodPoolMember.findUnique({ where: { poolId_userId: { poolId, userId } } }),
    prisma.foodPickupSlot.findUnique({ where: { id: slotId } }),
  ]);
  if (!member || !member.isPaidVerified) throw new HttpError(403, 'Only confirmed members can book a time');
  if (!slot || slot.poolId !== poolId) throw new HttpError(404, 'Time slot not found');
  if (member.pickupSlotId === slotId) return slot;
  // Capacity is enforced atomically: the increment only happens while the slot still has room.
  const taken = await prisma.foodPickupSlot.updateMany({ where: { id: slotId, bookedCount: { lt: slot.capacity } }, data: { bookedCount: { increment: 1 } } });
  if (taken.count === 0) throw new HttpError(409, 'That time is full. Pick another.');
  if (member.pickupSlotId) await prisma.foodPickupSlot.updateMany({ where: { id: member.pickupSlotId, bookedCount: { gt: 0 } }, data: { bookedCount: { decrement: 1 } } });
  await prisma.foodPoolMember.update({ where: { id: member.id }, data: { pickupSlotId: slotId } });
  return prisma.foodPickupSlot.findUniqueOrThrow({ where: { id: slotId } });
}

export async function markCollected(collectorId: string, poolId: string, memberId: string) {
  await asCollector(poolId, collectorId);
  const m = await prisma.foodPoolMember.findUnique({ where: { id: memberId } });
  if (!m || m.poolId !== poolId) throw new HttpError(404, 'Member not found in this pool');
  return prisma.foodPoolMember.update({ where: { id: memberId }, data: { collectedAt: new Date() } });
}

export async function ratePool(userId: string, poolId: string, input: { stars: number; qualityOk: boolean; comment?: string }) {
  const pool = await poolWithGroup(poolId);
  if (pool.status !== 'DELIVERED') throw new HttpError(400, 'You can rate once the food has been delivered');
  const member = await prisma.foodPoolMember.findUnique({ where: { poolId_userId: { poolId, userId } } });
  if (!member?.isPaidVerified) throw new HttpError(403, 'Only members of this pool can rate');
  const order = await prisma.foodPurchaseOrder.findUnique({ where: { poolId } });
  if (!order) throw new HttpError(400, 'No order found');
  try {
    await prisma.supplierRating.create({ data: { supplierId: order.supplierId, poolId, userId, stars: input.stars, qualityOk: input.qualityOk, comment: input.comment } });
  } catch (e: any) {
    if (e.code === 'P2002') throw new HttpError(409, 'You have already rated this delivery');
    throw e;
  }
  const agg = await prisma.supplierRating.aggregate({ where: { supplierId: order.supplierId }, _avg: { stars: true }, _count: { _all: true } });
  await prisma.ccgbSupplier.update({ where: { id: order.supplierId }, data: { ratingAvg: round2(agg._avg.stars ?? 0), ratingCount: agg._count._all } });
  if (!input.qualityOk) {
    await prisma.dispute.create({ data: { groupId: pool.groupId, foodPoolId: poolId, raisedById: userId, kind: 'FOOD_QUALITY', description: input.comment || 'Member reported a quality problem with the delivery.' } });
    await safeSms(pool.group.admin.phoneNumber, 'A member reported a food quality problem. Please review it in ÀJỌ app.');
  }
  return { rated: true };
}

/** Suppliers can change availability any time, but not the price of an item that is locked into a live order. */
export async function updateProduct(supplierUserId: string, productId: string, input: { unitPrice?: number; isAvailable?: boolean }) {
  const product = await prisma.ccgbProduct.findUnique({ where: { id: productId }, include: { supplier: true } });
  if (!product || product.supplier.userId !== supplierUserId) throw new HttpError(404, 'Product not found');
  if (input.unitPrice !== undefined && input.unitPrice !== product.unitPrice) {
    const locked = await prisma.foodPool.count({ where: { winningProductId: productId, status: { in: ['LOCKED', 'DISPATCHED'] } } });
    if (locked > 0) throw new HttpError(409, 'This price is locked by an order in progress and cannot be changed until delivery');
  }
  return prisma.ccgbProduct.update({ where: { id: productId }, data: input });
}
