import crypto from 'crypto';
import { ConsentDocType, ConsentDocument, Prisma, TranslationStatus } from '@prisma/client';
import { decisions } from '../../config/decisions';
import { prisma } from '../../lib/prisma';
import { getMongoDb } from '../../lib/mongodb';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { assertGroupMember } from '../../lib/access';

// MongoDB note: Prisma's `field: null` filter only matches a field that is stored as null, NOT one that was never
// written. So every field we filter on with `null` (supersededAt, groupId) is written as an explicit null on create.
import { safeSms } from '../../lib/notify';
import { normalizePhone } from '../../lib/phone';
import { saveFile } from '../../services/storage.service';
import { CORRECT_ANSWERS, DRAFT_LINE, NEEDS_COMPREHENSION, SEED_DOCUMENTS, UI_STRINGS } from './consent.docs';
import { buildConsentReceiptPdf } from './consent.receipt';
import { BASE_LANGUAGE, HUMAN_REVIEW_PRIORITY, resolveLanguage, SUPPORTED_LANGUAGES, TTS_LIKELY, WITNESS_RECOMMENDED } from './languages';
import { getTranslationProvider, sameShape } from './translation.provider';

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const DOC_TYPES: ConsentDocType[] = ['CUSTODY_MEMBER_DISCLOSURE', 'CUSTODY_COLLECTOR_AGREEMENT', 'PLATFORM_TERMS'];
const TITLES: Record<ConsentDocType, string> = {
  CUSTODY_MEMBER_DISCLOSURE: 'Collector custody: member disclosure',
  CUSTODY_COLLECTOR_AGREEMENT: 'Collector custody: collector agreement',
  PLATFORM_TERMS: 'CC-ÀJỌ terms of use',
};
const SIGN_OTP_TTL_MS = 10 * 60 * 1000;
const SIGN_OTP_RESEND_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

// ── Documents ───────────────────────────────────────────────────────────────

/** Creates version 1 of each English original that does not exist yet. Safe to run on every boot. */
export async function seedConsentDocuments(): Promise<number> {
  let created = 0;
  for (const type of DOC_TYPES) {
    const exists = await prisma.consentDocument.findFirst({ where: { type, language: BASE_LANGUAGE, translationStatus: 'ORIGINAL' } });
    if (exists) continue;
    const body = SEED_DOCUMENTS[type];
    await prisma.consentDocument.create({ data: { type, version: 1, language: BASE_LANGUAGE, languageLabel: 'English', bodyMarkdown: body, sha256: sha(body), translationStatus: 'ORIGINAL', supersededAt: null } });
    created++;
  }
  return created;
}

/** Startup-only seeding avoids the Prisma DNS resolver used by the API's database connector. */
export async function seedConsentDocumentsNative(): Promise<number> {
  let created = 0;
  const documents = (await getMongoDb()).collection('ConsentDocument');
  for (const type of DOC_TYPES) {
    const exists = await documents.findOne({ type, language: BASE_LANGUAGE, translationStatus: 'ORIGINAL' });
    if (exists) continue;
    const body = SEED_DOCUMENTS[type];
    const now = new Date();
    await documents.insertOne({
      type,
      version: 1,
      language: BASE_LANGUAGE,
      languageLabel: 'English',
      bodyMarkdown: body,
      sha256: sha(body),
      effectiveAt: now,
      supersededAt: null,
      translationStatus: 'ORIGINAL',
      createdAt: now,
    });
    created++;
  }
  return created;
}

/** The controlling document right now: the newest English original that has not been superseded. */
export async function currentOriginal(type: ConsentDocType): Promise<ConsentDocument> {
  const doc = await prisma.consentDocument.findFirst({ where: { type, language: BASE_LANGUAGE, translationStatus: 'ORIGINAL', supersededAt: null }, orderBy: { version: 'desc' } });
  if (!doc) throw new HttpError(503, 'This document has not been published yet');
  return doc;
}

/** A human-reviewed translation always wins over a machine one. */
async function findTranslation(original: ConsentDocument, code: string): Promise<ConsentDocument | null> {
  const rows = await prisma.consentDocument.findMany({ where: { translatedFromDocumentId: original.id, language: code, supersededAt: null } });
  return rows.find((r) => r.translationStatus === 'HUMAN_REVIEWED') ?? rows.find((r) => r.translationStatus === 'MACHINE_TRANSLATED') ?? null;
}

const plain = (md: string) => md.replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/^- /gm, '').replace(/\[[^\]]*\]/g, (m) => (m.startsWith('[DRAFT') ? '' : m)).trim();

async function uiFor(lang: { code: string; label: string }): Promise<{ ui: typeof UI_STRINGS; translated: boolean } | null> {
  if (lang.code === BASE_LANGUAGE) return { ui: UI_STRINGS, translated: false };
  const hash = sha(JSON.stringify(UI_STRINGS));
  const cached = await prisma.consentUiTranslation.findUnique({ where: { hash_language: { hash, language: lang.code } } });
  if (cached && sameShape(UI_STRINGS, cached.stringsJson)) return { ui: cached.stringsJson as unknown as typeof UI_STRINGS, translated: true };
  try {
    const out = await getTranslationProvider().translateStrings(UI_STRINGS as unknown as Record<string, unknown>, lang);
    await prisma.consentUiTranslation.upsert({
      where: { hash_language: { hash, language: lang.code } },
      create: { hash, language: lang.code, stringsJson: out as Prisma.InputJsonValue },
      update: { stringsJson: out as Prisma.InputJsonValue },
    });
    return { ui: out as unknown as typeof UI_STRINGS, translated: true };
  } catch {
    return null;
  }
}

export interface ConsentView {
  documentId: string;
  type: ConsentDocType;
  title: string;
  version: number;
  language: { code: string; label: string; custom: boolean };
  original: { language: string; body: string; sha256: string };
  /** What the person reads. Null if no translation could be produced: a witness must read the original aloud. */
  shown: { documentId: string; language: string; body: string; sha256: string; translationStatus: TranslationStatus } | null;
  banner: string | null;
  ui: typeof UI_STRINGS;
  witnessRecommended: boolean;
  witnessRequired: boolean;
  needsComprehension: boolean;
  audio: { supported: boolean; script: string; message: string | null };
  demo: { watermark: string } | null;
}

/**
 * Everything the consent screen needs, in the person's language. A machine translation is generated on demand and
 * cached; it is always labelled unofficial, shows the original side by side, and is never the signed text.
 */
export async function getConsentView(input: { type: ConsentDocType; language?: string; languageLabel?: string }): Promise<ConsentView> {
  const lang = resolveLanguage(input.language ?? BASE_LANGUAGE, input.languageLabel);
  const original = await currentOriginal(input.type);
  let shownDoc: ConsentDocument | null = original;
  if (lang.code !== BASE_LANGUAGE) {
    shownDoc = await findTranslation(original, lang.code);
    if (!shownDoc) {
      try {
        const body = await getTranslationProvider().translateDocument(original.bodyMarkdown, lang);
        shownDoc = await prisma.consentDocument.create({
          data: { type: input.type, version: original.version, language: lang.code, languageLabel: lang.label, bodyMarkdown: body, sha256: sha(body), translationStatus: 'MACHINE_TRANSLATED', translatedFromDocumentId: original.id, supersededAt: null },
        });
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        shownDoc = null;
      }
    }
  }
  const uiRes = await uiFor(lang);
  const ui = uiRes?.ui ?? UI_STRINGS;
  const machine = shownDoc?.translationStatus === 'MACHINE_TRANSLATED';
  const witnessRequired = lang.code !== BASE_LANGUAGE && (!shownDoc || !uiRes);
  const ttsOk = !witnessRequired && shownDoc !== null && TTS_LIKELY.has(lang.code);
  const script = shownDoc ? plain(shownDoc.bodyMarkdown) : '';
  return {
    documentId: original.id,
    type: input.type,
    title: TITLES[input.type],
    version: original.version,
    language: lang,
    original: { language: original.language, body: original.bodyMarkdown, sha256: original.sha256 },
    shown: shownDoc ? { documentId: shownDoc.id, language: shownDoc.language, body: shownDoc.bodyMarkdown, sha256: shownDoc.sha256, translationStatus: shownDoc.translationStatus } : null,
    banner: machine ? ui.machineBanner.replace('{original}', original.languageLabel ?? 'English') : null,
    ui,
    witnessRecommended: WITNESS_RECOMMENDED.has(lang.code) || (lang.custom && machine),
    witnessRequired,
    needsComprehension: NEEDS_COMPREHENSION[input.type],
    audio: ttsOk
      ? { supported: true, script, message: null }
      : { supported: false, script, message: ui.audioFallback },
    demo: decisions.consentDocsApproved ? null : { watermark: 'DRAFT · DEMO MODE' },
  };
}

/** An admin publishes a NEW version of the English original. Every earlier version, and its translations, is superseded. */
export async function publishOriginal(adminId: string, input: { type: ConsentDocType; bodyMarkdown: string }) {
  const body = input.bodyMarkdown.trim();
  if (body.length < 50) throw new HttpError(400, 'The document is too short');
  const prev = await prisma.consentDocument.findFirst({ where: { type: input.type, language: BASE_LANGUAGE, translationStatus: 'ORIGINAL' }, orderBy: { version: 'desc' } });
  const now = new Date();
  const doc = await prisma.consentDocument.create({
    data: { type: input.type, version: (prev?.version ?? 0) + 1, language: BASE_LANGUAGE, languageLabel: 'English', bodyMarkdown: body.startsWith('[') ? body : `${DRAFT_LINE}\n\n${body}`, sha256: sha(body), translationStatus: 'ORIGINAL', supersededAt: null },
  });
  if (prev) {
    await prisma.consentDocument.updateMany({ where: { type: input.type, supersededAt: null, id: { not: doc.id } }, data: { supersededAt: now } });
  }
  await audit(adminId, 'CONSENT_DOCUMENT_PUBLISHED', 'ConsentDocument', doc.id, { type: input.type, version: doc.version });
  return doc;
}

/** A reviewed translation replaces the machine one for everyone. */
export async function submitHumanTranslation(adminId: string, input: { originalDocumentId: string; language: string; languageLabel?: string; bodyMarkdown: string; reviewedBy: string }) {
  const original = await prisma.consentDocument.findUnique({ where: { id: input.originalDocumentId } });
  if (!original || original.translationStatus !== 'ORIGINAL') throw new HttpError(404, 'Original document not found');
  if (original.supersededAt) throw new HttpError(409, 'That version is out of date. Translate the current version.');
  const lang = resolveLanguage(input.language, input.languageLabel);
  if (lang.code === BASE_LANGUAGE) throw new HttpError(400, 'The English text is the original');
  if (input.reviewedBy.trim().length < 2) throw new HttpError(400, 'Say who reviewed it');
  const now = new Date();
  const body = input.bodyMarkdown.trim();
  const doc = await prisma.consentDocument.create({
    data: {
      type: original.type, version: original.version, language: lang.code, languageLabel: lang.label, bodyMarkdown: body, sha256: sha(body),
      translationStatus: 'HUMAN_REVIEWED', translatedFromDocumentId: original.id, reviewedBy: input.reviewedBy.trim(), reviewedAt: now, supersededAt: null,
    },
  });
  await prisma.consentDocument.updateMany({ where: { translatedFromDocumentId: original.id, language: lang.code, supersededAt: null, id: { not: doc.id } }, data: { supersededAt: now } });
  await audit(adminId, 'CONSENT_TRANSLATION_REVIEWED', 'ConsentDocument', doc.id, { language: lang.code, reviewedBy: input.reviewedBy });
  return doc;
}

/** For the admin screen: every document x priority language and whether it is missing, machine-only or human-reviewed. */
export async function translationSlots() {
  const out: { type: ConsentDocType; originalDocumentId: string; version: number; language: string; name: string; status: 'MISSING' | TranslationStatus }[] = [];
  for (const type of DOC_TYPES) {
    const original = await prisma.consentDocument.findFirst({ where: { type, language: BASE_LANGUAGE, translationStatus: 'ORIGINAL', supersededAt: null }, orderBy: { version: 'desc' } });
    if (!original) continue;
    for (const code of HUMAN_REVIEW_PRIORITY) {
      const t = await findTranslation(original, code);
      out.push({ type, originalDocumentId: original.id, version: original.version, language: code, name: SUPPORTED_LANGUAGES.find((l) => l.code === code)?.name ?? code, status: t?.translationStatus ?? 'MISSING' });
    }
  }
  return out;
}

// ── Comprehension ───────────────────────────────────────────────────────────

/** Graded on the server by option index, so it works in every language and cannot be bypassed by the client. */
export function gradeComprehension(answers: unknown): boolean {
  return Array.isArray(answers) && answers.length === CORRECT_ANSWERS.length && CORRECT_ANSWERS.every((c, i) => answers[i] === c);
}

// ── Signing OTP (typed-name path) ───────────────────────────────────────────

const hashOtp = (userId: string, code: string) => sha(`${userId}:${code}:consent`);

export async function requestSigningOtp(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.phoneNumber) throw new HttpError(409, 'Add a phone number first, or sign with a witness');
  const existing = await prisma.consentOtp.findUnique({ where: { userId } });
  if (existing && Date.now() - existing.createdAt.getTime() < SIGN_OTP_RESEND_MS) throw new HttpError(429, 'Please wait a minute before asking for another code');
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  await prisma.consentOtp.upsert({
    where: { userId },
    create: { userId, codeHash: hashOtp(userId, code), expiresAt: new Date(Date.now() + SIGN_OTP_TTL_MS) },
    update: { codeHash: hashOtp(userId, code), expiresAt: new Date(Date.now() + SIGN_OTP_TTL_MS), attempts: 0, verifiedAt: null, createdAt: new Date() },
  });
  await safeSms(user.phoneNumber, `ÀJỌ: your code to sign is ${code}. It expires in 10 minutes. Never share it.`);
}

async function checkSigningOtp(userId: string, code: string) {
  const row = await prisma.consentOtp.findUnique({ where: { userId } });
  if (!row || row.expiresAt < new Date()) throw new HttpError(401, 'That code has expired. Ask for a new one.');
  if (row.attempts >= MAX_OTP_ATTEMPTS) throw new HttpError(429, 'Too many wrong codes. Ask for a new one.');
  const a = Buffer.from(row.codeHash);
  const b = Buffer.from(hashOtp(userId, code));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await prisma.consentOtp.update({ where: { userId }, data: { attempts: { increment: 1 } } });
    throw new HttpError(401, 'Wrong code');
  }
  await prisma.consentOtp.delete({ where: { userId } });
}

// ── Signing ─────────────────────────────────────────────────────────────────

export interface WitnessInput { name: string; phone: string; signature: string; explained: boolean }
export interface SignInput {
  type: ConsentDocType;
  /** The controlling document the person was shown. Rejected if a newer version has been published since. */
  documentId?: string;
  groupId?: string;
  language?: string;
  languageLabel?: string;
  /** Hash of the translation the person read, as returned by getConsentView. */
  translationHash?: string;
  typedName: string;
  signatureImageUrl?: string;
  otp?: string;
  answers?: number[];
  witness?: WitnessInput;
}
export interface SignContext { ipAddress: string; userAgent: string }

const CUSTODY_TYPES = new Set<ConsentDocType>(['CUSTODY_MEMBER_DISCLOSURE', 'CUSTODY_COLLECTOR_AGREEMENT']);

/**
 * Records a signature on the ORIGINAL English document. The language the person read, the hash of that translation,
 * and its review status are stored beside it. A witness can stand in where the person cannot read the document.
 */
export async function signConsent(userId: string, input: SignInput, ctx: SignContext) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const original = await currentOriginal(input.type);
  if (input.documentId && input.documentId !== original.id) throw new HttpError(409, 'This document has been updated. Please read the new version and sign again.');
  if (input.typedName.trim().length < 2) throw new HttpError(400, 'Type your full name');

  // Which group, and is this person allowed to sign for it?
  let group: { id: string; name: string; adminId: string; fundsMode: string; pendingFundsMode: string | null } | null = null;
  if (CUSTODY_TYPES.has(input.type)) {
    if (!input.groupId) throw new HttpError(400, 'Choose the group this is for');
    group = await prisma.communityGroup.findUnique({ where: { id: input.groupId }, select: { id: true, name: true, adminId: true, fundsMode: true, pendingFundsMode: true } });
    if (!group) throw new HttpError(404, 'Group not found');
    if (input.type === 'CUSTODY_COLLECTOR_AGREEMENT') {
      if (group.adminId !== userId) throw new HttpError(403, 'Only the group collector can sign the collector agreement');
    } else {
      await assertGroupMember(group.id, userId);
      if (group.fundsMode !== 'COLLECTOR_CUSTODY' && group.pendingFundsMode !== 'COLLECTOR_CUSTODY') throw new HttpError(409, 'This group is not using collector custody');
    }
  } else if (input.groupId) {
    throw new HttpError(400, 'The platform terms are not signed per group');
  }

  const passed = NEEDS_COMPREHENSION[input.type] ? gradeComprehension(input.answers) : true;
  if (!passed) throw new HttpError(422, 'Please answer the three questions correctly before signing');

  // What the person read.
  const lang = resolveLanguage(input.language ?? BASE_LANGUAGE, input.languageLabel);
  let translationHash: string | null = null;
  let translationStatus: TranslationStatus = 'ORIGINAL';
  if (lang.code !== BASE_LANGUAGE && input.translationHash) {
    const row = await prisma.consentDocument.findFirst({ where: { sha256: input.translationHash, translatedFromDocumentId: original.id, language: lang.code } });
    if (!row) throw new HttpError(409, 'That translation is out of date. Please read it again.');
    translationHash = row.sha256;
    translationStatus = row.translationStatus;
  }
  const readOriginalOnly = lang.code === BASE_LANGUAGE;
  const witnessNeeded = !readOriginalOnly && !translationHash;
  if (witnessNeeded && !input.witness) throw new HttpError(422, 'We cannot confirm what you read. Please sign with a witness who reads it to you.');

  // Method: a witness, a drawn signature, or a typed name confirmed by a code sent to the person's phone.
  let witness: { userId: string | null; name: string; phone: string; signature: string } | null = null;
  let otpVerified = false;
  if (input.witness) {
    const w = input.witness;
    if (!w.explained) throw new HttpError(422, 'The witness must confirm they explained the document and the person understood');
    if (w.name.trim().length < 2 || w.signature.trim().length < 2) throw new HttpError(400, "The witness's name and signature are required");
    const phone = normalizePhone(w.phone, user.country as 'NG' | 'GH' | 'KE');
    if (!phone) throw new HttpError(400, "The witness's phone number is not valid");
    if (phone === user.phoneNumber) throw new HttpError(403, 'You cannot be your own witness');
    const wUser = await prisma.user.findFirst({ where: { phoneNumber: phone } });
    if (wUser?.id === userId) throw new HttpError(403, 'You cannot be your own witness');
    if (group && (wUser?.id === group.adminId || (await prisma.user.findUnique({ where: { id: group.adminId } }))?.phoneNumber === phone)) {
      throw new HttpError(403, 'A witness cannot be the collector of a custody group they run');
    }
    witness = { userId: wUser?.id ?? null, name: w.name.trim(), phone, signature: w.signature.trim() };
  } else if (!input.signatureImageUrl) {
    if (!input.otp) throw new HttpError(422, 'Enter the code we sent to your phone, or draw your signature');
    await checkSigningOtp(userId, input.otp);
    otpVerified = true;
  }

  const signedAt = new Date();
  const signatureHash = sha(JSON.stringify({
    userId, documentId: original.id, documentSha256: original.sha256, groupId: input.groupId ?? null, typedName: input.typedName.trim(), signedAt: signedAt.toISOString(),
    ip: ctx.ipAddress, language: lang.code, translationHash, witnessPhone: witness?.phone ?? null,
  }));

  let signature;
  try {
    signature = await prisma.consentSignature.create({
      data: {
        userId, documentId: original.id, documentSha256: original.sha256, groupId: input.groupId ?? null, typedName: input.typedName.trim(), signatureImageUrl: input.signatureImageUrl,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent.slice(0, 300), comprehensionPassed: passed, otpVerified, signedAt, signatureHash,
        translationLanguage: lang.code, translationHash, translationStatus, originalViewable: true,
        witnessUserId: witness?.userId ?? undefined, witnessName: witness?.name, witnessPhone: witness?.phone, witnessSignature: witness?.signature, witnessExplained: witness ? true : undefined,
      },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new HttpError(409, 'You have already signed this version');
    throw e;
  }
  await audit(userId, 'CONSENT_SIGNED', 'ConsentSignature', signature.id, { type: input.type, version: original.version, groupId: input.groupId ?? null, language: lang.code, translationStatus, witnessed: !!witness });

  // A receipt problem must never undo a valid signature.
  let receiptUrl: string | null = null;
  try {
    const pdf = await buildConsentReceiptPdf({
      receiptNo: `CS-${signature.id.slice(-6).toUpperCase()}`, documentTitle: TITLES[input.type], documentVersion: original.version, documentSha256: original.sha256,
      signerName: input.typedName.trim(), signedAt, groupName: group?.name, translationLanguage: lang.label, translationStatus, translationHash, signatureHash,
      witnessName: witness?.name, demo: !decisions.consentDocsApproved,
    });
    receiptUrl = await saveFile(pdf, 'consent/receipts', 'pdf', `consent-${signature.id}`);
    await prisma.consentSignature.update({ where: { id: signature.id }, data: { receiptUrl } });
    await safeSms(user.phoneNumber, `ÀJỌ: you signed "${TITLES[input.type]}". Your signed receipt: ${receiptUrl}`);
  } catch (e) {
    console.error('[consent] receipt failed', (e as Error).message);
  }
  return { signature: { id: signature.id, signedAt, signatureHash, translationStatus, translationLanguage: lang.code, witnessed: !!witness }, receiptUrl };
}

// ── Who must sign what ──────────────────────────────────────────────────────

/** True only if the person has signed the CURRENT version. A version bump makes everyone sign again. */
export async function hasSigned(userId: string, type: ConsentDocType, groupId?: string | null): Promise<boolean> {
  const original = await currentOriginal(type);
  return (await prisma.consentSignature.count({ where: { userId, documentId: original.id, groupId: groupId ?? null } })) > 0;
}

export interface RequiredConsent { type: ConsentDocType; documentId: string; version: number; groupId: string | null; reason: 'NEVER_SIGNED' | 'NEW_VERSION' }

export async function requiredConsents(userId: string, groupIds: string[] = []): Promise<RequiredConsent[]> {
  const out: RequiredConsent[] = [];
  const need = async (type: ConsentDocType, groupId: string | null) => {
    const original = await currentOriginal(type);
    if ((await prisma.consentSignature.count({ where: { userId, documentId: original.id, groupId } })) > 0) return;
    // A signature on an earlier version of the same document means this is a re-prompt, not a first signing.
    const olderDocs = await prisma.consentDocument.findMany({ where: { type, language: BASE_LANGUAGE, translationStatus: 'ORIGINAL', id: { not: original.id } }, select: { id: true } });
    const signedOld = olderDocs.length > 0 && (await prisma.consentSignature.count({ where: { userId, groupId, documentId: { in: olderDocs.map((d) => d.id) } } })) > 0;
    out.push({ type, documentId: original.id, version: original.version, groupId, reason: signedOld ? 'NEW_VERSION' : 'NEVER_SIGNED' });
  };
  await need('PLATFORM_TERMS', null);
  for (const gid of groupIds) {
    const g = await prisma.communityGroup.findUnique({ where: { id: gid }, select: { id: true, adminId: true, fundsMode: true, pendingFundsMode: true } });
    if (!g) continue;
    const custody = g.fundsMode === 'COLLECTOR_CUSTODY' || g.pendingFundsMode === 'COLLECTOR_CUSTODY';
    if (!custody) continue;
    if (g.adminId === userId) await need('CUSTODY_COLLECTOR_AGREEMENT', g.id);
    else await need('CUSTODY_MEMBER_DISCLOSURE', g.id);
  }
  return out;
}

export async function mySignatures(userId: string) {
  const rows = await prisma.consentSignature.findMany({ where: { userId }, orderBy: { signedAt: 'desc' }, take: 100 });
  const docs = await prisma.consentDocument.findMany({ where: { id: { in: rows.map((r) => r.documentId) } }, select: { id: true, type: true, version: true } });
  return rows.map((r) => ({
    id: r.id, groupId: r.groupId, signedAt: r.signedAt, receiptUrl: r.receiptUrl, translationLanguage: r.translationLanguage, translationStatus: r.translationStatus, witnessed: !!r.witnessName,
    type: docs.find((d) => d.id === r.documentId)?.type, version: docs.find((d) => d.id === r.documentId)?.version,
  }));
}

/** For the group admin: who has signed the current member disclosure, and the collector agreement. */
export async function groupConsentStatus(groupId: string) {
  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: groupId }, select: { adminId: true, fundsMode: true, pendingFundsMode: true } });
  const [disclosure, agreement] = await Promise.all([currentOriginal('CUSTODY_MEMBER_DISCLOSURE'), currentOriginal('CUSTODY_COLLECTOR_AGREEMENT')]);
  const members = await prisma.groupMember.findMany({ where: { groupId }, include: { user: { select: { id: true, fullName: true } } } });
  const signed = await prisma.consentSignature.findMany({ where: { groupId, documentId: disclosure.id }, select: { userId: true } });
  const signedSet = new Set(signed.map((s) => s.userId));
  const collectorSigned = (await prisma.consentSignature.count({ where: { groupId, documentId: agreement.id, userId: group.adminId } })) > 0;
  return {
    fundsMode: group.fundsMode, pendingFundsMode: group.pendingFundsMode, disclosureVersion: disclosure.version, collectorAgreementSigned: collectorSigned,
    members: members.filter((m) => m.user.id !== group.adminId).map((m) => ({ userId: m.user.id, name: m.user.fullName, signed: signedSet.has(m.user.id) })),
  };
}

/**
 * Runs when a group's switch to custody takes effect, at the start of a new cycle. Members who have not signed the
 * current disclosure by then leave the group. Their confirmed contributions stay in the ledger and are settled under the
 * group's own rules by the collector. Returns who was exited so the collector can see it.
 */
export async function enforceCustodyConsentAtCycleStart(groupId: string) {
  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: groupId }, select: { id: true, name: true, adminId: true } });
  const disclosure = await currentOriginal('CUSTODY_MEMBER_DISCLOSURE');
  const signed = new Set((await prisma.consentSignature.findMany({ where: { groupId, documentId: disclosure.id }, select: { userId: true } })).map((s) => s.userId));
  const members = await prisma.groupMember.findMany({ where: { groupId }, include: { user: true } });
  const exited: string[] = [];
  for (const m of members) {
    if (m.userId === group.adminId || signed.has(m.userId)) continue;
    await prisma.groupMember.delete({ where: { id: m.id } });
    exited.push(m.userId);
    await audit(null, 'CUSTODY_MEMBER_EXITED', 'CommunityGroup', groupId, { userId: m.userId, reason: 'did not sign the custody disclosure' });
    await safeSms(m.user.phoneNumber, `ÀJỌ: "${group.name}" now uses collector custody and you did not sign the disclosure, so you have left the group. Your confirmed contributions are handled under the group's rules. Contact your collector.`);
  }
  return exited;
}
