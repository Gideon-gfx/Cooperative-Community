const mockPrisma: Record<string, any> = {
  consentDocument: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn(), findUnique: jest.fn() },
  consentSignature: { create: jest.fn(), count: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  consentOtp: { findUnique: jest.fn(), upsert: jest.fn(), update: jest.fn(), delete: jest.fn() },
  consentUiTranslation: { findUnique: jest.fn(), upsert: jest.fn() },
  user: { findUniqueOrThrow: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn() },
  communityGroup: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
  groupMember: { findUnique: jest.fn(), findMany: jest.fn(), delete: jest.fn() },
  auditLog: { create: jest.fn() },
};
const sms = jest.fn();
jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../lib/notify', () => ({ safeSms: (...a: unknown[]) => sms(...a), safeSmsAndEmail: (...a: unknown[]) => a[0] && sms(a[0], a[3]), naira: (n: unknown) => `₦${n}` }));
jest.mock('../services/storage.service', () => ({ saveFile: jest.fn().mockResolvedValue('http://files/consent/receipt.pdf') }));

import crypto from 'crypto';
import { CORRECT_ANSWERS, NEEDS_COMPREHENSION, SEED_DOCUMENTS, UI_STRINGS } from '../modules/consent/consent.docs';
import { resolveLanguage } from '../modules/consent/languages';
import {
  enforceCustodyConsentAtCycleStart, getConsentView, gradeComprehension, hasSigned, publishOriginal, requiredConsents, seedConsentDocuments, signConsent, submitHumanTranslation,
} from '../modules/consent/consent.service';
import { sameShape, setTranslationProvider, type TranslationProvider } from '../modules/consent/translation.provider';
import { assertConsents } from '../modules/payments/payments.service';
import { saveFile } from '../services/storage.service';

const id = (c: string) => c.repeat(24);
const USER = id('a'), COLLECTOR = id('b'), GROUP = id('c'), DOC = id('d'), TR = id('e'), ADMIN = id('f'), WIT = id('9');
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const ctx = { ipAddress: '1.2.3.4', userAgent: 'jest' };
const ok = [...CORRECT_ANSWERS];

const original = (over: Record<string, unknown> = {}) => ({ id: DOC, type: 'CUSTODY_MEMBER_DISCLOSURE', version: 1, language: 'en', languageLabel: 'English', bodyMarkdown: '[DRAFT] # Original body', sha256: sha('[DRAFT] # Original body'), translationStatus: 'ORIGINAL', supersededAt: null, ...over });
const translation = (over: Record<string, unknown> = {}) => ({ id: TR, type: 'CUSTODY_MEMBER_DISCLOSURE', version: 1, language: 'yo', languageLabel: 'Yoruba', bodyMarkdown: 'Ọ̀rọ̀ Yorùbá', sha256: sha('Ọ̀rọ̀ Yorùbá'), translationStatus: 'MACHINE_TRANSLATED', translatedFromDocumentId: DOC, supersededAt: null, ...over });
const group = (over: Record<string, unknown> = {}) => ({ id: GROUP, name: 'Market Women', adminId: COLLECTOR, fundsMode: 'COLLECTOR_CUSTODY', pendingFundsMode: null, ...over });

class FakeProvider implements TranslationProvider {
  name = 'fake';
  docs = jest.fn(async (md: string, t: { label: string }) => `[${t.label}] ${md}`);
  strings = jest.fn(async (s: Record<string, unknown>) => JSON.parse(JSON.stringify(s).replace(/"([^"{}]+)"/g, (m) => m)));
  translateDocument(md: string, t: { code: string; label: string }) { return this.docs(md, t); }
  translateStrings(s: Record<string, unknown>) { return this.strings(s); }
}

let provider: FakeProvider;
beforeEach(() => {
  jest.resetAllMocks();
  provider = new FakeProvider();
  setTranslationProvider(provider);
  mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ id: USER, phoneNumber: '+2348031234567', country: 'NG' });
  mockPrisma.user.findUnique.mockResolvedValue({ phoneNumber: '+2348099999999' });
  mockPrisma.user.findFirst.mockResolvedValue(null);
  mockPrisma.communityGroup.findUnique.mockResolvedValue(group());
  mockPrisma.groupMember.findUnique.mockResolvedValue({ id: 'm' });
  mockPrisma.consentDocument.findFirst.mockResolvedValue(original());
  mockPrisma.consentDocument.findMany.mockResolvedValue([]);
  mockPrisma.consentUiTranslation.findUnique.mockResolvedValue(null);
  mockPrisma.consentSignature.create.mockImplementation(async ({ data }: any) => ({ id: id('1'), ...data }));
  mockPrisma.consentSignature.update.mockResolvedValue({});
  (saveFile as jest.Mock).mockResolvedValue('http://files/consent/receipt.pdf');
});
afterAll(() => setTranslationProvider(null));

describe('language: any language, including ones not on the list', () => {
  it('resolves listed codes, other well-formed codes, and free text', () => {
    expect(resolveLanguage('yo')).toMatchObject({ code: 'yo', custom: false });
    expect(resolveLanguage('GUW')).toMatchObject({ code: 'guw', label: 'Egun (Gun)' });
    expect(resolveLanguage('sq', 'Albanian')).toMatchObject({ code: 'sq', label: 'Albanian', custom: false });
    expect(resolveLanguage(undefined, 'Ebira')).toEqual({ code: 'x-ebira', label: 'Ebira', custom: true });
    expect(resolveLanguage('x-ebira')).toMatchObject({ custom: true });
    expect(() => resolveLanguage('', ' ')).toThrow();
  });
});

describe('the consent view', () => {
  it('English: the original is shown, with no banner and no translation', async () => {
    const v = await getConsentView({ type: 'CUSTODY_MEMBER_DISCLOSURE', language: 'en' });
    expect(v.shown?.documentId).toBe(DOC);
    expect(v.banner).toBeNull();
    expect(provider.docs).not.toHaveBeenCalled();
    expect(v.needsComprehension).toBe(true);
    expect(v.demo).toEqual({ watermark: 'DRAFT · DEMO MODE' });
  });

  it('a machine translation is generated once, labelled unofficial, never marked reviewed, and the original is always attached', async () => {
    mockPrisma.consentDocument.create.mockImplementation(async ({ data }: any) => ({ id: TR, ...data }));
    const v = await getConsentView({ type: 'CUSTODY_MEMBER_DISCLOSURE', language: 'yo' });
    expect(mockPrisma.consentDocument.create).toHaveBeenCalledWith({ data: expect.objectContaining({ translationStatus: 'MACHINE_TRANSLATED', translatedFromDocumentId: DOC, language: 'yo' }) });
    expect(mockPrisma.consentDocument.create.mock.calls[0][0].data).not.toHaveProperty('reviewedBy');
    expect(v.shown?.translationStatus).toBe('MACHINE_TRANSLATED');
    expect(v.banner).toContain('unofficial translation');
    expect(v.banner).toContain('English');
    expect(v.original.body).toBe(original().bodyMarkdown);
    expect(v.original.sha256).toBe(original().sha256);
  });

  it('a reviewed translation wins over the machine one and carries no banner', async () => {
    mockPrisma.consentDocument.findMany.mockResolvedValue([translation(), translation({ id: id('7'), translationStatus: 'HUMAN_REVIEWED' })]);
    const v = await getConsentView({ type: 'CUSTODY_MEMBER_DISCLOSURE', language: 'yo' });
    expect(v.shown?.documentId).toBe(id('7'));
    expect(v.shown?.translationStatus).toBe('HUMAN_REVIEWED');
    expect(v.banner).toBeNull();
    expect(provider.docs).not.toHaveBeenCalled();
  });

  it('an existing machine translation is reused, not paid for again', async () => {
    mockPrisma.consentDocument.findMany.mockResolvedValue([translation()]);
    await getConsentView({ type: 'CUSTODY_MEMBER_DISCLOSURE', language: 'yo' });
    expect(provider.docs).not.toHaveBeenCalled();
  });

  it('with no translation service, a witness is required and the person is told why', async () => {
    const { UnavailableTranslationProvider } = jest.requireActual('../modules/consent/translation.provider');
    setTranslationProvider(new UnavailableTranslationProvider());
    const v = await getConsentView({ type: 'CUSTODY_MEMBER_DISCLOSURE', language: 'ig' });
    expect(v.shown).toBeNull();
    expect(v.witnessRequired).toBe(true);
    expect(v.audio.supported).toBe(false);
    expect(v.audio.message).toBeTruthy();
  });

  it('Egun and unlisted machine-translated languages recommend a witness', async () => {
    mockPrisma.consentDocument.create.mockImplementation(async ({ data }: any) => ({ id: TR, ...data }));
    expect((await getConsentView({ type: 'PLATFORM_TERMS', language: 'guw' })).witnessRecommended).toBe(true);
    expect((await getConsentView({ type: 'PLATFORM_TERMS', language: 'x-custom', languageLabel: 'Ebira' })).witnessRecommended).toBe(true);
    expect((await getConsentView({ type: 'PLATFORM_TERMS', language: 'en' })).witnessRecommended).toBe(false);
  });

  it('read-aloud is offered only where text-to-speech is likely; elsewhere it falls back to a witness', async () => {
    mockPrisma.consentDocument.create.mockImplementation(async ({ data }: any) => ({ id: TR, ...data }));
    expect((await getConsentView({ type: 'PLATFORM_TERMS', language: 'fr' })).audio.supported).toBe(true);
    expect((await getConsentView({ type: 'PLATFORM_TERMS', language: 'ibb' })).audio.supported).toBe(false);
  });

  it('a translated interface keeps its structure (a dropped question is rejected)', () => {
    expect(sameShape(UI_STRINGS, JSON.parse(JSON.stringify(UI_STRINGS)))).toBe(true);
    const broken = JSON.parse(JSON.stringify(UI_STRINGS));
    broken.questions.pop();
    expect(sameShape(UI_STRINGS, broken)).toBe(false);
  });
});

describe('comprehension check', () => {
  it('passes only with all three correct answers', () => {
    expect(gradeComprehension(ok)).toBe(true);
    expect(gradeComprehension([0, 1])).toBe(false);
    expect(gradeComprehension([1, 1, 0])).toBe(false);
    expect(gradeComprehension(undefined)).toBe(false);
    expect(gradeComprehension('0,1,0')).toBe(false);
  });
  it('is required for the custody documents and not for the platform terms', () => {
    expect(NEEDS_COMPREHENSION).toEqual({ CUSTODY_MEMBER_DISCLOSURE: true, CUSTODY_COLLECTOR_AGREEMENT: true, PLATFORM_TERMS: false });
  });
  it('the sign button cannot be bypassed: the server rejects wrong or missing answers', async () => {
    const base = { type: 'CUSTODY_MEMBER_DISCLOSURE' as const, groupId: GROUP, typedName: 'Ade Bello', signatureImageUrl: 'http://x/sig.png' };
    await expect(signConsent(USER, { ...base, answers: [1, 1, 0] }, ctx)).rejects.toThrow('three questions');
    await expect(signConsent(USER, base, ctx)).rejects.toThrow('three questions');
    expect(mockPrisma.consentSignature.create).not.toHaveBeenCalled();
  });
});

describe('signing', () => {
  const base = { type: 'CUSTODY_MEMBER_DISCLOSURE' as const, groupId: GROUP, typedName: 'Ade Bello', answers: ok };
  const goodOtp = (code = '123456') => mockPrisma.consentOtp.findUnique.mockResolvedValue({ codeHash: sha(`${USER}:${code}:consent`), expiresAt: new Date(Date.now() + 60_000), attempts: 0 });

  it('signs the ORIGINAL English document with a typed name and a phone code, and stores a receipt', async () => {
    goodOtp();
    const r = await signConsent(USER, { ...base, otp: '123456', documentId: DOC }, ctx);
    expect(mockPrisma.consentSignature.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER, documentId: DOC, documentSha256: original().sha256, groupId: GROUP, translationLanguage: 'en', translationStatus: 'ORIGINAL', comprehensionPassed: true, otpVerified: true, ipAddress: '1.2.3.4', userAgent: 'jest' }),
    });
    expect(mockPrisma.consentOtp.delete).toHaveBeenCalled(); // a code works once
    expect(r.receiptUrl).toBe('http://files/consent/receipt.pdf');
    expect(sms).toHaveBeenCalledWith('+2348031234567', expect.stringContaining('receipt'));
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'CONSENT_SIGNED' }) });
  });

  it('switching language keeps the signature on the same original and records the translation hash and status shown', async () => {
    goodOtp();
    mockPrisma.consentDocument.findFirst
      .mockResolvedValueOnce(original()) // currentOriginal
      .mockResolvedValueOnce(translation()); // the translation row for the hash the person read
    await signConsent(USER, { ...base, otp: '123456', language: 'yo', translationHash: translation().sha256 }, ctx);
    expect(mockPrisma.consentSignature.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ documentId: DOC, documentSha256: original().sha256, translationLanguage: 'yo', translationHash: translation().sha256, translationStatus: 'MACHINE_TRANSLATED', originalViewable: true }),
    });
    // Signature validity does not depend on the language: it is on the original, so hasSigned sees it.
    mockPrisma.consentDocument.findFirst.mockResolvedValue(original());
    mockPrisma.consentSignature.count.mockResolvedValue(1);
    expect(await hasSigned(USER, 'CUSTODY_MEMBER_DISCLOSURE', GROUP)).toBe(true);
    expect(mockPrisma.consentSignature.count).toHaveBeenLastCalledWith({ where: { userId: USER, documentId: DOC, groupId: GROUP } });
  });

  it('a made-up translation hash is refused, and a translation with no hash needs a witness', async () => {
    goodOtp();
    mockPrisma.consentDocument.findFirst.mockResolvedValueOnce(original()).mockResolvedValueOnce(null);
    await expect(signConsent(USER, { ...base, otp: '123456', language: 'yo', translationHash: 'f'.repeat(64) }, ctx)).rejects.toThrow('out of date');
    mockPrisma.consentDocument.findFirst.mockResolvedValue(original());
    await expect(signConsent(USER, { ...base, otp: '123456', language: 'yo' }, ctx)).rejects.toThrow('witness');
  });

  it('a version bump rejects a stale signature attempt', async () => {
    await expect(signConsent(USER, { ...base, otp: '123456', documentId: id('8') }, ctx)).rejects.toThrow('updated');
  });

  it('needs a drawn signature or the phone code, and the code must be right and unexpired', async () => {
    await expect(signConsent(USER, base, ctx)).rejects.toThrow('code');
    mockPrisma.consentOtp.findUnique.mockResolvedValue({ codeHash: sha(`${USER}:111111:consent`), expiresAt: new Date(Date.now() + 60_000), attempts: 0 });
    await expect(signConsent(USER, { ...base, otp: '999999' }, ctx)).rejects.toThrow('Wrong code');
    expect(mockPrisma.consentOtp.update).toHaveBeenCalled();
    mockPrisma.consentOtp.findUnique.mockResolvedValue({ codeHash: 'x', expiresAt: new Date(Date.now() - 1), attempts: 0 });
    await expect(signConsent(USER, { ...base, otp: '111111' }, ctx)).rejects.toThrow('expired');
    mockPrisma.consentOtp.findUnique.mockResolvedValue({ codeHash: 'x', expiresAt: new Date(Date.now() + 60_000), attempts: 5 });
    await expect(signConsent(USER, { ...base, otp: '111111' }, ctx)).rejects.toThrow('Too many');
    expect(mockPrisma.consentSignature.create).not.toHaveBeenCalled();
    // a drawn signature needs no code
    await expect(signConsent(USER, { ...base, signatureImageUrl: 'http://x/sig.png' }, ctx)).resolves.toBeDefined();
  });

  it('signing twice is rejected', async () => {
    mockPrisma.consentSignature.create.mockRejectedValue({ code: 'P2002' });
    await expect(signConsent(USER, { ...base, signatureImageUrl: 'http://x/s.png' }, ctx)).rejects.toThrow('already signed');
  });

  it('custody documents are tied to the right group and person', async () => {
    const sig = { typedName: 'Ade Bello', answers: ok, signatureImageUrl: 'http://x/s.png' };
    await expect(signConsent(USER, { type: 'CUSTODY_MEMBER_DISCLOSURE', ...sig }, ctx)).rejects.toThrow('group');
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW' }));
    await expect(signConsent(USER, { type: 'CUSTODY_MEMBER_DISCLOSURE', groupId: GROUP, ...sig }, ctx)).rejects.toThrow('not using collector custody');
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group());
    await expect(signConsent(USER, { type: 'CUSTODY_COLLECTOR_AGREEMENT', groupId: GROUP, ...sig }, ctx)).rejects.toThrow('Only the group collector');
    mockPrisma.groupMember.findUnique.mockResolvedValue(null);
    await expect(signConsent(USER, { type: 'CUSTODY_MEMBER_DISCLOSURE', groupId: GROUP, ...sig }, ctx)).rejects.toThrow('not a member');
  });

  it('members can sign for a group that is about to switch to custody', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW', pendingFundsMode: 'COLLECTOR_CUSTODY' }));
    await expect(signConsent(USER, { ...base, signatureImageUrl: 'http://x/s.png' }, ctx)).resolves.toBeDefined();
  });

  it('the platform terms need no comprehension check and are never per-group', async () => {
    mockPrisma.consentDocument.findFirst.mockResolvedValue(original({ type: 'PLATFORM_TERMS' }));
    await expect(signConsent(USER, { type: 'PLATFORM_TERMS', typedName: 'Ade Bello', signatureImageUrl: 'http://x/s.png' }, ctx)).resolves.toBeDefined();
    await expect(signConsent(USER, { type: 'PLATFORM_TERMS', groupId: GROUP, typedName: 'Ade Bello', signatureImageUrl: 'http://x/s.png' }, ctx)).rejects.toThrow('not signed per group');
  });

  describe('witness-assisted signing', () => {
    const witness = { name: 'Mama Kemi', phone: '08051112222', signature: 'Mama Kemi', explained: true };
    const yo = { ...base, language: 'yo' };
    it('works with no phone code and no translation, and records the witness', async () => {
      await signConsent(USER, { ...yo, witness }, ctx);
      expect(mockPrisma.consentSignature.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ witnessName: 'Mama Kemi', witnessPhone: '+2348051112222', witnessSignature: 'Mama Kemi', witnessExplained: true, otpVerified: false, translationHash: null }),
      });
    });
    it('requires the explained checkbox, a name and a signature', async () => {
      await expect(signConsent(USER, { ...yo, witness: { ...witness, explained: false } }, ctx)).rejects.toThrow('explained');
      await expect(signConsent(USER, { ...yo, witness: { ...witness, name: 'M' } }, ctx)).rejects.toThrow('required');
      await expect(signConsent(USER, { ...yo, witness: { ...witness, phone: '123' } }, ctx)).rejects.toThrow('not valid');
    });
    it('cannot be the signer themselves', async () => {
      await expect(signConsent(USER, { ...yo, witness: { ...witness, phone: '+2348031234567' } }, ctx)).rejects.toThrow('own witness');
      mockPrisma.user.findFirst.mockResolvedValue({ id: USER });
      await expect(signConsent(USER, { ...yo, witness }, ctx)).rejects.toThrow('own witness');
    });
    it('cannot be the collector of the custody group they run', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: COLLECTOR });
      await expect(signConsent(USER, { ...yo, witness }, ctx)).rejects.toThrow('collector of a custody group');
      mockPrisma.user.findFirst.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue({ phoneNumber: '+2348051112222' }); // collector's phone is the witness's phone
      await expect(signConsent(USER, { ...yo, witness }, ctx)).rejects.toThrow('collector of a custody group');
      expect(mockPrisma.consentSignature.create).not.toHaveBeenCalled();
    });
    it('links the witness to their account when they have one', async () => {
      mockPrisma.user.findFirst.mockResolvedValue({ id: WIT });
      await signConsent(USER, { ...yo, witness }, ctx);
      expect(mockPrisma.consentSignature.create.mock.calls[0][0].data.witnessUserId).toBe(WIT);
    });
  });
});

describe('versions and re-prompts', () => {
  it('a signature on an older version is not enough: the person must sign the new one', async () => {
    mockPrisma.consentDocument.findFirst.mockResolvedValue(original({ version: 2 }));
    mockPrisma.consentSignature.count.mockResolvedValue(0);
    expect(await hasSigned(USER, 'CUSTODY_MEMBER_DISCLOSURE', GROUP)).toBe(false);
  });

  it('requiredConsents says NEW_VERSION when an earlier version was signed, and NEVER_SIGNED otherwise', async () => {
    mockPrisma.consentDocument.findFirst.mockResolvedValue(original({ version: 2 }));
    mockPrisma.consentDocument.findMany.mockImplementation(async ({ where }: any) => (where.type === 'CUSTODY_MEMBER_DISCLOSURE' ? [{ id: id('5') }] : []));
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group());
    // platform terms: never signed; disclosure: signed v1 only
    mockPrisma.consentSignature.count.mockImplementation(async ({ where }: any) => (where.documentId?.in ? 1 : 0));
    const out = await requiredConsents(USER, [GROUP]);
    expect(out.map((r) => [r.type, r.reason])).toEqual([['PLATFORM_TERMS', 'NEVER_SIGNED'], ['CUSTODY_MEMBER_DISCLOSURE', 'NEW_VERSION']]);
  });

  it('a collector is asked for the collector agreement, and nothing extra for an escrow group', async () => {
    mockPrisma.consentSignature.count.mockResolvedValue(0);
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group());
    expect((await requiredConsents(COLLECTOR, [GROUP])).map((r) => r.type)).toEqual(['PLATFORM_TERMS', 'CUSTODY_COLLECTOR_AGREEMENT']);
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW' }));
    expect((await requiredConsents(USER, [GROUP])).map((r) => r.type)).toEqual(['PLATFORM_TERMS']);
  });

  it('publishing a new version supersedes the old one and every translation of it', async () => {
    mockPrisma.consentDocument.findFirst.mockResolvedValue(original());
    mockPrisma.consentDocument.create.mockImplementation(async ({ data }: any) => ({ id: id('6'), ...data }));
    const d = await publishOriginal(ADMIN, { type: 'CUSTODY_MEMBER_DISCLOSURE', bodyMarkdown: 'A new, longer body of the disclosure with the changed terms spelled out in full.' });
    expect(d.version).toBe(2);
    expect(mockPrisma.consentDocument.updateMany).toHaveBeenCalledWith({ where: { type: 'CUSTODY_MEMBER_DISCLOSURE', supersededAt: null, id: { not: id('6') } }, data: { supersededAt: expect.any(Date) } });
    expect(mockPrisma.consentDocument.create.mock.calls[0][0].data.bodyMarkdown).toContain('[DRAFT');
  });
});

describe('human-reviewed translations', () => {
  const input = { originalDocumentId: DOC, language: 'yo', bodyMarkdown: 'Àkọsílẹ̀ Yorùbá tí a ti yẹ̀ wò', reviewedBy: 'Dr. Adeyemi + back-translator' };
  it('replaces the machine version for everyone and records who reviewed it', async () => {
    mockPrisma.consentDocument.findUnique.mockResolvedValue(original());
    mockPrisma.consentDocument.create.mockImplementation(async ({ data }: any) => ({ id: id('7'), ...data }));
    const d = await submitHumanTranslation(ADMIN, input);
    expect(d.translationStatus).toBe('HUMAN_REVIEWED');
    expect(mockPrisma.consentDocument.updateMany).toHaveBeenCalledWith({ where: { translatedFromDocumentId: DOC, language: 'yo', supersededAt: null, id: { not: id('7') } }, data: { supersededAt: expect.any(Date) } });
    expect(mockPrisma.consentDocument.create.mock.calls[0][0].data).toMatchObject({ reviewedBy: input.reviewedBy, sha256: sha(input.bodyMarkdown) });
  });
  it('refuses an out-of-date original, English, or a missing reviewer', async () => {
    mockPrisma.consentDocument.findUnique.mockResolvedValue(original({ supersededAt: new Date() }));
    await expect(submitHumanTranslation(ADMIN, input)).rejects.toThrow('out of date');
    mockPrisma.consentDocument.findUnique.mockResolvedValue(original());
    await expect(submitHumanTranslation(ADMIN, { ...input, language: 'en' })).rejects.toThrow('original');
    await expect(submitHumanTranslation(ADMIN, { ...input, reviewedBy: ' ' })).rejects.toThrow('reviewed');
  });
});

describe('seed documents', () => {
  it('are English-only placeholders that start with the lawyer-review line and cite no statutes', () => {
    for (const body of Object.values(SEED_DOCUMENTS)) {
      expect(body.startsWith('[DRAFT - REQUIRES REVIEW BY A QUALIFIED NIGERIAN LAWYER BEFORE USE]')).toBe(true);
      expect(body).not.toMatch(/\bAct\b|\bSection \d|\bCAP\b|\bLFN\b/);
    }
    const m = SEED_DOCUMENTS.CUSTODY_MEMBER_DISCLOSURE;
    expect(m).toMatch(/does \*\*not\*\* hold it/);
    expect(m).toMatch(/not guarantee/);
    expect(m).toMatch(/escrow/i);
    expect(m).toMatch(/voluntary/);
    expect(SEED_DOCUMENTS.CUSTODY_COLLECTOR_AGREEMENT).toMatch(/separate account/);
    expect(SEED_DOCUMENTS.CUSTODY_COLLECTOR_AGREEMENT).toMatch(/not mix it/);
  });
  it('seeding creates only the missing originals', async () => {
    mockPrisma.consentDocument.findFirst.mockResolvedValueOnce(original()).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    mockPrisma.consentDocument.create.mockResolvedValue({});
    expect(await seedConsentDocuments()).toBe(2);
  });
});

describe('cycle-start enforcement for a switch to custody', () => {
  it('members who have not signed the disclosure leave the group; the collector and signers stay', async () => {
    mockPrisma.communityGroup.findUniqueOrThrow.mockResolvedValue(group());
    mockPrisma.consentSignature.findMany.mockResolvedValue([{ userId: id('2') }]);
    mockPrisma.groupMember.findMany.mockResolvedValue([
      { id: 'm0', userId: COLLECTOR, user: { phoneNumber: '+2348000000000' } },
      { id: 'm1', userId: id('1'), user: { phoneNumber: '+2348000000001' } },
      { id: 'm2', userId: id('2'), user: { phoneNumber: '+2348000000002' } },
    ]);
    const exited = await enforceCustodyConsentAtCycleStart(GROUP);
    expect(exited).toEqual([id('1')]);
    expect(mockPrisma.groupMember.delete).toHaveBeenCalledTimes(1);
    expect(mockPrisma.groupMember.delete).toHaveBeenCalledWith({ where: { id: 'm1' } });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'CUSTODY_MEMBER_EXITED' }) });
    expect(sms).toHaveBeenCalledWith('+2348000000001', expect.stringContaining('did not sign'.replace('did not sign', 'did not sign')));
  });
});

describe('no contribution without consent', () => {
  it('nobody pays any group without accepting the terms', async () => {
    mockPrisma.consentDocument.findFirst.mockResolvedValue(original({ type: 'PLATFORM_TERMS' }));
    mockPrisma.consentSignature.count.mockResolvedValue(0);
    await expect(assertConsents(USER, { id: GROUP, fundsMode: 'ESCROW' })).rejects.toThrow('CONSENT_REQUIRED');
  });
  it('an escrow group needs only the terms', async () => {
    mockPrisma.consentSignature.count.mockResolvedValue(1);
    await expect(assertConsents(USER, { id: GROUP, fundsMode: 'ESCROW' })).resolves.toBeUndefined();
  });
  it('a custody group also needs the custody disclosure: terms alone are not enough', async () => {
    mockPrisma.consentSignature.count.mockImplementation(async ({ where }: any) => (where.groupId === null ? 1 : 0));
    await expect(assertConsents(USER, { id: GROUP, fundsMode: 'COLLECTOR_CUSTODY' })).rejects.toThrow('custody disclosure');
    mockPrisma.consentSignature.count.mockResolvedValue(1);
    await expect(assertConsents(USER, { id: GROUP, fundsMode: 'COLLECTOR_CUSTODY' })).resolves.toBeUndefined();
  });
});
