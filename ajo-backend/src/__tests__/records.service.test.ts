import os from 'os';
import path from 'path';
process.env.RECORDS_VAULT_DIR = path.join(os.tmpdir(), `vault-svc-${process.pid}`);
process.env.RECORDS_BACKUP_DIR = path.join(os.tmpdir(), `backup-svc-${process.pid}`);
process.env.RECORDS_ENCRYPTION_KEY = 'b'.repeat(64);

// A small in-memory stand-in for the tables the records module uses, so the whole flow can run end to end.
type Row = Record<string, any>;
let n = 0;
const oid = () => (++n).toString(16).padStart(24, '0');
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v === undefined) return true;
    if (k === 'OR') return (v as Row[]).some((w) => matches(row, w));
    if (k === 'AND') return (v as Row[]).every((w) => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return v.not === null ? row[k] != null : row[k] !== v.not;
      if ('gte' in v) return row[k] >= v.gte;
      if ('lt' in v) return row[k] < v.lt;
      if ('contains' in v) return String(row[k] ?? '').toLowerCase().includes(String(v.contains).toLowerCase());
      if ('has' in v) return (row[k] ?? []).includes(v.has);
      return true;
    }
    return (row[k] ?? null) === (v ?? null);
  });
}
function table(defaults: Row = {}) {
  const rows: Row[] = [];
  const zero = typeof 0n === 'bigint' ? 0 : 0;
  const apply = (r: Row, data: Row) => { for (const [k, v] of Object.entries(data)) r[k] = v && typeof v === 'object' && 'increment' in v ? (r[k] ?? 0) + v.increment : v; };
  return {
    rows,
    create: jest.fn(async ({ data, include }: Row) => { const { pages, ...rest } = data; const r = { id: oid(), createdAt: new Date(), ...defaults, ...rest }; rows.push(r); if (pages) r.pages = pages.create.map((p: Row) => ({ id: oid(), ...p })); return { ...r }; }),
    createMany: jest.fn(async ({ data }: Row) => { for (const d of data) rows.push({ id: oid(), createdAt: new Date(), ...defaults, ...d }); return { count: data.length }; }),
    findUnique: jest.fn(async ({ where, include }: Row) => { const r = rows.find((x) => matches(x, where.id ? { id: where.id } : Object.fromEntries(Object.entries(where).flatMap(([k, v]) => (v && typeof v === 'object' ? Object.entries(v as Row) : [[k, v]])))));  return r ? { ...r } : null; }),
    findUniqueOrThrow: jest.fn(async ({ where }: Row) => { const r = rows.find((x) => matches(x, where)); if (!r) throw new Error('not found'); return { ...r }; }),
    findFirst: jest.fn(async ({ where }: Row) => { const r = rows.find((x) => matches(x, where)); return r ? { ...r } : null; }),
    findMany: jest.fn(async ({ where, orderBy, take }: Row = {}) => { let out = rows.filter((x) => matches(x, where)).map((x) => ({ ...x })); if (orderBy) { const [k, d] = Object.entries(orderBy as Row)[0] as [string, string]; out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (d === 'desc' ? -1 : 1)); } return take ? out.slice(0, take) : out; }),
    update: jest.fn(async ({ where, data }: Row) => { const r = rows.find((x) => x.id === where.id); if (!r) throw new Error('not found'); apply(r, data); return { ...r }; }),
    updateMany: jest.fn(async ({ where, data }: Row) => { const hit = rows.filter((x) => matches(x, where)); hit.forEach((r) => apply(r, data)); return { count: hit.length }; }),
    deleteMany: jest.fn(async ({ where }: Row = {}) => { const keep = rows.filter((x) => !matches(x, where)); const c = rows.length - keep.length; rows.length = 0; rows.push(...keep); return { count: c }; }),
    delete: jest.fn(async ({ where }: Row) => { const i = rows.findIndex((x) => x.id === where.id); if (i >= 0) rows.splice(i, 1); }),
    count: jest.fn(async ({ where }: Row = {}) => rows.filter((x) => matches(x, where)).length),
    aggregate: jest.fn(async ({ where, _sum }: Row = {}) => { const hit = rows.filter((x) => matches(x, where)); const k = Object.keys(_sum ?? {})[0]; return { _sum: k ? { [k]: hit.reduce((s, r) => s + (r[k] ?? zero), hit.length && typeof hit[0][k] === 'bigint' ? 0n : 0) } : {} }; }),
    upsert: jest.fn(async ({ where, create, update }: Row) => { const key = Object.values(where)[0] as Row; const r = rows.find((x) => matches(x, key)); if (r) { apply(r, update); return r; } const nr = { id: oid(), ...create }; rows.push(nr); return nr; }),
  };
}

const db = {
  user: table(), communityGroup: table(), groupMember: table(), legacyMember: table({ claimedByUserId: null, mergedIntoUserId: null, mergedIntoLegacyId: null }),
  recordSource: table({ pages: [] }), recordPage: table(), importBatch: table(), stagedRow: table(), historicalLedgerEntry: table({ supersededById: null }), repositoryDocument: table(),
  recordsPrivacyConsent: table(), ocrUsage: table(), recordAccessLog: table(), fundsEntry: table(), subscription: table(), auditLog: table(),
  $transaction: (fn: (d: unknown) => unknown) => fn(db),
} as Record<string, any>;
const sms = jest.fn();
jest.mock('../lib/prisma', () => ({ prisma: db }));
jest.mock('../lib/notify', () => ({ safeSms: (...a: unknown[]) => sms(...a), naira: (n: unknown) => `₦${n}` }));

import fs from 'fs';
import fsp from 'fs/promises';
import { decisions } from '../config/decisions';
import { setOcrProvider, StubOcrProvider } from '../modules/records/ocr.provider';
import {
  approveBatch, boardSignoff, claimLegacyMembers, commitBatch, confirmPrivacy, correctEntry, createFileSource, createScanBatch, createSpreadsheetBatch, createTypedBatch, editRow, mergeMembers, myEntries,
  redactMember, replaceDraftRows, runOcr, spreadsheetPreview, splitMember, submitDraft, verifyEntry, listRows,
} from '../modules/records/records.service';
import { BACKUP_ROOT, completenessScore, dashboard, exportGroup, runRecordsBackup, searchRecords, timeline, uploadDocument } from '../modules/records/repository.service';
import { VAULT_ROOT } from '../modules/records/vault';

const COLLECTOR = { id: oid(), role: 'COLLECTOR' }, MEMBER = { id: oid(), role: 'MEMBER' }, BOARD = { id: oid(), role: 'BOARD_MEMBER' }, ADMIN = { id: oid(), role: 'ADMIN' };
let GROUP: string;
const png = Buffer.from('89504e470d0a1a0a', 'hex');

beforeEach(() => {
  for (const t of Object.values(db)) if (typeof t === 'object' && t.rows) t.rows.length = 0;
  jest.clearAllMocks();
  decisions.billing.enforced = false;
  setOcrProvider(null);
  db.user.rows.push({ id: COLLECTOR.id, fullName: 'Baba Àlàjọ', phoneNumber: '+2348000000001', role: 'COLLECTOR', preferredLanguage: 'EN' }, { id: MEMBER.id, fullName: 'Kemi Alade', phoneNumber: '+2348031234567', role: 'MEMBER', preferredLanguage: 'YO' });
  const g = { id: oid(), name: 'Badagry Traders', adminId: COLLECTOR.id, country: 'NG', fundsMode: 'ESCROW' };
  GROUP = g.id;
  db.communityGroup.rows.push(g);
  db.groupMember.rows.push({ id: oid(), groupId: GROUP, userId: COLLECTOR.id, user: db.user.rows[0] }, { id: oid(), groupId: GROUP, userId: MEMBER.id, user: db.user.rows[1] });
});
afterAll(async () => { await fsp.rm(VAULT_ROOT, { recursive: true, force: true }); await fsp.rm(BACKUP_ROOT, { recursive: true, force: true }); });

// helpers
const confirmNotice = () => confirmPrivacy(COLLECTOR, GROUP);
const typed = async (rows: Record<string, unknown>[], recordType: any = 'CONTRIBUTIONS', draft = false) => (await createTypedBatch(COLLECTOR, { groupId: GROUP, recordType, rows, draft }));
const goodRows = () => [
  { name: 'Kemi Alade', date: '14/03/2023', amount: '5000', cycleLabel: 'Week 1' },
  { name: 'Ade Bello', date: '14/03/2023', amount: '5000', cycleLabel: 'Week 1' },
];
const acceptAll = async (batchId: string) => { for (const r of await listRows(COLLECTOR, batchId)) await editRow(COLLECTOR, r.id, { status: 'ACCEPTED' }); };

describe('privacy comes first', () => {
  it('nothing can be imported until the organizer confirms the data-processing notice', async () => {
    await expect(createTypedBatch(COLLECTOR, { groupId: GROUP, recordType: 'CONTRIBUTIONS', rows: goodRows() })).rejects.toThrow('PRIVACY_NOTICE');
    await expect(createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SCAN', files: [{ buffer: png, mime: 'image/png' }] })).rejects.toThrow('PRIVACY_NOTICE');
    await confirmNotice();
    await expect(typed(goodRows())).resolves.toBeDefined();
  });
  it('only the group collector or an admin can manage records', async () => {
    await expect(confirmPrivacy(MEMBER, GROUP)).rejects.toThrow('Only the group collector');
    await expect(createTypedBatch(BOARD, { groupId: GROUP, recordType: 'CONTRIBUTIONS', rows: goodRows() })).rejects.toThrow('Only the group collector');
  });
});

describe('originals are preserved untouched', () => {
  it('a scan is stored encrypted in the vault, with its hash, and the source row is never updated or deleted by any code path', async () => {
    await confirmNotice();
    const s = await createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SCAN', files: [{ buffer: png, mime: 'image/png' }, { buffer: Buffer.from('page2'), mime: 'image/png' }] });
    expect(s.pageCount).toBe(2);
    expect(s.originalSha256).toHaveLength(64);
    const stored = s.pages[0];
    expect((await fsp.readFile(path.join(VAULT_ROOT, stored.vaultKey))).includes(png)).toBe(false);
    // static guarantee: nothing in the code can change or remove an original
    const dir = path.join(__dirname, '..', 'modules', 'records');
    const code = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(code).not.toMatch(/recordSource\.(update|updateMany|delete|deleteMany)/);
    expect(code).not.toMatch(/recordPage\.(update|updateMany|delete|deleteMany)/);
  });
  it('only the right kinds of file are accepted for each kind of upload', async () => {
    await confirmNotice();
    await expect(createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SCAN', files: [{ buffer: png, mime: 'application/pdf' }] })).rejects.toThrow('cannot be used');
    await expect(createFileSource(COLLECTOR, { groupId: GROUP, kind: 'PDF', files: [{ buffer: png, mime: 'application/pdf' }, { buffer: png, mime: 'application/pdf' }] })).rejects.toThrow('one file at a time'.replace('one', 'Upload one'));
  });
  it('typed entry keeps the exact submitted rows as its hashed original', async () => {
    await confirmNotice();
    const b = await typed(goodRows());
    const src = db.recordSource.rows.find((r: Row) => r.id === b.sourceId)!;
    expect(src.kind).toBe('TYPED');
    expect(src.originalSha256).toHaveLength(64);
  });
});

describe('nothing is committed automatically', () => {
  it('OCR only creates SUGGESTED rows and no record', async () => {
    await confirmNotice();
    setOcrProvider(new StubOcrProvider([{ fields: { name: 'Kemi Alade', date: '14/03/2023', amount: '5,000' }, confidence: { name: 0.9, date: 0.9, amount: 0.5 }, rawText: 'Kemi 14/3 5,000', page: 1 }]));
    const src = await createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SCAN', files: [{ buffer: png, mime: 'image/png' }] });
    const batch = await createScanBatch(COLLECTOR, { sourceId: src.id, recordType: 'CONTRIBUTIONS' });
    expect(batch.status).toBe('OCR_PENDING');
    const r = await runOcr(COLLECTOR, batch.id);
    expect(r.rows).toBe(1);
    const rows = await listRows(COLLECTOR, batch.id);
    expect(rows[0].status).toBe('SUGGESTED');
    expect(rows[0].issues).toContain('LOW_CONFIDENCE:amount');
    expect(db.historicalLedgerEntry.rows).toHaveLength(0);
    expect(db.importBatch.rows[0].status).toBe('IN_REVIEW');
  });

  it('cannot be approved while any row has not been decided, and cannot be committed unless approved', async () => {
    await confirmNotice();
    const b = await typed(goodRows());
    await expect(approveBatch(COLLECTOR, b.id)).rejects.toThrow('2 rows still need a decision');
    await expect(commitBatch(COLLECTOR, b.id)).rejects.toThrow('Only an approved import');
    const rows = await listRows(COLLECTOR, b.id);
    await editRow(COLLECTOR, rows[0].id, { status: 'ACCEPTED' });
    await expect(approveBatch(COLLECTOR, b.id)).rejects.toThrow('1 row still needs a decision');
    await editRow(COLLECTOR, rows[1].id, { status: 'REJECTED' });
    await expect(approveBatch(COLLECTOR, b.id)).resolves.toMatchObject({ status: 'APPROVED' });
    expect(db.historicalLedgerEntry.rows).toHaveLength(0); // approving is still not committing
  });

  it('a row with a fatal problem cannot be accepted until it is fixed', async () => {
    await confirmNotice();
    const b = await typed([{ name: 'Kemi Alade', date: '31/02/2023', amount: '5000' }]);
    const [row] = await listRows(COLLECTOR, b.id);
    expect(row.issues).toContain('BAD_DATE');
    await expect(editRow(COLLECTOR, row.id, { status: 'ACCEPTED' })).rejects.toThrow('BAD_DATE');
    const fixed = await editRow(COLLECTOR, row.id, { fields: { date: '28/02/2023' } });
    expect(fixed.status).toBe('EDITED');
    expect(fixed.issues).not.toContain('BAD_DATE');
    await expect(editRow(COLLECTOR, row.id, { status: 'ACCEPTED' })).resolves.toMatchObject({ status: 'ACCEPTED' });
  });

  it('committing twice cannot create records twice', async () => {
    await confirmNotice();
    const b = await typed(goodRows());
    await acceptAll(b.id);
    await approveBatch(COLLECTOR, b.id);
    await commitBatch(COLLECTOR, b.id);
    const first = db.historicalLedgerEntry.rows.length;
    await expect(commitBatch(COLLECTOR, b.id)).rejects.toThrow('Only an approved import');
    expect(db.historicalLedgerEntry.rows).toHaveLength(first);
  });
});

describe('data-quality checks reach the reviewer', () => {
  it('duplicates, already-saved entries and unmatched or ambiguous people are flagged', async () => {
    await confirmNotice();
    const b = await typed([...goodRows(), { name: 'kemi alade', date: '14/03/2023', amount: '5000', cycleLabel: 'week 1' }, { name: 'Chidi Okafor', date: '14/03/2023', amount: '5000', cycleLabel: 'Week 1' }]);
    const rows = await listRows(COLLECTOR, b.id);
    expect(rows[0].issues).toContain('DUPLICATE_IN_BATCH');
    expect(rows[2].issues).toContain('DUPLICATE_IN_BATCH');
    expect(rows[3].issues).toContain('UNMATCHED_MEMBER');
    expect(rows[0].matchedUserId).toBe(MEMBER.id); // "Kemi Alade" is a signed-up member
    // already saved
    await acceptAll((await typed([goodRows()[0]])).id);
  });
  it('rejecting one of two duplicates frees the other', async () => {
    await confirmNotice();
    const b = await typed([goodRows()[0], goodRows()[0]]);
    const rows = await listRows(COLLECTOR, b.id);
    await editRow(COLLECTOR, rows[1].id, { status: 'REJECTED' });
    expect((await listRows(COLLECTOR, b.id)).find((r) => r.id === rows[0].id)!.issues).not.toContain('DUPLICATE_IN_BATCH');
  });
  it('saved entries are recognised as duplicates of a later import', async () => {
    await confirmNotice();
    const b1 = await typed([goodRows()[0]]);
    await acceptAll(b1.id); await approveBatch(COLLECTOR, b1.id); await commitBatch(COLLECTOR, b1.id);
    const b2 = await typed([goodRows()[0]]);
    expect((await listRows(COLLECTOR, b2.id))[0].issues).toContain('DUPLICATE_EXISTING');
  });
  it('a name that fits two people must be chosen by a person', async () => {
    await confirmNotice();
    db.legacyMember.rows.push({ id: oid(), groupId: GROUP, name: 'Ade Bello', phone: null, claimedByUserId: null, mergedIntoUserId: null, mergedIntoLegacyId: null }, { id: oid(), groupId: GROUP, name: 'Ade Bellow', phone: null, claimedByUserId: null, mergedIntoUserId: null, mergedIntoLegacyId: null });
    const b = await typed([{ name: 'Ade Bello', date: '14/03/2023', amount: '5000' }]);
    const [row] = await listRows(COLLECTOR, b.id);
    expect(row.issues).toContain('AMBIGUOUS_MEMBER');
    await expect(editRow(COLLECTOR, row.id, { status: 'ACCEPTED' })).rejects.toThrow('AMBIGUOUS_MEMBER');
    const pick = db.legacyMember.rows[0].id;
    const chosen = await editRow(COLLECTOR, row.id, { matchLegacyId: pick });
    expect(chosen.issues).not.toContain('AMBIGUOUS_MEMBER');
    await expect(editRow(COLLECTOR, row.id, { status: 'ACCEPTED' })).resolves.toBeDefined();
  });
});

describe('spreadsheets and typed drafts', () => {
  it('uploads a CSV, previews the columns with a guessed mapping, then stages the mapped rows', async () => {
    await confirmNotice();
    const csv = 'Member Name,Date,Amount Paid\nKemi Alade,14/03/2023,5000\nAde Bello,14/03/2023,5000\n';
    const src = await createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SPREADSHEET', files: [{ buffer: Buffer.from(csv), mime: 'text/csv' }] });
    const preview = await spreadsheetPreview(COLLECTOR, src.id, 'CONTRIBUTIONS');
    expect(preview).toMatchObject({ header: ['Member Name', 'Date', 'Amount Paid'], rows: 2, guessedMapping: { name: 'Member Name', date: 'Date', amount: 'Amount Paid' } });
    const batch = await createSpreadsheetBatch(COLLECTOR, { sourceId: src.id, recordType: 'CONTRIBUTIONS', mapping: preview.guessedMapping });
    expect(batch.status).toBe('IN_REVIEW');
    expect(await listRows(COLLECTOR, batch.id)).toHaveLength(2);
    await expect(createSpreadsheetBatch(COLLECTOR, { sourceId: src.id, recordType: 'CONTRIBUTIONS', mapping: { name: 'Who' } })).rejects.toThrow('Column not found');
  });
  it('a typed draft autosaves (replace) and is only reviewable once submitted', async () => {
    await confirmNotice();
    const d = await typed([goodRows()[0]], 'CONTRIBUTIONS', true);
    expect(d.status).toBe('DRAFT');
    await replaceDraftRows(COLLECTOR, d.id, goodRows());
    expect(await listRows(COLLECTOR, d.id)).toHaveLength(2);
    await expect(submitDraft(COLLECTOR, d.id)).resolves.toMatchObject({ status: 'IN_REVIEW' });
    await expect(replaceDraftRows(COLLECTOR, d.id, goodRows())).rejects.toThrow('Only a draft');
  });
});

describe('quotas and plans never lock anyone out of their records', () => {
  it('over the monthly OCR quota only new reading pauses: typing still works', async () => {
    await confirmNotice();
    setOcrProvider(new StubOcrProvider([]));
    const src = await createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SCAN', files: [{ buffer: png, mime: 'image/png' }] });
    const batch = await createScanBatch(COLLECTOR, { sourceId: src.id, recordType: 'CONTRIBUTIONS' });
    db.ocrUsage.rows.push({ id: oid(), groupId: GROUP, month: new Date().toISOString().slice(0, 7), pages: decisions.quotas.ocrPagesPerMonth });
    await expect(runOcr(COLLECTOR, batch.id)).rejects.toThrow('OCR_QUOTA');
    expect(db.importBatch.rows.find((b: Row) => b.id === batch.id)!.status).toBe('OCR_PENDING'); // still waiting, not lost
    await expect(typed(goodRows())).resolves.toBeDefined();
    expect(await timeline(COLLECTOR, GROUP)).toBeDefined();
    await expect(exportGroup(COLLECTOR, GROUP, { format: 'csv' })).resolves.toBeDefined();
  });
  it('a full vault blocks new uploads but not typing, viewing or exporting', async () => {
    await confirmNotice();
    db.recordSource.rows.push({ id: oid(), groupId: GROUP, sizeBytes: BigInt(decisions.quotas.storageGb) * 1024n ** 3n });
    db.recordSource.aggregate.mockImplementation(async () => ({ _sum: { sizeBytes: BigInt(decisions.quotas.storageGb) * 1024n ** 3n } }));
    await expect(createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SCAN', files: [{ buffer: png, mime: 'image/png' }] })).rejects.toThrow('STORAGE_FULL');
    await expect(typed(goodRows())).resolves.toBeDefined();
    db.recordSource.aggregate.mockImplementation(async () => ({ _sum: { sizeBytes: 0n } }));
  });
  it('a lapsed organizer plan blocks NEW imports, but viewing, searching, the timeline, the dashboard and every export still work', async () => {
    await confirmNotice();
    decisions.billing.enforced = true; // and the organizer has no active plan
    await expect(createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SCAN', files: [{ buffer: png, mime: 'image/png' }] })).rejects.toThrow('You can still view and export all your records');
    // None of these ask about the plan (subscription.findUnique is not even mocked to return anything).
    await expect(timeline(COLLECTOR, GROUP)).resolves.toBeDefined();
    await expect(searchRecords(COLLECTOR, { groupId: GROUP, q: 'kemi' })).resolves.toBeDefined();
    await expect(dashboard(COLLECTOR, GROUP)).resolves.toBeDefined();
    for (const format of ['csv', 'pdf', 'zip'] as const) await expect(exportGroup(COLLECTOR, GROUP, { format })).resolves.toBeDefined();
  });
});

describe('records are historical, never live money', () => {
  it('no balance, commission, billing or trust code reads the historical table', () => {
    const root = path.join(__dirname, '..');
    const users: string[] = [];
    const walk = (dir: string) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, f.name); if (f.isDirectory()) { if (f.name !== '__tests__') walk(p); } else if (/\.ts$/.test(f.name) && /historicalLedgerEntry|HistoricalLedgerEntry/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(root, p)); } };
    walk(root);
    expect(users.every((u) => u.startsWith(`modules${path.sep}records`))).toBe(true);
    for (const f of ['modules/payments/funds-provider.ts', 'modules/payments/commission.service.ts', 'modules/billing/billing.service.ts', 'modules/billing/revenue.service.ts', 'services/trust.service.ts', 'services/ledger.service.ts']) {
      expect(fs.readFileSync(path.join(root, f), 'utf8')).not.toMatch(/from '[^']*records[^']*'|historicalLedger/i);
    }
  });
  it('commit creates only HISTORICAL entries, unverified, and never touches the live ledger', async () => {
    await confirmNotice();
    const b = await typed(goodRows());
    await acceptAll(b.id); await approveBatch(COLLECTOR, b.id);
    const r = await commitBatch(COLLECTOR, b.id);
    expect(r).toMatchObject({ entries: 2 });
    expect(db.historicalLedgerEntry.rows.every((e: Row) => e.verificationStatus === 'IMPORTED_UNVERIFIED')).toBe(true);
    expect(db.fundsEntry.create).not.toHaveBeenCalled();
    expect(db.historicalLedgerEntry.rows[0].amountKobo).toBe(500_000n);
  });
});

describe('members confirm their own history', () => {
  const commit = async (rows: Record<string, unknown>[]) => { await confirmNotice(); const b = await typed(rows); await acceptAll(b.id); await approveBatch(COLLECTOR, b.id); await commitBatch(COLLECTOR, b.id); return b; };

  it('everyone with a phone number is asked to confirm, in their own language', async () => {
    await commit([goodRows()[0]]);
    expect(sms).toHaveBeenCalledWith('+2348031234567', expect.stringContaining('Badagry Traders'));
    expect(sms.mock.calls[0][1]).toContain('Ṣí app'); // Kemi's language is Yorùbá
  });
  it('people not yet on the app become claimable legacy members and are texted if they have a phone', async () => {
    await commit([{ name: 'Chidi Okafor', phone: '08051112222', date: '14/03/2023', amount: '3000' }]);
    expect(db.legacyMember.rows).toHaveLength(1);
    expect(db.legacyMember.rows[0]).toMatchObject({ name: 'Chidi Okafor', phone: '+2348051112222', claimedByUserId: null });
    expect(sms).toHaveBeenCalledWith('+2348051112222', expect.any(String));
  });
  it('a member confirms their own entry; it becomes MEMBER_VERIFIED and keeps its amount', async () => {
    await commit([goodRows()[0]]);
    const [mine] = await myEntries(MEMBER.id);
    await verifyEntry(MEMBER, mine.id, { confirm: true });
    expect(db.historicalLedgerEntry.rows[0]).toMatchObject({ verificationStatus: 'MEMBER_VERIFIED', amountKobo: 500_000n });
    await expect(verifyEntry(MEMBER, mine.id, { confirm: true })).rejects.toThrow('already been confirmed');
  });
  it('nobody can confirm or dispute someone else\'s record', async () => {
    await commit([goodRows()[0]]);
    const stranger = { id: oid(), role: 'MEMBER' };
    db.user.rows.push({ id: stranger.id, fullName: 'Stranger', phoneNumber: '+2348066666666', role: 'MEMBER' });
    await expect(verifyEntry(stranger, db.historicalLedgerEntry.rows[0].id, { confirm: true })).rejects.toThrow('only confirm or dispute your own');
  });
  it('a dispute needs a reason, changes nothing, and tells the collector and the board', async () => {
    await commit([goodRows()[0]]);
    db.user.rows.push({ id: BOARD.id, phoneNumber: '+2348099999999', role: 'BOARD_MEMBER' });
    const e = db.historicalLedgerEntry.rows[0];
    await expect(verifyEntry(MEMBER, e.id, { confirm: false })).rejects.toThrow('what is wrong');
    sms.mockClear();
    await verifyEntry(MEMBER, e.id, { confirm: false, note: 'I paid 4,000 not 5,000' });
    expect(db.historicalLedgerEntry.rows[0]).toMatchObject({ verificationStatus: 'DISPUTED', amountKobo: 500_000n, disputeNote: 'I paid 4,000 not 5,000' });
    expect(db.historicalLedgerEntry.rows).toHaveLength(1); // nothing deleted or rewritten
    expect(sms).toHaveBeenCalledWith('+2348000000001', expect.stringContaining('disputes'));
    expect(sms).toHaveBeenCalledWith('+2348099999999', expect.stringContaining('disputes'));
  });
  it('a person claims their legacy record by signing in with that phone number, and then sees their history', async () => {
    await commit([{ name: 'Chidi Okafor', phone: '08051112222', date: '14/03/2023', amount: '3000' }]);
    const chidi = { id: oid(), role: 'MEMBER' };
    db.user.rows.push({ id: chidi.id, fullName: 'Chidi Okafor', phoneNumber: '+2348051112222', role: 'MEMBER' });
    expect(await claimLegacyMembers(chidi.id)).toHaveLength(1);
    expect(db.legacyMember.rows[0].claimedByUserId).toBe(chidi.id);
    const mine = await myEntries(chidi.id);
    expect(mine).toHaveLength(1);
    await expect(verifyEntry(chidi, mine[0].id, { confirm: true })).resolves.toMatchObject({ verificationStatus: 'MEMBER_VERIFIED' });
    // a different phone cannot claim it
    const other = { id: oid(), role: 'MEMBER' };
    db.user.rows.push({ id: other.id, fullName: 'X', phoneNumber: '+2348077777777', role: 'MEMBER' });
    expect(await myEntries(other.id)).toHaveLength(0);
  });
});

describe('corrections supersede, nothing is edited or deleted', () => {
  const commit1 = async () => { await confirmNotice(); const b = await typed([goodRows()[0]]); await acceptAll(b.id); await approveBatch(COLLECTOR, b.id); await commitBatch(COLLECTOR, b.id); return db.historicalLedgerEntry.rows[0]; };
  it('a correction adds a new unverified entry and points the old one at it', async () => {
    const old = await commit1();
    await verifyEntry(MEMBER, old.id, { confirm: false, note: 'wrong amount' });
    const next = await correctEntry(COLLECTOR, old.id, { amountKobo: 400_000n, reason: 'Member showed her receipt' });
    expect(db.historicalLedgerEntry.rows).toHaveLength(2);
    expect(db.historicalLedgerEntry.rows.find((r: Row) => r.id === old.id)).toMatchObject({ amountKobo: 500_000n, supersededById: next.id });
    expect(next).toMatchObject({ amountKobo: 400_000n, verificationStatus: 'IMPORTED_UNVERIFIED' });
    expect((await myEntries(MEMBER.id)).map((e) => e.id)).toEqual([next.id]); // only the current one is shown
    await expect(correctEntry(COLLECTOR, old.id, { amountKobo: 1n, reason: 'again please' })).rejects.toThrow('already been replaced');
  });
  it('no code path deletes a historical entry', () => {
    const dir = path.join(__dirname, '..', 'modules', 'records');
    const code = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(code).not.toMatch(/historicalLedgerEntry\.(delete|deleteMany)/);
  });
  it('a deletion request anonymises the person by superseding, keeps the amounts and the audit trail', async () => {
    await commit1();
    await redactMember(COLLECTOR, { groupId: GROUP, userId: MEMBER.id, reason: 'Member asked to be removed' });
    const current = db.historicalLedgerEntry.rows.filter((r: Row) => !r.supersededById);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ memberName: '[redacted]', redacted: true, userId: null, legacyMemberId: null, amountKobo: 500_000n });
    expect(db.historicalLedgerEntry.rows).toHaveLength(2);
    expect(db.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'HISTORY_REDACTED' }) });
    expect(await myEntries(MEMBER.id)).toHaveLength(0);
  });
  it('duplicate people are merged by a pointer, and a wrong merge can be undone', async () => {
    await confirmNotice();
    const a = { id: oid(), groupId: GROUP, name: 'Ola Bello', phone: null, claimedByUserId: null, mergedIntoUserId: null, mergedIntoLegacyId: null };
    const b = { id: oid(), groupId: GROUP, name: 'Ọlá Bello', phone: null, claimedByUserId: null, mergedIntoUserId: null, mergedIntoLegacyId: null };
    db.legacyMember.rows.push(a, b);
    await mergeMembers(COLLECTOR, { groupId: GROUP, fromLegacyId: a.id, intoLegacyId: b.id });
    expect(db.legacyMember.rows.find((r: Row) => r.id === a.id)!.mergedIntoLegacyId).toBe(b.id);
    await expect(mergeMembers(COLLECTOR, { groupId: GROUP, fromLegacyId: b.id, intoLegacyId: a.id })).rejects.toThrow('cannot be merged into');
    await splitMember(COLLECTOR, GROUP, a.id);
    expect(db.legacyMember.rows.find((r: Row) => r.id === a.id)!.mergedIntoLegacyId).toBeNull();
  });
});

describe('opening positions need three sign-offs', () => {
  it('collector approval, then a Trust Board sign-off from someone else, before it is committed', async () => {
    await confirmNotice();
    const b = await typed([{ name: 'Kemi Alade', amount: '30000', payoutOrder: '4', receivedPayout: 'no', asOf: '01/01/2024' }], 'OPENING_POSITION');
    await acceptAll(b.id); await approveBatch(COLLECTOR, b.id);
    await expect(commitBatch(COLLECTOR, b.id)).rejects.toThrow('Trust Board sign-off');
    await expect(boardSignoff(MEMBER, b.id)).rejects.toThrow('Only a Trust Board member');
    await expect(boardSignoff({ id: COLLECTOR.id, role: 'BOARD_MEMBER' }, b.id)).rejects.toThrow('someone other than');
    await boardSignoff(BOARD, b.id);
    await expect(boardSignoff(BOARD, b.id)).rejects.toThrow('Already signed off');
    await expect(commitBatch(COLLECTOR, b.id)).resolves.toMatchObject({ entries: 1 });
    expect(db.historicalLedgerEntry.rows[0].kind).toBe('OPENING');
    expect(db.fundsEntry.create).not.toHaveBeenCalled(); // opening balances are never turned into escrow or custody funds
  });
  it('only opening positions need the board', async () => {
    await confirmNotice();
    const b = await typed(goodRows());
    await acceptAll(b.id); await approveBatch(COLLECTOR, b.id);
    await expect(boardSignoff(BOARD, b.id)).rejects.toThrow('Only opening positions');
  });
});

describe('repository, search, timeline, exports', () => {
  const commitSome = async () => { await confirmNotice(); const b = await typed(goodRows()); await acceptAll(b.id); await approveBatch(COLLECTOR, b.id); await commitBatch(COLLECTOR, b.id); await verifyEntry(MEMBER, (await myEntries(MEMBER.id))[0].id, { confirm: true }); };

  it('documents are filed by folder with visibility, and members only see what they are allowed to', async () => {
    await confirmNotice();
    const base = { groupId: GROUP, folder: 'MINUTES' as const, file: { buffer: Buffer.from('Agreed: contribution is 5000 per week'), mime: 'text/plain' } };
    await uploadDocument(COLLECTOR, { ...base, title: 'Admin only minutes', visibility: 'ADMIN_ONLY' });
    await uploadDocument(COLLECTOR, { ...base, title: 'Board minutes', visibility: 'BOARD' });
    await uploadDocument(COLLECTOR, { ...base, title: 'Open minutes', visibility: 'MEMBERS', tags: ['2023'] });
    const titles = async (u: any) => (await searchRecords(u, { groupId: GROUP, q: 'contribution' })).documents.map((d) => d.title).sort();
    expect(await titles(COLLECTOR)).toEqual(['Admin only minutes', 'Board minutes', 'Open minutes']);
    expect(await titles(BOARD)).toEqual(['Board minutes', 'Open minutes']);
    expect(await titles(MEMBER)).toEqual(['Open minutes']);
    expect((await searchRecords(COLLECTOR, { groupId: GROUP, q: 'contribution' })).documents[0].snippet).toContain('contribution');
    expect(db.recordAccessLog.rows.some((r: Row) => r.action === 'SEARCH')).toBe(true);
  });

  it('the timeline labels imported (verified / unverified) against live, and a member sees only their own', async () => {
    await commitSome();
    db.fundsEntry.rows.push({ id: oid(), groupId: GROUP, status: 'CONFIRMED', type: 'CONTRIBUTION', amountKobo: 700_000n, payerUserId: MEMBER.id, counterpartyUserId: null, createdAt: new Date('2026-01-10') });
    const all = await timeline(COLLECTOR, GROUP);
    expect(all.scope).toBe('GROUP');
    expect(all.items.map((i) => i.label).sort()).toEqual(['Imported · unverified', 'Imported · verified', 'Live']);
    const mine = await timeline(MEMBER, GROUP);
    expect(mine.scope).toBe('MINE');
    expect(mine.items.map((i) => i.memberName)).not.toContain('Ade Bello');
  });

  it('exports everything: originals + CSV + members + history book + a manifest with intact hashes', async () => {
    await commitSome();
    await confirmNotice();
    const src = await createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SCAN', files: [{ buffer: png, mime: 'image/png' }] });
    const zip = await exportGroup(COLLECTOR, GROUP, { format: 'zip' });
    expect(zip.contentType).toBe('application/zip');
    const text = zip.body.toString('latin1');
    for (const name of ['originals/', 'data/entries.csv', 'data/members.csv', 'history-book.pdf', 'manifest.json']) expect(text).toContain(name);
    expect(zip.body.subarray(0, 2).toString()).toBe('PK');
    const csv = (await exportGroup(COLLECTOR, GROUP, { format: 'csv' })).body.toString('utf8');
    expect(csv).toContain('Kemi Alade');
    expect(csv.split('\n')[0]).toContain('Replaced by');
    const pdf = await exportGroup(COLLECTOR, GROUP, { format: 'pdf' });
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(db.recordAccessLog.rows.filter((r: Row) => r.action === 'EXPORT').length).toBeGreaterThanOrEqual(3);
    expect(src.id).toBeDefined();
  });

  it('masked exports shorten names', async () => {
    await commitSome();
    const csv = (await exportGroup(COLLECTOR, GROUP, { format: 'csv', mask: true })).body.toString('utf8');
    expect(csv).toContain('K. A.');
    expect(csv).not.toContain('Kemi Alade');
  });

  it('only the collector can export; members cannot', async () => {
    await expect(exportGroup(MEMBER, GROUP, { format: 'csv' })).rejects.toThrow('Only the group collector');
  });

  it('the completeness score blends committed rows, member verification and filed documents', () => {
    expect(completenessScore({ stagedRows: 0, committedRows: 0, withPerson: 0, verified: 0, foldersFilled: 0 })).toBe(0);
    expect(completenessScore({ stagedRows: 10, committedRows: 10, withPerson: 10, verified: 5, foldersFilled: 3 })).toBe(80);
    expect(completenessScore({ stagedRows: 10, committedRows: 10, withPerson: 10, verified: 10, foldersFilled: 3 })).toBe(100);
  });

  it('the nightly backup copies the encrypted vault and every records table, and prunes old ones', async () => {
    await commitSome();
    await confirmNotice();
    await createFileSource(COLLECTOR, { groupId: GROUP, kind: 'SCAN', files: [{ buffer: png, mime: 'image/png' }] });
    await fsp.mkdir(path.join(BACKUP_ROOT, 'records-2020-01-01'), { recursive: true });
    const r = await runRecordsBackup(new Date('2026-03-01T02:30:00Z'));
    expect(r.pruned).toBe(1);
    const data = JSON.parse(await fsp.readFile(path.join(r.dir, 'data.json'), 'utf8'));
    expect(data.entries.length).toBeGreaterThan(0);
    const copied = await fsp.readdir(path.join(r.dir, 'vault'));
    expect(copied.length).toBeGreaterThan(0);
    expect((await fsp.readFile(path.join(r.dir, 'vault', copied[0]))).includes(png)).toBe(false); // the backup stays encrypted
  });
});
