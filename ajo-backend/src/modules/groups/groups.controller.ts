import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { assertPilotLimits } from '../payments/custody.service';
import { objectId } from '../../lib/validators';
import { HttpError } from '../../lib/errors';
import { COUNTRIES, normalizePhone } from '../../lib/phone';
import { getCollectorStats, getTrust } from '../../services/trust.service';
import { safeSms } from '../../lib/notify';
import { assertGroupAdmin, assertGroupMember } from '../../lib/access';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';

export const groupsRouter = Router();
groupsRouter.use(authenticate);

const APP_LINK = 'https://ajo.app';

async function pollWithTallies(pollId: string, userId?: string) {
  const poll = await prisma.groupPoll.findUnique({
    where: { id: pollId },
    include: { options: { include: { _count: { select: { votes: true } } } } },
  });
  if (!poll) return null;
  const myVote = userId ? await prisma.pollVote.findUnique({ where: { pollId_userId: { pollId, userId } } }) : null;
  const options = poll.options.map((o) => ({ id: o.id, label: o.label, value: o.value, votes: o._count.votes }));
  const closed = poll.status === 'CLOSED' || (poll.closesAt !== null && poll.closesAt < new Date());
  const max = Math.max(0, ...options.map((o) => o.votes));
  return {
    id: poll.id,
    groupId: poll.groupId,
    title: poll.title,
    pollType: poll.pollType,
    status: closed ? 'CLOSED' : poll.status,
    closesAt: poll.closesAt,
    options,
    totalVotes: options.reduce((s, o) => s + o.votes, 0),
    myVoteOptionId: myVote?.pollOptionId ?? null,
    winner: closed && max > 0 ? options.find((o) => o.votes === max) ?? null : null,
  };
}

async function hydrateMessages(messages: any[], userId: string) {
  return Promise.all(
    messages.map(async (m) => {
      const base = {
        id: m.id,
        messageType: m.messageType,
        content: m.content,
        audioUrl: m.audioUrl,
        createdAt: m.createdAt,
        sender: m.sender ? { id: m.sender.id, fullName: m.sender.fullName } : null,
      };
      if (m.messageType === 'RECEIPT' && m.refId) {
        const s = await prisma.ajoRotationSchedule.findUnique({
          where: { id: m.refId },
          include: { recipient: { select: { fullName: true } }, ajoPool: { select: { title: true, group: { select: { currency: true } } } } },
        });
        return {
          ...base,
          receipt: s && {
            scheduleId: s.id,
            poolTitle: s.ajoPool.title,
            recipientName: s.recipient.fullName,
            totalCollected: s.totalCollected,
            platformFee: s.platformFee,
            collectorFee: s.collectorFee,
            netPayout: s.netPayout,
            receiptUrl: s.receiptUrl,
            currency: s.ajoPool.group.currency,
            payoutRef: s.payoutRef,
            payoutMethod: s.payoutMethod,
            paidOutAt: s.paidOutAt,
            recipientConfirmedAt: s.recipientConfirmedAt,
            status: s.status,
          },
        };
      }
      if (m.messageType === 'POLL' && m.refId) return { ...base, poll: await pollWithTallies(m.refId, userId) };
      return base;
    }),
  );
}

// 6/7/8 are declared before /:id routes so "polls" isn't captured as an id.
groupsRouter.post('/polls/create', roleGuard(['COLLECTOR', 'ADMIN']), async (req, res) => {
  const body = z
    .object({
      groupId: objectId,
      title: z.string().min(3),
      pollType: z.enum(['AJO_AMOUNT', 'AJO_SCHEDULE', 'FOOD_BUDGET', 'FOOD_ITEMS']),
      options: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).min(2),
      closesAt: z.coerce.date().optional(),
    })
    .parse(req.body);
  await assertGroupAdmin(body.groupId, req.user!.id);
  const poll = await prisma.groupPoll.create({
    data: {
      groupId: body.groupId,
      title: body.title,
      pollType: body.pollType,
      closesAt: body.closesAt,
      options: { create: body.options },
    },
  });
  await prisma.groupMessage.create({
    data: {
      groupId: body.groupId,
      senderId: req.user!.id,
      messageType: 'POLL',
      refId: poll.id,
      content: `📊 New poll: ${body.title}`,
    },
  });
  res.status(201).json({ poll: await pollWithTallies(poll.id, req.user!.id) });
});

groupsRouter.post('/polls/:id/vote', async (req, res) => {
  const { pollOptionId } = z.object({ pollOptionId: objectId }).parse(req.body);
  const poll = await prisma.groupPoll.findUnique({ where: { id: String(req.params.id) } });
  if (!poll) throw new HttpError(404, 'Poll not found');
  await assertGroupMember(poll.groupId, req.user!.id);
  if (poll.status !== 'OPEN' || (poll.closesAt && poll.closesAt < new Date())) throw new HttpError(400, 'Poll is closed');
  const option = await prisma.pollOption.findFirst({ where: { id: pollOptionId, pollId: poll.id } });
  if (!option) throw new HttpError(400, 'Option does not belong to this poll');
  try {
    await prisma.pollVote.create({ data: { pollId: poll.id, pollOptionId, userId: req.user!.id } });
  } catch (e: any) {
    if (e.code === 'P2002') throw new HttpError(409, 'You have already voted');
    throw e;
  }
  res.json({ poll: await pollWithTallies(poll.id, req.user!.id) });
});

groupsRouter.get('/polls/:id', async (req, res) => {
  const poll = await prisma.groupPoll.findUnique({ where: { id: String(req.params.id) } });
  if (!poll) throw new HttpError(404, 'Poll not found');
  await assertGroupMember(poll.groupId, req.user!.id);
  res.json({ poll: await pollWithTallies(poll.id, req.user!.id) });
});

groupsRouter.get('/mine', async (req, res) => {
  const memberships = await prisma.groupMember.findMany({
    where: { userId: req.user!.id },
    include: { group: { select: { id: true, name: true, adminId: true, currency: true } } },
  });
  res.json({ groups: memberships.map((m) => m.group) });
});

groupsRouter.post('/create', roleGuard(['COLLECTOR', 'ADMIN']), async (req, res) => {
  const body = z
    .object({ name: z.string().min(2), description: z.string().optional(), avatarUrl: z.string().url().optional(), country: z.enum(['NG', 'GH', 'KE']).default('NG') })
    .parse(req.body);
  const me = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (me!.role === 'COLLECTOR' && !me!.collectorApproved) {
    throw new HttpError(403, 'Your Collector account is awaiting admin approval');
  }
  await assertPilotLimits({ newGroup: true });
  const group = await prisma.communityGroup.create({
    data: { ...body, currency: COUNTRIES[body.country].currency, adminId: me!.id, members: { create: { userId: me!.id } } },
  });
  res.status(201).json({ group });
});

groupsRouter.post('/:id/invite', async (req, res) => {
  const groupId = String(req.params.id);
  const { phoneNumbers } = z.object({ phoneNumbers: z.array(z.string()).min(1).max(100) }).parse(req.body);
  const group = await assertGroupAdmin(groupId, req.user!.id);
  const result = { added: 0, invited: 0, invalid: [] as string[] };
  for (const raw of phoneNumbers) {
    const phone = normalizePhone(raw, group.country);
    if (!phone) {
      result.invalid.push(raw);
      continue;
    }
    const user = await prisma.user.findUnique({ where: { phoneNumber: phone } });
    if (user) {
      await assertPilotLimits({ groupId });
      await prisma.groupMember.upsert({
        where: { groupId_userId: { groupId, userId: user.id } },
        create: { groupId, userId: user.id },
        update: {},
      });
      await safeSms(phone, `You've been added to "${group.name}" on ÀJỌ. Open the app to see the group.`);
      result.added++;
    } else {
      await safeSms(phone, `You've been invited to join "${group.name}" on ÀJỌ. Download the app: ${APP_LINK}`);
      result.invited++;
    }
  }
  res.json(result);
});

groupsRouter.get('/:id', async (req, res) => {
  const groupId = String(req.params.id);
  await assertGroupMember(groupId, req.user!.id);
  const group = await prisma.communityGroup.findUnique({
    where: { id: groupId },
    include: {
      members: { include: { user: { select: { id: true, fullName: true, memberStatus: true, accountType: true } } } },
    },
  });
  if (!group) throw new HttpError(404, 'Group not found');
  const [messages, activeAjo, activeFood] = await Promise.all([
    prisma.groupMessage.findMany({
      where: { groupId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { sender: { select: { id: true, fullName: true } } },
    }),
    prisma.ajoPool.findMany({ where: { groupId, status: 'ACTIVE' }, select: { id: true, title: true } }),
    prisma.foodPool.findMany({ where: { groupId, status: { in: ['COLLECTING', 'LOCKED', 'DISPATCHED'] } }, select: { id: true } }),
  ]);
  res.json({
    group: {
      id: group.id,
      name: group.name,
      description: group.description,
      avatarUrl: group.avatarUrl,
      adminId: group.adminId,
      currency: group.currency,
      country: group.country,
    },
    members: await Promise.all(
      group.members.map(async (m) => ({ ...m.user, isAdmin: m.userId === group.adminId, trust: await getTrust(m.userId) })),
    ),
    collector: await getCollectorStats(group.adminId),
    isCollector: group.adminId === req.user!.id,
    messages: await hydrateMessages(messages, req.user!.id),
    activePoolsCount: activeAjo.length + activeFood.length,
    ajoPools: activeAjo,
    foodPools: activeFood,
  });
});

groupsRouter.post('/:id/messages', async (req, res) => {
  const groupId = String(req.params.id);
  await assertGroupMember(groupId, req.user!.id);
  const body = z
    .object({
      content: z.string().max(2000).optional(),
      audioUrl: z.string().url().optional(),
      messageType: z.enum(['TEXT', 'AUDIO']).default('TEXT'),
    })
    .refine((b) => b.content || b.audioUrl, 'content or audioUrl required')
    .parse(req.body);
  const message = await prisma.groupMessage.create({
    data: { groupId, senderId: req.user!.id, ...body },
    include: { sender: { select: { id: true, fullName: true } } },
  });
  res.status(201).json({ message: (await hydrateMessages([message], req.user!.id))[0] });
});

groupsRouter.get('/:id/messages', async (req, res) => {
  const groupId = String(req.params.id);
  await assertGroupMember(groupId, req.user!.id);
  const { before, limit } = z
    .object({ before: objectId.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
    .parse(req.query);
  const messages = await prisma.groupMessage.findMany({
    where: { groupId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
    include: { sender: { select: { id: true, fullName: true } } },
  });
  res.json({ messages: await hydrateMessages(messages, req.user!.id) });
});
