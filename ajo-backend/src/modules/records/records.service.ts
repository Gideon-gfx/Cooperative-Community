import ExcelJS from 'exceljs';
import { HistoricalKind, ImportBatch, Prisma, RecordSourceKind, RecordType, StagedRow } from '@prisma/client';
import { decisions } from '../../config/decisions';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { assertGroupMember } from '../../lib/access';
import { koboToNaira } from '../../lib/kobo';
import { t, type Lang } from '../../lib/i18n';
import { safeSms } from '../../lib/notify';
import { assertCanImportRecords } from '../billing/billing.service';
import { getOcrProvider } from './ocr.provider';
import {
  applyMapping, batchChecks, dupKey, foldName, guessMapping, matchMember, parseCsv, parseRow, type MemberCandidate, type ParsedRow,
} from './records.logic';
import { sha256, vaultGet, vaultPut } from './vault';

// ── Who may do what ─────────────────────────────────────────────────────────

type Actor = { id: string; role: string };

export async function loadGroup(groupId: string) {
  const g = await prisma.communityGroup.findUnique({ where: { id: groupId } });
  if (!g) throw new HttpError(404, 'Group not found');
  return g;
}
export const isManager = (u: Actor, g: { adminId: string }) => g.adminId === u.id || u.role === 'ADMIN';
export const isBoard = (u: Actor) => u.role === 'BOARD_MEMBER' || u.role === 'ADMIN';

/** The group's collector (or a platform admin) manages its records. */
export async function assertManager(u: Actor, groupId: string) {
  const g = await loadGroup(groupId);
  if (!isManager(u, g)) throw new HttpError(403, 'Only the group collector or an admin can manage records');
  return g;
}
export async function assertMemberOrManager(u: Actor, groupId: string) {
  const g = await loadGroup(groupId);
  if (!isManager(u, g) && !(u.role === 'BOARD_MEMBER')) await assertGroupMember(groupId, u.id);
  return g;
}
export async function logAccess(userId: string, groupId: string, action: string, entity: string, entityId?: string) {
  try { await prisma.recordAccessLog.create({ data: { userId, groupId, action, entity, entityId } }); } catch (e) { console.error('[records] access log failed', (e as Error).message); }
}

// ── Privacy notice (organizer confirms before importing other people's information) ──

export const PRIVACY_NOTICE_VERSION = 'draft-1';
export const PRIVACY_NOTICE = `[DRAFT - REQUIRES REVIEW BY A QUALIFIED NIGERIAN LAWYER BEFORE USE]

Before you import old records
These records contain personal information about people who may not have signed up to CC-ÀJỌ: their names, phone numbers and what they paid or received.
By continuing you confirm that:
1. You are the person who keeps these records for the group, or you have the group's permission to digitize them.
2. You will use them only to run and show your group's own history.
3. Each person with a phone number will receive a message so they can confirm or correct what is written about them.
4. A person can ask for their record to be corrected or removed. Corrections and removals are made by adding a new entry, and the history of the change is kept.
5. Nothing you import here is treated as live money until members have confirmed it.
Nigerian data protection law applies to this information. [APPLICABLE NOTICE AND LAWFUL-BASIS WORDING - TO BE COMPLETED BY THE LAWYER]`;

export async function confirmPrivacy(user: Actor, groupId: string) {
  await assertManager(user, groupId);
  try {
    await prisma.recordsPrivacyConsent.create({ data: { groupId, userId: user.id, noticeVersion: PRIVACY_NOTICE_VERSION } });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
  }
  await audit(user.id, 'RECORDS_PRIVACY_CONFIRMED', 'CommunityGroup', groupId, { version: PRIVACY_NOTICE_VERSION });
  return { confirmed: true, version: PRIVACY_NOTICE_VERSION };
}
export async function assertPrivacyConfirmed(groupId: string) {
  const c = await prisma.recordsPrivacyConsent.findUnique({ where: { groupId_noticeVersion: { groupId, noticeVersion: PRIVACY_NOTICE_VERSION } } });
  if (!c) throw new HttpError(409, 'PRIVACY_NOTICE: please read and confirm the data-processing notice before importing records');
}

// ── Quotas (organizer plan). Only NEW OCR and NEW uploads are limited; viewing, searching, typing and exporting never are ──

const GB = 1024 ** 3;
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export async function usageFor(adminId: string, now = new Date()) {
  const groups = await prisma.communityGroup.findMany({ where: { adminId }, select: { id: true } });
  const ids = groups.map((g) => g.id);
  const bytes = await prisma.recordSource.aggregate({ where: { groupId: { in: ids } }, _sum: { sizeBytes: true } });
  const ocr = await prisma.ocrUsage.aggregate({ where: { groupId: { in: ids }, month: monthKey(now) }, _sum: { pages: true } });
  return {
    storageBytes: Number(bytes._sum.sizeBytes ?? 0n), storageQuotaBytes: decisions.quotas.storageGb * GB,
    ocrPagesThisMonth: ocr._sum.pages ?? 0, ocrQuotaPerMonth: decisions.quotas.ocrPagesPerMonth,
  };
}

// ── Sources (originals are stored once and never changed) ───────────────────

const IMAGE = /^image\/(jpeg|png|webp|gif)$/;
const SHEET = new Set(['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain', 'text/tab-separated-values']);
const FILE_KINDS: Record<string, (m: string) => boolean> = {
  SCAN: (m) => IMAGE.test(m), PDF: (m) => m === 'application/pdf', SPREADSHEET: (m) => SHEET.has(m), DOCUMENT: (m) => IMAGE.test(m) || m === 'application/pdf' || m === 'text/plain' || SHEET.has(m),
};

export interface UploadedFile { buffer: Buffer; mime: string; name?: string }

export async function createFileSource(user: Actor, input: { groupId: string; kind: Exclude<RecordSourceKind, 'TYPED'>; files: UploadedFile[]; language?: string; assistedById?: string }) {
  const group = await assertManager(user, input.groupId);
  await assertCanImportRecords(user);
  await assertPrivacyConfirmed(group.id);
  if (!input.files.length) throw new HttpError(400, 'Choose at least one file');
  const ok = FILE_KINDS[input.kind];
  for (const f of input.files) if (!ok(f.mime)) throw new HttpError(400, `A ${f.mime || 'unknown'} file cannot be used for this kind of upload`);
  if ((input.kind === 'PDF' || input.kind === 'SPREADSHEET') && input.files.length !== 1) throw new HttpError(400, 'Upload one file at a time for this kind');

  const total = input.files.reduce((s, f) => s + f.buffer.length, 0);
  const usage = await usageFor(group.adminId);
  if (usage.storageBytes + total > usage.storageQuotaBytes) throw new HttpError(413, 'STORAGE_FULL: your record storage is full. You can still view, search, type and export everything.');
  if (input.assistedById) await assertGroupMember(group.id, input.assistedById).catch(() => { throw new HttpError(400, 'The helper must be a member of the group'); });

  const pages = [];
  for (const [i, f] of input.files.entries()) pages.push({ pageNumber: i + 1, vaultKey: await vaultPut(f.buffer), sha256: sha256(f.buffer), mime: f.mime, sizeBytes: f.buffer.length });
  const pdfPages = input.kind === 'PDF' ? Math.max(1, (input.files[0].buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length) : pages.length;
  const source = await prisma.recordSource.create({
    data: {
      groupId: group.id, uploadedById: user.id, kind: input.kind, originalSha256: sha256(pages.map((p) => p.sha256).join(':')), pageCount: pdfPages, sizeBytes: BigInt(total),
      language: input.language ?? 'en', assistedById: input.assistedById ?? null, pages: { create: pages },
    },
    include: { pages: true },
  });
  await audit(user.id, 'RECORD_SOURCE_UPLOADED', 'RecordSource', source.id, { kind: input.kind, pages: source.pageCount, assistedById: input.assistedById ?? null });
  return source;
}

// ── Staging: everything becomes SUGGESTIONS that a person reviews ───────────

export const FATAL_ISSUES = new Set(['MISSING_NAME', 'MISSING_DATE', 'BAD_DATE', 'MISSING_AMOUNT', 'BAD_AMOUNT', 'AMBIGUOUS_MEMBER']);

async function candidatesFor(groupId: string): Promise<MemberCandidate[]> {
  const [members, legacy] = await Promise.all([
    prisma.groupMember.findMany({ where: { groupId }, include: { user: { select: { id: true, fullName: true, phoneNumber: true } } } }),
    prisma.legacyMember.findMany({ where: { groupId, mergedIntoUserId: null, mergedIntoLegacyId: null } }),
  ]);
  return [
    ...members.map((m) => ({ id: m.user.id, kind: 'USER' as const, name: m.user.fullName, phone: m.user.phoneNumber })),
    ...legacy.map((l) => ({ id: l.id, kind: 'LEGACY' as const, name: l.name, phone: l.phone })),
  ];
}

const KIND_TO_TYPE: Record<HistoricalKind, RecordType> = { CONTRIBUTION: 'CONTRIBUTIONS', PAYOUT: 'PAYOUTS', ARREARS: 'ARREARS', OPENING: 'OPENING_POSITION' };
export const TYPE_TO_KIND: Record<Exclude<RecordType, 'MEMBERS'>, HistoricalKind> = { CONTRIBUTIONS: 'CONTRIBUTION', PAYOUTS: 'PAYOUT', ARREARS: 'ARREARS', OPENING_POSITION: 'OPENING' };

async function existingKeys(groupId: string, recordType: RecordType): Promise<Set<string>> {
  if (recordType === 'MEMBERS') return new Set();
  const kind = TYPE_TO_KIND[recordType];
  const rows = await prisma.historicalLedgerEntry.findMany({ where: { groupId, kind, supersededById: null, redacted: false } });
  return new Set(rows.map((r) => dupKey(KIND_TO_TYPE[r.kind], { name: r.memberName, date: r.date.toISOString().slice(0, 10), amountKobo: r.amountKobo.toString(), cycleLabel: r.cycleLabel })));
}

export interface RawRowInput { fields: Record<string, unknown>; confidence?: Record<string, number>; rawText?: string; box?: unknown; pageNumber?: number }

/** Recomputes every row's issues from what was read/typed: row-level problems, whole-batch problems, and who it is. */
export async function refreshBatchIssues(batchId: string) {
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  const group = await loadGroup(batch.groupId);
  const rows = await prisma.stagedRow.findMany({ where: { batchId }, orderBy: { id: 'asc' } });
  const cands = await candidatesFor(batch.groupId);
  const keys = await existingKeys(batch.groupId, batch.recordType);
  const parsed = rows.map((r) => parseRow(batch.recordType, r.rawFields as Record<string, unknown>, { country: group.country }, (r.confidence as Record<string, number>) ?? {}));
  // Rows the reviewer has rejected do not count as duplicates of the ones they kept.
  const live = rows.map((r, i) => (r.status === 'REJECTED' ? null : parsed[i].parsed));
  const liveIdx = live.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const batchIssues = batchChecks(batch.recordType, liveIdx.map((i) => live[i]!), keys);
  const out: StagedRow[] = [];
  for (const [i, r] of rows.entries()) {
    const extra = r.status === 'REJECTED' ? [] : batchIssues[liveIdx.indexOf(i)] ?? [];
    // Who is this? A choice the reviewer already made is kept; otherwise match by phone, then by name.
    let matchedUserId = r.matchedUserId, matchedLegacyId = r.matchedLegacyId, matchScore = r.matchScore;
    const memberIssues: string[] = [];
    if (!matchedUserId && !matchedLegacyId) {
      const m = matchMember(parsed[i].parsed.name, parsed[i].parsed.phone, cands);
      if (m.status === 'MATCHED' && m.candidate) { matchScore = m.score; if (m.candidate.kind === 'USER') matchedUserId = m.candidate.id; else matchedLegacyId = m.candidate.id; }
      else if (m.status === 'AMBIGUOUS') { memberIssues.push('AMBIGUOUS_MEMBER'); matchScore = m.score; }
      else memberIssues.push('UNMATCHED_MEMBER');
    }
    const issues = [...new Set([...parsed[i].issues, ...extra, ...memberIssues])];
    out.push(await prisma.stagedRow.update({ where: { id: r.id }, data: { parsedJson: parsed[i].parsed as unknown as Prisma.InputJsonValue, issues, matchedUserId: matchedUserId ?? null, matchedLegacyId: matchedLegacyId ?? null, matchScore: matchScore ?? null } }));
  }
  return out;
}

async function stage(batch: ImportBatch, rows: RawRowInput[]) {
  if (rows.length > 5000) throw new HttpError(413, 'Please import at most 5,000 rows at a time');
  await prisma.stagedRow.createMany({
    data: rows.map((r) => ({
      batchId: batch.id, pageNumber: r.pageNumber ?? null, rawText: r.rawText ?? null, ...(r.box ? { box: r.box as Prisma.InputJsonValue } : {}), rawFields: r.fields as Prisma.InputJsonValue,
      parsedJson: {} as Prisma.InputJsonValue, confidence: (r.confidence ?? {}) as Prisma.InputJsonValue, issues: [], status: 'SUGGESTED' as const, reviewedById: null, matchedUserId: null, matchedLegacyId: null, matchScore: null, committedEntryId: null,
    })),
  });
  await prisma.importBatch.update({ where: { id: batch.id }, data: { rowCount: { increment: rows.length } } });
  return refreshBatchIssues(batch.id);
}

async function newBatch(user: Actor, groupId: string, sourceId: string, recordType: RecordType, status: ImportBatch['status']) {
  return prisma.importBatch.create({ data: { groupId, sourceId, recordType, status, createdById: user.id, approvedById: null, boardSignoffById: null, ocrProvider: null } });
}

/** Scans and PDFs: a batch that waits for OCR. */
export async function createScanBatch(user: Actor, input: { sourceId: string; recordType: RecordType }) {
  const source = await prisma.recordSource.findUnique({ where: { id: input.sourceId } });
  if (!source) throw new HttpError(404, 'Upload not found');
  await assertManager(user, source.groupId);
  if (source.kind !== 'SCAN' && source.kind !== 'PDF') throw new HttpError(400, 'Only scans and PDFs are read by OCR');
  const batch = await newBatch(user, source.groupId, source.id, input.recordType, 'OCR_PENDING');
  await audit(user.id, 'IMPORT_BATCH_CREATED', 'ImportBatch', batch.id, { recordType: input.recordType, kind: source.kind });
  return batch;
}

/** The wizard's first step: the column headings, a few sample rows, and a guessed mapping to start from. */
export async function spreadsheetPreview(user: Actor, sourceId: string, recordType: RecordType) {
  const source = await prisma.recordSource.findUnique({ where: { id: sourceId }, include: { pages: true } });
  if (!source || source.kind !== 'SPREADSHEET') throw new HttpError(404, 'Spreadsheet not found');
  await assertManager(user, source.groupId);
  const table = await readTable(source.pages[0]);
  return { header: table[0] ?? [], sample: table.slice(1, 6), rows: Math.max(0, table.length - 1), guessedMapping: guessMapping(table[0] ?? [], recordType) };
}

async function readTable(page: { vaultKey: string; mime: string }): Promise<string[][]> {
  const buf = await vaultGet(page.vaultKey);
  if (page.mime.includes('spreadsheetml') || page.mime === 'application/vnd.ms-excel') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => { rows.push((row.values as unknown[]).slice(1).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v && typeof v === 'object' && 'text' in (v as object) ? String((v as { text: unknown }).text) : v === null || v === undefined ? '' : String(v)))); });
    return rows;
  }
  return parseCsv(buf.toString('utf8'));
}

export async function createSpreadsheetBatch(user: Actor, input: { sourceId: string; recordType: RecordType; mapping: Record<string, string> }) {
  const source = await prisma.recordSource.findUnique({ where: { id: input.sourceId }, include: { pages: true } });
  if (!source || source.kind !== 'SPREADSHEET') throw new HttpError(404, 'Spreadsheet not found');
  await assertManager(user, source.groupId);
  let mapped: Record<string, string>[];
  try { mapped = applyMapping(await readTable(source.pages[0]), input.mapping); } catch (e) { throw new HttpError(400, (e as Error).message); }
  const batch = await newBatch(user, source.groupId, source.id, input.recordType, 'IN_REVIEW');
  await stage(batch, mapped.map((fields) => ({ fields })));
  await audit(user.id, 'IMPORT_BATCH_CREATED', 'ImportBatch', batch.id, { recordType: input.recordType, kind: 'SPREADSHEET', rows: mapped.length });
  return prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
}

/** Typed entry (and pasted tables). No file, so the "original" is the exact rows as submitted, hashed. A DRAFT can be replaced until it is sent for review. */
export async function createTypedBatch(user: Actor, input: { groupId: string; recordType: RecordType; rows: Record<string, unknown>[]; assistedById?: string; draft?: boolean }) {
  const group = await assertManager(user, input.groupId);
  await assertPrivacyConfirmed(group.id);
  if (!input.rows.length) throw new HttpError(400, 'Add at least one row');
  const body = JSON.stringify(input.rows);
  const source = await prisma.recordSource.create({
    data: { groupId: group.id, uploadedById: user.id, kind: 'TYPED', originalSha256: sha256(body), pageCount: 0, sizeBytes: BigInt(body.length), language: 'en', assistedById: input.assistedById ?? null },
  });
  const batch = await newBatch(user, group.id, source.id, input.recordType, input.draft ? 'DRAFT' : 'IN_REVIEW');
  await stage(batch, input.rows.map((fields) => ({ fields })));
  await audit(user.id, 'IMPORT_BATCH_CREATED', 'ImportBatch', batch.id, { recordType: input.recordType, kind: 'TYPED', rows: input.rows.length, assistedById: input.assistedById ?? null });
  return prisma.importBatch.findUniqueOrThrow({ where: { id: batch.id } });
}

/** Autosave for a typed draft: replaces the unreviewed rows. Only while it is still a DRAFT. */
export async function replaceDraftRows(user: Actor, batchId: string, rows: Record<string, unknown>[]) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, 'Import not found');
  await assertManager(user, batch.groupId);
  if (batch.status !== 'DRAFT') throw new HttpError(409, 'Only a draft can be replaced');
  await prisma.stagedRow.deleteMany({ where: { batchId } });
  await prisma.importBatch.update({ where: { id: batchId }, data: { rowCount: 0 } });
  await stage(batch, rows.map((fields) => ({ fields })));
  return prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
}

export async function submitDraft(user: Actor, batchId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, 'Import not found');
  await assertManager(user, batch.groupId);
  const done = await prisma.importBatch.updateMany({ where: { id: batchId, status: 'DRAFT' }, data: { status: 'IN_REVIEW' } });
  if (done.count === 0) throw new HttpError(409, 'This import is not a draft');
  return prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
}

/**
 * Reads the scanned pages. This only creates SUGGESTIONS (status SUGGESTED): nothing becomes a record without a person
 * accepting each row. Over the monthly page quota, new reading pauses; everything else keeps working.
 */
export async function runOcr(user: Actor, batchId: string, now = new Date()) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, 'Import not found');
  const group = await assertManager(user, batch.groupId);
  const claimed = await prisma.importBatch.updateMany({ where: { id: batchId, status: 'OCR_PENDING' }, data: { ocrProvider: 'running' } });
  if (claimed.count === 0) throw new HttpError(409, 'This import has already been read');
  const release = (name: string | null) => prisma.importBatch.update({ where: { id: batchId }, data: { ocrProvider: name } });
  try {
    const source = await prisma.recordSource.findUniqueOrThrow({ where: { id: batch.sourceId }, include: { pages: { orderBy: { pageNumber: 'asc' } } } });
    const usage = await usageFor(group.adminId, now);
    if (usage.ocrPagesThisMonth + source.pageCount > usage.ocrQuotaPerMonth) {
      throw new HttpError(429, `OCR_QUOTA: this would use more than your ${usage.ocrQuotaPerMonth} pages a month for reading scans. You can type these pages in, or wait until next month. Nothing else is affected.`);
    }
    const provider = getOcrProvider();
    const all: RawRowInput[] = [];
    const failed: number[] = [];
    for (const page of source.pages) {
      try {
        const res = await provider.extract({ data: await vaultGet(page.vaultKey), mime: page.mime, recordType: batch.recordType, language: source.language });
        for (const r of res.rows) all.push({ fields: r.fields, confidence: r.confidence, rawText: r.rawText, box: r.box, pageNumber: page.mime === 'application/pdf' ? r.page ?? 1 : page.pageNumber });
      } catch (e) {
        failed.push(page.pageNumber);
        console.error('[records] OCR page failed', page.pageNumber, (e as Error).message);
      }
    }
    if (failed.length === source.pages.length) throw new HttpError(502, 'None of the pages could be read. Please try again, or type them in.');
    await prisma.ocrUsage.upsert({ where: { groupId_month: { groupId: group.id, month: monthKey(now) } }, create: { groupId: group.id, month: monthKey(now), pages: source.pageCount }, update: { pages: { increment: source.pageCount } } });
    await prisma.importBatch.update({ where: { id: batchId }, data: { status: 'IN_REVIEW', ocrProvider: provider.name } });
    await stage(batch, all);
    await audit(user.id, 'IMPORT_OCR_RUN', 'ImportBatch', batchId, { rows: all.length, failedPages: failed, provider: provider.name });
    return { rows: all.length, failedPages: failed, provider: provider.name };
  } catch (e) {
    await release(null);
    throw e;
  }
}

// ── Review: a person accepts, edits or rejects EVERY row ────────────────────

export interface RowEdit {
  fields?: Record<string, unknown>;
  status?: 'ACCEPTED' | 'REJECTED' | 'EDITED';
  /** Chosen when the name matched more than one member: exactly one of these. */
  matchUserId?: string;
  matchLegacyId?: string;
  /** Explicitly "this is a new person" after an ambiguous match. */
  asNewPerson?: boolean;
}

export async function editRow(user: Actor, rowId: string, edit: RowEdit) {
  const row = await prisma.stagedRow.findUnique({ where: { id: rowId } });
  if (!row) throw new HttpError(404, 'Row not found');
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: row.batchId } });
  await assertManager(user, batch.groupId);
  if (batch.status !== 'IN_REVIEW' && batch.status !== 'DRAFT') throw new HttpError(409, 'This import can no longer be edited');

  const data: Prisma.StagedRowUpdateInput = { reviewedAt: new Date(), reviewedById: user.id };
  if (edit.fields) {
    data.rawFields = { ...(row.rawFields as object), ...edit.fields } as Prisma.InputJsonValue;
    data.confidence = {} as Prisma.InputJsonValue; // a person has looked at it: the reader's doubts no longer apply
    data.status = 'EDITED';
    data.matchedUserId = null; data.matchedLegacyId = null; data.matchScore = null;
  }
  if (edit.matchUserId || edit.matchLegacyId) {
    data.matchedUserId = edit.matchUserId ?? null; data.matchedLegacyId = edit.matchLegacyId ?? null; data.matchScore = 1;
  }
  await prisma.stagedRow.update({ where: { id: rowId }, data });
  if (edit.fields || edit.matchUserId || edit.matchLegacyId || edit.asNewPerson) await refreshBatchIssues(batch.id);

  let current = await prisma.stagedRow.findUniqueOrThrow({ where: { id: rowId } });
  if (edit.asNewPerson) current = await prisma.stagedRow.update({ where: { id: rowId }, data: { issues: current.issues.filter((i) => i !== 'AMBIGUOUS_MEMBER').concat('UNMATCHED_MEMBER') } });
  if (edit.status) {
    if (edit.status === 'ACCEPTED') {
      const fatal = current.issues.filter((i) => FATAL_ISSUES.has(i));
      if (fatal.length) throw new HttpError(422, `Fix this first: ${fatal.join(', ')}`);
    }
    current = await prisma.stagedRow.update({ where: { id: rowId }, data: { status: edit.status, reviewedAt: new Date(), reviewedById: user.id } });
    // Rejecting one of two duplicates frees the other, so everything is re-checked.
    await refreshBatchIssues(batch.id);
    current = await prisma.stagedRow.findUniqueOrThrow({ where: { id: rowId } });
  }
  return current;
}

export async function listRows(user: Actor, batchId: string, filter?: { status?: StagedRow['status']; flagged?: boolean }) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, 'Import not found');
  await assertManager(user, batch.groupId);
  const rows = await prisma.stagedRow.findMany({ where: { batchId, ...(filter?.status ? { status: filter.status } : {}) }, orderBy: { id: 'asc' } });
  return rows.filter((r) => !filter?.flagged || r.issues.length > 0);
}

export async function approveBatch(user: Actor, batchId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, 'Import not found');
  await assertManager(user, batch.groupId);
  if (batch.status !== 'IN_REVIEW') throw new HttpError(409, 'Only an import under review can be approved');
  const rows = await prisma.stagedRow.findMany({ where: { batchId } });
  // The core safeguard: nothing is approved until a person has decided on EVERY row.
  const undecided = rows.filter((r) => r.status === 'SUGGESTED').length;
  if (undecided > 0) throw new HttpError(409, `${undecided} row${undecided > 1 ? 's' : ''} still need${undecided > 1 ? '' : 's'} a decision. Accept, edit or reject every row before approving.`);
  const accepted = rows.filter((r) => r.status === 'ACCEPTED' || r.status === 'EDITED');
  if (!accepted.length) throw new HttpError(409, 'There are no accepted rows to import');
  const bad = accepted.filter((r) => r.issues.some((i) => FATAL_ISSUES.has(i)));
  if (bad.length) throw new HttpError(409, `${bad.length} accepted row(s) still have problems that must be fixed.`);
  const done = await prisma.importBatch.updateMany({ where: { id: batchId, status: 'IN_REVIEW' }, data: { status: 'APPROVED', approvedById: user.id, approvedAt: new Date() } });
  if (done.count === 0) throw new HttpError(409, 'This import was already handled');
  await audit(user.id, 'IMPORT_BATCH_APPROVED', 'ImportBatch', batchId, { accepted: accepted.length, rejected: rows.length - accepted.length });
  return prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
}

export async function rejectBatch(user: Actor, batchId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, 'Import not found');
  await assertManager(user, batch.groupId);
  const done = await prisma.importBatch.updateMany({ where: { id: batchId, status: { in: ['DRAFT', 'OCR_PENDING', 'IN_REVIEW', 'APPROVED'] } }, data: { status: 'REJECTED' } });
  if (done.count === 0) throw new HttpError(409, 'This import cannot be rejected now');
  await audit(user.id, 'IMPORT_BATCH_REJECTED', 'ImportBatch', batchId);
}

/** A Trust Board member (not the uploader, not the collector) signs off an opening position before it is committed. */
export async function boardSignoff(user: Actor, batchId: string) {
  if (!isBoard(user)) throw new HttpError(403, 'Only a Trust Board member can sign this off');
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, 'Import not found');
  const group = await loadGroup(batch.groupId);
  if (batch.recordType !== 'OPENING_POSITION') throw new HttpError(409, 'Only opening positions need a board sign-off');
  if (batch.status !== 'APPROVED') throw new HttpError(409, 'The collector must approve it first');
  if (user.id === batch.createdById || user.id === group.adminId) throw new HttpError(403, 'The board sign-off must come from someone other than the person who prepared it and the collector');
  const done = await prisma.importBatch.updateMany({ where: { id: batchId, status: 'APPROVED', boardSignoffById: null }, data: { boardSignoffById: user.id, boardSignoffAt: new Date() } });
  if (done.count === 0) throw new HttpError(409, 'Already signed off');
  await audit(user.id, 'IMPORT_BOARD_SIGNOFF', 'ImportBatch', batchId);
}

// ── Commit: only now do records exist, and they are HISTORICAL ──────────────

function summaryFor(kind: HistoricalKind, amountKobo: bigint, cycle: string | null) {
  const amt = `₦${koboToNaira(amountKobo)}`;
  return kind === 'PAYOUT' ? `received ${amt}${cycle ? ` (${cycle})` : ''}` : kind === 'ARREARS' ? `owed ${amt}` : kind === 'OPENING' ? `had paid ${amt} so far` : `paid ${amt}${cycle ? ` (${cycle})` : ''}`;
}

export async function commitBatch(user: Actor, batchId: string) {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new HttpError(404, 'Import not found');
  const group = await assertManager(user, batch.groupId);
  if (batch.status !== 'APPROVED') throw new HttpError(409, 'Only an approved import can be committed');
  if (batch.recordType === 'OPENING_POSITION' && !batch.boardSignoffById) throw new HttpError(409, 'An opening position needs a Trust Board sign-off before it is committed');

  const rows = (await prisma.stagedRow.findMany({ where: { batchId, status: { in: ['ACCEPTED', 'EDITED'] } }, orderBy: { id: 'asc' } }));
  const cands = await candidatesFor(group.id);
  const notify = new Map<string, { phone: string; lang: Lang; group: string; summaries: string[] }>();

  const result = await prisma.$transaction(async (db) => {
    // Claim first: committing twice can never duplicate a record.
    const claimed = await db.importBatch.updateMany({ where: { id: batchId, status: 'APPROVED' }, data: { status: 'COMMITTED', committedAt: new Date() } });
    if (claimed.count === 0) throw new HttpError(409, 'This import was already committed');
    const created: Record<string, string> = {}; // person key → LegacyMember id created in this commit
    let entries = 0, newPeople = 0;
    for (const r of rows) {
      const p = r.parsedJson as unknown as ParsedRow;
      let userId = r.matchedUserId, legacyId = r.matchedLegacyId;
      if (!userId && !legacyId) {
        const key = p.phone ?? foldName(p.name);
        legacyId = created[key] ?? null;
        if (!legacyId) {
          const existing = cands.find((c) => c.kind === 'LEGACY' && ((p.phone && c.phone === p.phone) || foldName(c.name) === foldName(p.name)));
          legacyId = existing?.id ?? null;
        }
        if (!legacyId) {
          const l = await db.legacyMember.create({ data: { groupId: group.id, name: p.name, phone: p.phone ?? null, joinDate: p.joinDate ? new Date(p.joinDate) : null, claimedByUserId: null, mergedIntoUserId: null, mergedIntoLegacyId: null } });
          legacyId = l.id; created[key] = l.id; newPeople++;
        }
      }
      if (batch.recordType === 'MEMBERS') { await db.stagedRow.update({ where: { id: r.id }, data: { committedEntryId: null } }); continue; }
      const kind = TYPE_TO_KIND[batch.recordType];
      const entry = await db.historicalLedgerEntry.create({
        data: {
          groupId: group.id, userId: userId ?? null, legacyMemberId: userId ? null : legacyId, memberName: p.name, date: new Date(p.date ?? p.asOf ?? new Date().toISOString()), amountKobo: BigInt(p.amountKobo!), kind,
          cycleLabel: p.cycleLabel ?? null, sourceId: batch.sourceId, batchId, verificationStatus: 'IMPORTED_UNVERIFIED', verifiedAt: null, disputeNote: null, supersededById: null, redacted: false,
        },
      });
      await db.stagedRow.update({ where: { id: r.id }, data: { committedEntryId: entry.id } });
      entries++;
      // Each person with a phone number is asked to confirm their own history.
      const person = userId ? cands.find((c) => c.kind === 'USER' && c.id === userId) : cands.find((c) => c.id === legacyId) ?? { phone: p.phone, id: legacyId! };
      const phone = person?.phone ?? p.phone;
      if (phone) {
        const key = phone;
        const cur = notify.get(key) ?? { phone, lang: 'EN' as Lang, group: group.name, summaries: [] };
        cur.summaries.push(summaryFor(kind, entry.amountKobo, entry.cycleLabel));
        notify.set(key, cur);
      }
    }
    return { entries, newPeople };
  }, { timeout: 120_000, maxWait: 10_000 });

  await audit(user.id, 'IMPORT_BATCH_COMMITTED', 'ImportBatch', batchId, result);
  // Ask people to confirm. Registered users get their own language.
  const langs = await prisma.user.findMany({ where: { phoneNumber: { in: [...notify.keys()] } }, select: { phoneNumber: true, preferredLanguage: true } });
  for (const n of notify.values()) {
    const lang = (langs.find((l) => l.phoneNumber === n.phone)?.preferredLanguage as Lang | undefined) ?? 'EN';
    const first = n.summaries.slice(0, 2).join(' and ') + (n.summaries.length > 2 ? ` and ${n.summaries.length - 2} more` : '');
    await safeSms(n.phone, t(lang, 'records.verify', { group: n.group, summary: first }));
  }
  return { ...result, asked: notify.size };
}

// ── Members confirm their own history ───────────────────────────────────────

/** Anyone signed in by phone who matches a legacy record can claim it: the phone one-time code is the proof. */
export async function claimLegacyMembers(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.phoneNumber) return [];
  const open = await prisma.legacyMember.findMany({ where: { phone: user.phoneNumber, claimedByUserId: null, mergedIntoUserId: null, mergedIntoLegacyId: null } });
  for (const l of open) {
    const done = await prisma.legacyMember.updateMany({ where: { id: l.id, claimedByUserId: null }, data: { claimedByUserId: userId, claimedAt: new Date() } });
    if (done.count > 0) await audit(userId, 'LEGACY_MEMBER_CLAIMED', 'LegacyMember', l.id, { groupId: l.groupId });
  }
  return prisma.legacyMember.findMany({ where: { claimedByUserId: userId } });
}

/** Everything that is "me": my user id, plus the legacy records I have claimed (and anything merged into them). */
export async function myIdentity(userId: string) {
  await claimLegacyMembers(userId);
  const legacy = await prisma.legacyMember.findMany({ where: { OR: [{ claimedByUserId: userId }, { mergedIntoUserId: userId }] } });
  const ids = legacy.map((l) => l.id);
  const merged = ids.length ? await prisma.legacyMember.findMany({ where: { mergedIntoLegacyId: { in: ids } } }) : [];
  return { userId, legacyIds: [...ids, ...merged.map((m) => m.id)] };
}

export async function myEntries(userId: string) {
  const me = await myIdentity(userId);
  return prisma.historicalLedgerEntry.findMany({
    where: { supersededById: null, OR: [{ userId }, ...(me.legacyIds.length ? [{ legacyMemberId: { in: me.legacyIds } }] : [])] },
    orderBy: { date: 'desc' },
  });
}

/** Confirm or dispute your OWN entry. A dispute never changes or removes it: it goes to the collector and the board, who correct it by superseding. */
export async function verifyEntry(user: Actor, entryId: string, input: { confirm: boolean; note?: string }) {
  const entry = await prisma.historicalLedgerEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new HttpError(404, 'Entry not found');
  const me = await myIdentity(user.id);
  const mine = entry.userId === user.id || (entry.legacyMemberId && me.legacyIds.includes(entry.legacyMemberId));
  if (!mine) throw new HttpError(403, 'You can only confirm or dispute your own record');
  if (entry.supersededById) throw new HttpError(409, 'This entry has been replaced by a corrected one');
  if (!input.confirm && (input.note ?? '').trim().length < 3) throw new HttpError(400, 'Tell us what is wrong');
  const done = await prisma.historicalLedgerEntry.updateMany({
    where: { id: entryId, verificationStatus: { in: ['IMPORTED_UNVERIFIED', 'DISPUTED'] }, supersededById: null },
    data: input.confirm ? { verificationStatus: 'MEMBER_VERIFIED', verifiedAt: new Date(), disputeNote: null } : { verificationStatus: 'DISPUTED', disputeNote: input.note!.trim() },
  });
  if (done.count === 0) throw new HttpError(409, 'This entry has already been confirmed');
  await audit(user.id, input.confirm ? 'HISTORY_CONFIRMED' : 'HISTORY_DISPUTED', 'HistoricalLedgerEntry', entryId, { note: input.note ?? null });
  if (!input.confirm) {
    const group = await loadGroup(entry.groupId);
    const watchers = await prisma.user.findMany({ where: { OR: [{ id: group.adminId }, { role: 'BOARD_MEMBER' }] } });
    for (const w of watchers) await safeSms(w.phoneNumber, `ÀJỌ: a member disputes an old record in "${group.name}" (₦${koboToNaira(entry.amountKobo)}): ${input.note!.trim().slice(0, 100)}. Please review it in the app.`);
  }
  return prisma.historicalLedgerEntry.findUniqueOrThrow({ where: { id: entryId } });
}

// ── Corrections, erasure and merging: always by adding, never by editing ────

async function supersede(entry: Awaited<ReturnType<typeof prisma.historicalLedgerEntry.findUniqueOrThrow>>, changes: Partial<{ amountKobo: bigint; date: Date; cycleLabel: string | null; memberName: string; userId: string | null; legacyMemberId: string | null; redacted: boolean }>) {
  if (entry.supersededById) throw new HttpError(409, 'This entry has already been replaced');
  const next = await prisma.historicalLedgerEntry.create({
    data: {
      groupId: entry.groupId, userId: changes.userId !== undefined ? changes.userId : entry.userId, legacyMemberId: changes.legacyMemberId !== undefined ? changes.legacyMemberId : entry.legacyMemberId,
      memberName: changes.memberName ?? entry.memberName, date: changes.date ?? entry.date, amountKobo: changes.amountKobo ?? entry.amountKobo, kind: entry.kind,
      cycleLabel: changes.cycleLabel !== undefined ? changes.cycleLabel : entry.cycleLabel, sourceId: entry.sourceId, batchId: entry.batchId,
      // A corrected entry must be confirmed again by the person it is about.
      verificationStatus: 'IMPORTED_UNVERIFIED', verifiedAt: null, disputeNote: null, supersededById: null, redacted: changes.redacted ?? entry.redacted,
    },
  });
  const claimed = await prisma.historicalLedgerEntry.updateMany({ where: { id: entry.id, supersededById: null }, data: { supersededById: next.id } });
  if (claimed.count === 0) throw new HttpError(409, 'This entry was replaced by someone else just now');
  return next;
}

export async function correctEntry(user: Actor, entryId: string, input: { amountKobo?: bigint; date?: Date; cycleLabel?: string | null; reason: string }) {
  const entry = await prisma.historicalLedgerEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new HttpError(404, 'Entry not found');
  await assertManager(user, entry.groupId);
  if (input.reason.trim().length < 5) throw new HttpError(400, 'Say why it is being corrected');
  if (input.amountKobo !== undefined && input.amountKobo <= 0n) throw new HttpError(400, 'The amount must be greater than zero');
  const next = await supersede(entry, { amountKobo: input.amountKobo, date: input.date, cycleLabel: input.cycleLabel });
  await audit(user.id, 'HISTORY_CORRECTED', 'HistoricalLedgerEntry', next.id, { replaces: entry.id, reason: input.reason, fromKobo: entry.amountKobo.toString(), toKobo: next.amountKobo.toString() });
  return next;
}

/**
 * A deletion request: the person's name and phone are removed everywhere they are stored, by superseding each of their
 * entries with an anonymous one. The amounts stay as an anonymous fact of the group's history. The audit trail is kept.
 */
export async function redactMember(user: Actor, input: { groupId: string; userId?: string; legacyMemberId?: string; reason: string }) {
  await assertManager(user, input.groupId);
  if (input.reason.trim().length < 5) throw new HttpError(400, 'Say why');
  if (!input.userId && !input.legacyMemberId) throw new HttpError(400, 'Choose the person');
  const where = { groupId: input.groupId, supersededById: null, ...(input.userId ? { userId: input.userId } : { legacyMemberId: input.legacyMemberId }) };
  const entries = await prisma.historicalLedgerEntry.findMany({ where });
  for (const e of entries) await supersede(e, { memberName: '[redacted]', userId: null, legacyMemberId: null, redacted: true });
  if (input.legacyMemberId) await prisma.legacyMember.update({ where: { id: input.legacyMemberId }, data: { name: '[redacted]', phone: null } });
  await audit(user.id, 'HISTORY_REDACTED', 'CommunityGroup', input.groupId, { userId: input.userId ?? null, legacyMemberId: input.legacyMemberId ?? null, entries: entries.length, reason: input.reason });
  return { redacted: entries.length };
}

/** Two records for one person: merged by a pointer, so no history is rewritten and a wrong merge can be undone. */
export async function mergeMembers(user: Actor, input: { groupId: string; fromLegacyId: string; intoUserId?: string; intoLegacyId?: string }) {
  await assertManager(user, input.groupId);
  if (!!input.intoUserId === !!input.intoLegacyId) throw new HttpError(400, 'Choose exactly one person to merge into');
  const from = await prisma.legacyMember.findUnique({ where: { id: input.fromLegacyId } });
  if (!from || from.groupId !== input.groupId) throw new HttpError(404, 'Record not found');
  if (input.intoLegacyId === from.id) throw new HttpError(400, 'Cannot merge a record into itself');
  if (input.intoLegacyId) {
    const to = await prisma.legacyMember.findUnique({ where: { id: input.intoLegacyId } });
    if (!to || to.groupId !== input.groupId || to.mergedIntoLegacyId || to.mergedIntoUserId) throw new HttpError(409, 'That record cannot be merged into');
  } else await assertGroupMember(input.groupId, input.intoUserId!);
  await prisma.legacyMember.update({ where: { id: from.id }, data: { mergedIntoUserId: input.intoUserId ?? null, mergedIntoLegacyId: input.intoLegacyId ?? null } });
  await audit(user.id, 'LEGACY_MEMBER_MERGED', 'LegacyMember', from.id, { intoUserId: input.intoUserId ?? null, intoLegacyId: input.intoLegacyId ?? null });
}

export async function splitMember(user: Actor, groupId: string, legacyId: string) {
  await assertManager(user, groupId);
  const l = await prisma.legacyMember.findUnique({ where: { id: legacyId } });
  if (!l || l.groupId !== groupId) throw new HttpError(404, 'Record not found');
  await prisma.legacyMember.update({ where: { id: legacyId }, data: { mergedIntoUserId: null, mergedIntoLegacyId: null } });
  await audit(user.id, 'LEGACY_MEMBER_SPLIT', 'LegacyMember', legacyId);
}
