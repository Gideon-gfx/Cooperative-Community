import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { objectId } from '../../lib/validators';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { verifyWebhookSignature } from '../../services/monnify.service';
import { serializeEntry } from '../ledger/ledger.router';
import { recordBillingPayment } from '../billing/billing.service';
import { MonnifyEscrowProvider } from './monnify-escrow.provider';
import { approveTier, cleanRecord, completedCycles, eligibleTier, requestFundsMode, requestTierUpgrade, verifyCollectorIdentity } from './custody.service';
import { contribute, previewFees } from './payments.service';

export const paymentsRouter = Router();

// ── Monnify webhook ─────────────────────────────────────────────────────────
// Unauthenticated by design: the HMAC-SHA512 signature over the RAW body is the authentication. Each delivery is
// recorded once (WebhookReceipt), so Monnify's retries and duplicates are harmless.
paymentsRouter.post('/webhook/monnify', async (req, res) => {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (!raw || !verifyWebhookSignature(raw, req.header('monnify-signature'))) {
    console.warn('[webhook] rejected: bad or missing Monnify signature');
    return void res.status(401).json({ error: 'Invalid signature' });
  }
  const body = z
    .object({ eventType: z.string(), eventData: z.object({ paymentReference: z.string().optional(), transactionReference: z.string().optional(), reference: z.string().optional(), status: z.string().optional(), paymentStatus: z.string().optional() }).passthrough() })
    .safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: 'Malformed event' });
  const { eventType, eventData } = body.data;
  const ref = eventData.transactionReference ?? eventData.reference ?? eventData.paymentReference;
  if (!ref) return void res.status(400).json({ error: 'No reference' });

  const key = `${eventType}:${ref}`;
  try {
    await prisma.webhookReceipt.create({ data: { transactionReference: key, eventType } });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return void res.json({ ok: true, duplicate: true });
    throw e;
  }

  try {
    const escrow = new MonnifyEscrowProvider();
    let outcome: string = 'IGNORED';
    if (eventType === 'SUCCESSFUL_TRANSACTION' && eventData.paymentReference && eventData.transactionReference) {
      // Platform billing (subscriptions CCS-, commission invoices CCC-) is the platform's own revenue and is kept apart from pooled funds.
      outcome = /^CC[SC]-/.test(eventData.paymentReference)
        ? await recordBillingPayment(eventData.paymentReference, eventData.transactionReference)
        : await escrow.recordCollected(eventData.paymentReference, eventData.transactionReference);
    } else if (eventType === 'SUCCESSFUL_DISBURSEMENT' && eventData.reference) {
      outcome = await escrow.finalizeDisbursement(eventData.reference, true);
    } else if ((eventType === 'FAILED_DISBURSEMENT' || eventType === 'REVERSED_DISBURSEMENT') && eventData.reference) {
      outcome = await escrow.finalizeDisbursement(eventData.reference, false, eventType);
    }
    res.json({ ok: true, outcome });
  } catch (e) {
    // Let Monnify retry: forget that we saw this delivery, then fail.
    await prisma.webhookReceipt.deleteMany({ where: { transactionReference: key } });
    console.error('[webhook] handler failed', (e as Error).message);
    res.status(500).json({ error: 'Could not process the event' });
  }
});

// ── Authenticated routes ────────────────────────────────────────────────────
paymentsRouter.use(authenticate);

const purposeType = z.enum(['AJO', 'CCGB', 'SETTLEMENT_FUND']);
const amount = z.union([z.string().min(1).max(20), z.number()]);

/** Pay into a group. Escrow returns a checkout link; custody records the declared payment. The user always comes from the token. */
paymentsRouter.post('/contribute', async (req, res) => {
  const b = z
    .object({ groupId: objectId, purposeType, purposeId: objectId, amount, facilitatorAccountId: objectId.optional(), bankReference: z.string().trim().max(100).optional(), proofImageUrl: z.string().url().optional() })
    .parse(req.body);
  const out = await contribute(req.user!, b);
  res.status(201).json({ ...out, result: out.result.kind === 'DECLARED' ? { kind: 'DECLARED', entry: serializeEntry(out.result.entry) } : out.result });
});

/** Ask to change a group's funds mode. It only takes effect at the start of the next cycle. */
paymentsRouter.post('/groups/:groupId/funds-mode', async (req, res) => {
  const { mode } = z.object({ mode: z.enum(['ESCROW', 'COLLECTOR_CUSTODY']) }).parse(req.body);
  const g = await requestFundsMode(req.user!, String(req.params.groupId), mode);
  res.json({ fundsMode: g.fundsMode, pendingFundsMode: g.pendingFundsMode, effective: 'at the start of the next cycle' });
});

paymentsRouter.patch('/groups/:groupId/registration', roleGuard(['ADMIN']), async (req, res) => {
  const { status } = z.object({ status: z.enum(['UNREGISTERED', 'IN_PROGRESS', 'REGISTERED']) }).parse(req.body);
  const g = await prisma.communityGroup.update({ where: { id: String(req.params.groupId) }, data: { registrationStatus: status } });
  await audit(req.user!.id, 'GROUP_REGISTRATION_SET', 'CommunityGroup', g.id, { status });
  res.json({ registrationStatus: g.registrationStatus });
});

// ── Collector verification & custody tiers ──
paymentsRouter.get('/custody/me', async (req, res) => {
  const kyc = await prisma.collectorKyc.findUnique({ where: { userId: req.user!.id } });
  const [{ clean, ...rates }, cycles] = await Promise.all([cleanRecord(req.user!.id), completedCycles(req.user!.id)]);
  res.json({ approvedTier: kyc?.approvedTier ?? 0, requestedTier: kyc?.requestedTier ?? null, pendingTier: kyc?.pendingTier ?? null, eligibleTier: eligibleTier(kyc, cycles, clean), cleanRecord: { clean, ...rates }, completedCycles: cycles });
});

/** The ID number is sent to the verification provider once and never stored or logged. */
paymentsRouter.post('/custody/kyc', roleGuard(['COLLECTOR', 'FACILITATOR']), async (req, res) => {
  const b = z.object({ kind: z.enum(['BVN', 'NIN']), idNumber: z.string().regex(/^\d{11}$/, 'Must be 11 digits') }).parse(req.body);
  const kyc = await verifyCollectorIdentity(req.user!.id, b.kind, b.idNumber);
  res.json({ bvnVerified: kyc.bvnVerified, ninVerified: kyc.ninVerified, nameMatch: kyc.nameMatch, approvedTier: kyc.approvedTier });
});

paymentsRouter.post('/custody/tier/request', roleGuard(['COLLECTOR', 'FACILITATOR']), async (req, res) => {
  const { tier } = z.object({ tier: z.number().int().min(1).max(3) }).parse(req.body);
  res.json({ requestedTier: (await requestTierUpgrade(req.user!.id, tier)).requestedTier });
});

paymentsRouter.patch('/custody/tier/:userId/approve', roleGuard(['ADMIN']), async (req, res) => {
  const { tier } = z.object({ tier: z.number().int().min(1).max(3) }).parse(req.body);
  res.json({ approvedTier: (await approveTier(req.user!.id, String(req.params.userId), tier)).approvedTier });
});

/** The Trust Board endorses a collector for tier 2+. */
paymentsRouter.patch('/custody/endorse/:userId', roleGuard(['BOARD_MEMBER', 'ADMIN']), async (req, res) => {
  const kyc = await prisma.collectorKyc.update({ where: { userId: String(req.params.userId) }, data: { boardEndorsed: true } }).catch(() => {
    throw new HttpError(404, 'This collector has not started verification');
  });
  await audit(req.user!.id, 'CUSTODY_ENDORSED', 'CollectorKyc', kyc.id, { userId: kyc.userId });
  res.json({ boardEndorsed: true });
});

/** An admin records the document checks done outside the app (address, certificate, licences, entity account name). */
paymentsRouter.patch('/custody/attest/:userId', roleGuard(['ADMIN']), async (req, res) => {
  const b = z.object({ addressAttested: z.boolean().optional(), entityCertVerified: z.boolean().optional(), licenseDocsVerified: z.boolean().optional(), entityAccountName: z.string().trim().min(2).max(120).optional() }).parse(req.body);
  const kyc = await prisma.collectorKyc.update({ where: { userId: String(req.params.userId) }, data: b }).catch(() => {
    throw new HttpError(404, 'This collector has not started verification');
  });
  await audit(req.user!.id, 'CUSTODY_DOCS_ATTESTED', 'CollectorKyc', kyc.id, { userId: kyc.userId, fields: Object.keys(b) });
  res.json({ ok: true });
});

export const feesRouter = Router();
feesRouter.use(authenticate);
feesRouter.get('/preview', async (req, res) => {
  const q = z.object({ amount: amount, purpose: purposeType, collectorFeePct: z.coerce.number().min(0).max(100).optional(), transportFee: amount.optional() }).parse(req.query);
  const p = await previewFees({ amount: q.amount, purposeType: q.purpose, collectorFeePct: q.collectorFeePct, transportFee: q.transportFee });
  res.json({ waterfall: p.waterfall, platformCommissionBp: p.platformCommissionBp, gatewayFeeBearer: p.gatewayFeeBearer });
});
