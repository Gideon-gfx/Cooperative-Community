process.env.MONNIFY_CLIENT_SECRET = 'test-secret';

const mockPrisma: Record<string, any> = {
  webhookReceipt: { create: jest.fn(), deleteMany: jest.fn() },
  auditLog: { create: jest.fn() },
};
const recordCollected = jest.fn();
const finalizeDisbursement = jest.fn();
jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../lib/notify', () => ({ safeSms: jest.fn(), safeSmsAndEmail: jest.fn(), naira: (n: unknown) => `₦${n}` }));
jest.mock('../modules/payments/monnify-escrow.provider', () => ({
  MonnifyEscrowProvider: jest.fn().mockImplementation(() => ({ recordCollected, finalizeDisbursement })),
}));

import crypto from 'crypto';
import express from 'express';
import type { AddressInfo } from 'net';
import { paymentsRouter } from '../modules/payments/payments.router';
import { errorHandler } from '../middleware/error.middleware';

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
app.use('/api/payments', paymentsRouter);
app.use(errorHandler);

const server = app.listen(0);
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/payments/webhook/monnify`;
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sign = (raw: string, secret = 'test-secret') => crypto.createHmac('sha512', secret).update(raw).digest('hex');
const post = (payload: unknown, sig?: string | null) => {
  const raw = JSON.stringify(payload);
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(sig === null ? {} : { 'monnify-signature': sig ?? sign(raw) }) }, body: raw });
};
const paid = { eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: 'CCA-1', transactionReference: 'MNFY|1' } };

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.webhookReceipt.create.mockResolvedValue({});
  recordCollected.mockResolvedValue('RECORDED');
  finalizeDisbursement.mockResolvedValue('DONE');
});

describe('POST /api/payments/webhook/monnify', () => {
  it('rejects a missing, wrong or tampered signature before doing anything', async () => {
    expect((await post(paid, null)).status).toBe(401);
    expect((await post(paid, sign(JSON.stringify(paid), 'wrong'))).status).toBe(401);
    const tampered = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'monnify-signature': sign(JSON.stringify(paid)) }, body: JSON.stringify({ ...paid, eventData: { ...paid.eventData, paymentReference: 'CCA-2' } }) });
    expect(tampered.status).toBe(401);
    expect(mockPrisma.webhookReceipt.create).not.toHaveBeenCalled();
    expect(recordCollected).not.toHaveBeenCalled();
  });

  it('records a paid transaction exactly once', async () => {
    const r = await post(paid);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, outcome: 'RECORDED' });
    expect(recordCollected).toHaveBeenCalledWith('CCA-1', 'MNFY|1');
    expect(mockPrisma.webhookReceipt.create).toHaveBeenCalledWith({ data: { transactionReference: 'SUCCESSFUL_TRANSACTION:MNFY|1', eventType: 'SUCCESSFUL_TRANSACTION' } });
  });

  it('a redelivered event is acknowledged and ignored (idempotent on the transaction reference)', async () => {
    mockPrisma.webhookReceipt.create.mockRejectedValue({ code: 'P2002' });
    const r = await post(paid);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ duplicate: true });
    expect(recordCollected).not.toHaveBeenCalled();
  });

  it('if processing fails, the receipt is forgotten and Monnify is told to retry', async () => {
    recordCollected.mockRejectedValue(new Error('db down'));
    const r = await post(paid);
    expect(r.status).toBe(500);
    expect(mockPrisma.webhookReceipt.deleteMany).toHaveBeenCalledWith({ where: { transactionReference: 'SUCCESSFUL_TRANSACTION:MNFY|1' } });
  });

  it('settles disbursement results', async () => {
    await post({ eventType: 'SUCCESSFUL_DISBURSEMENT', eventData: { reference: 'CCR-1' } });
    expect(finalizeDisbursement).toHaveBeenCalledWith('CCR-1', true);
    await post({ eventType: 'FAILED_DISBURSEMENT', eventData: { reference: 'CCR-2' } });
    expect(finalizeDisbursement).toHaveBeenCalledWith('CCR-2', false, 'FAILED_DISBURSEMENT');
  });

  it('ignores event types it does not handle, and rejects malformed bodies', async () => {
    const r = await post({ eventType: 'SOMETHING_NEW', eventData: { transactionReference: 'X' } });
    expect(await r.json()).toMatchObject({ outcome: 'IGNORED' });
    expect((await post({ nope: true })).status).toBe(400);
  });
});
