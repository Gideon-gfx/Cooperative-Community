const mockPrisma = {
  facilitatorAccount: { findUnique: jest.fn() },
  fundsEntry: { create: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), updateMany: jest.fn(), findMany: jest.fn(), groupBy: jest.fn(), aggregate: jest.fn() },
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  auditLog: { create: jest.fn() },
  platformConfig: { findUnique: jest.fn(), create: jest.fn() },
  commissionAccrual: { create: jest.fn(), updateMany: jest.fn() },
};
const sms = jest.fn();
jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../lib/notify', () => ({ safeSms: (...a: unknown[]) => sms(...a), naira: (n: unknown) => `₦${n}` }));

import { koboToNaira, nairaToKobo } from '../lib/kobo';
import { CollectorCustodyProvider } from '../modules/payments/collector-custody.provider';
import { getFundsProvider } from '../modules/payments/funds-provider';
import { chaseUnconfirmed } from '../modules/ledger/ledger.cron';

const id = (c: string) => c.repeat(24);
const PAYER = id('a'), FAC = id('b'), ACC = id('c'), ENTRY = id('d'), POOL = id('e'), ADMIN = id('f'), GRAD = id('9');
const p = new CollectorCustodyProvider();

const account = (over = {}) => ({ id: ACC, userId: FAC, isVerifiedByAdmin: true, ...over });
const entry = (over = {}) => ({ id: ENTRY, fundsMode: 'COLLECTOR_CUSTODY', groupId: id('8'), type: 'CONTRIBUTION', purposeType: 'AJO', purposeId: POOL, payerUserId: PAYER, counterpartyUserId: null, facilitatorAccountId: ACC, amountKobo: 1_250_050n, status: 'DECLARED', account: account(), ...over });

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({ phoneNumber: '+2348011111111' });
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.platformConfig.findUnique.mockResolvedValue({ platformCommissionBp: 500, settlementCommissionBp: 0 });
  mockPrisma.commissionAccrual.create.mockResolvedValue({});
  mockPrisma.commissionAccrual.updateMany.mockResolvedValue({ count: 1 });
});

describe('money is exact', () => {
  it('parses naira to kobo without float error', () => {
    expect(nairaToKobo('1250.50')).toBe(125050n);
    expect(nairaToKobo(0.3)).toBe(30n);
    expect(() => nairaToKobo(0.1 + 0.2)).toThrow('2 decimal'); // float noise (0.30000000000000004) is refused, not rounded
  });
  it('rejects bad amounts', () => {
    for (const bad of ['0', '-5', 'abc', '1.234', '', 'Infinity', '99999999999']) expect(() => nairaToKobo(bad)).toThrow();
    expect(nairaToKobo('-5', { allowSigned: true })).toBe(-500n);
  });
  it('formats kobo back to an exact string', () => {
    expect(koboToNaira(125050n)).toBe('1250.50');
    expect(koboToNaira(5n)).toBe('0.05');
    expect(koboToNaira(-250n)).toBe('-2.50');
  });
});

describe('declaring a payment', () => {
  const input = { groupId: id('8'), payerUserId: PAYER, facilitatorAccountId: ACC, purposeType: 'AJO' as const, purposeId: POOL, amountKobo: 500_000n, proofImageUrl: 'https://x/y.jpg' };
  it('creates a DECLARED entry and texts the facilitator', async () => {
    mockPrisma.facilitatorAccount.findUnique.mockResolvedValue(account());
    mockPrisma.fundsEntry.create.mockResolvedValue({ id: ENTRY });
    await p.collect(input);
    expect(mockPrisma.fundsEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'CONTRIBUTION', amountKobo: 500_000n, payerUserId: PAYER }) });
    expect(sms).toHaveBeenCalledWith('+2348011111111', expect.stringContaining('₦5000.00'));
  });
  it('needs evidence, a verified account, and a payer who is not the facilitator', async () => {
    await expect(p.collect({ ...input, proofImageUrl: undefined })).rejects.toThrow('proof');
    mockPrisma.facilitatorAccount.findUnique.mockResolvedValue(account({ isVerifiedByAdmin: false }));
    await expect(p.collect(input)).rejects.toThrow('verified');
    mockPrisma.facilitatorAccount.findUnique.mockResolvedValue(account());
    await expect(p.collect({ ...input, payerUserId: FAC })).rejects.toThrow('themselves');
  });
});

describe('confirmation rules', () => {
  beforeEach(() => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(entry());
    mockPrisma.fundsEntry.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.fundsEntry.findUniqueOrThrow.mockResolvedValue(entry({ status: 'CONFIRMED' }));
  });
  it('the facilitator confirms and the payer gets an SMS receipt', async () => {
    await p.confirm(ENTRY, FAC);
    expect(sms).toHaveBeenCalledWith('+2348011111111', expect.stringContaining('does not hold it'));
  });
  it('confirming accrues the platform commission against the collector, and the receipt shows the fee line', async () => {
    mockPrisma.fundsEntry.findUniqueOrThrow.mockResolvedValue(entry({ status: 'CONFIRMED' }));
    await p.confirm(ENTRY, FAC);
    // ₦12,500.50 at 5% = ₦625.03 (half-up)
    expect(mockPrisma.commissionAccrual.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amountKobo: 62_503n, fundsMode: 'COLLECTOR_CUSTODY', collectorUserId: FAC, fundsEntryId: ENTRY, invoiceId: null }) });
    expect(sms).toHaveBeenCalledWith('+2348011111111', expect.stringContaining('Platform fee on this payment: ₦625.03'));
  });
  it('confirming twice cannot double-accrue (the accrual is unique per entry)', async () => {
    mockPrisma.fundsEntry.findUniqueOrThrow.mockResolvedValue(entry({ status: 'CONFIRMED' }));
    mockPrisma.commissionAccrual.create.mockRejectedValue({ code: 'P2002' });
    await expect(p.confirm(ENTRY, FAC)).resolves.toBeDefined();
  });
  it('a confirmed refund takes the commission back', async () => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(entry({ type: 'REFUND', payerUserId: FAC, counterpartyUserId: PAYER, relatedEntryId: id('1') }));
    await p.confirm(ENTRY, PAYER);
    expect(mockPrisma.commissionAccrual.updateMany).toHaveBeenCalledWith({ where: { fundsEntryId: id('1'), status: { in: ['PENDING', 'EARNED'] } }, data: expect.objectContaining({ status: 'REFUNDED' }) });
  });
  it('the payer can never confirm their own payment', async () => {
    await expect(p.confirm(ENTRY, PAYER)).rejects.toThrow('own payment');
    expect(mockPrisma.fundsEntry.updateMany).not.toHaveBeenCalled();
  });
  it('a stranger cannot confirm', async () => {
    await expect(p.confirm(ENTRY, ADMIN)).rejects.toThrow('other party');
  });
  it('a facilitator who owns a different account cannot confirm', async () => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(entry({ account: account({ userId: id('1') }) }));
    await expect(p.confirm(ENTRY, FAC)).rejects.toThrow('other party');
  });
  it('confirming twice is rejected, and a lost race never double counts', async () => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(entry({ status: 'CONFIRMED' }));
    await expect(p.confirm(ENTRY, FAC)).rejects.toThrow('not waiting');
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(entry());
    mockPrisma.fundsEntry.updateMany.mockResolvedValue({ count: 0 });
    await expect(p.confirm(ENTRY, FAC)).rejects.toThrow('already handled');
  });
  it('confirming never rewrites the amount', async () => {
    await p.confirm(ENTRY, FAC);
    expect(JSON.stringify(mockPrisma.fundsEntry.updateMany.mock.calls[0][0].data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('amountKobo');
  });
  it('a dispute needs the facilitator and moves the entry to DISPUTED', async () => {
    await p.dispute(ENTRY, FAC, 'No money received');
    expect(mockPrisma.fundsEntry.updateMany).toHaveBeenCalledWith({ where: { id: ENTRY, status: 'DECLARED' }, data: { status: 'DISPUTED', disputeNote: 'No money received' } });
    await expect(p.dispute(ENTRY, PAYER, 'x')).rejects.toThrow('own payment');
  });
});

describe('derived balances', () => {
  it('sums only CONFIRMED rows: contributions + adjustments − releases', async () => {
    mockPrisma.fundsEntry.groupBy.mockResolvedValue([
      { type: 'CONTRIBUTION', _sum: { amountKobo: 10_000_000n } },
      { type: 'ADJUSTMENT', _sum: { amountKobo: -50_000n } },
      { type: 'RELEASE', _sum: { amountKobo: 4_000_000n } },
    ]);
    const t = await p.totals({ purposeType: 'AJO', purposeId: POOL });
    expect(t).toEqual({ contributions: 10_000_000n, adjustments: -50_000n, releases: 4_000_000n, refunds: 0n, commissions: 0n, balance: 5_950_000n });
    expect(mockPrisma.fundsEntry.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { status: 'CONFIRMED', purposeType: 'AJO', purposeId: POOL, fundsMode: 'COLLECTOR_CUSTODY' } }));
  });
  it('is zero with no confirmed rows', async () => {
    mockPrisma.fundsEntry.groupBy.mockResolvedValue([]);
    expect((await p.totals({})).balance).toBe(0n);
  });
});

describe('releases', () => {
  const rel = { groupId: id('8'), actorId: FAC, facilitatorAccountId: ACC, purposeType: 'SETTLEMENT_FUND' as const, purposeId: POOL, recipientUserId: GRAD, amountKobo: 3_000_000n };
  beforeEach(() => {
    mockPrisma.facilitatorAccount.findUnique.mockResolvedValue(account());
    mockPrisma.fundsEntry.groupBy.mockResolvedValue([{ type: 'CONTRIBUTION', _sum: { amountKobo: 5_000_000n } }]);
    mockPrisma.fundsEntry.aggregate.mockResolvedValue({ _sum: { amountKobo: 0n } });
    mockPrisma.fundsEntry.create.mockResolvedValue({ id: ENTRY });
  });
  it('records a release the recipient must confirm', async () => {
    await p.release(rel);
    expect(mockPrisma.fundsEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'RELEASE', payerUserId: FAC, counterpartyUserId: GRAD }) });
  });
  it('cannot pay out more than is confirmed, counting releases still waiting', async () => {
    mockPrisma.fundsEntry.aggregate.mockResolvedValue({ _sum: { amountKobo: 3_000_000n } });
    await expect(p.release(rel)).rejects.toThrow('available to release');
  });
  it('only the account owner can release, and not to themselves', async () => {
    await expect(p.release({ ...rel, actorId: PAYER })).rejects.toThrow('not your');
    await expect(p.release({ ...rel, recipientUserId: FAC })).rejects.toThrow('yourself');
  });
  it('only the recipient confirms a release, never the facilitator who paid', async () => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(entry({ type: 'RELEASE', payerUserId: FAC, counterpartyUserId: GRAD }));
    mockPrisma.fundsEntry.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.fundsEntry.findUniqueOrThrow.mockResolvedValue({});
    await expect(p.confirm(ENTRY, FAC)).rejects.toThrow('own payment');
    await p.confirm(ENTRY, GRAD);
    expect(mockPrisma.fundsEntry.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('append-only corrections', () => {
  it('an adjustment is a NEW signed, already-confirmed row that points at the original', async () => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(entry({ status: 'CONFIRMED' }));
    mockPrisma.fundsEntry.create.mockResolvedValue({ id: id('7') });
    await p.adjust({ adminId: ADMIN, entryId: ENTRY, amountKobo: -250_000n, note: 'Typed 12,500 instead of 10,000' });
    expect(mockPrisma.fundsEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'ADJUSTMENT', amountKobo: -250_000n, relatedEntryId: ENTRY, status: 'CONFIRMED' }) });
    expect(mockPrisma.fundsEntry.updateMany).not.toHaveBeenCalled();
  });
  it('needs a reason and a non-zero amount', async () => {
    await expect(p.adjust({ adminId: ADMIN, entryId: ENTRY, amountKobo: 0n, note: 'long enough note' })).rejects.toThrow('zero');
    await expect(p.adjust({ adminId: ADMIN, entryId: ENTRY, amountKobo: 5n, note: 'x' })).rejects.toThrow('Explain');
  });
});

describe('funds mode', () => {
  it('picks the provider from the group mode', async () => {
    expect((await getFundsProvider('COLLECTOR_CUSTODY')).mode).toBe('COLLECTOR_CUSTODY');
    expect((await getFundsProvider('ESCROW')).mode).toBe('ESCROW');
  });
  it('custody cannot confirm an escrow entry', async () => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(entry({ fundsMode: 'ESCROW' }));
    await expect(p.confirm(ENTRY, FAC)).rejects.toThrow('Escrow');
  });
});

describe('48h chase', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  it('reminds the facilitator once after 48h', async () => {
    mockPrisma.fundsEntry.findMany.mockResolvedValueOnce([entry()]).mockResolvedValueOnce([]);
    mockPrisma.fundsEntry.updateMany.mockResolvedValue({ count: 1 });
    const r = await chaseUnconfirmed(now);
    expect(r).toEqual({ reminded: 1, escalated: 0 });
    expect(mockPrisma.fundsEntry.findMany.mock.calls[0][0].where.createdAt.lt).toEqual(new Date('2026-03-08T12:00:00Z'));
    expect(sms).toHaveBeenCalledWith('+2348011111111', expect.stringContaining('48 hours'));
  });
  it('escalates to admins 24h after the reminder, and a lost race sends nothing', async () => {
    mockPrisma.fundsEntry.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([entry()]);
    mockPrisma.user.findMany.mockResolvedValue([{ phoneNumber: '+2348099999999' }]);
    mockPrisma.fundsEntry.updateMany.mockResolvedValue({ count: 1 });
    expect(await chaseUnconfirmed(now)).toEqual({ reminded: 0, escalated: 1 });
    expect(sms).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('unconfirmed'));
    sms.mockClear();
    mockPrisma.fundsEntry.findMany.mockResolvedValueOnce([entry()]).mockResolvedValueOnce([]);
    mockPrisma.fundsEntry.updateMany.mockResolvedValue({ count: 0 });
    await chaseUnconfirmed(now);
    expect(sms).not.toHaveBeenCalled();
  });
});
