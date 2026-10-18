import axios from 'axios';
import crypto from 'crypto';
import { config } from '../lib/config';

const { baseUrl } = config.monnify;
let cached: { token: string; expiresAt: number } | null = null;

export async function authenticateMonnify(): Promise<string> {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const basic = Buffer.from(`${config.monnify.apiKey}:${config.monnify.clientSecret}`).toString('base64');
  const { data } = await axios.post(`${baseUrl}/api/v1/auth/login`, {}, { headers: { Authorization: `Basic ${basic}` } });
  const token: string = data.responseBody.accessToken;
  cached = { token, expiresAt: Date.now() + 55 * 60 * 1000 };
  return token;
}

const authHeaders = async () => ({ Authorization: `Bearer ${await authenticateMonnify()}` });

export async function initializeTransaction(
  amount: number,
  customerName: string,
  customerEmail: string,
  reference: string,
  metadata: Record<string, unknown> = {},
): Promise<{ checkoutUrl: string; transactionReference: string }> {
  const { data } = await axios.post(
    `${baseUrl}/api/v1/merchant/transactions/init-transaction`,
    {
      amount,
      customerName,
      customerEmail,
      paymentReference: reference,
      paymentDescription: 'ÀJỌ payment',
      currencyCode: 'NGN',
      contractCode: config.monnify.contractCode,
      metaData: metadata,
    },
    { headers: await authHeaders() },
  );
  return { checkoutUrl: data.responseBody.checkoutUrl, transactionReference: data.responseBody.transactionReference };
}

export interface PayoutItem {
  accountNumber: string;
  bankCode: string;
  amount: number;
  narration: string;
}

/** Bulk disbursement. Returns the batch reference. */
export async function initiateSplitPayout(payouts: PayoutItem[]): Promise<string> {
  if (payouts.length === 0) throw new Error('No payouts supplied');
  const batchReference = `AJO-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { data } = await axios.post(
    `${baseUrl}/api/v2/disbursements/batch`,
    {
      title: payouts[0].narration,
      batchReference,
      narration: payouts[0].narration,
      sourceAccountNumber: config.monnify.sourceAccount,
      onValidationFailure: 'CONTINUE',
      notificationInterval: 25,
      transactionList: payouts.map((p, i) => ({
        amount: p.amount,
        reference: `${batchReference}-${i}`,
        narration: p.narration,
        destinationBankCode: p.bankCode,
        destinationAccountNumber: p.accountNumber,
        currency: 'NGN',
      })),
    },
    { headers: await authHeaders() },
  );
  return data.responseBody?.batchReference ?? batchReference;
}

export async function verifyTransaction(transactionReference: string) {
  const { data } = await axios.get(
    `${baseUrl}/api/v2/transactions/${encodeURIComponent(transactionReference)}`,
    { headers: await authHeaders() },
  );
  return data.responseBody as { paymentStatus: string; amountPaid: number; [k: string]: unknown };
}

/**
 * Monnify signs every webhook: HMAC-SHA512 (hex) of the RAW request body with the client secret, sent as `monnify-signature`.
 * Compared in constant time. Anything unsigned or wrongly signed must be rejected before it is parsed.
 */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined, secret = config.monnify.clientSecret): boolean {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature.trim().toLowerCase());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface SingleTransfer { amountNaira: string; reference: string; narration: string; bankCode: string; accountNumber: string }
export type TransferState = 'SUCCESS' | 'PENDING' | 'FAILED';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (e: unknown) => axios.isAxiosError(e) && (!e.response || e.response.status >= 500);

/**
 * One disbursement. The reference is ours and stays the same across retries, so Monnify can de-duplicate:
 * a network blip never pays twice. Only network errors and 5xx are retried (backoff 1s, 2s, 4s).
 */
export async function initiateSingleTransfer(t: SingleTransfer, attempts = 3, backoffMs = 1000): Promise<{ state: TransferState; providerRef?: string; message?: string }> {
  let last: unknown;
  for (let n = 0; n < attempts; n++) {
    try {
      const { data } = await axios.post(
        `${baseUrl}/api/v2/disbursements/single`,
        { amount: Number(t.amountNaira), reference: t.reference, narration: t.narration, destinationBankCode: t.bankCode, destinationAccountNumber: t.accountNumber, currency: 'NGN', sourceAccountNumber: config.monnify.sourceAccount },
        { headers: await authHeaders() },
      );
      const status = String(data.responseBody?.status ?? '').toUpperCase();
      return { state: status === 'SUCCESS' ? 'SUCCESS' : status === 'FAILED' ? 'FAILED' : 'PENDING', providerRef: data.responseBody?.reference, message: data.responseMessage };
    } catch (e) {
      last = e;
      if (!retryable(e)) break;
      if (n < attempts - 1) await sleep(backoffMs * 2 ** n);
    }
  }
  const msg = axios.isAxiosError(last) ? (last.response?.data?.responseMessage ?? last.message) : String(last);
  return { state: axios.isAxiosError(last) && last.response && last.response.status < 500 ? 'FAILED' : 'PENDING', message: msg };
}

export async function disbursementStatus(reference: string): Promise<TransferState> {
  const { data } = await axios.get(`${baseUrl}/api/v2/disbursements/single/summary`, { params: { reference }, headers: await authHeaders() });
  const status = String(data.responseBody?.status ?? '').toUpperCase();
  return status === 'SUCCESS' ? 'SUCCESS' : status === 'FAILED' || status === 'REVERSED' ? 'FAILED' : 'PENDING';
}

/** Asks the bank who owns an account number. The name comes from the bank, so nobody can pretend an account is someone else's. */
export async function validateBankAccount(accountNumber: string, bankCode: string): Promise<{ accountName: string }> {
  const { data } = await axios.get(`${baseUrl}/api/v1/disbursements/account/validate`, { params: { accountNumber, bankCode }, headers: await authHeaders() });
  const name = String(data.responseBody?.accountName ?? '').trim();
  if (!name) throw new Error('The bank did not return an account name');
  return { accountName: name };
}
