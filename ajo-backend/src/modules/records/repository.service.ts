import archiver from 'archiver';
import fs from 'fs/promises';
import path from 'path';
import PDFDocument from 'pdfkit';
import { DocFolder, DocVisibility, HistoricalLedgerEntry, RepositoryDocument } from '@prisma/client';

import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { koboToNaira } from '../../lib/kobo';
import { publicBaseUrl } from '../../services/storage.service';
import { toCsv } from '../../services/ledger.service';
import { getOcrProvider } from './ocr.provider';
import { assertManager, assertMemberOrManager, createFileSource, isBoard, isManager, loadGroup, logAccess, myIdentity, usageFor, type UploadedFile } from './records.service';
import { sha256, signFileToken, VAULT_ROOT, vaultGet, verifyFileToken } from './vault';

type Actor = { id: string; role: string };

// ── Masking (data minimisation for exports) ─────────────────────────────────

export const maskName = (n: string) => (n === '[redacted]' ? n : n.split(/\s+/).filter(Boolean).map((p) => `${p[0].toUpperCase()}.`).join(' '));
export const maskPhone = (p?: string | null) => (p ? `${p.slice(0, 4)}•••••${p.slice(-3)}` : '');

// ── Documents ───────────────────────────────────────────────────────────────

async function canSee(user: Actor, group: { id: string; adminId: string }, vis: DocVisibility): Promise<boolean> {
  if (isManager(user, group)) return true;
  if (vis === 'ADMIN_ONLY') return false;
  if (user.role === 'BOARD_MEMBER') return true;
  if (vis === 'BOARD') return false;
  return (await prisma.groupMember.count({ where: { groupId: group.id, userId: user.id } })) > 0;
}

export async function uploadDocument(user: Actor, input: { groupId: string; folder: DocFolder; title: string; tags?: string[]; visibility?: DocVisibility; retention?: boolean; file: UploadedFile; readText?: boolean; language?: string; assistedById?: string }) {
  const source = await createFileSource(user, { groupId: input.groupId, kind: 'DOCUMENT', files: [input.file], language: input.language, assistedById: input.assistedById });
  let ocrText: string | null = null;
  if (input.readText && source.pages[0] && /^image\/|application\/pdf/.test(source.pages[0].mime)) {
    try {
      const group = await loadGroup(input.groupId);
      const u = await usageFor(group.adminId);
      // Over the monthly quota, searchable text is skipped; the document itself is still saved.
      if (u.ocrPagesThisMonth + source.pageCount <= u.ocrQuotaPerMonth) {
        ocrText = (await getOcrProvider().extract({ data: await vaultGet(source.pages[0].vaultKey), mime: source.pages[0].mime, recordType: 'MEMBERS', language: input.language ?? 'en' })).fullText;
        const month = new Date().toISOString().slice(0, 7);
        await prisma.ocrUsage.upsert({ where: { groupId_month: { groupId: input.groupId, month } }, create: { groupId: input.groupId, month, pages: source.pageCount }, update: { pages: { increment: source.pageCount } } });
      }
    } catch (e) {
      console.error('[records] document text reading skipped:', (e as Error).message);
    }
  } else if (input.file.mime === 'text/plain') ocrText = input.file.buffer.toString('utf8').slice(0, 200_000);
  const doc = await prisma.repositoryDocument.create({
    data: { groupId: input.groupId, folder: input.folder, title: input.title.trim(), tags: (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean), ocrText, visibility: input.visibility ?? 'ADMIN_ONLY', sourceId: source.id, retention: input.retention ?? false, uploadedById: user.id },
  });
  await audit(user.id, 'RECORD_DOCUMENT_ADDED', 'RepositoryDocument', doc.id, { folder: input.folder });
  return doc;
}

export async function listDocuments(user: Actor, input: { groupId: string; folder?: DocFolder; tag?: string }) {
  const group = await assertMemberOrManager(user, input.groupId);
  const docs = await prisma.repositoryDocument.findMany({ where: { groupId: input.groupId, ...(input.folder ? { folder: input.folder } : {}), ...(input.tag ? { tags: { has: input.tag.toLowerCase() } } : {}) }, orderBy: { createdAt: 'desc' } });
  const visible: RepositoryDocument[] = [];
  for (const d of docs) if (await canSee(user, group, d.visibility)) visible.push(d);
  return visible.map(({ ocrText, ...d }) => ({ ...d, hasText: !!ocrText }));
}

export async function getDocument(user: Actor, id: string) {
  const doc = await prisma.repositoryDocument.findUnique({ where: { id } });
  if (!doc) throw new HttpError(404, 'Document not found');
  const group = await loadGroup(doc.groupId);
  if (!(await canSee(user, group, doc.visibility))) throw new HttpError(403, 'You do not have access to this document');
  const pages = await prisma.recordPage.findMany({ where: { sourceId: doc.sourceId }, orderBy: { pageNumber: 'asc' } });
  await logAccess(user.id, doc.groupId, 'VIEW', 'RepositoryDocument', id);
  const { ocrText, ...meta } = doc;
  return { ...meta, pages: pages.map((p) => ({ pageNumber: p.pageNumber, mime: p.mime, url: `${publicBaseUrl()}/api/records/files/${signFileToken({ pageId: p.id, groupId: doc.groupId, uid: user.id })}` })) };
}

export async function updateDocument(user: Actor, id: string, input: { title?: string; tags?: string[]; folder?: DocFolder; visibility?: DocVisibility; retention?: boolean }) {
  const doc = await prisma.repositoryDocument.findUnique({ where: { id } });
  if (!doc) throw new HttpError(404, 'Document not found');
  await assertManager(user, doc.groupId);
  return prisma.repositoryDocument.update({ where: { id }, data: { title: input.title?.trim(), tags: input.tags?.map((t) => t.trim().toLowerCase()).filter(Boolean), folder: input.folder, visibility: input.visibility, retention: input.retention } });
}

/** Removes the listing. A document under retention cannot be removed, and the original file stays in the vault either way. */
export async function removeDocument(user: Actor, id: string) {
  const doc = await prisma.repositoryDocument.findUnique({ where: { id } });
  if (!doc) throw new HttpError(404, 'Document not found');
  await assertManager(user, doc.groupId);
  if (doc.retention) throw new HttpError(409, 'This document is under retention and cannot be removed');
  await prisma.repositoryDocument.delete({ where: { id } });
  await audit(user.id, 'RECORD_DOCUMENT_REMOVED', 'RepositoryDocument', id);
}

/** The streamed file for a signed link. The link was issued to someone who passed the access check, and it expires. */
export async function readSignedFile(token: string) {
  const claim = verifyFileToken(token);
  const page = await prisma.recordPage.findUnique({ where: { id: claim.pageId } });
  if (!page) throw new HttpError(404, 'File not found');
  const buffer = await vaultGet(page.vaultKey);
  await logAccess(claim.uid, claim.groupId, 'DOWNLOAD', 'RecordPage', page.id);
  return { buffer, mime: page.mime };
}

/** Originals of imports (not repository documents) are for the collector only. */
export async function issueSourceFileUrls(user: Actor, sourceId: string) {
  const source = await prisma.recordSource.findUnique({ where: { id: sourceId }, include: { pages: { orderBy: { pageNumber: 'asc' } } } });
  if (!source) throw new HttpError(404, 'Upload not found');
  await assertManager(user, source.groupId);
  await logAccess(user.id, source.groupId, 'VIEW', 'RecordSource', sourceId);
  return source.pages.map((p) => ({ pageNumber: p.pageNumber, mime: p.mime, url: `${publicBaseUrl()}/api/records/files/${signFileToken({ pageId: p.id, groupId: source.groupId, uid: user.id })}` }));
}

// ── Search ──────────────────────────────────────────────────────────────────

export async function searchRecords(user: Actor, input: { groupId: string; q: string }) {
  const q = input.q.trim();
  if (q.length < 2) throw new HttpError(400, 'Type at least two letters');
  const group = await assertMemberOrManager(user, input.groupId);
  const docs = await prisma.repositoryDocument.findMany({
    where: { groupId: input.groupId, OR: [{ title: { contains: q, mode: 'insensitive' } }, { ocrText: { contains: q, mode: 'insensitive' } }, { tags: { has: q.toLowerCase() } }] }, take: 50,
  });
  const documents = [];
  for (const d of docs) if (await canSee(user, group, d.visibility)) {
    const at = d.ocrText ? d.ocrText.toLowerCase().indexOf(q.toLowerCase()) : -1;
    documents.push({ id: d.id, title: d.title, folder: d.folder, tags: d.tags, snippet: at >= 0 ? d.ocrText!.slice(Math.max(0, at - 40), at + 80).replace(/\s+/g, ' ') : null });
  }
  const seesAll = isManager(user, group) || isBoard(user);
  const me = seesAll ? null : await myIdentity(user.id);
  const entries = await prisma.historicalLedgerEntry.findMany({
    where: { groupId: input.groupId, supersededById: null, OR: [{ memberName: { contains: q, mode: 'insensitive' } }, { cycleLabel: { contains: q, mode: 'insensitive' } }], ...(seesAll ? {} : { OR: [{ userId: user.id }, { legacyMemberId: { in: me!.legacyIds } }] }) },
    orderBy: { date: 'desc' }, take: 100,
  });
  await logAccess(user.id, input.groupId, 'SEARCH', 'CommunityGroup', input.groupId);
  return { documents, entries: entries.map(presentEntry) };
}

// ── Timeline: old and live history side by side, clearly labelled ───────────

export type Origin = 'IMPORTED_VERIFIED' | 'IMPORTED_UNVERIFIED' | 'IMPORTED_DISPUTED' | 'LIVE';
export const originOf = (e: Pick<HistoricalLedgerEntry, 'verificationStatus'>): Origin => (e.verificationStatus === 'MEMBER_VERIFIED' ? 'IMPORTED_VERIFIED' : e.verificationStatus === 'DISPUTED' ? 'IMPORTED_DISPUTED' : 'IMPORTED_UNVERIFIED');
export const ORIGIN_LABEL: Record<Origin, string> = { IMPORTED_VERIFIED: 'Imported · verified', IMPORTED_UNVERIFIED: 'Imported · unverified', IMPORTED_DISPUTED: 'Imported · disputed', LIVE: 'Live' };

const presentEntry = (e: HistoricalLedgerEntry) => ({
  id: e.id, date: e.date.toISOString().slice(0, 10), kind: e.kind, memberName: e.memberName, amount: koboToNaira(e.amountKobo), cycleLabel: e.cycleLabel, origin: originOf(e), label: ORIGIN_LABEL[originOf(e)], disputeNote: e.disputeNote,
});

export async function timeline(user: Actor, groupId: string) {
  const group = await assertMemberOrManager(user, groupId);
  const seesAll = isManager(user, group) || isBoard(user);
  const me = seesAll ? null : await myIdentity(user.id);
  const mine = seesAll ? {} : { OR: [{ userId: user.id }, ...(me!.legacyIds.length ? [{ legacyMemberId: { in: me!.legacyIds } }] : [])] };
  const [hist, live] = await Promise.all([
    prisma.historicalLedgerEntry.findMany({ where: { groupId, supersededById: null, ...mine }, orderBy: { date: 'desc' }, take: 1000 }),
    prisma.fundsEntry.findMany({ where: { groupId, status: 'CONFIRMED', type: { in: ['CONTRIBUTION', 'RELEASE', 'REFUND'] }, ...(seesAll ? {} : { OR: [{ payerUserId: user.id }, { counterpartyUserId: user.id }] }) }, orderBy: { createdAt: 'desc' }, take: 1000 }),
  ]);
  const names = await prisma.user.findMany({ where: { id: { in: [...new Set(live.map((l) => l.payerUserId))] } }, select: { id: true, fullName: true } });
  const items = [
    ...hist.map(presentEntry),
    ...live.map((l) => ({ id: l.id, date: l.createdAt.toISOString().slice(0, 10), kind: l.type, memberName: names.find((n) => n.id === l.payerUserId)?.fullName ?? '—', amount: koboToNaira(l.amountKobo), cycleLabel: null as string | null, origin: 'LIVE' as Origin, label: ORIGIN_LABEL.LIVE, disputeNote: null as string | null })),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { scope: seesAll ? 'GROUP' : 'MINE', items };
}

// ── Dashboard ───────────────────────────────────────────────────────────────

/** How complete the digital record book is: what is committed, what members have confirmed, and whether the key documents are filed. */
export function completenessScore(i: { stagedRows: number; committedRows: number; withPerson: number; verified: number; foldersFilled: number }): number {
  const committed = i.stagedRows ? Math.min(1, i.committedRows / i.stagedRows) : 0;
  const verified = i.withPerson ? i.verified / i.withPerson : 0;
  const docs = Math.min(1, i.foldersFilled / 3); // constitution, minutes, register
  return Math.round(100 * (0.4 * committed + 0.4 * verified + 0.2 * docs));
}

export async function dashboard(user: Actor, groupId: string, now = new Date()) {
  const group = await assertManager(user, groupId);
  const [sources, batches, entries, docs, legacy] = await Promise.all([
    prisma.recordSource.findMany({ where: { groupId }, select: { kind: true, pageCount: true } }),
    prisma.importBatch.findMany({ where: { groupId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.historicalLedgerEntry.findMany({ where: { groupId, supersededById: null, redacted: false }, select: { verificationStatus: true, userId: true, legacyMemberId: true } }),
    prisma.repositoryDocument.findMany({ where: { groupId }, select: { folder: true } }),
    prisma.legacyMember.count({ where: { groupId, claimedByUserId: null, mergedIntoUserId: null, mergedIntoLegacyId: null } }),
  ]);
  const batchIds = batches.map((b) => b.id);
  const rows = batchIds.length ? await prisma.stagedRow.findMany({ where: { batchId: { in: batchIds } }, select: { status: true, issues: true, batchId: true } }) : [];
  const committedBatches = new Set(batches.filter((b) => b.status === 'COMMITTED').map((b) => b.id));
  const withPerson = entries.filter((e) => e.userId || e.legacyMemberId);
  const verified = withPerson.filter((e) => e.verificationStatus === 'MEMBER_VERIFIED').length;
  const stagedRows = rows.filter((r) => r.status !== 'REJECTED').length;
  const committedRows = rows.filter((r) => committedBatches.has(r.batchId) && r.status !== 'REJECTED').length;
  const folders = new Set(docs.map((d) => d.folder));
  const usage = await usageFor(group.adminId, now);
  return {
    pagesScanned: sources.filter((s) => s.kind === 'SCAN' || s.kind === 'PDF').reduce((s, x) => s + x.pageCount, 0),
    rows: { total: rows.length, reviewed: rows.filter((r) => r.status !== 'SUGGESTED').length, accepted: rows.filter((r) => r.status === 'ACCEPTED' || r.status === 'EDITED').length, rejected: rows.filter((r) => r.status === 'REJECTED').length },
    memberVerified: { verified, of: withPerson.length, pct: withPerson.length ? Math.round((verified / withPerson.length) * 100) : 0 },
    disputesOpen: entries.filter((e) => e.verificationStatus === 'DISPUTED').length,
    duplicatesToResolve: rows.filter((r) => r.status !== 'REJECTED' && r.issues.some((i) => i.startsWith('DUPLICATE'))).length,
    peopleToChoose: rows.filter((r) => r.status !== 'REJECTED' && r.issues.includes('AMBIGUOUS_MEMBER')).length,
    unclaimedPeople: legacy,
    batchQueue: batches.map((b) => ({ id: b.id, status: b.status, recordType: b.recordType, rowCount: b.rowCount, createdAt: b.createdAt })),
    documents: Object.fromEntries((['CONSTITUTION', 'MINUTES', 'REGISTER', 'RECEIPTS', 'CERTIFICATES', 'OTHER'] as const).map((f) => [f, docs.filter((d) => d.folder === f).length])),
    storage: { usedBytes: usage.storageBytes, quotaBytes: usage.storageQuotaBytes, pct: Math.round((usage.storageBytes / usage.storageQuotaBytes) * 100) },
    ocr: { usedThisMonth: usage.ocrPagesThisMonth, quotaPerMonth: usage.ocrQuotaPerMonth },
    completenessScore: completenessScore({ stagedRows, committedRows, withPerson: withPerson.length, verified, foldersFilled: ['CONSTITUTION', 'MINUTES', 'REGISTER'].filter((f) => folders.has(f as DocFolder)).length }),
  };
}

// ── Exports: always available, even on a lapsed plan ────────────────────────

const FONT_DIR = path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
const REG = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

interface ExportOpts { mask?: boolean }

async function loadExportData(groupId: string) {
  const [group, entries, legacy, members] = await Promise.all([
    loadGroup(groupId),
    prisma.historicalLedgerEntry.findMany({ where: { groupId }, orderBy: { date: 'asc' } }),
    prisma.legacyMember.findMany({ where: { groupId } }),
    prisma.groupMember.findMany({ where: { groupId }, include: { user: { select: { fullName: true, phoneNumber: true } } } }),
  ]);
  return { group, entries, legacy, members };
}

export function entriesCsv(entries: HistoricalLedgerEntry[], o: ExportOpts = {}) {
  return toCsv([
    ['Date', 'Member', 'Type', 'Amount (NGN)', 'Cycle', 'Status', 'Current', 'Replaced by', 'Disputed note'],
    ...entries.map((e) => [e.date.toISOString().slice(0, 10), o.mask ? maskName(e.memberName) : e.memberName, e.kind, koboToNaira(e.amountKobo), e.cycleLabel ?? '', e.verificationStatus, e.supersededById ? 'no' : 'yes', e.supersededById ?? '', e.disputeNote ?? '']),
  ]);
}

export function membersCsv(legacy: { name: string; phone: string | null; joinDate: Date | null; claimedByUserId: string | null }[], members: { user: { fullName: string; phoneNumber: string | null } }[], o: ExportOpts = {}) {
  return toCsv([
    ['Name', 'Phone', 'Joined', 'Signed up'],
    ...members.map((m) => [o.mask ? maskName(m.user.fullName) : m.user.fullName, o.mask ? maskPhone(m.user.phoneNumber) : m.user.phoneNumber ?? '', '', 'yes']),
    ...legacy.map((l) => [o.mask ? maskName(l.name) : l.name, o.mask ? maskPhone(l.phone) : l.phone ?? '', l.joinDate?.toISOString().slice(0, 10) ?? '', l.claimedByUserId ? 'yes' : 'no']),
  ]);
}

export async function annualSummary(user: Actor, groupId: string, year: number) {
  await assertManager(user, groupId);
  const { entries } = await loadExportData(groupId);
  const inYear = entries.filter((e) => !e.supersededById && e.date.getUTCFullYear() === year);
  const sum = (k: string) => inYear.filter((e) => e.kind === k).reduce((s, e) => s + e.amountKobo, 0n);
  const byMonth = Array.from({ length: 12 }, (_, m) => ({ month: m + 1, contributions: koboToNaira(inYear.filter((e) => e.kind === 'CONTRIBUTION' && e.date.getUTCMonth() === m).reduce((s, e) => s + e.amountKobo, 0n)) }));
  return {
    year, entries: inYear.length, contributions: koboToNaira(sum('CONTRIBUTION')), payouts: koboToNaira(sum('PAYOUT')), arrears: koboToNaira(sum('ARREARS')),
    verifiedPct: inYear.length ? Math.round((inYear.filter((e) => e.verificationStatus === 'MEMBER_VERIFIED').length / inYear.length) * 100) : 0, byMonth,
  };
}

function pdfTable(doc: PDFKit.PDFDocument, title: string, header: string[], rows: string[][], widths: number[]) {
  doc.font(BOLD).fontSize(13).fillColor('#2A1712').text(title);
  doc.moveDown(0.4);
  const line = (cells: string[], bold: boolean) => {
    if (doc.y > doc.page.height - 80) doc.addPage();
    const y = doc.y;
    let x = 50;
    doc.font(bold ? BOLD : REG).fontSize(9).fillColor('#2A1712');
    cells.forEach((c, i) => { doc.text(c, x, y, { width: widths[i] - 6, lineBreak: false, ellipsis: true }); x += widths[i]; });
    doc.y = y + 15;
    doc.x = 50;
  };
  line(header, true);
  rows.forEach((r) => line(r, false));
  doc.moveDown();
}

export function historyBookPdf(group: { name: string }, entries: HistoricalLedgerEntry[], o: ExportOpts = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    doc.rect(0, 0, doc.page.width, 90).fill('#C2410C');
    doc.fillColor('#FFFFFF').font(BOLD).fontSize(22).text(`${group.name}: history book`, 50, 34);
    doc.rect(0, 90, doc.page.width, 5).fill('#F6B33D');
    doc.fillColor('#7A5C50').font(REG).fontSize(9).text(`Printed ${new Date().toISOString().slice(0, 10)}. "Imported" entries come from old records. "Unverified" means the person has not yet confirmed it. ${o.mask ? 'Names are shortened.' : ''}`, 50, 110, { width: 495 });
    doc.y = 150; doc.x = 50;
    const current = entries.filter((e) => !e.supersededById);
    const years = [...new Set(current.map((e) => e.date.getUTCFullYear()))].sort();
    for (const y of years) {
      const ys = current.filter((e) => e.date.getUTCFullYear() === y);
      pdfTable(doc, String(y), ['Date', 'Member', 'Type', 'Amount (₦)', 'Cycle', 'Status'], ys.map((e) => [e.date.toISOString().slice(0, 10), o.mask ? maskName(e.memberName) : e.memberName, e.kind.toLowerCase(), koboToNaira(e.amountKobo), e.cycleLabel ?? '', e.verificationStatus === 'MEMBER_VERIFIED' ? 'verified' : e.verificationStatus === 'DISPUTED' ? 'disputed' : 'unverified']), [70, 150, 70, 80, 70, 55]);
    }
    if (!years.length) doc.font(REG).fontSize(11).text('No imported records yet.');
    doc.end();
  });
}

/** A member's own statement. A member can print theirs; the collector can print anyone's. */
export async function memberStatementPdf(user: Actor, groupId: string, who: { userId?: string; legacyMemberId?: string }, o: ExportOpts = {}) {
  const group = await assertMemberOrManager(user, groupId);
  const me = await myIdentity(user.id);
  const isMe = (who.userId && who.userId === user.id) || (who.legacyMemberId && me.legacyIds.includes(who.legacyMemberId));
  if (!isMe && !isManager(user, group)) throw new HttpError(403, 'You can only print your own statement');
  if (!who.userId && !who.legacyMemberId) throw new HttpError(400, 'Choose the member');
  const entries = await prisma.historicalLedgerEntry.findMany({ where: { groupId, supersededById: null, ...(who.userId ? { userId: who.userId } : { legacyMemberId: who.legacyMemberId }) }, orderBy: { date: 'asc' } });
  await logAccess(user.id, groupId, 'EXPORT', 'MemberStatement', who.userId ?? who.legacyMemberId);
  return historyBookPdf({ name: `${group.name} · ${entries[0] ? (o.mask ? maskName(entries[0].memberName) : entries[0].memberName) : 'member'}` }, entries, o);
}

async function zipOf(files: { name: string; data: Buffer | string }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c)); archive.on('end', () => resolve(Buffer.concat(chunks))); archive.on('error', reject);
    for (const f of files) archive.append(f.data, { name: f.name });
    archive.finalize();
  });
}

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'text/csv': 'csv', 'text/plain': 'txt' };

/** Everything, so there is no lock-in: originals + structured CSV + printable history book + a manifest of hashes. */
export async function exportGroup(user: Actor, groupId: string, input: { format: 'csv' | 'pdf' | 'zip'; mask?: boolean }) {
  await assertManager(user, groupId);
  const { group, entries, legacy, members } = await loadExportData(groupId);
  const o = { mask: input.mask };
  await logAccess(user.id, groupId, 'EXPORT', 'CommunityGroup', groupId);
  await audit(user.id, 'RECORDS_EXPORTED', 'CommunityGroup', groupId, { format: input.format, masked: !!input.mask });
  const slug = group.name.replace(/[^\w-]+/g, '_').slice(0, 40);
  if (input.format === 'csv') return { contentType: 'text/csv; charset=utf-8', filename: `${slug}-records.csv`, body: Buffer.from('﻿' + entriesCsv(entries, o)) };
  const book = await historyBookPdf(group, entries, o);
  if (input.format === 'pdf') return { contentType: 'application/pdf', filename: `${slug}-history-book.pdf`, body: book };

  const sources = await prisma.recordSource.findMany({ where: { groupId }, include: { pages: { orderBy: { pageNumber: 'asc' } } } });
  const files: { name: string; data: Buffer | string }[] = [];
  const manifest: Record<string, unknown>[] = [];
  for (const s of sources) {
    for (const p of s.pages) {
      try {
        const data = await vaultGet(p.vaultKey);
        const name = `originals/${s.createdAt.toISOString().slice(0, 10)}-${s.kind.toLowerCase()}-${s.id.slice(-6)}/page-${p.pageNumber}.${EXT[p.mime] ?? 'bin'}`;
        files.push({ name, data });
        manifest.push({ file: name, sha256: p.sha256, intact: sha256(data) === p.sha256, sourceId: s.id, uploadedAt: s.createdAt });
      } catch (e) {
        manifest.push({ sourceId: s.id, page: p.pageNumber, error: 'could not be read' });
      }
    }
  }
  files.push({ name: 'data/entries.csv', data: '﻿' + entriesCsv(entries, o) }, { name: 'data/members.csv', data: '﻿' + membersCsv(legacy, members, o) }, { name: 'history-book.pdf', data: book }, { name: 'manifest.json', data: JSON.stringify({ group: group.name, exportedAt: new Date().toISOString(), masked: !!input.mask, files: manifest }, null, 2) });
  return { contentType: 'application/zip', filename: `${slug}-records.zip`, body: await zipOf(files) };
}

// ── Nightly backup ──────────────────────────────────────────────────────────

export const BACKUP_ROOT = path.resolve(process.cwd(), process.env.RECORDS_BACKUP_DIR || 'records-backups');
const BACKUP_KEEP_DAYS = 14;

/** Copies the encrypted vault and a JSON dump of every records table. The copy stays encrypted: it is only as readable as the vault. */
export async function runRecordsBackup(now = new Date()) {
  const dir = path.join(BACKUP_ROOT, `records-${now.toISOString().slice(0, 10)}`);
  await fs.mkdir(dir, { recursive: true });
  try { await fs.cp(VAULT_ROOT, path.join(dir, 'vault'), { recursive: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  const data = {
    sources: await prisma.recordSource.findMany({ include: { pages: true } }), batches: await prisma.importBatch.findMany(), rows: await prisma.stagedRow.findMany(),
    entries: await prisma.historicalLedgerEntry.findMany(), legacyMembers: await prisma.legacyMember.findMany(), documents: await prisma.repositoryDocument.findMany(), consents: await prisma.recordsPrivacyConsent.findMany(),
  };
  await fs.writeFile(path.join(dir, 'data.json'), json(data));
  const kept = (await fs.readdir(BACKUP_ROOT)).filter((n) => /^records-\d{4}-\d{2}-\d{2}$/.test(n)).sort();
  const old = kept.filter((n) => now.getTime() - new Date(n.slice(8)).getTime() > BACKUP_KEEP_DAYS * 86_400_000);
  for (const n of old) await fs.rm(path.join(BACKUP_ROOT, n), { recursive: true, force: true });
  return { dir, tables: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])), pruned: old.length };
}

