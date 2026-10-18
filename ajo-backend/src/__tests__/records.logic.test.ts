import os from 'os';
import path from 'path';
process.env.RECORDS_VAULT_DIR = path.join(os.tmpdir(), `vault-test-${process.pid}`);
process.env.RECORDS_ENCRYPTION_KEY = 'a'.repeat(64);

import fs from 'fs/promises';
import { applyMapping, batchChecks, dupKey, foldName, guessMapping, matchMember, nameSimilarity, parseAmountKobo, parseCsv, parseDate, parseRow, scoreOcr, templateCsv, type ParsedRow } from '../modules/records/records.logic';
import { parseLedgerText } from '../modules/records/ocr.provider';
import { decrypt, encrypt, signFileToken, VAULT_ROOT, vaultGet, vaultPut, verifyFileToken } from '../modules/records/vault';

const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
afterAll(() => fs.rm(VAULT_ROOT, { recursive: true, force: true }));

describe('amounts as people write them', () => {
  it('reads naira written many ways, exactly', () => {
    for (const [input, kobo] of [['₦12,500', 1_250_000n], ['N5000', 500_000n], ['NGN 5,000.50', 500_050n], ['12 500', 1_250_000n], ['5k', 500_000n], ['12.5k', 1_250_000n], [5000, 500_000n], ['  7,000 naira ', 700_000n]] as const) {
      expect(parseAmountKobo(input)).toBe(kobo);
    }
  });
  it('refuses what is not money', () => {
    for (const bad of ['', 'abc', '5,00x', '1.234', null, undefined, '--5', '12/03']) expect(parseAmountKobo(bad as never)).toBeNull();
  });
});

describe('dates as people write them (day first)', () => {
  it('reads the common styles', () => {
    expect(iso(parseDate('14/03/2023'))).toBe('2023-03-14');
    expect(iso(parseDate('14-3-23'))).toBe('2023-03-14');
    expect(iso(parseDate('14.03.2023'))).toBe('2023-03-14');
    expect(iso(parseDate('2023-03-14'))).toBe('2023-03-14');
    expect(iso(parseDate('14 March 2023'))).toBe('2023-03-14');
    expect(iso(parseDate('14th Mar, 2023'))).toBe('2023-03-14');
    expect(iso(parseDate('March 14, 2023'))).toBe('2023-03-14');
    expect(iso(parseDate('05/04/2021'))).toBe('2021-04-05'); // 5 April, not 4 May
    expect(iso(parseDate('1/1/99'))).toBe('1999-01-01');
  });
  it('an impossible date is rejected, never rolled over', () => {
    for (const bad of ['31/02/2023', '32/01/2023', '00/05/2023', '14/13/2023', 'soon', '']) expect(parseDate(bad)).toBeNull();
  });
});

describe('names: Yorùbá marks, honorifics, order, spelling slips', () => {
  it('folds tone marks and under-dots', () => {
    expect(foldName('Ọlájídé Ṣadé')).toBe('olajide sade');
    expect(foldName('Àbáké')).toBe('abake');
  });
  it('treats the same person written differently as a match', () => {
    expect(nameSimilarity('Ọlájídé Bello', 'Olajide Bello')).toBeGreaterThan(0.95);
    expect(nameSimilarity('Bello Ade', 'Ade Bello')).toBeGreaterThan(0.95);
    expect(nameSimilarity('Mama Bísí Adéwálé', 'Bisi Adewale')).toBeGreaterThan(0.95);
    expect(nameSimilarity('Adebayo Kemi', 'Adebayo Kemmi')).toBeGreaterThan(0.9);
  });
  it('keeps different people apart', () => {
    expect(nameSimilarity('Adebayo Kemi', 'Okafor Chidi')).toBeLessThan(0.7);
    expect(nameSimilarity('Ade Bello', 'Ade Balogun')).toBeLessThan(0.92);
  });
  it('a phone number is a certain match; one strong name is accepted; several close ones are left to a person', () => {
    const c = [{ id: 'u1', kind: 'USER' as const, name: 'Kemi Alade', phone: '+2348031234567' }, { id: 'l1', kind: 'LEGACY' as const, name: 'Ade Bello', phone: null }, { id: 'l2', kind: 'LEGACY' as const, name: 'Ade Bellow', phone: null }];
    expect(matchMember('Someone Else', '+2348031234567', c)).toMatchObject({ status: 'MATCHED', score: 1, candidate: { id: 'u1' } });
    expect(matchMember('Kemi Alade', null, c)).toMatchObject({ status: 'MATCHED', candidate: { id: 'u1' } });
    expect(matchMember('Ade Bello', null, c).status).toBe('AMBIGUOUS');
    expect(matchMember('Chidi Okafor', null, c).status).toBe('NEW');
  });
});

describe('reading a row', () => {
  const ctx = { country: 'NG', now: new Date('2026-06-01T00:00:00Z') };
  it('cleans a contribution row', () => {
    const { parsed, issues } = parseRow('CONTRIBUTIONS', { name: '  Mama  Bísí ', date: '14/03/2023', amount: '₦5,000', cycleLabel: 'Week 3' }, ctx);
    expect(parsed).toMatchObject({ name: 'Mama Bísí', date: '2023-03-14', amountKobo: '500000', cycleLabel: 'Week 3' });
    expect(issues).toEqual([]);
  });
  it('flags every problem without throwing', () => {
    expect(parseRow('CONTRIBUTIONS', { name: '', date: '31/02/2023', amount: 'lots' }, ctx).issues).toEqual(expect.arrayContaining(['MISSING_NAME', 'BAD_DATE', 'BAD_AMOUNT']));
    expect(parseRow('CONTRIBUTIONS', { name: 'A', date: '01/01/2030', amount: '100' }, ctx).issues).toContain('FUTURE_DATE');
    expect(parseRow('CONTRIBUTIONS', { name: 'A', date: '01/01/1940', amount: '100' }, ctx).issues).toContain('IMPLAUSIBLE_DATE');
    expect(parseRow('CONTRIBUTIONS', { name: 'A', date: '01/01/2020', amount: '0' }, ctx).issues).toContain('BAD_AMOUNT');
    expect(parseRow('MEMBERS', { name: 'A', phone: '12345' }, ctx).issues).toContain('BAD_PHONE');
  });
  it('normalises phone numbers to +234', () => {
    expect(parseRow('MEMBERS', { name: 'Kemi', phone: '0803 123 4567', joinDate: '1/1/2020' }, ctx).parsed).toMatchObject({ phone: '+2348031234567', joinDate: '2020-01-01' });
  });
  it('the reader\'s doubts become low-confidence flags', () => {
    expect(parseRow('CONTRIBUTIONS', { name: 'Kemi', date: '1/1/2020', amount: '500' }, ctx, { name: 0.95, amount: 0.4 }).issues).toEqual(['LOW_CONFIDENCE:amount']);
  });
  it('arrears and opening positions have their own fields', () => {
    expect(parseRow('ARREARS', { name: 'Kemi', amount: '2000', asOf: '1/1/2024' }, ctx).parsed).toMatchObject({ amountKobo: '200000', asOf: '2024-01-01' });
    expect(parseRow('OPENING_POSITION', { name: 'Kemi', amount: '30000', payoutOrder: '4', receivedPayout: 'No' }, ctx).parsed).toMatchObject({ payoutOrder: 4, receivedPayout: false });
  });
});

describe('batch-level checks', () => {
  const p = (name: string, date: string, amountKobo: string, cycleLabel?: string): ParsedRow => ({ name, date, amountKobo, cycleLabel });
  it('finds duplicates inside the batch (both copies are marked)', () => {
    const r = batchChecks('CONTRIBUTIONS', [p('Kemi Ade', '2023-03-14', '500000'), p('Bola', '2023-03-14', '500000'), p('Ọ̀kẹ́mi', '2023-03-14', '500000'), p('kemi ade', '2023-03-14', '500000')]);
    expect(r[0]).toContain('DUPLICATE_IN_BATCH');
    expect(r[3]).toContain('DUPLICATE_IN_BATCH');
    expect(r[1]).not.toContain('DUPLICATE_IN_BATCH');
  });
  it('finds entries that are already saved', () => {
    const rows = [p('Kemi Ade', '2023-03-14', '500000')];
    const existing = new Set([dupKey('CONTRIBUTIONS', rows[0])]);
    expect(batchChecks('CONTRIBUTIONS', rows, existing)[0]).toContain('DUPLICATE_EXISTING');
  });
  it('flags an amount far from the pattern', () => {
    const rows = ['500000', '500000', '500000', '500000', '500000', '50000000'].map((a, i) => p(`Member ${i}`, '2023-03-14', a));
    const r = batchChecks('CONTRIBUTIONS', rows);
    expect(r[5]).toContain('AMOUNT_OUTLIER');
    expect(r[0]).not.toContain('AMOUNT_OUTLIER');
  });
  it('flags a cycle whose total is not members x contribution', () => {
    const rows = [
      p('A One', '2023-01-07', '500000', 'Week 1'), p('B Two', '2023-01-07', '500000', 'Week 1'), p('C Three', '2023-01-07', '500000', 'Week 1'),
      p('A One', '2023-01-14', '500000', 'Week 2'), p('B Two', '2023-01-14', '500000', 'Week 2'), // C Three is missing from week 2
    ];
    const r = batchChecks('CONTRIBUTIONS', rows);
    expect(r[3]).toContain('CYCLE_TOTAL_MISMATCH');
    expect(r[0]).not.toContain('CYCLE_TOTAL_MISMATCH');
  });
  it('a members list is checked for the same person twice', () => {
    const r = batchChecks('MEMBERS', [{ name: 'Ọlá Bello' }, { name: 'Ola Bello' }, { name: 'Tunde' }]);
    expect(r[0]).toContain('DUPLICATE_IN_BATCH');
    expect(r[2]).toEqual([]);
  });
});

describe('spreadsheets', () => {
  it('reads CSV with quotes, commas, newlines and a byte-order mark', () => {
    const t = parseCsv('﻿Name,Amount\r\n"Bello, Ade","5,000"\r\n"Say ""hi""",100\r\n\r\n');
    expect(t).toEqual([['Name', 'Amount'], ['Bello, Ade', '5,000'], ['Say "hi"', '100']]);
  });
  it('maps their columns to ours, and says which column is missing', () => {
    const table = [['Full Name', 'Amt Paid', 'When'], ['Ade', '5000', '1/1/2023']];
    expect(applyMapping(table, { name: 'full name', amount: 'Amt Paid', date: 'When' })).toEqual([{ name: 'Ade', amount: '5000', date: '1/1/2023' }]);
    expect(() => applyMapping(table, { name: 'Who' })).toThrow('name');
  });
  it('guesses a mapping to start the wizard', () => {
    expect(guessMapping(['Member Name', 'Phone No', 'Date', 'Amount Paid', 'Week'], 'CONTRIBUTIONS')).toMatchObject({ name: 'Member Name', date: 'Date', amount: 'Amount Paid', cycleLabel: 'Week' });
  });
  it('every record type has a downloadable template that matches its fields', () => {
    expect(templateCsv('CONTRIBUTIONS').split('\n')[0]).toBe('name,date,amount,cycleLabel,phone');
    expect(templateCsv('MEMBERS').split('\n')[0]).toBe('name,phone,joinDate');
  });
});

describe('OCR helpers', () => {
  it('parses loose ledger lines at low confidence', () => {
    const rows = parseLedgerText('Mama Bisi   14/03/2023   ₦5,000\nIya Tunde 14/03/2023 N2500\n--\nTotal', 'CONTRIBUTIONS');
    expect(rows).toHaveLength(2);
    expect(rows[0].fields).toMatchObject({ name: 'Mama Bisi', date: '14/03/2023', amount: '₦5,000' });
    expect(rows[0].confidence.name).toBeLessThan(0.75);
  });
  it('scores field-level accuracy against a hand-keyed answer', () => {
    const expected = [{ name: 'Adé Bello', date: '14/03/2023', amount: '5000' }, { name: 'Kemi Alade', date: '14/03/2023', amount: '2500' }];
    const predicted = [{ name: 'Olu Extra', date: '1/1/2020', amount: '1' }, { name: 'Ade Bello', date: '14-3-2023', amount: '₦5,000' }, { name: 'Kemi Alade', date: '14/03/2023', amount: '2,000' }];
    const s = scoreOcr(predicted, expected, ['name', 'date', 'amount']);
    expect(s).toMatchObject({ correct: 5, total: 6, extraRows: 1 });
    expect(s.perField.amount).toEqual({ correct: 1, total: 2 });
  });
});

describe('the vault', () => {
  it('encrypts: ciphertext is not the plaintext, differs every time, and round-trips', () => {
    const plain = Buffer.from('Mama Bisi paid ₦5,000 on 14/03/2023');
    const a = encrypt(plain), b = encrypt(plain);
    expect(a.includes(plain)).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(decrypt(a).equals(plain)).toBe(true);
  });
  it('detects tampering', () => {
    const blob = encrypt(Buffer.from('original page'));
    blob[blob.length - 1] ^= 1;
    expect(() => decrypt(blob)).toThrow();
  });
  it('stores only ciphertext, in a folder that is not served as static files', async () => {
    const key = await vaultPut(Buffer.from('scan bytes'));
    expect(key).toMatch(/\.enc$/);
    const onDisk = await fs.readFile(path.join(VAULT_ROOT, key));
    expect(onDisk.includes(Buffer.from('scan bytes'))).toBe(false);
    expect((await vaultGet(key)).toString()).toBe('scan bytes');
    expect(VAULT_ROOT.includes(`${path.sep}uploads`)).toBe(false); // /files serves uploads/; the vault must never be inside it
    await expect(vaultGet('../../etc/passwd')).rejects.toThrow('Bad file key');
  });
  it('signed links work for ten minutes, then expire, and cannot be forged', () => {
    const now = Date.now();
    const t = signFileToken({ pageId: 'p1', groupId: 'g1', uid: 'u1' }, now);
    expect(verifyFileToken(t, now + 5 * 60_000)).toMatchObject({ pageId: 'p1', groupId: 'g1', uid: 'u1' });
    expect(() => verifyFileToken(t, now + 11 * 60_000)).toThrow('expired');
    const [body] = t.split('.');
    expect(() => verifyFileToken(`${body}.AAAA`)).toThrow('Invalid');
    const forged = Buffer.from(JSON.stringify({ pageId: 'p2', groupId: 'g1', uid: 'u1', exp: Math.floor(now / 1000) + 600 })).toString('base64url');
    expect(() => verifyFileToken(`${forged}.${t.split('.')[1]}`)).toThrow('Invalid');
  });
});
