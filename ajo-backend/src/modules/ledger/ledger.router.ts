import { Router } from 'express';
import { FundsEntry } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { assertGroupMember } from '../../lib/access';
import { CUSTODY_NOTICE, ESCROW_NOTICE, modeBadge, noticeFor } from '../../lib/constants';
import { koboToNaira, nairaToKobo } from '../../lib/kobo';
import { objectId } from '../../lib/validators';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { deriveTotals, getFundsProvider } from '../payments/funds-provider';
import { contribute } from '../payments/payments.service';

// The ledger: every contribution, release, refund and commission, with balances derived from CONFIRMED rows only.
// Custody entries are declared and confirmed here; escrow entries are written by the payment webhook.
// Every user id comes from the JWT, never from the request body.
export const ledgerRouter = Router();
ledgerRouter.use(authenticate);

const amount = z.union([z.string().min(1).max(20), z.number()]);
const purposeType = z.enum(['AJO', 'CCGB', 'SETTLEMENT_FUND']);

/** BigInt cannot go through JSON; money leaves the API as an exact naira string. */
export function serializeEntry(e: FundsEntry) {
  const { amountKobo, ...rest } = e;
  return { ...rest, amount: koboToNaira(amountKobo) };
}
const notices = { ESCROW: ESCROW_NOTICE, COLLECTOR_CUSTODY: CUSTODY_NOTICE };

async function providerForEntry(entryId: string) {
  const entry = await prisma.fundsEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new HttpError(404, 'Entry not found');
  return getFundsProvider(entry.fundsMode);
}

// ── Facilitator accounts (collector-held mode) ──
ledgerRouter.post('/accounts', roleGuard(['FACILITATOR', 'COLLECTOR']), async (req, res) => {
  const b = z
    .object({ bankName: z.string().trim().min(2).max(60), accountNumber: z.string().regex(/^\d{10}$/, 'Account number must be 10 digits'), accountName: z.string().trim().min(2).max(100), communityGroupId: objectId.optional() })
    .parse(req.body);
  if (b.communityGroupId) await assertGroupMember(b.communityGroupId, req.user!.id);
  const account = await prisma.facilitatorAccount.create({ data: { ...b, userId: req.user!.id } });
  await audit(req.user!.id, 'FACILITATOR_ACCOUNT_ADDED', 'FacilitatorAccount', account.id);
  res.status(201).json({ account, notices });
});

/** Verified accounts a member can pay into. A group's account is only shown to that group's members. */
ledgerRouter.get('/accounts', async (req, res) => {
  const q = z.object({ communityGroupId: objectId.optional() }).parse(req.query);
  const accounts = await prisma.facilitatorAccount.findMany({ where: { isVerifiedByAdmin: true, ...(q.communityGroupId ? { communityGroupId: q.communityGroupId } : {}) } });
  const mine = new Set((await prisma.groupMember.findMany({ where: { userId: req.user!.id }, select: { groupId: true } })).map((m) => m.groupId));
  res.json({ accounts: accounts.filter((a) => !a.communityGroupId || mine.has(a.communityGroupId)), notices });
});

ledgerRouter.patch('/accounts/:id/verify', roleGuard(['ADMIN']), async (req, res) => {
  const account = await prisma.facilitatorAccount.update({ where: { id: String(req.params.id) }, data: { isVerifiedByAdmin: true } });
  await audit(req.user!.id, 'FACILITATOR_ACCOUNT_VERIFIED', 'FacilitatorAccount', account.id);
  res.json({ account });
});

// ── Entries ──
/** Declare a payment made to the group's collector. Only for COLLECTOR_CUSTODY groups; escrow groups use /api/payments/contribute. */
ledgerRouter.post('/declare', async (req, res) => {
  const b = z
    .object({ groupId: objectId, facilitatorAccountId: objectId, purposeType, purposeId: objectId, amount, bankReference: z.string().trim().max(100).optional(), proofImageUrl: z.string().url().optional() })
    .parse(req.body);
  const group = await prisma.communityGroup.findUnique({ where: { id: b.groupId }, select: { fundsMode: true } });
  if (!group) throw new HttpError(404, 'Group not found');
  if (group.fundsMode !== 'COLLECTOR_CUSTODY') throw new HttpError(409, 'This group uses escrow. Pay through /api/payments/contribute instead.');
  const out = await contribute(req.user!, b);
  res.status(201).json({ entry: out.result.kind === 'DECLARED' ? serializeEntry(out.result.entry) : null, notice: out.notice, badge: out.badge });
});

ledgerRouter.patch('/:id/confirm', async (req, res) => {
  const p = await providerForEntry(String(req.params.id));
  const entry = await p.confirm(String(req.params.id), req.user!.id);
  res.json({ entry: serializeEntry(entry), notice: noticeFor(entry.fundsMode) });
});

ledgerRouter.patch('/:id/dispute', async (req, res) => {
  const { note } = z.object({ note: z.string().trim().min(3).max(300) }).parse(req.body);
  const p = await providerForEntry(String(req.params.id));
  const entry = await p.dispute(String(req.params.id), req.user!.id, note);
  res.json({ entry: serializeEntry(entry), notice: noticeFor(entry.fundsMode) });
});

/** A platform admin corrects a mistake with a new, signed entry. The original row is never edited. */
ledgerRouter.post('/:id/adjust', roleGuard(['ADMIN']), async (req, res) => {
  const b = z.object({ amount, note: z.string().trim().min(5).max(300) }).parse(req.body);
  const p = await providerForEntry(String(req.params.id));
  const entry = await p.adjust({ adminId: req.user!.id, entryId: String(req.params.id), amountKobo: nairaToKobo(b.amount, { allowSigned: true }), note: b.note });
  res.status(201).json({ entry: serializeEntry(entry) });
});

/** What I have paid or been paid, with my confirmed totals per purpose derived from the ledger. */
ledgerRouter.get('/mine', async (req, res) => {
  const me = req.user!.id;
  const entries = await prisma.fundsEntry.findMany({ where: { OR: [{ payerUserId: me }, { counterpartyUserId: me }] }, orderBy: { createdAt: 'desc' }, take: 100 });
  const purposes = ['AJO', 'CCGB', 'SETTLEMENT_FUND'] as const;
  const totals = await Promise.all(purposes.map(async (p) => ({ purposeType: p, ...(await deriveTotals({ purposeType: p, payerUserId: me })) })));
  res.json({
    entries: entries.map(serializeEntry),
    confirmed: totals.map((t) => ({ purposeType: t.purposeType, contributions: koboToNaira(t.contributions), adjustments: koboToNaira(t.adjustments), releases: koboToNaira(t.releases) })),
    waitingForFacilitator: entries.filter((e) => e.payerUserId === me && e.status === 'DECLARED' && e.fundsMode === 'COLLECTOR_CUSTODY').length,
    notices,
  });
});

/** The public audit trail for a group, visible to every member: confirmed entries and disputes, with the derived balance. */
ledgerRouter.get('/group/:groupId', async (req, res) => {
  const groupId = String(req.params.groupId);
  await assertGroupMember(groupId, req.user!.id);
  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: groupId }, select: { fundsMode: true, registrationStatus: true } });
  const entries = await prisma.fundsEntry.findMany({ where: { groupId, status: { in: ['CONFIRMED', 'DISPUTED', 'REVERSED'] } }, orderBy: { createdAt: 'desc' }, take: 300 });
  const people = await prisma.user.findMany({ where: { id: { in: [...new Set(entries.map((e) => e.payerUserId))] } }, select: { id: true, fullName: true } });
  const totals = await deriveTotals({ groupId });
  res.json({
    mode: group.fundsMode, badge: modeBadge(group.fundsMode), notice: noticeFor(group.fundsMode), registrationStatus: group.registrationStatus,
    balance: koboToNaira(totals.balance), contributions: koboToNaira(totals.contributions), releases: koboToNaira(totals.releases), refunds: koboToNaira(totals.refunds), commissions: koboToNaira(totals.commissions),
    entries: entries.map((e) => ({ ...serializeEntry(e), payerName: people.find((p) => p.id === e.payerUserId)?.fullName ?? '—', proofImageUrl: undefined })),
    disputes: entries.filter((e) => e.status === 'DISPUTED').length,
  });
});

/** Payments declared to my account(s) that I still have to confirm or dispute. */
ledgerRouter.get('/facilitator/pending', roleGuard(['FACILITATOR', 'COLLECTOR']), async (req, res) => {
  const accounts = await prisma.facilitatorAccount.findMany({ where: { userId: req.user!.id }, select: { id: true } });
  const entries = await prisma.fundsEntry.findMany({ where: { facilitatorAccountId: { in: accounts.map((a) => a.id) }, type: 'CONTRIBUTION', status: 'DECLARED' }, orderBy: { createdAt: 'asc' }, take: 200 });
  const people = await prisma.user.findMany({ where: { id: { in: entries.map((e) => e.payerUserId) } }, select: { id: true, fullName: true } });
  res.json({ entries: entries.map((e) => ({ ...serializeEntry(e), payerName: people.find((p) => p.id === e.payerUserId)?.fullName ?? '—' })), notice: CUSTODY_NOTICE });
});
