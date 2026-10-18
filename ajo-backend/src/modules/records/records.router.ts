import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { nairaToKobo } from '../../lib/kobo';
import { objectId } from '../../lib/validators';
import { authenticate } from '../../middleware/auth.middleware';
import { annualSummary, completenessScore as _c, dashboard, exportGroup, getDocument, issueSourceFileUrls, listDocuments, memberStatementPdf, readSignedFile, removeDocument, searchRecords, timeline, updateDocument, uploadDocument } from './repository.service';
import { FIELDS, templateCsv } from './records.logic';
import {
  approveBatch, boardSignoff, commitBatch, confirmPrivacy, correctEntry, createFileSource, createScanBatch, createSpreadsheetBatch, createTypedBatch, editRow, listRows, mergeMembers, myEntries,
  PRIVACY_NOTICE, PRIVACY_NOTICE_VERSION, redactMember, rejectBatch, replaceDraftRows, runOcr, spreadsheetPreview, splitMember, submitDraft, verifyEntry, assertManager,
} from './records.service';

void _c;
export const recordsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 40 } });

const recordType = z.enum(['MEMBERS', 'CONTRIBUTIONS', 'PAYOUTS', 'ARREARS', 'OPENING_POSITION']);
const folder = z.enum(['CONSTITUTION', 'MINUTES', 'REGISTER', 'RECEIPTS', 'CERTIFICATES', 'OTHER']);
const visibility = z.enum(['ADMIN_ONLY', 'BOARD', 'MEMBERS']);
const truthy = z.preprocess((v) => v === true || v === 'true' || v === '1', z.boolean());
const files = (req: { files?: unknown }) => ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({ buffer: f.buffer, mime: f.mimetype, name: f.originalname }));

// A short-lived signed link is the credential here: it was issued to someone who passed the access check, and it expires.
recordsRouter.get('/files/:token', async (req, res) => {
  const f = await readSignedFile(String(req.params.token));
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(f.buffer);
});

recordsRouter.use(authenticate);

// ── Privacy notice ──
recordsRouter.get('/privacy/notice', (_req, res) => void res.json({ version: PRIVACY_NOTICE_VERSION, text: PRIVACY_NOTICE }));
recordsRouter.post('/privacy/confirm', async (req, res) => {
  const b = z.object({ groupId: objectId }).parse(req.body);
  res.json(await confirmPrivacy(req.user!, b.groupId));
});

// ── Templates and the dashboard ──
recordsRouter.get('/templates/:type', (req, res) => {
  const t = recordType.parse(String(req.params.type).replace(/\.csv$/, '').toUpperCase());
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${t.toLowerCase()}-template.csv"`);
  res.send('﻿' + templateCsv(t));
});
recordsRouter.get('/fields', (_req, res) => void res.json(FIELDS));
recordsRouter.get('/dashboard/:groupId', async (req, res) => res.json(await dashboard(req.user!, String(req.params.groupId))));

// ── Intake: every route ends in the same reviewable batch ──
recordsRouter.post('/sources', upload.array('files', 40), async (req, res) => {
  const b = z.object({ groupId: objectId, kind: z.enum(['SCAN', 'PDF', 'SPREADSHEET', 'DOCUMENT']), language: z.string().max(20).optional(), assistedById: objectId.optional() }).parse(req.body);
  const s = await createFileSource(req.user!, { ...b, files: files(req) });
  res.status(201).json({ id: s.id, kind: s.kind, pageCount: s.pageCount, sha256: s.originalSha256 });
});
recordsRouter.get('/sources/:id/columns', async (req, res) => {
  const q = z.object({ recordType }).parse(req.query);
  res.json(await spreadsheetPreview(req.user!, String(req.params.id), q.recordType));
});
recordsRouter.get('/sources/:id/files', async (req, res) => res.json({ pages: await issueSourceFileUrls(req.user!, String(req.params.id)) }));

recordsRouter.post('/batches', async (req, res) => {
  const b = z.object({ sourceId: objectId, recordType, mapping: z.record(z.string(), z.string()).optional() }).parse(req.body);
  const src = await prisma.recordSource.findUnique({ where: { id: b.sourceId } });
  if (!src) throw new HttpError(404, 'Upload not found');
  const batch = src.kind === 'SPREADSHEET'
    ? await createSpreadsheetBatch(req.user!, { sourceId: b.sourceId, recordType: b.recordType, mapping: b.mapping ?? (() => { throw new HttpError(400, 'Choose which column is which'); })() })
    : await createScanBatch(req.user!, b);
  res.status(201).json({ batch });
});
recordsRouter.post('/batches/typed', async (req, res) => {
  const b = z.object({ groupId: objectId, recordType, rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000), assistedById: objectId.optional(), draft: z.boolean().optional() }).parse(req.body);
  res.status(201).json({ batch: await createTypedBatch(req.user!, b) });
});
recordsRouter.get('/batches', async (req, res) => {
  const q = z.object({ groupId: objectId }).parse(req.query);
  await assertManager(req.user!, q.groupId);
  res.json({ batches: await prisma.importBatch.findMany({ where: { groupId: q.groupId }, orderBy: { createdAt: 'desc' }, take: 100 }) });
});
recordsRouter.put('/batches/:id/rows', async (req, res) => {
  const b = z.object({ rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000) }).parse(req.body);
  res.json({ batch: await replaceDraftRows(req.user!, String(req.params.id), b.rows) });
});
recordsRouter.post('/batches/:id/submit', async (req, res) => res.json({ batch: await submitDraft(req.user!, String(req.params.id)) }));
recordsRouter.post('/batches/:id/ocr', async (req, res) => res.json(await runOcr(req.user!, String(req.params.id))));

// ── Review ──
recordsRouter.get('/batches/:id/rows', async (req, res) => {
  const q = z.object({ status: z.enum(['SUGGESTED', 'EDITED', 'ACCEPTED', 'REJECTED']).optional(), flagged: truthy.optional() }).parse(req.query);
  res.json({ rows: await listRows(req.user!, String(req.params.id), q) });
});
recordsRouter.patch('/rows/:id', async (req, res) => {
  const b = z.object({ fields: z.record(z.string(), z.unknown()).optional(), status: z.enum(['ACCEPTED', 'REJECTED', 'EDITED']).optional(), matchUserId: objectId.optional(), matchLegacyId: objectId.optional(), asNewPerson: z.boolean().optional() }).parse(req.body);
  res.json({ row: await editRow(req.user!, String(req.params.id), b) });
});
recordsRouter.post('/batches/:id/approve', async (req, res) => res.json({ batch: await approveBatch(req.user!, String(req.params.id)) }));
recordsRouter.post('/batches/:id/reject', async (req, res) => { await rejectBatch(req.user!, String(req.params.id)); res.json({ ok: true }); });
recordsRouter.post('/batches/:id/board-signoff', async (req, res) => { await boardSignoff(req.user!, String(req.params.id)); res.json({ ok: true }); });
recordsRouter.post('/batches/:id/commit', async (req, res) => res.json(await commitBatch(req.user!, String(req.params.id))));

// ── Members confirm and correct ──
recordsRouter.get('/mine', async (req, res) => {
  const rows = await myEntries(req.user!.id);
  res.json({ entries: rows.map((e) => ({ id: e.id, groupId: e.groupId, date: e.date.toISOString().slice(0, 10), kind: e.kind, amount: Number(e.amountKobo) / 100, amountText: (Number(e.amountKobo) / 100).toFixed(2), cycleLabel: e.cycleLabel, status: e.verificationStatus, disputeNote: e.disputeNote })) });
});
recordsRouter.post('/verify/:entryId', async (req, res) => {
  const b = z.object({ confirm: z.boolean(), note: z.string().trim().max(300).optional() }).parse(req.body);
  const e = await verifyEntry(req.user!, String(req.params.entryId), b);
  res.json({ id: e.id, status: e.verificationStatus });
});
recordsRouter.post('/entries/:id/correct', async (req, res) => {
  const b = z.object({ amount: z.union([z.string(), z.number()]).optional(), date: z.coerce.date().optional(), cycleLabel: z.string().max(60).nullable().optional(), reason: z.string().trim().min(5).max(300) }).parse(req.body);
  const e = await correctEntry(req.user!, String(req.params.id), { amountKobo: b.amount === undefined ? undefined : nairaToKobo(b.amount), date: b.date, cycleLabel: b.cycleLabel, reason: b.reason });
  res.status(201).json({ id: e.id, replaces: String(req.params.id) });
});
recordsRouter.post('/redact', async (req, res) => {
  const b = z.object({ groupId: objectId, userId: objectId.optional(), legacyMemberId: objectId.optional(), reason: z.string().trim().min(5).max(300) }).parse(req.body);
  res.json(await redactMember(req.user!, b));
});
recordsRouter.post('/members/merge', async (req, res) => {
  const b = z.object({ groupId: objectId, fromLegacyId: objectId, intoUserId: objectId.optional(), intoLegacyId: objectId.optional() }).parse(req.body);
  await mergeMembers(req.user!, b);
  res.json({ ok: true });
});
recordsRouter.post('/members/split', async (req, res) => {
  const b = z.object({ groupId: objectId, legacyMemberId: objectId }).parse(req.body);
  await splitMember(req.user!, b.groupId, b.legacyMemberId);
  res.json({ ok: true });
});

// ── Repository, search, timeline, export (never behind a plan) ──
recordsRouter.post('/documents', upload.single('file'), async (req, res) => {
  const b = z.object({ groupId: objectId, folder, title: z.string().trim().min(2).max(120), tags: z.string().optional(), visibility: visibility.optional(), retention: truthy.optional(), readText: truthy.optional(), language: z.string().max(20).optional(), assistedById: objectId.optional() }).parse(req.body);
  if (!req.file) throw new HttpError(400, 'Choose a file');
  const d = await uploadDocument(req.user!, { ...b, tags: b.tags?.split(',') , file: { buffer: req.file.buffer, mime: req.file.mimetype, name: req.file.originalname } });
  res.status(201).json({ id: d.id, folder: d.folder, title: d.title });
});
recordsRouter.get('/documents', async (req, res) => {
  const q = z.object({ groupId: objectId, folder: folder.optional(), tag: z.string().max(40).optional() }).parse(req.query);
  res.json({ documents: await listDocuments(req.user!, q) });
});
recordsRouter.get('/documents/:id', async (req, res) => res.json(await getDocument(req.user!, String(req.params.id))));
recordsRouter.patch('/documents/:id', async (req, res) => {
  const b = z.object({ title: z.string().trim().min(2).max(120).optional(), tags: z.array(z.string().max(40)).max(20).optional(), folder: folder.optional(), visibility: visibility.optional(), retention: z.boolean().optional() }).parse(req.body);
  const d = await updateDocument(req.user!, String(req.params.id), b);
  res.json({ id: d.id });
});
recordsRouter.delete('/documents/:id', async (req, res) => { await removeDocument(req.user!, String(req.params.id)); res.json({ ok: true }); });

recordsRouter.get('/search', async (req, res) => {
  const q = z.object({ groupId: objectId, q: z.string().min(2).max(80) }).parse(req.query);
  res.json(await searchRecords(req.user!, q));
});
recordsRouter.get('/timeline/:groupId', async (req, res) => res.json(await timeline(req.user!, String(req.params.groupId))));
recordsRouter.get('/summary/:groupId', async (req, res) => {
  const q = z.object({ year: z.coerce.number().int().min(1950).max(2100) }).parse(req.query);
  res.json(await annualSummary(req.user!, String(req.params.groupId), q.year));
});
recordsRouter.get('/export/:groupId', async (req, res) => {
  const q = z.object({ format: z.enum(['csv', 'pdf', 'zip']).default('zip'), mask: truthy.optional() }).parse(req.query);
  const f = await exportGroup(req.user!, String(req.params.groupId), { format: q.format, mask: q.mask });
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
  res.send(f.body);
});
recordsRouter.get('/statement/:groupId', async (req, res) => {
  const q = z.object({ userId: objectId.optional(), legacyMemberId: objectId.optional(), mask: truthy.optional() }).parse(req.query);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="statement.pdf"');
  res.send(await memberStatementPdf(req.user!, String(req.params.groupId), q, { mask: q.mask }));
});
