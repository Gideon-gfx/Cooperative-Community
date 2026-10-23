import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User, UserRole } from '@prisma/client';
import { ensureEmailUniqueIndex, prisma } from '../../lib/prisma';
import { config } from '../../lib/config';
import { HttpError } from '../../lib/errors';
import { COUNTRIES, normalizePhone } from '../../lib/phone';
import { safeSms } from '../../lib/notify';
import { sendSms } from '../../services/termii.service';
import { sendEmail } from '../../lib/mailer';
import { audit, auditNative } from '../../lib/audit';
import { hashPassword, hashPin, isValidPin, verifyPassword, verifyPin } from '../../lib/security';
import { createEmailUser, createVerifiedPhoneUser, findUserByEmail, findUserById, findUserByPhone, findUserIdByReferralCode, markUserVerifiedByPhone, updateUserById } from '../../lib/mongo-users';
import { consumeOtpCode, deleteOtpCode, findOtpCode, incrementOtpAttempts, upsertOtpCode } from '../../lib/mongo-otp';
import { consumePasswordResetCode, deletePasswordResetCode, findPasswordResetCode, incrementPasswordResetAttempts, upsertPasswordResetCode } from '../../lib/mongo-password-reset';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { getCollectorStatsNative, getTrustNative } from '../../services/native-auth-profile.service';

export const authRouter = Router();

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const hashOtp = (phone: string, otp: string) => crypto.createHash('sha256').update(`${phone}:${otp}:${config.jwtSecret}`).digest('hex');

async function sendAuthSms(to: string, message: string): Promise<void> {
  try {
    await sendSms(to, message);
  } catch (error) {
    console.error('[auth] Termii SMS delivery failed:', error instanceof Error ? error.message : 'Unknown error');
    throw new HttpError(503, 'We could not send an SMS code right now. Please try again later.');
  }
}

/** Never send pinHash to a client. */
export function publicUser(u: User) {
  const { pinHash, passwordHash, pinFailedCount, pinLockedUntil, ...rest } = u;
  return { ...rest, hasPin: !!pinHash };
}

const signToken = (u: User) => jwt.sign({ userId: u.id, role: u.role, phone: u.phoneNumber ?? null }, config.jwtSecret, { expiresIn: '90d' });

const countrySchema = z.enum(['NG', 'GH', 'KE']).default('NG');
const phoneBody = z.object({ phoneNumber: z.string(), country: countrySchema });
const toPhone = (b: z.infer<typeof phoneBody>) => {
  const p = normalizePhone(b.phoneNumber, b.country);
  if (!p) throw new HttpError(400, `Invalid ${COUNTRIES[b.country].name} phone number`);
  return p;
};
const emailSchema = z.string().trim().email().max(254).transform((email) => email.toLowerCase());
const passwordSchema = z.string().min(8).max(128);

// ── Referral codes ──
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I, so a code read aloud is not misheard
const newReferralCode = () => 'AJO-' + Array.from({ length: 6 }, () => REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)]).join('');
const normalizeRef = (c: string) => c.trim().toUpperCase().replace(/\s+/g, '');

/** Who a typed referral code belongs to. A code that does not exist is an error, so a typo does not silently lose the credit. */
async function referrerFor(code?: string): Promise<string | undefined> {
  if (!code?.trim()) return undefined;
  const ownerId = await findUserIdByReferralCode(normalizeRef(code));
  if (!ownerId) throw new HttpError(400, 'That referral code was not found. Check it, or leave it empty.');
  return ownerId;
}

async function referralSummary(userId: string) {
  const [me, count] = await Promise.all([prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } }), prisma.user.count({ where: { referredById: userId } })]);
  return { code: me.referralCode ?? null, referred: count };
}

authRouter.get('/referral', authenticate, async (req, res) => res.json(await referralSummary(req.user!.id)));

/** Makes this person's referral code the first time, and gives the same one back every time after. */
authRouter.post('/referral-code', authenticate, async (req, res) => {
  await ensureEmailUniqueIndex();
  const existing = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { referralCode: true } });
  if (!existing.referralCode) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const done = await prisma.user.updateMany({ where: { id: req.user!.id, OR: [{ referralCode: null }, { referralCode: { isSet: false } }] }, data: { referralCode: newReferralCode() } });
        if (done.count >= 0) break;
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e; // a code clash: try another
      }
    }
    await audit(req.user!.id, 'REFERRAL_CODE_CREATED', 'User', req.user!.id);
  }
  res.json(await referralSummary(req.user!.id));
});

authRouter.post('/register', async (req, res) => {
  const body = z.object({
    email: emailSchema,
    password: passwordSchema,
    fullName: z.string().trim().min(2).max(100),
    role: z.enum(['MEMBER', 'COLLECTOR', 'TRANSPORTER']).default('MEMBER'),
    country: countrySchema,
    referralCode: z.string().trim().max(20).optional(),
  }).parse(req.body);
  await ensureEmailUniqueIndex();
  const referredById = await referrerFor(body.referralCode);
  if (await findUserByEmail(body.email)) throw new HttpError(409, 'An account with this email already exists');
  const user = await createEmailUser({
    email: body.email,
    passwordHash: await hashPassword(body.password),
    fullName: body.fullName,
    role: body.role,
    country: body.country,
    ...(referredById ? { referredById } : {}),
  });
  await auditNative(user.id, 'REGISTER_EMAIL', 'User', user.id);
  if (user.email) await sendEmail(user.email, 'Welcome to ÀJỌ', `Hi ${user.fullName},\n\nYour ÀJỌ account is ready. You can now sign in and join your community.\n\nIf you did not create this account, please contact support.`);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

authRouter.post('/login-email', async (req, res) => {
  const body = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).parse(req.body);
  const user = await findUserByEmail(body.email);
  if (!user?.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
    throw new HttpError(401, 'Wrong email or password');
  }
  await auditNative(user.id, 'LOGIN_EMAIL', 'User', user.id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

const resetHash = (userId: string, code: string) => crypto.createHash('sha256').update(`reset:${userId}:${code}:${config.jwtSecret}`).digest('hex');

/** Only an existing account can ask for a code: anyone else is told so plainly. */
authRouter.post('/forgot-password', async (req, res) => {
  const body = z.object({ email: emailSchema }).parse(req.body);
  const user = await findUserByEmail(body.email);
  if (!user) throw new HttpError(404, 'We could not find an account with this email. Check the email or create an account.');
  if (!user.passwordHash) throw new HttpError(409, 'This account has no password. Log in with your phone number and PIN instead.');
  {
    const existing = await findPasswordResetCode(user.id);
    if (!existing || Date.now() - existing.createdAt.getTime() >= OTP_RESEND_MS) {
      const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
      const data = { codeHash: resetHash(user.id, code), expiresAt: new Date(Date.now() + OTP_TTL_MS), attempts: 0, createdAt: new Date() };
      await upsertPasswordResetCode({ userId: user.id, ...data });
      const sent = await sendEmail(body.email, 'Your ÀJỌ password reset code', `Your ÀJỌ password reset code is ${code}. It expires in 10 minutes. If you did not ask for this, ignore this email. Never share this code.`);
      if (!sent && !user.phoneNumber && process.env.NODE_ENV === 'production') throw new HttpError(503, 'We could not send the email right now. Please try again later.');
      if (user.phoneNumber) await safeSms(user.phoneNumber, `Your ÀJỌ password reset code is ${code}. It expires in 10 minutes. Never share it.`);
      await auditNative(user.id, 'PASSWORD_RESET_REQUESTED', 'User', user.id);
    }
  }
  res.json({ success: true });
});

/** Checks a recovery code. With consume=false the code stays usable, so the app can check it on one screen and use it on the next. */
async function checkResetCode(userId: string, code: string, consume: boolean) {
  const entry = await findPasswordResetCode(userId);
  if (!entry || entry.expiresAt < new Date() || entry.attempts >= MAX_OTP_ATTEMPTS) throw new HttpError(400, 'Invalid or expired code');
  const a = Buffer.from(entry.codeHash);
  const b = Buffer.from(resetHash(userId, code));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await incrementPasswordResetAttempts(entry.id, MAX_OTP_ATTEMPTS);
    throw new HttpError(400, 'Invalid or expired code');
  }
  if (consume && !(await consumePasswordResetCode(userId, entry.codeHash, new Date(), MAX_OTP_ATTEMPTS))) {
    throw new HttpError(400, 'Invalid or expired code');
  }
}

const identity = z.union([
  z.object({ email: emailSchema }),
  phoneBody,
]);
async function userFor(body: z.infer<typeof identity>) {
  if ('email' in body) return findUserByEmail(body.email);
  return findUserByPhone(toPhone(body));
}

authRouter.post('/verify-reset-code', async (req, res) => {
  const body = z.object({ code: z.string().length(6) }).and(identity).parse(req.body);
  const user = await userFor(body);
  if (!user) throw new HttpError(400, 'Invalid or expired code');
  await checkResetCode(user.id, body.code, false);
  res.json({ valid: true });
});

authRouter.post('/reset-password', async (req, res) => {
  const body = z.object({ email: emailSchema, code: z.string().length(6), newPassword: passwordSchema }).parse(req.body);
  const user = await findUserByEmail(body.email);
  if (!user) throw new HttpError(400, 'Invalid or expired code');
  await checkResetCode(user.id, body.code, true);
  if (!(await updateUserById(user.id, { passwordHash: await hashPassword(body.newPassword) }))) {
    throw new Error('User disappeared during password reset');
  }
  await auditNative(user.id, 'PASSWORD_RESET', 'User', user.id);
  res.json({ success: true });
});

/** Forgot PIN: the code goes to the phone by SMS. Only an existing account can ask for one. */
authRouter.post('/forgot-pin', async (req, res) => {
  const body = phoneBody.parse(req.body);
  const phone = toPhone(body);
  const user = await findUserByPhone(phone);
  if (!user) throw new HttpError(404, 'We could not find an account with this phone number. Check the number or create an account.');
  {
    const existing = await findPasswordResetCode(user.id);
    if (!existing || Date.now() - existing.createdAt.getTime() >= OTP_RESEND_MS) {
      const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
      const data = { codeHash: resetHash(user.id, code), expiresAt: new Date(Date.now() + OTP_TTL_MS), attempts: 0, createdAt: new Date() };
      await upsertPasswordResetCode({ userId: user.id, ...data });
      try {
        await sendAuthSms(phone, `Your ÀJỌ PIN reset code is ${code}. It expires in 10 minutes. Never share it.`);
      } catch (error) {
        await deletePasswordResetCode(user.id, data.codeHash);
        throw error;
      }
      await auditNative(user.id, 'PIN_RESET_REQUESTED', 'User', user.id);
    }
  }
  res.json({ success: true });
});

authRouter.post('/reset-pin', async (req, res) => {
  const body = phoneBody.extend({ code: z.string().length(6), newPin: z.string() }).parse(req.body);
  if (!isValidPin(body.newPin)) throw new HttpError(400, 'PIN must be exactly 4 digits');
  if (/^(\d)\1{3}$/.test(body.newPin) || body.newPin === '1234' || body.newPin === '0123') throw new HttpError(400, 'Choose a PIN that is harder to guess');
  const user = await findUserByPhone(toPhone(body));
  if (!user) throw new HttpError(400, 'Invalid or expired code');
  await checkResetCode(user.id, body.code, true);
  if (!(await updateUserById(user.id, { pinHash: hashPin(body.newPin), pinMustChange: false, pinFailedCount: 0, pinLockedUntil: null }))) {
    throw new Error('User disappeared during PIN reset');
  }
  await auditNative(user.id, 'PIN_RESET', 'User', user.id);
  res.json({ success: true });
});

authRouter.post('/request-otp', async (req, res) => {
  const phone = toPhone(phoneBody.parse(req.body));
  const existing = await findOtpCode(phone);
  if (existing && Date.now() - existing.createdAt.getTime() < OTP_RESEND_MS) throw new HttpError(429, 'Please wait a minute before asking for another code');
  const otp = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const data = { codeHash: hashOtp(phone, otp), expiresAt: new Date(Date.now() + OTP_TTL_MS), attempts: 0, createdAt: new Date() };
  await upsertOtpCode({ phoneNumber: phone, ...data });
  try {
    await sendAuthSms(phone, `Your ÀJỌ verification code is ${otp}. It expires in 10 minutes. Never share it.`);
  } catch (error) {
    await deleteOtpCode(phone, data.codeHash);
    throw error;
  }
  res.json({ success: true });
});

authRouter.post('/verify-otp', async (req, res) => {
  const body = phoneBody
    .extend({
      otp: z.string().length(6),
      fullName: z.string().min(2).optional(),
      role: z.enum(['MEMBER', 'COLLECTOR', 'TRANSPORTER']).default('MEMBER'),
      referralCode: z.string().trim().max(20).optional(),
    })
    .parse(req.body);
  const phone = toPhone(body);

  const entry = await findOtpCode(phone);
  if (!entry || entry.expiresAt < new Date() || entry.attempts >= MAX_OTP_ATTEMPTS) throw new HttpError(400, 'Invalid or expired code');
  const a = Buffer.from(entry.codeHash);
  const b = Buffer.from(hashOtp(phone, body.otp));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await incrementOtpAttempts(entry.id, MAX_OTP_ATTEMPTS);
    throw new HttpError(400, 'Invalid or expired code');
  }
  if (!(await consumeOtpCode(entry.id, entry.codeHash, new Date(), MAX_OTP_ATTEMPTS))) {
    throw new HttpError(400, 'Invalid or expired code');
  }

  const existing = await findUserByPhone(phone);
  const referredById = existing ? undefined : await referrerFor(body.referralCode);
  if (!existing && !body.fullName) throw new HttpError(400, 'fullName is required for new accounts');
  const user = existing
    ? await markUserVerifiedByPhone(phone)
    : await createVerifiedPhoneUser({
        phoneNumber: phone,
        fullName: body.fullName!,
        role: body.role as UserRole,
        country: body.country,
        ...(referredById ? { referredById } : {}),
      });
  if (!user) throw new HttpError(404, 'User not found');
  await auditNative(user.id, 'LOGIN_OTP', 'User', user.id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

/** Sign in with phone + PIN (for members whose collector created the account, and to save SMS costs). */
authRouter.post('/login-pin', async (req, res) => {
  const body = phoneBody.extend({ pin: z.string() }).parse(req.body);
  const phone = toPhone(body);
  const user = await findUserByPhone(phone);
  if (!user || !user.pinHash) throw new HttpError(401, 'Wrong phone number or PIN');
  await verifyPin(user.id, body.pin);
  await auditNative(user.id, 'LOGIN_PIN', 'User', user.id);
  res.json({ token: signToken(user), user: publicUser(user), mustChangePin: user.pinMustChange });
});

authRouter.post('/set-pin', authenticate, async (req, res) => {
  const { pin, currentPin } = z.object({ pin: z.string(), currentPin: z.string().optional() }).parse(req.body);
  if (!isValidPin(pin)) throw new HttpError(400, 'PIN must be exactly 4 digits');
  if (/^(\d)\1{3}$/.test(pin) || pin === '1234' || pin === '0123') throw new HttpError(400, 'Choose a PIN that is harder to guess');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (user.pinHash && !user.pinMustChange) await verifyPin(user.id, currentPin);
  await prisma.user.update({ where: { id: user.id }, data: { pinHash: hashPin(pin), pinMustChange: false, pinFailedCount: 0, pinLockedUntil: null } });
  await audit(user.id, 'PIN_SET', 'User', user.id);
  res.json({ success: true });
});

authRouter.post('/update-profile', authenticate, async (req, res) => {
  const data = z
    .object({
      fullName: z.string().min(2).optional(),
      bankAccountNo: z.string().regex(/^\d{10}$/).optional(),
      bankCode: z.string().min(3).max(6).optional(),
      locationLat: z.number().min(-90).max(90).optional(),
      locationLng: z.number().min(-180).max(180).optional(),
      locationLabel: z.string().max(200).optional(),
      preferredLanguage: z.enum(['EN', 'PCM', 'YO', 'HA', 'IG']).optional(),
      reminderHour: z.number().int().min(0).max(23).optional(),
    })
    .parse(req.body);
  const user = await prisma.user.update({ where: { id: req.user!.id }, data });
  if (user.email && Object.keys(data).length > 0) {
    await sendEmail(user.email, 'Your ÀJỌ profile was updated', 'Your profile settings were updated. If you did not make this change, please secure your account and contact support.');
  }
  res.json({ user: publicUser(user) });
});

authRouter.get('/profile', authenticate, async (req, res) => {
  const user = await findUserById(req.user!.id);
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user: publicUser(user), trust: await getTrustNative(user.id), collector: user.role === 'COLLECTOR' ? await getCollectorStatsNative(user.id) : null });
});

authRouter.patch('/admin/collectors/:id/approve', authenticate, roleGuard(['ADMIN']), async (req, res) => {
  const user = await prisma.user.update({ where: { id: String(req.params.id) }, data: { collectorApproved: true } });
  await audit(req.user!.id, 'COLLECTOR_APPROVED', 'User', user.id);
  res.json({ user: publicUser(user) });
});
