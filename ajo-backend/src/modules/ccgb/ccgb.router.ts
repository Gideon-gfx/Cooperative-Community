import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { assertGroupAdmin, assertGroupMember } from '../../lib/access';
import { objectId } from '../../lib/validators';
import { verifyPin } from '../../lib/security';
import { round2 } from '../../lib/money';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { attestFunds, getLedger } from '../../services/ledger.service';
import { assertCanStartCycle } from '../billing/billing.service';
import {
  bookSlot, confirmDelivery, createSlots, getVoteTallies, joinFoodPool, lockAndProcessPool, markCollected, ratePool, recordFoodPayment,
  recordRefund, updateProduct, verifyFoodPayment, voteFoodItem,
} from './ccgb.service';

export const ccgbRouter = Router();

// ── Public ──
ccgbRouter.get('/suppliers/products', async (req, res) => {
  const q = z.object({ category: z.string().optional(), availableOnly: z.enum(['true', 'false']).optional() }).parse(req.query);
  const products = await prisma.ccgbProduct.findMany({
    where: { supplier: { isAdminApproved: true }, ...(q.category ? { category: q.category } : {}), ...(q.availableOnly === 'true' ? { isAvailable: true } : {}) },
    include: { supplier: { select: { businessName: true, supplierType: true, ratingAvg: true, ratingCount: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ products });
});

ccgbRouter.use(authenticate);

// ── Suppliers ──
ccgbRouter.post('/suppliers/register', async (req, res) => {
  const b = z
    .object({ businessName: z.string().min(2), supplierType: z.enum(['FACTORY', 'LARGE_WHOLESALER', 'FARMER']), rcNumber: z.string().optional(), locationLat: z.number().optional(), locationLng: z.number().optional() })
    .parse(req.body);
  res.status(201).json({ supplier: await prisma.ccgbSupplier.create({ data: { ...b, userId: req.user!.id } }) });
});

ccgbRouter.post('/suppliers/products', async (req, res) => {
  const b = z.object({ name: z.string().min(2), category: z.string().min(2), unitPrice: z.number().positive(), kgWeightPerUnit: z.number().positive(), imageUrl: z.string().url().optional() }).parse(req.body);
  const supplier = await prisma.ccgbSupplier.findUnique({ where: { userId: req.user!.id } });
  if (!supplier) throw new HttpError(403, 'Register as a supplier first');
  if (!supplier.isAdminApproved) throw new HttpError(403, 'Your supplier account is awaiting admin approval');
  res.status(201).json({ product: await prisma.ccgbProduct.create({ data: { ...b, supplierId: supplier.id } }) });
});

ccgbRouter.patch('/suppliers/products/:id', async (req, res) => {
  const b = z.object({ unitPrice: z.number().positive().optional(), isAvailable: z.boolean().optional() }).parse(req.body);
  res.json({ product: await updateProduct(req.user!.id, String(req.params.id), b) });
});

/** The signed-in user's supplier profile and products (404 if they have not registered). */
ccgbRouter.get('/suppliers/me', async (req, res) => {
  const supplier = await prisma.ccgbSupplier.findUnique({ where: { userId: req.user!.id }, include: { products: { orderBy: { createdAt: 'desc' } } } });
  res.json({ supplier });
});

/** Delivery jobs for a transporter. Drivers are not group members, so they get their own limited view. */
ccgbRouter.get('/jobs', roleGuard(['TRANSPORTER']), async (req, res) => {
  const pools = await prisma.foodPool.findMany({
    where: { driverId: req.user!.id, status: { in: ['LOCKED', 'DISPATCHED', 'DELIVERED'] } },
    include: { group: { select: { name: true, currency: true } }, winningProduct: { include: { supplier: { select: { businessName: true, locationLat: true, locationLng: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  res.json({
    jobs: pools.map((p) => ({
      poolId: p.id, status: p.status, groupName: p.group.name, currency: p.group.currency, hub: p.communityHubAddr,
      pickup: p.winningProduct?.supplier.businessName, product: p.winningProduct?.name, orderUnits: p.orderUnits, orderKg: p.orderKg,
      fee: p.transportFee, deliveredAt: p.deliveredAt, receivedKg: p.receivedKg,
    })),
  });
});

// ── Admin ──
ccgbRouter.patch('/admin/suppliers/:id/approve', roleGuard(['ADMIN']), async (req, res) => {
  const s = await prisma.ccgbSupplier.findUnique({ where: { id: String(req.params.id) } });
  if (!s) throw new HttpError(404, 'Supplier not found');
  res.json({ supplier: await prisma.ccgbSupplier.update({ where: { id: s.id }, data: { isAdminApproved: !s.isAdminApproved } }) });
});

ccgbRouter.patch('/admin/members/:id/verify-payment', roleGuard(['ADMIN', 'COLLECTOR']), async (req, res) => {
  res.json({ member: await verifyFoodPayment(req.user!, String(req.params.id)) });
});

// ── Pools ──
ccgbRouter.post('/pools/create', roleGuard(['COLLECTOR', 'ADMIN']), async (req, res) => {
  const b = z
    .object({
      groupId: objectId, contributionAmt: z.number().positive(), targetMembers: z.number().int().min(2), communityHubAddr: z.string().min(3),
      liveWindowHours: z.number().positive().max(24 * 30).default(48), supplierDepositPct: z.number().min(0).max(100).default(50),
    })
    .parse(req.body);
  const group = await assertGroupAdmin(b.groupId, req.user!.id);
  await assertCanStartCycle(req.user!); // new cycles only: running cycles and members are never blocked
  const pool = await prisma.foodPool.create({
    data: {
      groupId: b.groupId, contributionAmt: b.contributionAmt, targetMembers: b.targetMembers, communityHubAddr: b.communityHubAddr,
      supplierDepositPct: b.supplierDepositPct, liveWindowEnd: new Date(Date.now() + b.liveWindowHours * 3600 * 1000),
    },
  });
  await prisma.groupMessage.create({
    data: { groupId: b.groupId, messageType: 'SYSTEM', content: `🛒 A new food pool is open: ${b.contributionAmt.toLocaleString()} ${group.currency} per share, ${b.targetMembers} members needed. Your collector holds the money; every payment is shown in the ledger.` },
  });
  res.status(201).json({ pool });
});

ccgbRouter.get('/my-pools', async (req, res) => {
  const pools = await prisma.foodPool.findMany({
    where: { OR: [{ members: { some: { userId: req.user!.id } } }, { group: { adminId: req.user!.id } }] },
    include: { group: { select: { name: true, currency: true } }, winningProduct: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ pools });
});

ccgbRouter.get('/pools/:id', async (req, res) => {
  const pool = await prisma.foodPool.findUnique({
    where: { id: String(req.params.id) },
    include: { group: { select: { id: true, name: true, adminId: true, currency: true } }, winningProduct: { include: { supplier: { select: { businessName: true, ratingAvg: true, ratingCount: true } } } } },
  });
  if (!pool) throw new HttpError(404, 'Pool not found');
  await assertGroupMember(pool.groupId, req.user!.id);
  const isCollector = pool.group.adminId === req.user!.id || req.user!.role === 'ADMIN';
  const [me, slots, payments, ledger, myRating] = await Promise.all([
    prisma.foodPoolMember.findUnique({ where: { poolId_userId: { poolId: pool.id, userId: req.user!.id } } }),
    prisma.foodPickupSlot.findMany({ where: { poolId: pool.id }, orderBy: { startsAt: 'asc' } }),
    prisma.foodPayment.groupBy({ by: ['kind'], where: { poolId: pool.id }, _sum: { amount: true } }),
    getLedger({ foodPoolId: pool.id }),
    prisma.supplierRating.findUnique({ where: { poolId_userId: { poolId: pool.id, userId: req.user!.id } } }),
  ]);
  const members = isCollector
    ? await prisma.foodPoolMember.findMany({ where: { poolId: pool.id }, include: { user: { select: { fullName: true } } } })
    : undefined;
  const paid = (k: string) => round2(payments.find((p) => p.kind === k)?._sum.amount ?? 0);
  res.json({
    pool,
    currency: pool.group.currency,
    tallies: await getVoteTallies(pool.id),
    isCollector,
    myMembership: me,
    iRated: !!myRating,
    slots: slots.map((s) => ({ ...s, full: s.bookedCount >= s.capacity })),
    paid: { supplierDeposit: paid('SUPPLIER_DEPOSIT'), supplierBalance: paid('SUPPLIER_BALANCE'), driver: paid('DRIVER_FEE'), refunds: paid('REFUND') },
    funds: { heldByCollector: ledger.heldByCollector, totalIn: ledger.totalIn, totalOut: ledger.totalOut, lastAttestation: ledger.lastAttestation },
    members: members?.map((m) => ({ id: m.id, fullName: m.user.fullName, shares: m.shares, proofOfPaymentUrl: m.proofOfPaymentUrl, isPaidVerified: m.isPaidVerified, pickupSlotId: m.pickupSlotId, collectedAt: m.collectedAt, refundDue: m.refundDue, refundedAt: m.refundedAt })),
  });
});

ccgbRouter.post('/pools/join', async (req, res) => {
  const b = z.object({ poolId: objectId, proofOfPaymentUrl: z.string().url(), shares: z.number().int().min(1).max(10).default(1) }).parse(req.body);
  res.status(201).json({ member: await joinFoodPool(req.user!.id, b.poolId, b.proofOfPaymentUrl, b.shares) });
});

ccgbRouter.post('/pools/vote', async (req, res) => {
  const b = z.object({ poolId: objectId, productId: objectId }).parse(req.body);
  res.json({ tallies: await voteFoodItem(req.user!.id, b.poolId, b.productId) });
});

ccgbRouter.post('/pools/:id/lock', roleGuard(['COLLECTOR', 'ADMIN']), async (req, res) => {
  const pool = await prisma.foodPool.findUnique({ where: { id: String(req.params.id) } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  await assertGroupAdmin(pool.groupId, req.user!.id, true, req.user!.role);
  res.json(await lockAndProcessPool(pool.id));
});

ccgbRouter.post('/pools/:id/confirm-delivery', roleGuard(['TRANSPORTER']), async (req, res) => {
  const b = z.object({ proofUrl: z.string().url(), receivedKg: z.number().positive().optional() }).parse(req.body);
  res.json(await confirmDelivery(req.user!.id, String(req.params.id), b));
});

// ── Collector custody: payments out, refunds, ledger ──
ccgbRouter.post('/pools/:id/payments', roleGuard(['COLLECTOR']), async (req, res) => {
  const b = z.object({ kind: z.enum(['SUPPLIER_DEPOSIT', 'SUPPLIER_BALANCE', 'DRIVER_FEE']), amount: z.number().positive(), reference: z.string().max(100).optional(), proofUrl: z.string().url().optional(), pin: z.string() }).parse(req.body);
  await verifyPin(req.user!.id, b.pin);
  res.status(201).json({ payment: await recordFoodPayment(req.user!.id, String(req.params.id), b) });
});

ccgbRouter.post('/pools/:id/refunds/:memberId', roleGuard(['COLLECTOR']), async (req, res) => {
  const b = z.object({ reference: z.string().max(100).optional(), proofUrl: z.string().url().optional(), pin: z.string() }).parse(req.body);
  await verifyPin(req.user!.id, b.pin);
  res.json(await recordRefund(req.user!.id, String(req.params.id), String(req.params.memberId), b));
});

ccgbRouter.get('/pools/:id/ledger', async (req, res) => {
  const pool = await prisma.foodPool.findUnique({ where: { id: String(req.params.id) }, include: { group: true } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  await assertGroupMember(pool.groupId, req.user!.id);
  res.json({ currency: pool.group.currency, isCollector: pool.group.adminId === req.user!.id, ...(await getLedger({ foodPoolId: pool.id })) });
});

ccgbRouter.post('/pools/:id/attest', roleGuard(['COLLECTOR']), async (req, res) => {
  const b = z.object({ declaredAmount: z.number().min(0), note: z.string().max(200).optional(), proofUrl: z.string().url().optional(), pin: z.string() }).parse(req.body);
  await verifyPin(req.user!.id, b.pin);
  const pool = await prisma.foodPool.findUnique({ where: { id: String(req.params.id) }, include: { group: true } });
  if (!pool) throw new HttpError(404, 'Pool not found');
  await assertGroupAdmin(pool.groupId, req.user!.id);
  res.status(201).json(await attestFunds({ foodPoolId: pool.id }, req.user!.id, pool.groupId, pool.group.currency, b));
});

// ── Pickup, collection, ratings ──
ccgbRouter.post('/pools/:id/slots', roleGuard(['COLLECTOR']), async (req, res) => {
  const b = z.object({ slots: z.array(z.object({ startsAt: z.coerce.date(), endsAt: z.coerce.date(), capacity: z.number().int().min(1).max(500) })).min(1).max(20) }).parse(req.body);
  res.status(201).json({ slots: await createSlots(req.user!.id, String(req.params.id), b.slots) });
});
ccgbRouter.post('/pools/:id/slots/:slotId/book', async (req, res) => {
  res.json({ slot: await bookSlot(req.user!.id, String(req.params.id), String(req.params.slotId)) });
});
ccgbRouter.post('/pools/:id/members/:memberId/collected', roleGuard(['COLLECTOR']), async (req, res) => {
  res.json({ member: await markCollected(req.user!.id, String(req.params.id), String(req.params.memberId)) });
});
ccgbRouter.post('/pools/:id/rate', async (req, res) => {
  const b = z.object({ stars: z.number().int().min(1).max(5), qualityOk: z.boolean().default(true), comment: z.string().max(300).optional() }).parse(req.body);
  res.status(201).json(await ratePool(req.user!.id, String(req.params.id), b));
});
