const mockPrisma: Record<string, any> = {
  planPrice: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  subscription: { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  subscriptionInvoice: { findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  commissionInvoice: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  commissionAccrual: { create: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn() },
  fundsEntry: { aggregate: jest.fn() },
  providerTransaction: { aggregate: jest.fn() },
  platformConfig: { findUnique: jest.fn(), create: jest.fn() },
  user: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findMany: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: (fn: (db: unknown) => unknown) => fn(mockPrisma),
};
const sms = jest.fn();
const mockMonnify = { verifyTransaction: jest.fn(), initializeTransaction: jest.fn() };
jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../lib/notify', () => ({ safeSms: (...a: unknown[]) => sms(...a), safeSmsAndEmail: (...a: unknown[]) => a[0] && sms(a[0], a[3]), naira: (n: unknown) => `₦${n}` }));
jest.mock('../services/monnify.service', () => ({ ...jest.requireActual('../services/monnify.service'), ...mockMonnify }));

import fs from 'fs';
import path from 'path';
import { decisions } from '../config/decisions';
import { addMonthsUtc, annualFromMonthly, daysUntil, divergence, escalationLevelFor, monthlyEquivalent, nextReminder, periodEndFor, previousMonth } from '../modules/billing/billing.logic';
import {
  accrueCustodyCommission, assertCanStartCycle, chaseCommissionInvoices, generateCommissionInvoices, priceAt, recordBillingPayment, runSubscriptionCycle, seedPlanPrices, setPrice, subscribe,
} from '../modules/billing/billing.service';
import { buildRevenueReport } from '../modules/billing/revenue.service';
import { voidPendingCommission } from '../modules/payments/commission.service';

const id = (c: string) => c.repeat(24);
const USER = id('a'), ADMIN = id('b'), SUB = id('c'), INV = id('d'), POOL = id('e'), GROUP = id('f');
const d = (s: string) => new Date(s);
const DAY = 86_400_000;

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.$transaction = (fn: (db: unknown) => unknown) => fn(mockPrisma);
  mockPrisma.user.findUnique.mockResolvedValue({ phoneNumber: '+2348011111111' });
  mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ id: USER, fullName: 'Mama Bísí', phoneNumber: '+2348011111111' });
  mockPrisma.user.findMany.mockResolvedValue([{ phoneNumber: '+2348099999999' }]);
  mockMonnify.initializeTransaction.mockResolvedValue({ checkoutUrl: 'https://pay/x', transactionReference: 'MNFY|1' });
  mockMonnify.verifyTransaction.mockResolvedValue({ paymentStatus: 'PAID', amountPaid: 10000 });
  decisions.billing.enforced = false;
  decisions.billing.memberPlusEnabled = false;
});

describe('pure billing rules', () => {
  it('month maths clamps to the end of the month instead of rolling over', () => {
    expect(addMonthsUtc(d('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonthsUtc(d('2028-01-31T00:00:00Z'), 1).toISOString()).toBe('2028-02-29T00:00:00.000Z'); // leap year
    expect(addMonthsUtc(d('2026-12-15T00:00:00Z'), 1).toISOString()).toBe('2027-01-15T00:00:00.000Z');
    expect(periodEndFor(d('2026-03-31T00:00:00Z'), 'YEARLY').toISOString()).toBe('2027-03-31T00:00:00.000Z');
    expect(periodEndFor(d('2028-02-29T00:00:00Z'), 'YEARLY').toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });

  it('the yearly price is 12 x monthly x 0.9, in whole kobo, from whatever monthly price is in the database', () => {
    expect(annualFromMonthly(1_000_000n)).toBe(10_800_000n); // ₦10,000/month → ₦108,000/year
    expect(annualFromMonthly(200_000n)).toBe(2_160_000n); // ₦2,000/month → ₦21,600/year
    expect(annualFromMonthly(1_234_500n)).toBe((1_234_500n * 108n) / 10n); // an admin-changed price follows the same rule
    expect(annualFromMonthly(333_333n)).toBe(3_599_996n); // 3,599,996.4 rounds half-up
  });

  it('MRR spreads a yearly plan over 12 months', () => {
    expect(monthlyEquivalent(10_800_000n, 'YEARLY')).toBe(900_000n);
    expect(monthlyEquivalent(1_000_000n, 'MONTHLY')).toBe(1_000_000n);
  });

  it('reminders go at 7, 3 and 0 days, the smallest due one only, and never all at once after downtime', () => {
    expect(nextReminder(10, [])).toBeNull();
    expect(nextReminder(7, [])).toEqual({ send: 7, markSent: [7] });
    expect(nextReminder(6, [7])).toBeNull();
    expect(nextReminder(3, [7])).toEqual({ send: 3, markSent: [3] });
    expect(nextReminder(0, [7, 3])).toEqual({ send: 0, markSent: [0] });
    expect(nextReminder(1, [])).toEqual({ send: 3, markSent: [7, 3] }); // job was down: one SMS, both marked
  });

  it('daysUntil counts calendar days in UTC: 0 on the day it ends, negative after', () => {
    expect(daysUntil(d('2026-03-10T12:00:00Z'), d('2026-03-03T12:00:00Z'))).toBe(7);
    expect(daysUntil(d('2026-03-10T12:00:00Z'), d('2026-03-03T23:00:00Z'))).toBe(7);
    expect(daysUntil(d('2026-03-10T14:00:00Z'), d('2026-03-10T07:00:00Z'))).toBe(0);
    expect(daysUntil(d('2026-03-10T14:00:00Z'), d('2026-03-11T07:00:00Z'))).toBe(-1);
  });

  it('commission invoices escalate warn → block → admin review', () => {
    expect([0, 1, 6, 7, 20, 21, 40].map((n) => escalationLevelFor(n))).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it('flags a collector whose confirmed total falls well short of what members declared', () => {
    expect(divergence(10_000_000n, 10_000_000n)).toEqual({ bp: 0, flagged: false });
    expect(divergence(10_000_000n, 9_500_000n)).toEqual({ bp: 500, flagged: false }); // 5%: under the 10% line
    expect(divergence(10_000_000n, 8_000_000n)).toEqual({ bp: 2000, flagged: true });
    expect(divergence(1_000_000n, 0n)).toEqual({ bp: 10_000, flagged: false }); // ₦10,000 declared is under the minimum sample
    expect(divergence(0n, 0n).flagged).toBe(false);
  });

  it('invoices are cut for the previous calendar month', () => {
    const { start, end } = previousMonth(d('2026-03-01T04:00:00Z'));
    expect([start.toISOString(), end.toISOString()]).toEqual(['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z']);
    expect(previousMonth(d('2026-01-01T04:00:00Z')).start.toISOString()).toBe('2025-12-01T00:00:00.000Z');
  });
});

describe('prices live in the database', () => {
  it('seed values: organizer ₦10,000 / ₦108,000, member plus ₦2,000 / ₦21,600, only where missing', async () => {
    mockPrisma.planPrice.findFirst.mockResolvedValue(null);
    expect(await seedPlanPrices()).toBe(4);
    const rows = mockPrisma.planPrice.create.mock.calls.map((c: any) => c[0].data);
    expect(rows.map((r: any) => `${r.plan}/${r.interval}/${r.amountKobo}`)).toEqual(['ORGANIZER/MONTHLY/1000000', 'ORGANIZER/YEARLY/10800000', 'MEMBER_PLUS/MONTHLY/200000', 'MEMBER_PLUS/YEARLY/2160000']);
    mockPrisma.planPrice.create.mockClear();
    mockPrisma.planPrice.findFirst.mockResolvedValue({ id: 'x' });
    expect(await seedPlanPrices()).toBe(0);
  });

  it('priceAt reads the newest row that has started', async () => {
    mockPrisma.planPrice.findFirst.mockResolvedValue({ amountKobo: 1_200_000n });
    const at = d('2026-06-01T00:00:00Z');
    expect(await priceAt('ORGANIZER', 'MONTHLY', at)).toBe(1_200_000n);
    expect(mockPrisma.planPrice.findFirst).toHaveBeenCalledWith({ where: { plan: 'ORGANIZER', interval: 'MONTHLY', effectiveFrom: { lte: at } }, orderBy: { effectiveFrom: 'desc' } });
    mockPrisma.planPrice.findFirst.mockResolvedValue(null);
    await expect(priceAt('ORGANIZER', 'MONTHLY')).rejects.toThrow('no price');
  });

  it('a new price closes the old row, must start later, and never touches an existing subscription', async () => {
    mockPrisma.planPrice.findFirst.mockResolvedValue({ id: 'old', effectiveFrom: d('2026-01-01T00:00:00Z') });
    mockPrisma.planPrice.create.mockResolvedValue({ id: 'new' });
    await setPrice(ADMIN, { plan: 'ORGANIZER', interval: 'MONTHLY', amountKobo: 1_500_000n, effectiveFrom: d('2026-07-01T00:00:00Z') });
    expect(mockPrisma.planPrice.update).toHaveBeenCalledWith({ where: { id: 'old' }, data: { effectiveTo: d('2026-07-01T00:00:00Z') } });
    expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
    expect(mockPrisma.subscription.updateMany).not.toHaveBeenCalled();
    await expect(setPrice(ADMIN, { plan: 'ORGANIZER', interval: 'MONTHLY', amountKobo: 1n, effectiveFrom: d('2026-01-01T00:00:00Z') })).rejects.toThrow('after the current');
    await expect(setPrice(ADMIN, { plan: 'ORGANIZER', interval: 'MONTHLY', amountKobo: 0n })).rejects.toThrow('greater than zero');
  });
});

describe('subscribing', () => {
  it('the organizer plan is for organizers; member plus needs its flag; custody has no separate price', async () => {
    await expect(subscribe({ id: USER, role: 'MEMBER' }, 'ORGANIZER', 'MONTHLY')).rejects.toThrow('collectors, facilitators and admins');
    await expect(subscribe({ id: USER, role: 'MEMBER' }, 'MEMBER_PLUS', 'MONTHLY')).rejects.toThrow('not available');
    expect(Object.keys(decisions.billing)).not.toContain('custodyPrice');
  });

  it('a new organizer subscription starts LAPSED with an invoice at the price in the database', async () => {
    const sub = { id: SUB, userId: USER, plan: 'ORGANIZER', interval: 'MONTHLY', status: 'LAPSED' };
    mockPrisma.subscription.findUnique.mockResolvedValue(null);
    mockPrisma.subscription.create.mockResolvedValue(sub);
    mockPrisma.subscription.update.mockResolvedValue(sub);
    mockPrisma.subscriptionInvoice.findFirst.mockResolvedValue(null);
    mockPrisma.planPrice.findFirst.mockResolvedValue({ amountKobo: 1_000_000n });
    mockPrisma.subscriptionInvoice.create.mockImplementation(async ({ data }: any) => ({ id: INV, ...data }));
    mockPrisma.subscriptionInvoice.update.mockImplementation(async ({ data }: any) => ({ id: INV, amountKobo: 1_000_000n, ...data }));
    const out = await subscribe({ id: USER, role: 'COLLECTOR' }, 'ORGANIZER', 'MONTHLY');
    expect(out.subscription.status).toBe('LAPSED');
    expect(mockPrisma.subscriptionInvoice.create.mock.calls[0][0].data).toMatchObject({ amountKobo: 1_000_000n, plan: 'ORGANIZER', interval: 'MONTHLY' });
    expect(mockPrisma.subscriptionInvoice.create.mock.calls[0][0].data.paymentReference).toMatch(/^CCS-/);
    expect(out.invoice?.checkoutUrl).toBe('https://pay/x');
    expect(mockMonnify.initializeTransaction.mock.calls[0][0]).toBe(10000);
  });
});

describe('paying a subscription invoice', () => {
  const invoice = (over: Record<string, unknown> = {}) => ({ id: INV, subscriptionId: SUB, userId: USER, plan: 'ORGANIZER', interval: 'MONTHLY', amountKobo: 1_000_000n, status: 'PENDING', periodStart: d('2026-04-01T00:00:00Z'), periodEnd: d('2026-05-01T00:00:00Z'), ...over });
  const sub = (over: Record<string, unknown> = {}) => ({ id: SUB, status: 'ACTIVE', currentPeriodEnd: d('2026-04-01T00:00:00Z'), ...over });
  beforeEach(() => {
    mockPrisma.subscriptionInvoice.findUnique.mockResolvedValue(invoice());
    mockPrisma.subscriptionInvoice.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.subscription.findUniqueOrThrow = jest.fn().mockResolvedValue(sub());
    mockPrisma.subscription.update.mockImplementation(async ({ data }: any) => ({ id: SUB, ...data }));
  });

  it('an early renewal extends from where the period ended, losing no time', async () => {
    expect(await recordBillingPayment('CCS-1', 'MNFY|1')).toBe('RECORDED');
    const data = mockPrisma.subscription.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'ACTIVE', priceKobo: 1_000_000n, graceEndsAt: null, remindersSent: [] });
    expect(data.currentPeriodStart).toEqual(d('2026-04-01T00:00:00Z'));
    expect(data.currentPeriodEnd).toEqual(d('2026-05-01T00:00:00Z'));
  });

  it('paying inside the grace window still extends from the old end', async () => {
    mockPrisma.subscription.findUniqueOrThrow.mockResolvedValue(sub({ status: 'GRACE' }));
    await recordBillingPayment('CCS-1', 'MNFY|1');
    expect(mockPrisma.subscription.update.mock.calls[0][0].data.currentPeriodStart).toEqual(d('2026-04-01T00:00:00Z'));
  });

  it('paying after the plan has lapsed starts a fresh period from today, not backdated', async () => {
    mockPrisma.subscription.findUniqueOrThrow.mockResolvedValue(sub({ status: 'LAPSED' }));
    const before = Date.now();
    await recordBillingPayment('CCS-1', 'MNFY|1');
    expect(mockPrisma.subscription.update.mock.calls[0][0].data.currentPeriodStart.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('the period is frozen at the price that was paid, even if the price later changes', async () => {
    mockPrisma.subscriptionInvoice.findUnique.mockResolvedValue(invoice({ amountKobo: 1_000_000n }));
    mockMonnify.verifyTransaction.mockResolvedValue({ paymentStatus: 'PAID', amountPaid: 10000 });
    await recordBillingPayment('CCS-1', 'MNFY|1');
    expect(mockPrisma.subscription.update.mock.calls[0][0].data.priceKobo).toBe(1_000_000n);
    expect(mockPrisma.planPrice.findFirst).not.toHaveBeenCalled(); // the current price list is not consulted when a period is paid
  });

  it('is idempotent and re-checks with Monnify', async () => {
    mockPrisma.subscriptionInvoice.findUnique.mockResolvedValue(invoice({ status: 'PAID' }));
    expect(await recordBillingPayment('CCS-1', 'MNFY|1')).toBe('DUPLICATE');
    mockPrisma.subscriptionInvoice.findUnique.mockResolvedValue(invoice());
    mockPrisma.subscriptionInvoice.updateMany.mockResolvedValue({ count: 0 });
    expect(await recordBillingPayment('CCS-1', 'MNFY|1')).toBe('DUPLICATE');
    mockMonnify.verifyTransaction.mockResolvedValue({ paymentStatus: 'PENDING', amountPaid: 0 });
    expect(await recordBillingPayment('CCS-1', 'MNFY|1')).toBe('NOT_PAID');
    mockMonnify.verifyTransaction.mockResolvedValue({ paymentStatus: 'PAID', amountPaid: 5000 });
    expect(await recordBillingPayment('CCS-1', 'MNFY|1')).toBe('AMOUNT_MISMATCH');
    mockPrisma.subscriptionInvoice.findUnique.mockResolvedValue(null);
    mockPrisma.commissionInvoice.findUnique.mockResolvedValue(null);
    expect(await recordBillingPayment('NOPE', 'x')).toBe('UNKNOWN');
  });

  it('a commission invoice payment marks it PAID once', async () => {
    mockPrisma.subscriptionInvoice.findUnique.mockResolvedValue(null);
    mockPrisma.commissionInvoice.findUnique.mockResolvedValue({ id: INV, collectorUserId: USER, amountKobo: 1_000_000n, status: 'PENDING' });
    mockPrisma.commissionInvoice.updateMany.mockResolvedValue({ count: 1 });
    expect(await recordBillingPayment('CCC-1', 'MNFY|2')).toBe('RECORDED');
    mockPrisma.commissionInvoice.updateMany.mockResolvedValue({ count: 0 });
    expect(await recordBillingPayment('CCC-1', 'MNFY|2')).toBe('DUPLICATE');
  });
});

describe('the subscription lifecycle: reminders, grace, lapse', () => {
  const end = d('2026-04-01T14:00:00Z');
  const sub = (over: Record<string, unknown> = {}) => ({ id: SUB, userId: USER, plan: 'ORGANIZER', interval: 'MONTHLY', status: 'ACTIVE', currentPeriodEnd: end, remindersSent: [], cancelAtPeriodEnd: false, graceEndsAt: null, ...over });
  beforeEach(() => {
    mockPrisma.subscription.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.subscription.update.mockResolvedValue({});
    mockPrisma.subscriptionInvoice.findFirst.mockResolvedValue(null);
    mockPrisma.subscriptionInvoice.create.mockImplementation(async ({ data }: any) => ({ id: INV, ...data }));
    mockPrisma.subscriptionInvoice.update.mockResolvedValue({});
    mockPrisma.planPrice.findFirst.mockResolvedValue({ amountKobo: 1_000_000n });
  });

  it('7 days before: creates the renewal invoice and sends the first reminder', async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([sub()]);
    const r = await runSubscriptionCycle(new Date(end.getTime() - 7 * DAY));
    expect(r).toMatchObject({ reminded: 1, invoiced: 1 });
    expect(mockPrisma.subscriptionInvoice.create.mock.calls[0][0].data.periodStart).toEqual(end); // renews from where it ends
    expect(sms).toHaveBeenCalledWith('+2348011111111', expect.stringContaining('ends in 7 days'));
  });

  it('3 days and on the day: further reminders, no second invoice', async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([sub({ remindersSent: [7] })]);
    mockPrisma.subscriptionInvoice.findFirst.mockResolvedValue({ id: INV });
    await runSubscriptionCycle(new Date(end.getTime() - 3 * DAY));
    expect(mockPrisma.subscriptionInvoice.create).not.toHaveBeenCalled();
    expect(sms).toHaveBeenLastCalledWith('+2348011111111', expect.stringContaining('ends in 3 days'));
    mockPrisma.subscription.findMany.mockResolvedValue([sub({ remindersSent: [7, 3] })]);
    await runSubscriptionCycle(new Date(end.getTime() - 6 * 3600_000)); // the 08:00 job on the day it ends
    expect(sms).toHaveBeenLastCalledWith('+2348011111111', expect.stringContaining('renews today'));
  });

  it('a reminder is not sent twice for the same day', async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([sub({ remindersSent: [7] })]);
    expect((await runSubscriptionCycle(new Date(end.getTime() - 5 * DAY))).reminded).toBe(0);
  });

  it('at the end of the period it enters a 7-day grace, and members are told nothing changes for them', async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([sub({ remindersSent: [7, 3, 0] })]);
    const r = await runSubscriptionCycle(new Date(end.getTime() + 1000));
    expect(r.graced).toBe(1);
    expect(mockPrisma.subscription.update).toHaveBeenCalledWith({ where: { id: SUB }, data: { status: 'GRACE', graceEndsAt: new Date(end.getTime() + 7 * DAY) } });
    expect(sms).toHaveBeenCalledWith('+2348011111111', expect.stringContaining('7 days to renew'));
  });

  it('after grace it lapses, with a message that running cycles and members are untouched', async () => {
    const graceEndsAt = new Date(end.getTime() + 7 * DAY);
    mockPrisma.subscription.findMany.mockResolvedValue([sub({ status: 'GRACE', graceEndsAt })]);
    mockPrisma.subscriptionInvoice.updateMany.mockResolvedValue({ count: 1 });
    expect((await runSubscriptionCycle(new Date(graceEndsAt.getTime() + 1000))).lapsed).toBe(1);
    expect(mockPrisma.subscription.update).toHaveBeenCalledWith({ where: { id: SUB }, data: { status: 'LAPSED' } });
    expect(sms).toHaveBeenCalledWith('+2348011111111', expect.stringContaining('members can still pay, confirm and be paid'));
  });

  it('still in grace before the grace date', async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([sub({ status: 'GRACE', graceEndsAt: new Date(end.getTime() + 7 * DAY) })]);
    const r = await runSubscriptionCycle(new Date(end.getTime() + 3 * DAY));
    expect(r.lapsed).toBe(0);
    expect(mockPrisma.subscription.update).not.toHaveBeenCalled();
  });

  it('a cancelled plan runs to the end of the paid period and then simply stops, with no grace and no reminders', async () => {
    mockPrisma.subscription.findMany.mockResolvedValue([sub({ cancelAtPeriodEnd: true })]);
    expect((await runSubscriptionCycle(new Date(end.getTime() - 3 * DAY))).reminded).toBe(0);
    const r = await runSubscriptionCycle(new Date(end.getTime() + 1000));
    expect(r.cancelled).toBe(1);
    expect(mockPrisma.subscription.update).toHaveBeenCalledWith({ where: { id: SUB }, data: expect.objectContaining({ status: 'CANCELLED' }) });
  });
});

describe('read-only means NEW cycles only: members are never blocked', () => {
  const org = { id: USER, role: 'COLLECTOR' };
  it('does nothing until billing is enforced (the pilot)', async () => {
    await expect(assertCanStartCycle(org)).resolves.toBeUndefined();
    expect(mockPrisma.subscription.findUnique).not.toHaveBeenCalled();
  });
  it('once enforced: an active or in-grace organizer may start cycles; a lapsed, cancelled or missing one may not', async () => {
    decisions.billing.enforced = true;
    mockPrisma.commissionInvoice.findFirst.mockResolvedValue(null);
    for (const status of ['ACTIVE', 'GRACE']) {
      mockPrisma.subscription.findUnique.mockResolvedValue({ status });
      await expect(assertCanStartCycle(org)).resolves.toBeUndefined();
    }
    for (const status of ['LAPSED', 'CANCELLED']) {
      mockPrisma.subscription.findUnique.mockResolvedValue({ status });
      await expect(assertCanStartCycle(org)).rejects.toThrow('SUBSCRIPTION_REQUIRED');
    }
    mockPrisma.subscription.findUnique.mockResolvedValue(null);
    await expect(assertCanStartCycle(org)).rejects.toThrow('not affected');
  });
  it('an unpaid commission invoice past the block date stops new cycles but says current ones continue', async () => {
    decisions.billing.enforced = true;
    mockPrisma.subscription.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    mockPrisma.commissionInvoice.findFirst.mockResolvedValue({ amountKobo: 250_000n });
    await expect(assertCanStartCycle(org)).rejects.toThrow('COMMISSION_OVERDUE');
    expect(mockPrisma.commissionInvoice.findFirst).toHaveBeenCalledWith({ where: { collectorUserId: USER, status: 'PENDING', escalationLevel: { gte: 2 } } });
  });
  it('platform admins are exempt', async () => {
    decisions.billing.enforced = true;
    await expect(assertCanStartCycle({ id: ADMIN, role: 'ADMIN' })).resolves.toBeUndefined();
  });
  it('the gate is only wired into creating a new pool; no member action ever calls it', () => {
    const root = path.join(__dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { if (f.name !== '__tests__') walk(p); } else if (/\.ts$/.test(f.name) && /assertCanStartCycle/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['modules/ajo/ajo.router.ts', 'modules/billing/billing.service.ts', 'modules/ccgb/ccgb.router.ts']);
    // And a member's own records and money screens do not know billing exists.
    for (const f of ['modules/ledger/ledger.router.ts', 'modules/payments/payments.service.ts', 'modules/payments/funds-provider.ts']) {
      expect(fs.readFileSync(path.join(root, f), 'utf8')).not.toMatch(/billing/i);
    }
  });
});

describe('commission accrual for custody', () => {
  const entry = { id: id('1'), type: 'CONTRIBUTION', groupId: GROUP, purposeType: 'AJO', purposeId: POOL, payerUserId: USER, amountKobo: 1_000_000n };
  beforeEach(() => mockPrisma.platformConfig.findUnique.mockResolvedValue({ platformCommissionBp: 500, settlementCommissionBp: 0 }));
  it('accrues 5% against the collector, PENDING until the cycle completes', async () => {
    mockPrisma.commissionAccrual.create.mockResolvedValue({});
    await accrueCustodyCommission(entry as never, ADMIN);
    expect(mockPrisma.commissionAccrual.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amountKobo: 50_000n, fundsMode: 'COLLECTOR_CUSTODY', collectorUserId: ADMIN, invoiceId: null }) });
  });
  it('apprenticeship settlement funds accrue nothing at the default 0%', async () => {
    expect(await accrueCustodyCommission({ ...entry, purposeType: 'SETTLEMENT_FUND' } as never, ADMIN)).toBeNull();
    expect(mockPrisma.commissionAccrual.create).not.toHaveBeenCalled();
  });
  it('only contributions accrue, and a duplicate confirm cannot double-accrue', async () => {
    expect(await accrueCustodyCommission({ ...entry, type: 'RELEASE' } as never, ADMIN)).toBeNull();
    mockPrisma.commissionAccrual.create.mockRejectedValue({ code: 'P2002' });
    expect(await accrueCustodyCommission(entry as never, ADMIN)).toBeNull();
  });
  it('a dissolved pool voids pending commission: the platform keeps nothing', async () => {
    mockPrisma.commissionAccrual.updateMany.mockResolvedValue({ count: 4 });
    expect(await voidPendingCommission('CCGB', POOL)).toBe(4);
    expect(mockPrisma.commissionAccrual.updateMany).toHaveBeenCalledWith({ where: { purposeType: 'CCGB', purposeId: POOL, status: 'PENDING' }, data: expect.objectContaining({ status: 'REFUNDED' }) });
  });
});

describe('monthly commission invoices (custody)', () => {
  const accrual = (over: Record<string, unknown> = {}) => ({ id: id('2'), collectorUserId: ADMIN, purposeType: 'AJO', purposeId: POOL, amountKobo: 50_000n, ...over });
  const now = d('2026-03-01T04:00:00Z');
  beforeEach(() => {
    mockPrisma.commissionInvoice.create.mockImplementation(async ({ data }: any) => ({ id: INV, ...data }));
    mockPrisma.commissionAccrual.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.fundsEntry.aggregate.mockResolvedValueOnce({ _sum: { amountKobo: 2_000_000n } }).mockResolvedValueOnce({ _sum: { amountKobo: 2_000_000n } });
  });

  it('bills a collector once for EARNED, not-yet-invoiced commission for the previous month, due in 14 days', async () => {
    mockPrisma.commissionAccrual.findMany.mockResolvedValue([accrual(), accrual({ id: id('3'), amountKobo: 70_000n })]);
    const out = await generateCommissionInvoices(now);
    expect(mockPrisma.commissionAccrual.findMany).toHaveBeenCalledWith({ where: { fundsMode: 'COLLECTOR_CUSTODY', status: 'EARNED', invoiceId: null, collectorUserId: { not: null } } });
    expect(out).toHaveLength(1);
    expect(mockPrisma.commissionInvoice.create.mock.calls[0][0].data).toMatchObject({
      collectorUserId: ADMIN, amountKobo: 120_000n, accrualCount: 2, periodStart: d('2026-02-01T00:00:00Z'), periodEnd: d('2026-03-01T00:00:00Z'), flaggedDivergence: false, divergenceBp: 0,
      dueAt: new Date(now.getTime() + 14 * DAY), remindersSent: [], // an explicit empty list: the reminder claim matches on it
    });
    expect(mockPrisma.commissionAccrual.updateMany).toHaveBeenCalledWith({ where: { id: { in: [id('2'), id('3')] }, invoiceId: null }, data: { invoiceId: INV } });
    expect(sms).toHaveBeenCalledWith('+2348011111111', expect.stringContaining('₦1200.00'));
  });

  it('flags the collector when members declared much more than they confirmed', async () => {
    mockPrisma.fundsEntry.aggregate.mockReset();
    mockPrisma.fundsEntry.aggregate.mockResolvedValueOnce({ _sum: { amountKobo: 10_000_000n } }).mockResolvedValueOnce({ _sum: { amountKobo: 7_000_000n } });
    mockPrisma.commissionAccrual.findMany.mockResolvedValue([accrual()]);
    await generateCommissionInvoices(now);
    expect(mockPrisma.commissionInvoice.create.mock.calls[0][0].data).toMatchObject({ declaredKobo: 10_000_000n, confirmedKobo: 7_000_000n, divergenceBp: 3000, flaggedDivergence: true });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'COMMISSION_DIVERGENCE_FLAGGED' }) });
  });

  it('running twice for the same month cannot double-bill, and there is nothing to bill without earned commission', async () => {
    mockPrisma.commissionAccrual.findMany.mockResolvedValue([accrual()]);
    mockPrisma.commissionInvoice.create.mockRejectedValue({ code: 'P2002' });
    expect(await generateCommissionInvoices(now)).toEqual([]);
    mockPrisma.commissionAccrual.findMany.mockResolvedValue([]);
    expect(await generateCommissionInvoices(now)).toEqual([]);
  });
});

describe('chasing commission invoices', () => {
  const due = d('2026-03-15T00:00:00Z');
  const inv = (over: Record<string, unknown> = {}) => ({ id: INV, collectorUserId: ADMIN, amountKobo: 120_000n, status: 'PENDING', dueAt: due, escalationLevel: 0, remindersSent: [], ...over });
  beforeEach(() => mockPrisma.commissionInvoice.updateMany.mockResolvedValue({ count: 1 }));

  it('reminds 3 days before and on the due date', async () => {
    mockPrisma.commissionInvoice.findMany.mockResolvedValue([inv()]);
    await chaseCommissionInvoices(new Date(due.getTime() - 3 * DAY));
    expect(sms).toHaveBeenLastCalledWith('+2348011111111', expect.stringContaining('due in 3 days'));
    mockPrisma.commissionInvoice.findMany.mockResolvedValue([inv({ remindersSent: [3] })]);
    await chaseCommissionInvoices(new Date(due.getTime() + 7 * 3600_000)); // the 07:00 job on the due date
    expect(sms).toHaveBeenLastCalledWith('+2348011111111', expect.stringContaining('due today'));
  });

  it('escalates: warn on day 1, block new cycles on day 7, admin review on day 21', async () => {
    mockPrisma.commissionInvoice.findMany.mockResolvedValue([inv()]);
    await chaseCommissionInvoices(new Date(due.getTime() + 2 * DAY));
    expect(mockPrisma.commissionInvoice.updateMany).toHaveBeenLastCalledWith({ where: { id: INV, escalationLevel: { lt: 1 } }, data: { escalationLevel: 1 } });
    expect(sms).toHaveBeenLastCalledWith('+2348011111111', expect.stringContaining('overdue'));
    mockPrisma.commissionInvoice.findMany.mockResolvedValue([inv({ escalationLevel: 1 })]);
    await chaseCommissionInvoices(new Date(due.getTime() + 8 * DAY));
    expect(mockPrisma.commissionInvoice.updateMany).toHaveBeenLastCalledWith({ where: { id: INV, escalationLevel: { lt: 2 } }, data: { escalationLevel: 2 } });
    expect(sms).toHaveBeenLastCalledWith('+2348011111111', expect.stringContaining('cannot start new cycles'));
    mockPrisma.commissionInvoice.findMany.mockResolvedValue([inv({ escalationLevel: 2 })]);
    await chaseCommissionInvoices(new Date(due.getTime() + 22 * DAY));
    expect(sms).toHaveBeenLastCalledWith('+2348099999999', expect.stringContaining('review'));
  });

  it('does nothing twice: same level, or a lost race', async () => {
    mockPrisma.commissionInvoice.findMany.mockResolvedValue([inv({ escalationLevel: 1 })]);
    expect((await chaseCommissionInvoices(new Date(due.getTime() + 2 * DAY))).escalated).toBe(0);
    mockPrisma.commissionInvoice.findMany.mockResolvedValue([inv()]);
    mockPrisma.commissionInvoice.updateMany.mockResolvedValue({ count: 0 });
    sms.mockClear();
    await chaseCommissionInvoices(new Date(due.getTime() + 2 * DAY));
    expect(sms).not.toHaveBeenCalled();
  });
});

describe('the admin revenue dashboard', () => {
  it('computes MRR/ARR, churn, commission earned vs refunded, who owes what, and flagged collectors', async () => {
    const now = d('2026-03-15T00:00:00Z');
    mockPrisma.subscription.findMany.mockResolvedValue([
      { plan: 'ORGANIZER', status: 'ACTIVE', interval: 'MONTHLY', priceKobo: 1_000_000n },
      { plan: 'ORGANIZER', status: 'ACTIVE', interval: 'YEARLY', priceKobo: 10_800_000n },
      { plan: 'MEMBER_PLUS', status: 'GRACE', interval: 'YEARLY', priceKobo: 2_160_000n },
    ]);
    mockPrisma.subscription.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0); // cancelled, lapsed
    mockPrisma.commissionAccrual.groupBy.mockResolvedValue([
      { status: 'EARNED', fundsMode: 'ESCROW', _sum: { amountKobo: 5_000_000n }, _count: { _all: 3 } },
      { status: 'EARNED', fundsMode: 'COLLECTOR_CUSTODY', _sum: { amountKobo: 1_000_000n }, _count: { _all: 2 } },
      { status: 'PENDING', fundsMode: 'ESCROW', _sum: { amountKobo: 400_000n }, _count: { _all: 1 } },
      { status: 'REFUNDED', fundsMode: 'ESCROW', _sum: { amountKobo: 250_000n }, _count: { _all: 1 } },
    ]);
    mockPrisma.commissionInvoice.findMany.mockResolvedValue([
      { id: INV, collectorUserId: ADMIN, amountKobo: 600_000n, status: 'PENDING', escalationLevel: 2, flaggedDivergence: true, declaredKobo: 10_000_000n, confirmedKobo: 7_000_000n, divergenceBp: 3000, periodStart: d('2026-02-01T00:00:00Z'), createdAt: d('2026-03-01T00:00:00Z') },
      { id: id('7'), collectorUserId: ADMIN, amountKobo: 400_000n, status: 'PAID', escalationLevel: 0, flaggedDivergence: false, declaredKobo: 0n, confirmedKobo: 0n, divergenceBp: 0, periodStart: d('2026-01-01T00:00:00Z'), createdAt: d('2026-02-01T00:00:00Z') },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: ADMIN, fullName: 'Baba Àlàjọ' }]);
    mockPrisma.providerTransaction.aggregate.mockResolvedValue({ _sum: { amountKobo: 100_000_000n } });
    const r = await buildRevenueReport(now);
    expect(r.subscriptions).toMatchObject({ active: 3, mrr: '20800.00', arr: '249600.00' });
    expect(r.subscriptions.byPlan).toEqual({ ORGANIZER: 2, MEMBER_PLUS: 1 });
    expect(r.subscriptions.churn).toMatchObject({ last30Days: 1, cancelled: 1, lapsed: 0, rateBp: 2500 });
    expect(r.commission).toMatchObject({ earned: '60000.00', pending: '4000.00', refunded: '2500.00', invoiced: '10000.00', collected: '4000.00', outstandingTotal: '6000.00' });
    expect(r.commission.byMode.ESCROW).toEqual({ earned: '50000.00', refunded: '2500.00' });
    expect(r.commission.outstandingByCollector).toEqual([expect.objectContaining({ collector: 'Baba Àlàjọ', owed: '6000.00', worstLevel: 2 })]);
    expect(r.flaggedCollectors).toEqual([expect.objectContaining({ collector: 'Baba Àlàjọ', declared: '100000.00', confirmed: '70000.00', divergencePct: '30.0' })]);
    expect(r.gatewayFees).toMatchObject({ estimate: true, volume: '1000000.00' });
  });
});
