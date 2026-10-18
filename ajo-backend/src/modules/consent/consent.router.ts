import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { objectId } from '../../lib/validators';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { HUMAN_REVIEW_PRIORITY, SUPPORTED_LANGUAGES, TTS_LIKELY, WITNESS_RECOMMENDED } from './languages';
import {
  getConsentView, groupConsentStatus, mySignatures, publishOriginal, requestSigningOtp, requiredConsents, signConsent, submitHumanTranslation, translationSlots,
} from './consent.service';

// Consent & disclaimers. The signed text is always the English original; translations only help people understand it.
export const consentRouter = Router();
consentRouter.use(authenticate);

const docType = z.enum(['CUSTODY_MEMBER_DISCLOSURE', 'CUSTODY_COLLECTOR_AGREEMENT', 'PLATFORM_TERMS']);

/** The searchable language list. People can also type a language that is not here. */
consentRouter.get('/languages', (_req, res) => {
  res.json({
    languages: SUPPORTED_LANGUAGES.map((l) => ({ ...l, humanReviewPriority: HUMAN_REVIEW_PRIORITY.indexOf(l.code) + 1 || null, witnessRecommended: WITNESS_RECOMMENDED.has(l.code), readAloudLikely: TTS_LIKELY.has(l.code) })),
    allowCustom: true,
  });
});

consentRouter.get('/document', async (req, res) => {
  const q = z.object({ type: docType, language: z.string().max(40).optional(), languageLabel: z.string().max(60).optional() }).parse(req.query);
  try {
    res.json(await getConsentView(q));
  } catch (e) {
    if (e instanceof Error && !(e instanceof HttpError) && /language/i.test(e.message)) throw new HttpError(400, e.message);
    throw e;
  }
});

consentRouter.post('/otp', async (req, res) => {
  await requestSigningOtp(req.user!.id);
  res.json({ sent: true });
});

consentRouter.post('/sign', async (req, res) => {
  const b = z
    .object({
      type: docType,
      documentId: objectId.optional(),
      groupId: objectId.optional(),
      language: z.string().max(40).optional(),
      languageLabel: z.string().max(60).optional(),
      translationHash: z.string().length(64).optional(),
      typedName: z.string().trim().min(2).max(120),
      signatureImageUrl: z.string().url().optional(),
      otp: z.string().regex(/^\d{6}$/).optional(),
      answers: z.array(z.number().int().min(0).max(5)).max(5).optional(),
      witness: z.object({ name: z.string().trim().min(2).max(120), phone: z.string().trim().min(6).max(20), signature: z.string().trim().min(2).max(300), explained: z.boolean() }).optional(),
    })
    .parse(req.body);
  // The person's id comes from the token. The IP and device are recorded with the signature.
  const out = await signConsent(req.user!.id, b, { ipAddress: req.ip ?? 'unknown', userAgent: req.header('user-agent') ?? 'unknown' });
  res.status(201).json(out);
});

consentRouter.get('/mine', async (req, res) => {
  const groups = await prisma.groupMember.findMany({ where: { userId: req.user!.id }, select: { groupId: true } });
  const [signatures, required] = await Promise.all([mySignatures(req.user!.id), requiredConsents(req.user!.id, groups.map((g) => g.groupId))]);
  res.json({ signatures, required });
});

/** Who has and has not signed: the group's collector or a platform admin only. */
consentRouter.get('/group/:groupId/status', async (req, res) => {
  const g = await prisma.communityGroup.findUnique({ where: { id: String(req.params.groupId) }, select: { adminId: true } });
  if (!g) throw new HttpError(404, 'Group not found');
  if (g.adminId !== req.user!.id && req.user!.role !== 'ADMIN') throw new HttpError(403, 'Only the group collector or an admin can see this');
  res.json(await groupConsentStatus(String(req.params.groupId)));
});

// ── Admin ──
consentRouter.get('/admin/slots', roleGuard(['ADMIN']), async (_req, res) => {
  res.json({ slots: await translationSlots() });
});

consentRouter.post('/admin/documents', roleGuard(['ADMIN']), async (req, res) => {
  const b = z.object({ type: docType, bodyMarkdown: z.string().min(50).max(60_000) }).parse(req.body);
  const d = await publishOriginal(req.user!.id, b);
  res.status(201).json({ documentId: d.id, version: d.version });
});

/** A reviewed translation replaces the machine one for everyone. */
consentRouter.post('/admin/translations', roleGuard(['ADMIN']), async (req, res) => {
  const b = z
    .object({ originalDocumentId: objectId, language: z.string().min(2).max(40), languageLabel: z.string().max(60).optional(), bodyMarkdown: z.string().min(50).max(60_000), reviewedBy: z.string().trim().min(2).max(120) })
    .parse(req.body);
  const d = await submitHumanTranslation(req.user!.id, b);
  res.status(201).json({ documentId: d.id, translationStatus: d.translationStatus });
});
