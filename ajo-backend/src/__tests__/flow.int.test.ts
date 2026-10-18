import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const sms: { to: string; msg: string }[] = [];
jest.mock('../services/termii.service', () => ({ sendSms: async (to: string, msg: string) => void sms.push({ to, msg }) }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let rs: MongoMemoryReplSet;
let prisma: any, ajo: any, ccgb: any, ledger: any, trust: any, ussd: any, security: any;

const mkUser = (phone: string, name: string, extra: Record<string, unknown> = {}) =>
  prisma.user.create({ data: { phoneNumber: phone, fullName: name, isVerified: true, ...extra } });

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ binary: { version: '6.0.14' }, instanceOpts: [{ launchTimeout: 60000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const url = `${rs.getUri().split('/?')[0]}/ajo?replicaSet=testset`;
  process.env.DATABASE_URL = url;
  process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'ajo-int-uploads');
  process.env.CCGB_PLATFORM_FEE_RATE = '0';
  process.env.AJO_PLATFORM_FEE_RATE = '0';
  // async (not execFileSync): blocking the event loop here stalls the in-process replica-set monitor
  await promisify(execFile)(path.resolve('node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'], { env: { ...process.env, DATABASE_URL: url }, timeout: 150000 });
  ({ prisma } = require('../lib/prisma'));
  ajo = require('../modules/ajo/ajo.service');
  ccgb = require('../modules/ccgb/ccgb.service');
  ledger = require('../services/ledger.service');
  trust = require('../services/trust.service');
  ussd = require('../modules/ussd/ussd.service');
  security = require('../lib/security');
});

afterAll(async () => {
  await prisma?.$disconnect();
  await rs?.stop();
});

describe('Àjọ with collector custody', () => {
  let collector: any, A: any, B: any, C: any, group: any, pool: any, schedules: any[];

  it('creates a pool: one slot per member, everyone else pays into each cycle', async () => {
    collector = await mkUser('+2348000000001', 'Baba Collector', { role: 'COLLECTOR', collectorApproved: true });
    [A, B, C] = await Promise.all([mkUser('+2348000000002', 'Ada'), mkUser('+2348000000003', 'Bola'), mkUser('+2348000000004', 'Chidi')]);
    group = await prisma.communityGroup.create({
      data: { name: 'Market Women', adminId: collector.id, members: { create: [collector, A, B, C].map((u) => ({ userId: u.id })) } },
    });
    const full = await ajo.createAjoPool(collector.id, group.id, {
      title: 'Weekly Àjọ', amountPerMember: 1000, cycleFrequency: 'WEEKLY', collectorFeePct: 2,
      memberIds: [A.id, B.id, C.id], startDate: new Date(), preserveOrder: true,
    });
    pool = full;
    schedules = full.schedules;
    expect(schedules.map((s) => s.recipientId)).toEqual([A.id, B.id, C.id]);
    const rows = await prisma.ajoContribution.findMany({ where: { ajoPoolId: pool.id } });
    expect(rows).toHaveLength(6);
    expect(rows.some((r: any) => r.scheduleId === schedules[0].id && r.contributorId === A.id)).toBe(false);
  });

  it('member payment waits for the collector; instalments and collector-recorded cash complete the cycle', async () => {
    const s1 = schedules[0].id;
    const bPay = await ajo.recordPayment(B, { scheduleId: s1, method: 'TRANSFER', reference: 'TRF-1' });
    expect(bPay.payment.status).toBe('PENDING');
    expect(bPay.contributionVerified).toBe(false);

    const bContribution = await prisma.ajoContribution.findFirstOrThrow({ where: { scheduleId: s1, contributorId: B.id } });
    await expect(ajo.verifyContribution(B, bContribution.id)).rejects.toThrow(/collector/i); // members can't verify
    await ajo.verifyContribution(collector, bContribution.id);
    expect((await prisma.ajoContribution.findUniqueOrThrow({ where: { id: bContribution.id } })).status).toBe('VERIFIED');

    // C pays in two instalments: 600 by transfer (needs confirming) + 400 cash handed to the collector
    await ajo.recordPayment(C, { scheduleId: s1, amount: 600, method: 'TRANSFER' });
    const cContribution = await prisma.ajoContribution.findFirstOrThrow({ where: { scheduleId: s1, contributorId: C.id } });
    await ajo.verifyContribution(collector, cContribution.id);
    const mid = await prisma.ajoContribution.findUniqueOrThrow({ where: { id: cContribution.id } });
    expect(mid.paidAmount).toBe(600);
    expect(mid.status).not.toBe('VERIFIED');
    await expect(ajo.recordPayment(C, { scheduleId: s1, amount: 500 })).rejects.toThrow(/between 0 and 400/); // can't overpay

    const cash = await ajo.recordPayment(collector, { scheduleId: s1, contributorId: C.id, amount: 400, method: 'CASH' });
    expect(cash.payment.status).toBe('VERIFIED'); // collector holds the cash, so it's confirmed at once
    expect(cash.readyForPayout).toBe(true);
    expect((await prisma.ajoRotationSchedule.findUniqueOrThrow({ where: { id: s1 } })).status).toBe('READY');
  });

  it('ledger shows exactly what the collector holds', async () => {
    const l = await ajo.poolLedger(pool.id);
    expect(l.totalIn).toBe(2000);
    expect(l.totalOut).toBe(0);
    expect(l.heldByCollector).toBe(2000);
  });

  it('collector records the payout; ledger and receipt follow; it cannot be recorded twice', async () => {
    const s1 = schedules[0].id;
    await expect(ajo.recordPayout(collector.id, s1, { method: 'TRANSFER' })).rejects.toThrow(/reference|proof/i);
    const out = await ajo.recordPayout(collector.id, s1, { method: 'TRANSFER', reference: 'BANK-REF-9' });
    expect(out).toMatchObject({ totalCollected: 2000, collectorFee: 40, netPayout: 1960, platformFee: 0 });
    expect(out.receiptUrl).toMatch(/\/files\/ajo\/receipts\/.*\.pdf$/);
    await expect(ajo.recordPayout(collector.id, s1, { method: 'CASH' })).rejects.toThrow(/already/i);

    const l = await ajo.poolLedger(pool.id);
    expect(l.totalOut).toBe(2000);
    expect(l.heldByCollector).toBe(0);
    expect(sms.some((m) => m.to === A.phoneNumber && /paid you/.test(m.msg) && /CONFIRM/.test(m.msg))).toBe(true);
  });

  it('only the recipient can confirm; "not received" opens a dispute', async () => {
    const s1 = schedules[0].id;
    await expect(ajo.confirmReceipt(B.id, s1, true)).rejects.toThrow(/recipient/i);
    const res = await ajo.confirmReceipt(A.id, s1, true);
    expect(res.status).toBe('COMPLETED');
    expect((await prisma.ajoRotationSchedule.findUniqueOrThrow({ where: { id: s1 } })).recipientConfirmedAt).not.toBeNull();

    const disputed = await ajo.confirmReceipt(A.id, s1, false, 'Nothing arrived');
    expect(disputed.status).toBe('DISPUTED');
    expect(await prisma.dispute.count({ where: { scheduleId: s1, kind: 'PAYOUT_NOT_RECEIVED' } })).toBe(1);
  });

  it('flags only members who recorded NO payment; WARNED then DEFAULTER; trust reflects it', async () => {
    const [, s2, s3] = schedules;
    const past = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    await prisma.ajoContribution.updateMany({ where: { scheduleId: { in: [s2.id, s3.id] } }, data: { dueAt: past } });

    await ajo.recordPayment(C, { scheduleId: s2.id, method: 'TRANSFER' }); // C reported paying on cycle 2 → must not be flagged
    expect(await ajo.flagDefaulter(s2.id)).toBe(1); // only A
    expect((await prisma.user.findUniqueOrThrow({ where: { id: A.id } })).memberStatus).toBe('WARNED');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: C.id } })).memberStatus).toBe('CLEAN');

    await ajo.flagDefaulter(s3.id); // A misses again
    expect((await prisma.user.findUniqueOrThrow({ where: { id: A.id } })).memberStatus).toBe('DEFAULTER');
    expect((await trust.getTrust(A.id)).missed).toBe(2);
    expect((await trust.getTrust(B.id)).verified).toBe(1);
  });

  it('collector can cover a missed share; it counts against the member', async () => {
    const s3 = schedules[2].id;
    const aRow = await prisma.ajoContribution.findFirstOrThrow({ where: { scheduleId: s3, contributorId: A.id } });
    const res = await ajo.recordPayment(collector, { contributionId: aRow.id, contributorId: A.id, coverShortfall: true });
    expect(res.payment.reference).toBe('COVERED_BY_COLLECTOR');
    const after = await prisma.ajoContribution.findUniqueOrThrow({ where: { id: aRow.id } });
    expect(after).toMatchObject({ status: 'VERIFIED', coveredByCollector: true });
    expect((await trust.getTrust(A.id)).missed).toBe(2); // 1 still MISSED (cycle 2) + 1 covered (cycle 3)
  });

  it('collector declares their balance; a mismatch is announced to the group', async () => {
    const r = await ledger.attestFunds({ ajoPoolId: pool.id }, collector.id, group.id, 'NGN', { declaredAmount: 500 });
    expect(r.mismatch).not.toBe(0);
    const msg = await prisma.groupMessage.findFirst({ where: { groupId: group.id, content: { contains: 'difference' } } });
    expect(msg).not.toBeNull();
  });

  it('a defaulter needs a guarantor to join a new pool', async () => {
    const base = { title: 'P2', amountPerMember: 500, cycleFrequency: 'WEEKLY', collectorFeePct: 2, memberIds: [A.id, B.id, C.id], startDate: new Date(), preserveOrder: true };
    await expect(ajo.createAjoPool(collector.id, group.id, base)).rejects.toThrow(/defaulter/i);
    const ok = await ajo.createAjoPool(collector.id, group.id, { ...base, guarantors: { [A.id]: C.id } });
    expect(ok.schedules).toHaveLength(3);
    expect(await prisma.ajoGuarantee.count({ where: { ajoPoolId: ok.id } })).toBe(1);
    pool = ok;
    schedules = ok.schedules;
  });

  it('turn swap: peer accepts, collector approves, contribution rows follow the new recipients', async () => {
    const [s1, s2] = schedules; // A then B
    const swap = await ajo.requestSwap(A.id, pool.id, s1.id, s2.id, 'Emergency');
    await expect(ajo.decideSwap(collector.id, swap.id, true)).rejects.toThrow(/not waiting/i);
    await expect(ajo.respondSwap(C.id, swap.id, true)).rejects.toThrow(/not for you/i);
    await ajo.respondSwap(B.id, swap.id, true);
    await ajo.decideSwap(collector.id, swap.id, true);

    const [n1, n2] = await Promise.all([s1.id, s2.id].map((id) => prisma.ajoRotationSchedule.findUniqueOrThrow({ where: { id } })));
    expect(n1.recipientId).toBe(B.id);
    expect(n2.recipientId).toBe(A.id);
    for (const s of [n1, n2]) {
      const rows = await prisma.ajoContribution.findMany({ where: { scheduleId: s.id } });
      expect(rows).toHaveLength(2);
      expect(rows.some((r: any) => r.contributorId === s.recipientId)).toBe(false); // nobody pays into their own cycle
    }
  });

  it('exports a CSV record for the collector only', async () => {
    const csv = await ajo.exportPoolCsv(collector.id, schedules[0].ajoPoolId);
    expect(csv).toContain('LEDGER');
    await expect(ajo.exportPoolCsv(A.id, schedules[0].ajoPoolId)).rejects.toThrow(/collector/i);
  });
});

describe('PIN + USSD for an assisted account (no smartphone)', () => {
  it('collector-created member sets their own PIN by USSD, then reads balances', async () => {
    const collector = await mkUser('+2348000000101', 'Baba Two', { role: 'COLLECTOR', collectorApproved: true });
    const member = await mkUser('+2348000000102', 'Mama Rural', {
      accountType: 'ASSISTED', createdByAgentId: collector.id, pinHash: security.hashPin('4821'), pinMustChange: true, preferredLanguage: 'PCM',
    });
    const dial = (text: string) => ussd.handleUssd({ phoneNumber: member.phoneNumber, text });
    expect(await dial('')).toMatch(/temporary PIN|temporary/i);
    expect(await dial('9999')).toMatch(/^END Wrong PIN/);
    expect(await dial('4821')).toMatch(/^CON Choose new/);
    expect(await dial('4821*7351')).toMatch(/^END PIN don save/);
    expect(await dial('')).toMatch(/^CON ÀJỌ/);
    expect(await dial('1')).toMatch(/^END You no get any money/); // pidgin, nothing due
    await expect(security.verifyPin(member.id, '7351')).resolves.toBeUndefined();
  });

  it('five wrong PINs lock the account', async () => {
    const u = await mkUser('+2348000000103', 'Lock Me', { pinHash: security.hashPin('1357') });
    for (let i = 0; i < 4; i++) await expect(security.verifyPin(u.id, '0000')).rejects.toThrow(/Wrong PIN/);
    await expect(security.verifyPin(u.id, '0000')).rejects.toThrow(/Locked|Too many/i);
    await expect(security.verifyPin(u.id, '1357')).rejects.toThrow(/Too many/i); // even the right PIN, while locked
  });
});

describe('Food pool with collector custody', () => {
  let collector: any, A: any, B: any, C: any, driver: any, supplierUser: any, supplier: any, product: any, group: any, pool: any, members: Record<string, any>;

  it('shares, confirmed payments, vote, lock at a fixed price', async () => {
    collector = await mkUser('+2348000000201', 'Baba Food', { role: 'COLLECTOR', collectorApproved: true, locationLat: 6.5, locationLng: 3.3 });
    [A, B, C] = await Promise.all([mkUser('+2348000000202', 'A'), mkUser('+2348000000203', 'B'), mkUser('+2348000000204', 'C')]);
    driver = await mkUser('+2348000000205', 'Driver', { role: 'TRANSPORTER', locationLat: 6.5, locationLng: 3.31 });
    supplierUser = await mkUser('+2348000000206', 'Supplier');
    supplier = await prisma.ccgbSupplier.create({ data: { userId: supplierUser.id, businessName: 'Rice Mill', supplierType: 'FACTORY', isAdminApproved: true, locationLat: 6.5, locationLng: 3.3 } });
    product = await prisma.ccgbProduct.create({ data: { supplierId: supplier.id, name: 'Rice 50kg', category: 'grains', unitPrice: 7000, kgWeightPerUnit: 50 } });
    group = await prisma.communityGroup.create({ data: { name: 'Food Group', adminId: collector.id, members: { create: [collector, A, B, C].map((u) => ({ userId: u.id })) } } });
    pool = await prisma.foodPool.create({ data: { groupId: group.id, contributionAmt: 5000, targetMembers: 3, communityHubAddr: 'Hall', liveWindowEnd: new Date(Date.now() + 3600_000) } });

    members = {};
    for (const [u, shares] of [[A, 2], [B, 1], [C, 1]] as const) members[u.id] = await ccgb.joinFoodPool(u.id, pool.id, 'https://x/proof.jpg', shares);
    await expect(ccgb.joinFoodPool(A.id, pool.id, 'https://x/p.jpg')).rejects.toThrow(/already/i);
    // money only counts once the collector confirms it
    expect((await prisma.foodPool.findUniqueOrThrow({ where: { id: pool.id } })).totalFund).toBe(0);
    await expect(ccgb.voteFoodItem(A.id, pool.id, product.id)).rejects.toThrow(/not been confirmed/i);

    await expect(ccgb.verifyFoodPayment(A, members[A.id].id)).rejects.toThrow(/collector or an admin/i);
    for (const u of [A, B, C]) await ccgb.verifyFoodPayment(collector, members[u.id].id);
    expect((await prisma.foodPool.findUniqueOrThrow({ where: { id: pool.id } })).totalFund).toBe(20000);
    for (const u of [A, B, C]) await ccgb.voteFoodItem(u.id, pool.id, product.id);

    const res = await ccgb.lockAndProcessPool(pool.id);
    // 20000 − 5000 base transport (supplier = hub, 0 km) = 15000 → 2 whole units at the locked ₦7000
    expect(res).toMatchObject({ transportFee: 5000, netFoodBudget: 15000, units: 2, orderAmount: 14000, leftover: 1000, driverId: driver.id });
    pool = await prisma.foodPool.findUniqueOrThrow({ where: { id: pool.id } });
    expect(pool).toMatchObject({ status: 'LOCKED', lockedUnitPrice: 7000, orderKg: 100 });
  });

  it('price is locked while the order is in progress', async () => {
    await expect(ccgb.updateProduct(supplierUser.id, product.id, { unitPrice: 9000 })).rejects.toThrow(/locked/i);
    await expect(ccgb.updateProduct(supplierUser.id, product.id, { isAvailable: true })).resolves.toBeDefined();
  });

  it('supplier deposit is capped; the balance waits for delivery', async () => {
    const pay = (kind: string, amount: number) => ccgb.recordFoodPayment(collector.id, pool.id, { kind, amount, reference: 'TRF' });
    await expect(pay('SUPPLIER_DEPOSIT', 8000)).rejects.toThrow(/cannot exceed/i); // cap is 50% of ₦14,000 = ₦7,000
    await pay('SUPPLIER_DEPOSIT', 7000);
    await expect(pay('SUPPLIER_BALANCE', 1000)).rejects.toThrow(/after delivery/i);
    await expect(pay('DRIVER_FEE', 5000)).rejects.toThrow(/after delivery/i);
    await expect(ccgb.recordFoodPayment(collector.id, pool.id, { kind: 'SUPPLIER_DEPOSIT', amount: 1 })).rejects.toThrow(/proof/i);
  });

  it('delivery needs a photo; a short delivery cuts the supplier balance proportionally', async () => {
    await expect(ccgb.confirmDelivery(A.id, pool.id, { proofUrl: 'https://x/d.jpg' })).rejects.toThrow(/not the assigned/i);
    await expect(ccgb.confirmDelivery(driver.id, pool.id, { proofUrl: '' })).rejects.toThrow(/photo/i);
    const d = await ccgb.confirmDelivery(driver.id, pool.id, { proofUrl: 'https://x/delivery.jpg', receivedKg: 50 }); // only half arrived
    expect(d).toMatchObject({ short: true, status: 'DELIVERED' });
    expect(await prisma.dispute.count({ where: { foodPoolId: pool.id, kind: 'FOOD_SHORTFALL' } })).toBe(1);

    const pay = (kind: string, amount: number) => ccgb.recordFoodPayment(collector.id, pool.id, { kind, amount, reference: 'TRF' });
    // supplier is owed ₦7,000 for the 50 kg that arrived and has already had ₦7,000 as a deposit
    await expect(pay('SUPPLIER_BALANCE', 1)).rejects.toThrow(/at most/i);
    await pay('DRIVER_FEE', 5000);
    await expect(pay('DRIVER_FEE', 1)).rejects.toThrow(/driver fee/i);
  });

  it('pickup slots respect capacity; leftover is shared back by shares; refunds are recorded', async () => {
    const [slot] = await ccgb.createSlots(collector.id, pool.id, [{ startsAt: new Date(Date.now() + 3600_000), endsAt: new Date(Date.now() + 7200_000), capacity: 1 }]).then((s: any[]) => s);
    await ccgb.bookSlot(A.id, pool.id, slot.id);
    await expect(ccgb.bookSlot(B.id, pool.id, slot.id)).rejects.toThrow(/full/i);
    expect((await prisma.foodPickupSlot.findUniqueOrThrow({ where: { id: slot.id } })).bookedCount).toBe(1);

    // ₦1,000 leftover over 4 shares: A (2 shares) ₦500, B ₦250, C ₦250
    const owed = Object.fromEntries((await prisma.foodPoolMember.findMany({ where: { poolId: pool.id } })).map((m: any) => [m.userId, m.refundDue]));
    expect(owed).toEqual({ [A.id]: 500, [B.id]: 250, [C.id]: 250 });
    await ccgb.recordRefund(collector.id, pool.id, members[A.id].id, { reference: 'REF-1' });
    await expect(ccgb.recordRefund(collector.id, pool.id, members[A.id].id, { reference: 'REF-1' })).rejects.toThrow(/nothing|already/i);
    await ccgb.markCollected(collector.id, pool.id, members[A.id].id);
  });

  it('ratings update the supplier average once per member; a quality complaint opens a dispute', async () => {
    await ccgb.ratePool(B.id, pool.id, { stars: 4, qualityOk: true });
    await ccgb.ratePool(C.id, pool.id, { stars: 2, qualityOk: false, comment: 'Bags were wet' });
    await expect(ccgb.ratePool(B.id, pool.id, { stars: 5, qualityOk: true })).rejects.toThrow(/already/i);
    const s = await prisma.ccgbSupplier.findUniqueOrThrow({ where: { id: supplier.id } });
    expect(s).toMatchObject({ ratingAvg: 3, ratingCount: 2 });
    expect(await prisma.dispute.count({ where: { foodPoolId: pool.id, kind: 'FOOD_QUALITY' } })).toBe(1);
  });

  it('the food ledger adds up: in − out = what the collector holds', async () => {
    const l = await ledger.getLedger({ foodPoolId: pool.id });
    expect(l.totalIn).toBe(20000);
    expect(l.totalOut).toBe(7000 + 5000 + 500); // deposit + driver + A's refund
    expect(l.heldByCollector).toBe(7500);
  });

  it('a pool that misses its target dissolves and owes refunds only to confirmed payers', async () => {
    const p2 = await prisma.foodPool.create({ data: { groupId: group.id, contributionAmt: 3000, targetMembers: 10, communityHubAddr: 'Hall', liveWindowEnd: new Date(Date.now() + 3600_000) } });
    const m1 = await ccgb.joinFoodPool(A.id, p2.id, 'https://x/a.jpg');
    await ccgb.joinFoodPool(B.id, p2.id, 'https://x/b.jpg'); // never confirmed
    await ccgb.verifyFoodPayment(collector, m1.id);
    const r = await ccgb.dissolveFoodPool(p2.id);
    expect(r.refunded).toBe(1);
    const rows = await prisma.foodPoolMember.findMany({ where: { poolId: p2.id } });
    expect(rows.find((m: any) => m.userId === A.id).refundDue).toBe(3000);
    expect(rows.find((m: any) => m.userId === B.id).refundDue).toBe(0);
  });
});
