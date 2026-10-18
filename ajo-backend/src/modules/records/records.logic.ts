import { RecordType } from '@prisma/client';
import { nairaToKobo } from '../../lib/kobo';
import { normalizePhone } from '../../lib/phone';

// Pure rules for reading old records: amounts, dates, names, quality checks. No database, so all of it is testable.

// ── Amounts ─────────────────────────────────────────────────────────────────

/** "₦12,500", "N12 500.50", "12.5k", "NGN 5,000" → kobo. Returns null if it cannot be read as money. */
export function parseAmountKobo(input: unknown): bigint | null {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/ngn|naira|₦|\bn(?=\d)/g, '').replace(/[,\s]/g, '');
  let mult = 1;
  if (/k$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  try {
    const kobo = nairaToKobo(s);
    return kobo * BigInt(mult);
  } catch {
    return null;
  }
}

// ── Dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function validDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt : null;
}
const monthNumber = (w: string) => MONTHS[w.slice(0, 4).toLowerCase()] ?? MONTHS[w.slice(0, 3).toLowerCase()];
const fullYear = (y: number) => (y >= 100 ? y : y > 50 ? 1900 + y : 2000 + y);

/**
 * Reads the dates people actually write: 14/03/2023, 14-3-23, 14.03.2023, 2023-03-14, 14 March 2023, March 14, 2023.
 * Numeric dates are DAY first (the Nigerian way). An impossible date (31/02) returns null instead of rolling over.
 */
export function parseDate(input: unknown): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input;
  const s = String(input ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) return validDate(fullYear(+m[3]), +m[2], +m[1]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?,?[\s-]+(\d{2,4})$/i);
  if (m) {
    const mo = monthNumber(m[2]);
    return mo ? validDate(fullYear(+m[3]), mo, +m[1]) : null;
  }
  m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/i);
  if (m) {
    const mo = monthNumber(m[1]);
    return mo ? validDate(fullYear(+m[3]), mo, +m[2]) : null;
  }
  return null;
}

export const EARLIEST_PLAUSIBLE = new Date(Date.UTC(1950, 0, 1));

// ── Names ───────────────────────────────────────────────────────────────────

const HONORIFICS = new Set(['mama', 'baba', 'alhaja', 'alhaji', 'chief', 'mrs', 'mr', 'miss', 'madam', 'iya', 'iyá', 'ìyá', 'pastor', 'dr', 'prof', 'engr', 'hon', 'elder', 'deacon', 'evang', 'ms', 'sir', 'oba', 'otunba', 'ọba', 'ìyálọ́jà', 'iyaloja']);

/** Folds Yorùbá tone marks and under-dots so "Ọlájídé", "Olajide" and "OLAJIDE" compare as the same name. */
export function foldName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ọ/gi, 'o').replace(/ẹ/gi, 'e').replace(/ṣ/gi, 's').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function nameTokens(name: string): string[] {
  return foldName(name).split(' ').filter((t) => t && !HONORIFICS.has(t));
}

/** Tidy for display: NFC, single spaces, trimmed. Keeps the person's own diacritics. */
export const tidyName = (name: string) => name.normalize('NFC').replace(/\s+/g, ' ').trim();

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; matches++; break; }
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) if (am[i]) { while (!bm[k]) k++; if (a[i] !== b[k]) t++; k++; }
  return (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
}

function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  let p = 0;
  while (p < Math.min(4, a.length, b.length) && a[p] === b[p]) p++;
  return j + p * 0.1 * (1 - j);
}

/** 0..1. Order-insensitive ("Bello Ade" = "Ade Bello"), tolerant of spelling slips, blind to tone marks and honorifics. */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;
  const sorted = (t: string[]) => [...t].sort().join(' ');
  const whole = Math.max(jaroWinkler(ta.join(' '), tb.join(' ')), jaroWinkler(sorted(ta), sorted(tb)));
  // One name that is a full subset of the other ("Kemi Alade" vs "Kemi") is a weaker match than equality.
  const subset = ta.every((t) => tb.includes(t)) || tb.every((t) => ta.includes(t));
  return subset && whole < 0.9 ? Math.max(whole, 0.86) : whole;
}

export interface MemberCandidate { id: string; kind: 'USER' | 'LEGACY'; name: string; phone?: string | null }
export interface MemberMatch { status: 'MATCHED' | 'AMBIGUOUS' | 'NEW'; candidate?: MemberCandidate; score: number; others?: MemberCandidate[] }

export const MATCH_AUTO = 0.92;
export const MATCH_MAYBE = 0.85;

/** A phone number match is certain. Otherwise one strong name match is accepted; several close ones are left for a person to choose. */
export function matchMember(name: string, phone: string | null | undefined, candidates: MemberCandidate[]): MemberMatch {
  if (phone) {
    const byPhone = candidates.find((c) => c.phone && c.phone === phone);
    if (byPhone) return { status: 'MATCHED', candidate: byPhone, score: 1 };
  }
  const scored = candidates.map((c) => ({ c, s: nameSimilarity(name, c.name) })).filter((x) => x.s >= MATCH_MAYBE).sort((a, b) => b.s - a.s);
  if (!scored.length) return { status: 'NEW', score: 0 };
  const close = scored.filter((x) => x.s >= MATCH_MAYBE);
  if (scored[0].s >= MATCH_AUTO && (close.length === 1 || scored[0].s - scored[1].s >= 0.05)) return { status: 'MATCHED', candidate: scored[0].c, score: scored[0].s };
  return { status: 'AMBIGUOUS', candidate: scored[0].c, score: scored[0].s, others: scored.slice(1).map((x) => x.c) };
}

// ── Rows ────────────────────────────────────────────────────────────────────

export const FIELDS: Record<RecordType, { required: string[]; optional: string[] }> = {
  MEMBERS: { required: ['name'], optional: ['phone', 'joinDate'] },
  CONTRIBUTIONS: { required: ['name', 'date', 'amount'], optional: ['cycleLabel', 'phone'] },
  PAYOUTS: { required: ['name', 'date', 'amount'], optional: ['cycleLabel', 'phone'] },
  ARREARS: { required: ['name', 'amount'], optional: ['asOf', 'phone'] },
  OPENING_POSITION: { required: ['name', 'amount'], optional: ['asOf', 'payoutOrder', 'receivedPayout', 'phone'] },
};

export interface ParsedRow {
  name: string;
  phone?: string | null;
  joinDate?: string | null;
  date?: string | null;
  asOf?: string | null;
  amountKobo?: string | null;
  cycleLabel?: string | null;
  payoutOrder?: number | null;
  receivedPayout?: boolean | null;
}

export const LOW_CONFIDENCE = 0.75;

/**
 * Turns one raw row (what OCR read, what was typed, or a spreadsheet line) into clean values plus a list of issues.
 * Issues never block: they are shown to the reviewer, who decides.
 */
export function parseRow(recordType: RecordType, raw: Record<string, unknown>, ctx: { country: string; now?: Date }, confidence: Record<string, number> = {}) {
  const now = ctx.now ?? new Date();
  const issues: string[] = [];
  const f = FIELDS[recordType];
  const str = (k: string) => (raw[k] === undefined || raw[k] === null ? '' : String(raw[k]).trim());
  const out: ParsedRow = { name: tidyName(str('name')) };
  if (!out.name) issues.push('MISSING_NAME');

  const dateField = (k: 'date' | 'joinDate' | 'asOf', required: boolean) => {
    const v = str(k);
    if (!v) { if (required) issues.push('MISSING_DATE'); return null; }
    const d = parseDate(v);
    if (!d) { issues.push('BAD_DATE'); return null; }
    if (d.getTime() > now.getTime() + 24 * 3600_000) issues.push('FUTURE_DATE');
    if (d < EARLIEST_PLAUSIBLE) issues.push('IMPLAUSIBLE_DATE');
    return d.toISOString().slice(0, 10);
  };
  if (f.required.includes('date') || f.optional.includes('date')) out.date = dateField('date', f.required.includes('date'));
  if (f.optional.includes('joinDate')) out.joinDate = dateField('joinDate', false);
  if (f.optional.includes('asOf')) out.asOf = dateField('asOf', false);

  if (f.required.includes('amount') || f.optional.includes('amount')) {
    const v = str('amount');
    if (!v) issues.push('MISSING_AMOUNT');
    else {
      const k = parseAmountKobo(v);
      if (k === null) issues.push('BAD_AMOUNT');
      else if (k <= 0n && recordType !== 'ARREARS') issues.push('BAD_AMOUNT');
      else out.amountKobo = k.toString();
    }
  }
  if (f.optional.includes('phone')) {
    const v = str('phone');
    if (v) {
      const p = normalizePhone(v, ctx.country);
      if (p) out.phone = p;
      else issues.push('BAD_PHONE');
    }
  }
  if (f.optional.includes('cycleLabel')) out.cycleLabel = str('cycleLabel') || null;
  if (f.optional.includes('payoutOrder')) {
    const v = str('payoutOrder');
    if (v) { const n = Number(v); if (Number.isInteger(n) && n > 0) out.payoutOrder = n; else issues.push('BAD_PAYOUT_ORDER'); }
  }
  if (f.optional.includes('receivedPayout')) {
    const v = str('receivedPayout').toLowerCase();
    if (v) out.receivedPayout = ['yes', 'y', 'true', '1', 'received'].includes(v) ? true : ['no', 'n', 'false', '0'].includes(v) ? false : null;
  }
  // Handwriting is unreliable: anything the reader was unsure about is called out so it gets a second look.
  for (const [field, c] of Object.entries(confidence)) if (c < LOW_CONFIDENCE) issues.push(`LOW_CONFIDENCE:${field}`);
  return { parsed: out, issues: [...new Set(issues)] };
}

export const ISSUE_TEXT: Record<string, string> = {
  MISSING_NAME: 'No name', MISSING_DATE: 'No date', BAD_DATE: 'The date could not be read', FUTURE_DATE: 'The date is in the future', IMPLAUSIBLE_DATE: 'The date is before 1950',
  MISSING_AMOUNT: 'No amount', BAD_AMOUNT: 'The amount could not be read', BAD_PHONE: 'The phone number is not valid', BAD_PAYOUT_ORDER: 'The payout order is not a whole number',
  DUPLICATE_IN_BATCH: 'The same entry appears twice in this import', DUPLICATE_EXISTING: 'This entry is already in your records', AMOUNT_OUTLIER: 'The amount is very different from the others',
  CYCLE_TOTAL_MISMATCH: 'The total for this cycle does not equal members × contribution', AMBIGUOUS_MEMBER: 'Could be more than one member: please choose', UNMATCHED_MEMBER: 'A new person: they will be added as a legacy member',
};

// ── Batch-level checks ──────────────────────────────────────────────────────

export const dupKey = (kind: string, p: ParsedRow) => [kind, foldName(p.name), p.date ?? p.asOf ?? '', p.amountKobo ?? '', (p.cycleLabel ?? '').toLowerCase()].join('|');

const median = (xs: bigint[]) => { const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); return s[Math.floor(s.length / 2)]; };

/**
 * Looks across the whole batch: repeats, repeats of what is already saved, amounts far from the pattern, and cycles whose
 * total is not members x contribution. Returns extra issues per row index.
 */
export function batchChecks(recordType: RecordType, rows: ParsedRow[], existingKeys: Set<string> = new Set()): string[][] {
  const extra: string[][] = rows.map(() => []);
  const seen = new Map<string, number>();
  rows.forEach((p, i) => {
    if (recordType === 'MEMBERS') return;
    const k = dupKey(recordType, p);
    if (seen.has(k)) { extra[i].push('DUPLICATE_IN_BATCH'); extra[seen.get(k)!].includes('DUPLICATE_IN_BATCH') || extra[seen.get(k)!].push('DUPLICATE_IN_BATCH'); } else seen.set(k, i);
    if (existingKeys.has(k)) extra[i].push('DUPLICATE_EXISTING');
  });
  if (recordType === 'MEMBERS') {
    const names = new Map<string, number>();
    rows.forEach((p, i) => { const k = foldName(p.name); if (names.has(k)) { extra[i].push('DUPLICATE_IN_BATCH'); extra[names.get(k)!].push('DUPLICATE_IN_BATCH'); } else names.set(k, i); });
    return extra.map((e) => [...new Set(e)]);
  }

  const amounts = rows.map((p) => (p.amountKobo ? BigInt(p.amountKobo) : null)).filter((x): x is bigint => x !== null && x > 0n);
  if (amounts.length >= 5) {
    const med = median(amounts);
    rows.forEach((p, i) => { if (p.amountKobo) { const a = BigInt(p.amountKobo); if (a > 0n && (a > med * 20n || a * 20n < med)) extra[i].push('AMOUNT_OUTLIER'); } });
  }

  if (recordType === 'CONTRIBUTIONS') {
    const members = new Set(rows.map((p) => foldName(p.name)).filter(Boolean)).size;
    const byCycle = new Map<string, number[]>();
    rows.forEach((p, i) => { if (p.cycleLabel && p.amountKobo) byCycle.set(p.cycleLabel.toLowerCase(), [...(byCycle.get(p.cycleLabel.toLowerCase()) ?? []), i]); });
    if (byCycle.size >= 2 && members >= 2) {
      const modal = (() => { const c = new Map<string, number>(); for (const p of rows) if (p.amountKobo) c.set(p.amountKobo, (c.get(p.amountKobo) ?? 0) + 1); return BigInt([...c.entries()].sort((a, b) => b[1] - a[1])[0][0]); })();
      for (const idxs of byCycle.values()) {
        const total = idxs.reduce((s, i) => s + BigInt(rows[i].amountKobo!), 0n);
        if (total !== modal * BigInt(members)) idxs.forEach((i) => extra[i].push('CYCLE_TOTAL_MISMATCH'));
      }
    }
  }
  return extra.map((e) => [...new Set(e)]);
}

// ── Spreadsheet helpers ─────────────────────────────────────────────────────

/** Minimal CSV reader: quotes, escaped quotes, commas and newlines inside quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** Applies the wizard's column mapping (our field → their header) to a table whose first row is the header. */
export function applyMapping(table: string[][], mapping: Record<string, string>): Record<string, string>[] {
  const [header, ...body] = table;
  const idx = Object.fromEntries(Object.entries(mapping).map(([field, col]) => [field, header.findIndex((h) => h.trim().toLowerCase() === col.trim().toLowerCase())]));
  const missing = Object.entries(idx).filter(([, i]) => i < 0).map(([f]) => f);
  if (missing.length) throw new Error(`Column not found for: ${missing.join(', ')}`);
  return body.map((r) => Object.fromEntries(Object.entries(idx).map(([field, i]) => [field, (r[i] ?? '').trim()])));
}

/** Guesses a mapping from common header words, so the wizard starts filled in. */
export function guessMapping(header: string[], recordType: RecordType): Record<string, string> {
  const want: Record<string, RegExp> = {
    name: /name|member|person|oníbàárà/i, phone: /phone|mobile|tel|gsm/i, date: /^date|paid on|when/i, amount: /amount|amt|paid|sum|₦|naira|contribution/i,
    cycleLabel: /cycle|week|month|round|turn/i, joinDate: /join|since|started/i, asOf: /as of|asof|balance date/i, payoutOrder: /order|position|turn no/i, receivedPayout: /received|collected|has collected/i,
  };
  const f = FIELDS[recordType];
  const out: Record<string, string> = {};
  for (const field of [...f.required, ...f.optional]) { const h = header.find((x) => want[field]?.test(x) && !Object.values(out).includes(x)); if (h) out[field] = h; }
  return out;
}

export function templateCsv(recordType: RecordType): string {
  const f = FIELDS[recordType];
  const cols = [...f.required, ...f.optional];
  const example: Record<string, string> = { name: 'Adé Bello', phone: '0803 123 4567', date: '14/03/2023', amount: '5000', cycleLabel: 'Week 3', joinDate: '01/01/2020', asOf: '01/01/2024', payoutOrder: '4', receivedPayout: 'no' };
  return `${cols.join(',')}\n${cols.map((c) => example[c] ?? '').join(',')}\n`;
}

// ── OCR scoring (for the bake-off) ──────────────────────────────────────────

/** Field-level accuracy of OCR rows against a hand-keyed answer: rows are paired by closest name, each field compared once. */
export function scoreOcr(predicted: Record<string, string>[], expected: Record<string, string>[], fields: string[]) {
  const used = new Set<number>();
  let correct = 0, total = 0;
  const perField: Record<string, { correct: number; total: number }> = Object.fromEntries(fields.map((f) => [f, { correct: 0, total: 0 }]));
  for (const e of expected) {
    let best = -1, bs = 0;
    predicted.forEach((p, i) => { if (used.has(i)) return; const s = nameSimilarity(p.name ?? '', e.name ?? ''); if (s > bs) { bs = s; best = i; } });
    const p = best >= 0 && bs >= 0.7 ? predicted[best] : null;
    if (p) used.add(best);
    for (const f of fields) {
      total++; perField[f].total++;
      const ok = p && (f === 'name' ? nameSimilarity(p.name ?? '', e.name ?? '') >= 0.92 : f === 'amount' ? parseAmountKobo(p.amount) === parseAmountKobo(e.amount) : f.toLowerCase().includes('date') ? parseDate(p[f])?.getTime() === parseDate(e[f])?.getTime() : String(p[f] ?? '').trim().toLowerCase() === String(e[f] ?? '').trim().toLowerCase());
      if (ok) { correct++; perField[f].correct++; }
    }
  }
  return { correct, total, accuracy: total ? correct / total : 0, extraRows: predicted.length - used.size, perField };
}
