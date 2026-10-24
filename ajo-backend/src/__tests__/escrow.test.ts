import crypto from 'crypto';

const mockPrisma: Record<string, any> = {
  providerTransaction: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  fundsEntry: { create: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn(), aggregate: jest.fn() },
  commissionAccrual: { create: jest.fn(), updateMany: jest.fn() },
  platformConfig: { findUnique: jest.fn(), create: jest.fn() },
  communityGroup: { findUnique: jest.fn() },
  settlementFund: { findUnique: jest.fn() },
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: (fn: (db: unknown) => unknown) => fn(mockPrisma),
};
const sms = jest.fn();
const mockMonnify = { verifyTransaction: jest.fn(), initializeTransaction: jest.fn(), initiateSingleTransfer: jest.fn() };
jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../lib/notify', () => ({ safeSms: (...a: unknown[]) => sms(...a), safeSmsAndEmail: (...a: unknown[]) => a[0] && sms(a[0], a[3]), naira: (n: unknown) => `₦${n}` }));
jest.mock('../services/monnify.service', () => ({ ...jest.requireActual('../services/monnify.service'), ...mockMonnify }));

import { verifyWebhookSignature } from '../services/monnify.service';
import { MonnifyEscrowProvider } from '../modules/payments/monnify-escrow.provider';
import { dissolvePurpose, earnCommission } from '../modules/payments/commission.service';

const id = (c: string) => c.repeat(24);
const GROUP = id('a'), PAYER = id('b'), POOL = id('c'), TX = id('d'), ENTRY = id('e'), ADMIN = id('f');
const e = new MonnifyEscrowProvider();

const tx = (over: Record<string, unknown> = {}) => ({ id: TX, kind: 'COLLECT', status: 'INITIATED', paymentReference: 'CCA-1', groupId: GROUP, purposeType: 'AJO', purposeId: POOL, payerUserId: PAYER, amountKobo: 1_000_000n, ...over });

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.$transaction = (fn: (db: unknown) => unknown) => fn(mockPrisma);
  mockPrisma.user.findUnique.mockResolvedValue({ phoneNumber: '+2348011111111' });
  mockPrisma.user.findMany.mockResolvedValue([{ phoneNumber: '+2348099999999' }]);
  mockPrisma.platformConfig.findUnique.mockResolvedValue({ platformCommissionBp: 500, settlementCommissionBp: 0, gatewayFeeBearer: 'PLATFORM' });
  mockPrisma.fundsEntry.create.mockResolvedValue({ id: ENTRY });
  mockPrisma.providerTransaction.updateMany.mockResolvedValue({ count: 1 });
  mockMonnify.verifyTransaction.mockResolvedValue({ paymentStatus: 'PAID', amountPaid: 10000 });
});

describe('Monnify webhook signature (HMAC-SHA512)', () => {
  const body = Buffer.from(JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: 'CCA-1' } }));
  const sign = (b: Buffer, secret: string) => crypto.createHmac('sha512', secret).update(b).digest('hex');
  it('accepts the exact body signed with the client secret', () => {
    expect(verifyWebhookSignature(body, sign(body, 'sekret'), 'sekret')).toBe(true);
  });
  it('rejects a tampered body, a wrong secret, a missing signature, and an empty secret', () => {
    expect(verifyWebhookSignature(Buffer.from('{"x":1}'), sign(body, 'sekret'), 'sekret')).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, 'other'), 'sekret')).toBe(false);
    expect(verifyWebhookSignature(body, undefined, 'sekret')).toBe(false);
    expect(verifyWebhookSignature(body, sign(body, ''), '')).toBe(false);
    expect(verifyWebhookSignature(body, 'short', 'sekret')).toBe(false);
  });
});

describe('recording a Monnify payment', () => {
  it('writes a CONFIRMED contribution, ONE commission entry and a PENDING accrual', async () => {
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(tx());
    expect(await e.recordCollected('CCA-1', 'MNFY|1')).toBe('RECORDED');
    const created = mockPrisma.fundsEntry.create.mock.calls.map((c: any) => c[0].data);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({ type: 'CONTRIBUTION', status: 'CONFIRMED', fundsMode: 'ESCROW', amountKobo: 1_000_000n, providerRef: 'MNFY|1' });
    expect(created[1]).toMatchObject({ type: 'COMMISSION', amountKobo: 50_000n, relatedEntryId: ENTRY });
    expect(mockPrisma.commissionAccrual.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amountKobo: 50_000n, fundsEntryId: ENTRY }) });
    expect(sms).toHaveBeenCalledWith('+2348011111111', expect.stringContaining('₦100.00'.replace('100', '10000')));
  });

  it('is idempotent: an already-PAID transaction, or a lost race, records nothing', async () => {
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(tx({ status: 'PAID' }));
    expect(await e.recordCollected('CCA-1', 'MNFY|1')).toBe('DUPLICATE');
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(tx());
    mockPrisma.providerTransaction.updateMany.mockResolvedValue({ count: 0 });
    expect(await e.recordCollected('CCA-1', 'MNFY|1')).toBe('DUPLICATE');
    expect(mockPrisma.fundsEntry.create).not.toHaveBeenCalled();
  });

  it('settlement funds carry 0% commission by default: no commission entry at all', async () => {
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(tx({ purposeType: 'SETTLEMENT_FUND' }));
    await e.recordCollected('CCA-1', 'MNFY|1');
    expect(mockPrisma.fundsEntry.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.commissionAccrual.create).not.toHaveBeenCalled();
  });

  it('re-checks with Monnify: not PAID, or paid less than asked, is never recorded', async () => {
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(tx());
    mockMonnify.verifyTransaction.mockResolvedValue({ paymentStatus: 'PENDING', amountPaid: 0 });
    expect(await e.recordCollected('CCA-1', 'MNFY|1')).toBe('NOT_PAID');
    mockMonnify.verifyTransaction.mockResolvedValue({ paymentStatus: 'PAID', amountPaid: 9000 });
    expect(await e.recordCollected('CCA-1', 'MNFY|1')).toBe('AMOUNT_MISMATCH');
    expect(mockPrisma.fundsEntry.create).not.toHaveBeenCalled();
    expect(sms).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('less than the contribution'));
  });

  it('ignores references we never issued', async () => {
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(null);
    expect(await e.recordCollected('NOPE', 'MNFY|1')).toBe('UNKNOWN');
  });
});

describe('escrow gate', () => {
  const OLD = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = OLD; });
  it('refuses to collect in production while MONNIFY_POOLING_APPROVED is false', async () => {
    process.env.NODE_ENV = 'production';
    await expect(e.collect({ groupId: GROUP, payerUserId: PAYER, purposeType: 'AJO', purposeId: POOL, amountKobo: 1000n })).rejects.toThrow('MONNIFY_POOLING_APPROVED');
    expect(mockPrisma.providerTransaction.create).not.toHaveBeenCalled();
  });
  it('works in sandbox/test', async () => {
    mockMonnify.initializeTransaction.mockResolvedValue({ checkoutUrl: 'https://pay/x', transactionReference: 'MNFY|9' });
    const r = await e.collect({ groupId: GROUP, payerUserId: PAYER, purposeType: 'AJO', purposeId: POOL, amountKobo: 1_000_000n, chargeKobo: 1_000_000n });
    expect(r).toMatchObject({ kind: 'CHECKOUT', checkoutUrl: 'https://pay/x' });
    expect(mockMonnify.initializeTransaction.mock.calls[0][0]).toBe(10000);
  });
});

describe('disbursement', () => {
  const dtx = (over = {}) => ({ id: TX, kind: 'DISBURSE', status: 'DISBURSING', paymentReference: 'CCF-1', fundsEntryId: ENTRY, payeeUserId: PAYER, amountKobo: 1_000_000n, ...over });
  it('success confirms the entry; a refund also takes its commission back', async () => {
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(dtx());
    mockPrisma.fundsEntry.findUniqueOrThrow.mockResolvedValue({ id: ENTRY, type: 'REFUND', relatedEntryId: id('1') });
    expect(await e.finalizeDisbursement('CCF-1', true)).toBe('DONE');
    expect(mockPrisma.fundsEntry.updateMany).toHaveBeenCalledWith({ where: { id: ENTRY, status: 'DECLARED' }, data: expect.objectContaining({ status: 'CONFIRMED' }) });
    expect(mockPrisma.fundsEntry.updateMany).toHaveBeenCalledWith({ where: { type: 'COMMISSION', relatedEntryId: id('1'), status: 'CONFIRMED' }, data: { status: 'REVERSED' } });
    expect(mockPrisma.commissionAccrual.updateMany).toHaveBeenCalledWith({ where: { fundsEntryId: id('1'), status: { in: ['PENDING', 'EARNED'] } }, data: expect.objectContaining({ status: 'REFUNDED' }) });
  });
  it('a plain release does not touch commission', async () => {
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(dtx());
    mockPrisma.fundsEntry.findUniqueOrThrow.mockResolvedValue({ id: ENTRY, type: 'RELEASE', relatedEntryId: null });
    await e.finalizeDisbursement('CCF-1', true);
    expect(mockPrisma.commissionAccrual.updateMany).not.toHaveBeenCalled();
  });
  it('failure reverses the entry, leaves commission alone and alerts the admins loudly', async () => {
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(dtx());
    mockPrisma.fundsEntry.findUniqueOrThrow.mockResolvedValue({ id: ENTRY, type: 'REFUND', relatedEntryId: id('1') });
    await e.finalizeDisbursement('CCF-1', false, 'Invalid account');
    expect(mockPrisma.fundsEntry.updateMany).toHaveBeenCalledWith({ where: { id: ENTRY, status: 'DECLARED' }, data: expect.objectContaining({ status: 'REVERSED' }) });
    expect(mockPrisma.commissionAccrual.updateMany).not.toHaveBeenCalled();
    expect(sms).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('FAILED'));
  });
  it('settling twice is a no-op', async () => {
    mockPrisma.providerTransaction.findUnique.mockResolvedValue(dtx());
    mockPrisma.providerTransaction.updateMany.mockResolvedValue({ count: 0 });
    expect(await e.finalizeDisbursement('CCF-1', true)).toBe('DUPLICATE');
    expect(mockPrisma.fundsEntry.updateMany).not.toHaveBeenCalled();
  });

  describe('release', () => {
    const rel = { groupId: GROUP, purposeType: 'SETTLEMENT_FUND' as const, purposeId: POOL, actorId: ADMIN, recipientUserId: PAYER, amountKobo: 3_000_000n, destination: { bankCode: '058', accountNumber: '0123456789' } };
    beforeEach(() => {
      mockPrisma.fundsEntry.groupBy.mockResolvedValue([{ type: 'CONTRIBUTION', _sum: { amountKobo: 5_000_000n } }]);
      mockPrisma.fundsEntry.aggregate.mockResolvedValue({ _sum: { amountKobo: 0n } });
      mockMonnify.initiateSingleTransfer.mockResolvedValue({ state: 'PENDING' });
      mockPrisma.fundsEntry.findUniqueOrThrow.mockResolvedValue({ id: ENTRY, status: 'DECLARED' });
    });
    it('starts a disbursement and leaves the entry DECLARED until the bank confirms', async () => {
      await e.release(rel);
      expect(mockPrisma.fundsEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'RELEASE', fundsMode: 'ESCROW', amountKobo: 3_000_000n }) });
      expect(mockMonnify.initiateSingleTransfer).toHaveBeenCalledWith(expect.objectContaining({ amountNaira: '30000.00', bankCode: '058' }));
      expect(mockPrisma.fundsEntry.updateMany).not.toHaveBeenCalled();
    });
    it('cannot release more than the group holds, counting payouts already in flight', async () => {
      mockPrisma.fundsEntry.aggregate.mockResolvedValue({ _sum: { amountKobo: 3_000_000n } });
      await expect(e.release(rel)).rejects.toThrow('available');
      expect(mockMonnify.initiateSingleTransfer).not.toHaveBeenCalled();
    });
    it('needs a destination account', async () => {
      await expect(e.release({ ...rel, destination: undefined })).rejects.toThrow('destination');
    });
  });
});

describe('refunds and commission lifecycle', () => {
  const contribution = { id: ENTRY, type: 'CONTRIBUTION', fundsMode: 'ESCROW', status: 'CONFIRMED', groupId: GROUP, purposeType: 'AJO', purposeId: POOL, payerUserId: PAYER, amountKobo: 1_000_000n };
  it('refunds the FULL contribution, commission included', async () => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(contribution);
    mockPrisma.fundsEntry.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ bankAccountNo: '0123456789', bankCode: '058' });
    mockMonnify.initiateSingleTransfer.mockResolvedValue({ state: 'PENDING' });
    mockPrisma.fundsEntry.findUniqueOrThrow.mockResolvedValue({ id: ENTRY });
    await e.refund({ entryId: ENTRY, actorId: ADMIN });
    expect(mockPrisma.fundsEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'REFUND', amountKobo: 1_000_000n, relatedEntryId: ENTRY }) });
    expect(mockMonnify.initiateSingleTransfer).toHaveBeenCalledWith(expect.objectContaining({ amountNaira: '10000.00' }));
  });
  it('needs bank details, and cannot refund twice', async () => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue(contribution);
    mockPrisma.fundsEntry.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ bankAccountNo: null, bankCode: null });
    await expect(e.refund({ entryId: ENTRY, actorId: ADMIN })).rejects.toThrow('bank account');
    mockPrisma.fundsEntry.findFirst.mockResolvedValue({ id: 'x' });
    await expect(e.refund({ entryId: ENTRY, actorId: ADMIN })).rejects.toThrow('already been refunded');
  });
  it('commission becomes EARNED only when the cycle completes', async () => {
    mockPrisma.commissionAccrual.updateMany.mockResolvedValue({ count: 3 });
    expect(await earnCommission('AJO', POOL, ADMIN)).toBe(3);
    expect(mockPrisma.commissionAccrual.updateMany).toHaveBeenCalledWith({ where: { purposeType: 'AJO', purposeId: POOL, status: 'PENDING' }, data: expect.objectContaining({ status: 'EARNED' }) });
  });
  it('dissolving a pool refunds every contribution in full, and one member without bank details does not block the rest', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue({ id: GROUP, fundsMode: 'ESCROW' });
    mockPrisma.fundsEntry.findMany.mockResolvedValue([{ id: id('1') }, { id: id('2') }, { id: id('3') }]);
    const refund = jest.spyOn(MonnifyEscrowProvider.prototype, 'refund')
      .mockResolvedValueOnce({ id: 'r1' } as never)
      .mockRejectedValueOnce(new Error('The member needs to add their bank account'))
      .mockResolvedValueOnce({ id: 'r3' } as never);
    const r = await dissolvePurpose({ groupId: GROUP, purposeType: 'AJO', purposeId: POOL, actorId: ADMIN });
    expect(r.refunded).toBe(2);
    expect(r.failed).toEqual([{ entryId: id('2'), error: 'The member needs to add their bank account' }]);
    expect(refund).toHaveBeenCalledTimes(3);
    refund.mockRestore();
  });
});

describe('append-only', () => {
  it('an escrow adjustment is a new signed entry, never an edit', async () => {
    mockPrisma.fundsEntry.findUnique.mockResolvedValue({ id: ENTRY, groupId: GROUP, fundsMode: 'ESCROW', purposeType: 'AJO', purposeId: POOL });
    await e.adjust({ adminId: ADMIN, entryId: ENTRY, amountKobo: -10_000n, note: 'Duplicate payment fixed' });
    expect(mockPrisma.fundsEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'ADJUSTMENT', amountKobo: -10_000n, relatedEntryId: ENTRY }) });
    expect(mockPrisma.fundsEntry.updateMany).not.toHaveBeenCalled();
  });
});
