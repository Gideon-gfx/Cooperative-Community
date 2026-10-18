import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { assertGroupMember } from '../../lib/access';
import { objectId } from '../../lib/validators';
import { verifyPin } from '../../lib/security';
import { audit } from '../../lib/audit';
import { authenticate } from '../../middleware/auth.middleware';
import { addEntry, attestFunds, getLedger } from '../../services/ledger.service';
import {
  assertHost, confirmDelivery, createCampaign, giveGift, loadCampaign, markCollected, progressOf, recordDelivery, rejectGift, setStatus, verifyGift,
} from './campaigns.service';

// Ìtìlẹ́yìn: aṣọ ẹbí and help-someone collections. The host holds the money; the platform only records it.
export const campaignsRouter = Router();
campaignsRouter.use(authenticate);

const method = z.enum(['TRANSFER', 'CASH']);

campaignsRouter.post('/', async (req, res) => {
  const b = z
    .object({
      groupId: objectId,
      kind: z.enum(['ASO_EBI', 'HELP', 'OTHER']),
      occasion: z.string().min(2).max(30),
      occasionLabel: z.string().trim().min(2).max(40).optional(),
      title: z.string().min(3).max(100),
      description: z.string().max(1000).optional(),
      eventDate: z.coerce.date().optional(),
      venue: z.string().max(150).optional(),
      partAmount: z.number().positive().optional(),
      targetAmount: z.number().positive().optional(),
      targetPeople: z.number().int().positive().optional(),
      recipientName: z.string().min(2).max(100).optional(),
      recipientNote: z.string().max(500).optional(),
      recipientUserId: objectId.optional(),
      closesAt: z.coerce.date().optional(),
      options: z.array(z.object({ label: z.string().min(2).max(60), note: z.string().max(60).optional() })).max(6).optional(),
    })
    .parse(req.body);
  res.status(201).json({ campaign: await createCampaign(req.user!.id, b) });
});

/** Everything open (or recently finished) in the groups I belong to. */
campaignsRouter.get('/mine', async (req, res) => {
  const q = z.object({ kind: z.enum(['ASO_EBI', 'HELP', 'OTHER']).optional() }).parse(req.query);
  const userId = req.user!.id;
  const memberships = await prisma.groupMember.findMany({ where: { userId }, select: { groupId: true } });
  const campaigns = await prisma.campaign.findMany({
    where: { groupId: { in: memberships.map((m) => m.groupId) }, ...(q.kind ? { kind: q.kind } : {}), status: { in: ['OPEN', 'CLOSED', 'COMPLETED'] } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { options: true },
  });
  const groups = await prisma.communityGroup.findMany({ where: { id: { in: campaigns.map((c) => c.groupId) } }, select: { id: true, name: true, currency: true } });
  const hosts = await prisma.user.findMany({ where: { id: { in: campaigns.map((c) => c.hostId) } }, select: { id: true, fullName: true } });
  const mine = await prisma.campaignGift.findMany({ where: { userId, campaignId: { in: campaigns.map((c) => c.id) }, status: { in: ['PENDING', 'VERIFIED'] } }, select: { campaignId: true, status: true } });
  const out = await Promise.all(
    campaigns.map(async (c) => ({
      ...c,
      groupName: groups.find((g) => g.id === c.groupId)?.name,
      currency: groups.find((g) => g.id === c.groupId)?.currency ?? 'NGN',
      hostName: hosts.find((h) => h.id === c.hostId)?.fullName,
      isHost: c.hostId === userId,
      myGiftStatus: mine.find((m) => m.campaignId === c.id)?.status ?? null,
      progress: await progressOf(c.id),
    })),
  );
  res.json({ campaigns: out });
});

campaignsRouter.get('/:id', async (req, res) => {
  const c = await loadCampaign(String(req.params.id));
  await assertGroupMember(c.groupId, req.user!.id);
  const userId = req.user!.id;
  const [gifts, progress, ledger] = await Promise.all([
    prisma.campaignGift.findMany({ where: { campaignId: c.id, status: { in: ['PENDING', 'VERIFIED'] } }, orderBy: { createdAt: 'asc' } }),
    progressOf(c.id),
    getLedger({ campaignId: c.id }),
  ]);
  const people = await prisma.user.findMany({ where: { id: { in: gifts.map((g) => g.userId) } }, select: { id: true, fullName: true } });
  const isHost = c.hostId === userId;
  res.json({
    campaign: { ...c, group: undefined, host: undefined, hostName: c.host.fullName, groupName: c.group.name, fundsMode: c.group.fundsMode, currency: c.group.currency, isHost, isRecipient: c.recipientUserId === userId },
    // Everyone sees who has paid. Proofs and references are only for the giver and the host.
    gifts: gifts.map((g) => {
      const own = g.userId === userId;
      return {
        id: g.id, userId: g.userId, name: people.find((p) => p.id === g.userId)?.fullName ?? '—', kind: g.kind, amount: g.amount, foodNote: g.foodNote, status: g.status,
        optionId: g.optionId, optionLabel: c.options.find((o) => o.id === g.optionId)?.label ?? null, collectedAt: g.collectedAt, createdAt: g.createdAt,
        ...(own || isHost ? { method: g.method, proofUrl: g.proofUrl, reference: g.reference, receiptNo: g.receiptNo } : {}),
      };
    }),
    progress,
    funds: { heldByCollector: ledger.heldByCollector, totalIn: ledger.totalIn, totalOut: ledger.totalOut, lastAttestation: ledger.lastAttestation },
  });
});

campaignsRouter.post('/:id/gifts', async (req, res) => {
  const b = z
    .object({
      kind: z.enum(['MONEY', 'FOOD']),
      optionId: objectId.optional(),
      amount: z.number().positive().optional(),
      foodNote: z.string().max(150).optional(),
      method: method.optional(),
      proofUrl: z.string().url().optional(),
      reference: z.string().max(100).optional(),
      forUserId: objectId.optional(),
    })
    .parse(req.body);
  res.status(201).json(await giveGift(req.user!.id, String(req.params.id), b));
});

campaignsRouter.patch('/gifts/:id/verify', async (req, res) => {
  res.json({ gift: await verifyGift(req.user!.id, String(req.params.id)) });
});
campaignsRouter.patch('/gifts/:id/reject', async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(2).max(200) }).parse(req.body);
  res.json({ gift: await rejectGift(req.user!.id, String(req.params.id), reason) });
});
campaignsRouter.patch('/gifts/:id/collected', async (req, res) => {
  const { collected } = z.object({ collected: z.boolean().default(true) }).parse(req.body ?? {});
  res.json({ gift: await markCollected(req.user!.id, String(req.params.id), collected) });
});

/** Host records that the help reached the family. Requires their PIN. */
campaignsRouter.post('/:id/deliver', async (req, res) => {
  const b = z.object({ amount: z.number().positive().optional(), note: z.string().max(300).optional(), proofUrl: z.string().url().optional(), pin: z.string() }).parse(req.body);
  await verifyPin(req.user!.id, b.pin);
  res.json({ campaign: await recordDelivery(req.user!.id, String(req.params.id), b) });
});

campaignsRouter.post('/:id/confirm', async (req, res) => {
  const b = z.object({ received: z.boolean(), note: z.string().max(300).optional() }).parse(req.body);
  res.json(await confirmDelivery(req.user!.id, String(req.params.id), b.received, b.note));
});

campaignsRouter.patch('/:id/status', async (req, res) => {
  const { status } = z.object({ status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']) }).parse(req.body);
  res.json({ campaign: await setStatus(req.user!.id, String(req.params.id), status) });
});

// ── Transparency ──
campaignsRouter.get('/:id/ledger', async (req, res) => {
  const c = await loadCampaign(String(req.params.id));
  await assertGroupMember(c.groupId, req.user!.id);
  res.json({ currency: c.group.currency, isCollector: c.hostId === req.user!.id, ...(await getLedger({ campaignId: c.id })) });
});

/** Host records money going out (fabric bought, a refund) or an adjustment. Requires their PIN. */
campaignsRouter.post('/:id/ledger', async (req, res) => {
  const b = z.object({ type: z.enum(['EXPENSE', 'REFUND', 'ADJUSTMENT']), direction: z.enum(['IN', 'OUT']).default('OUT'), amount: z.number().positive(), note: z.string().min(3).max(200), pin: z.string() }).parse(req.body);
  const c = await loadCampaign(String(req.params.id));
  assertHost(c, req.user!.id);
  await verifyPin(req.user!.id, b.pin);
  const entry = await addEntry({ campaignId: c.id }, b.direction, b.type, b.amount, req.user!.id, b.note);
  await audit(req.user!.id, 'LEDGER_ENTRY', 'Campaign', c.id, { type: b.type, amount: b.amount });
  res.status(201).json({ entry });
});

campaignsRouter.post('/:id/attest', async (req, res) => {
  const b = z.object({ declaredAmount: z.number().min(0), note: z.string().max(200).optional(), proofUrl: z.string().url().optional(), pin: z.string() }).parse(req.body);
  const c = await loadCampaign(String(req.params.id));
  assertHost(c, req.user!.id);
  await verifyPin(req.user!.id, b.pin);
  res.status(201).json(await attestFunds({ campaignId: c.id }, req.user!.id, c.groupId, c.group.currency, b));
});
