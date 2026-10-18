import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { COUNTRIES, normalizePhone } from '../../lib/phone';
import { audit } from '../../lib/audit';
import { hashPin, randomPin } from '../../lib/security';
import { safeSms } from '../../lib/notify';
import { config } from '../../lib/config';
import { assertGroupAdmin } from '../../lib/access';
import { objectId } from '../../lib/validators';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { getTrust } from '../../services/trust.service';

/**
 * "Agent mode": the collector (Baba Àlàjọ) enrols members who only have a basic phone.
 * These ASSISTED accounts work through USSD / SMS and a temporary PIN that only the member receives.
 */
export const agentRouter = Router();
agentRouter.use(authenticate, roleGuard(['COLLECTOR', 'ADMIN']));

async function sendActivation(phone: string, name: string, groupName: string, pin: string) {
  await safeSms(
    phone,
    `ÀJỌ: ${name}, you have been added to "${groupName}". Dial ${config.ussdShortCode} and use temporary PIN ${pin} to start. You will choose your own PIN. Do not share it.`,
  );
}

agentRouter.post('/members', async (req, res) => {
  const b = z
    .object({ groupId: objectId, fullName: z.string().min(2), phoneNumber: z.string(), language: z.enum(['EN', 'PCM', 'YO', 'HA', 'IG']).default('EN') })
    .parse(req.body);
  const group = await assertGroupAdmin(b.groupId, req.user!.id);
  const phone = normalizePhone(b.phoneNumber, group.country);
  if (!phone) throw new HttpError(400, `Invalid ${COUNTRIES[group.country]?.name ?? ''} phone number`);

  let user = await prisma.user.findUnique({ where: { phoneNumber: phone } });
  let created = false;
  if (!user) {
    const pin = randomPin();
    user = await prisma.user.create({
      data: {
        phoneNumber: phone, fullName: b.fullName, role: 'MEMBER', isVerified: true, accountType: 'ASSISTED', createdByAgentId: req.user!.id,
        preferredLanguage: b.language, country: group.country, pinHash: hashPin(pin), pinMustChange: true,
      },
    });
    created = true;
    await sendActivation(phone, user.fullName, group.name, pin);
  } else {
    await safeSms(phone, `You have been added to "${group.name}" on ÀJỌ.`);
  }
  await prisma.groupMember.upsert({ where: { groupId_userId: { groupId: group.id, userId: user.id } }, create: { groupId: group.id, userId: user.id }, update: {} });
  await audit(req.user!.id, created ? 'ASSISTED_ACCOUNT_CREATED' : 'MEMBER_ADDED', 'User', user.id, { groupId: group.id });
  res.status(created ? 201 : 200).json({ user: { id: user.id, fullName: user.fullName, phoneNumber: user.phoneNumber, accountType: user.accountType }, created });
});

agentRouter.get('/members', async (req, res) => {
  const { groupId } = z.object({ groupId: objectId }).parse(req.query);
  await assertGroupAdmin(groupId, req.user!.id);
  const members = await prisma.groupMember.findMany({ where: { groupId }, include: { user: true } });
  res.json({
    members: await Promise.all(
      members.map(async (m) => ({
        id: m.user.id, fullName: m.user.fullName, phoneNumber: m.user.phoneNumber, accountType: m.user.accountType,
        memberStatus: m.user.memberStatus, activated: m.user.accountType === 'SELF' || !m.user.pinMustChange, trust: await getTrust(m.user.id),
      })),
    ),
  });
});

/** Sends the member a fresh temporary PIN by SMS (e.g. they forgot it). Only the collector who created the account can do this. */
agentRouter.post('/members/:id/reset-pin', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user || user.accountType !== 'ASSISTED' || user.createdByAgentId !== req.user!.id) throw new HttpError(403, 'You can only reset accounts you created');
  if (!user.phoneNumber) throw new HttpError(400, 'This account has no phone number for SMS activation');
  const pin = randomPin();
  await prisma.user.update({ where: { id: user.id }, data: { pinHash: hashPin(pin), pinMustChange: true, pinFailedCount: 0, pinLockedUntil: null } });
  await sendActivation(user.phoneNumber, user.fullName, 'ÀJỌ', pin);
  await audit(req.user!.id, 'ASSISTED_PIN_RESET', 'User', user.id);
  res.json({ success: true });
});
