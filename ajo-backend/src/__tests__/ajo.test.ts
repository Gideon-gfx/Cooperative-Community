import { Prisma } from '@prisma/client';
import {
  calculateAjoFees, computeTrustScore, expandSlots, nextMemberStatus, overdueAfterGrace, payoutDateFor, remainingToPay, shuffle,
} from '../modules/ajo/ajo.logic';
import { checkPinHash, hashPin, isValidPin } from '../lib/security';
import { normalizePhone } from '../lib/phone';
import { LANG_CODES, t } from '../lib/i18n';
import { money } from '../lib/money';
import { toCsv } from '../services/ledger.service';

describe('Àjọ payout rotation', () => {
  it('shuffle yields a non-repeating sequence covering every member', () => {
    const members = Array.from({ length: 12 }, (_, i) => `user-${i}`);
    for (let run = 0; run < 50; run++) {
      const order = shuffle(members);
      expect(new Set(order).size).toBe(members.length);
      expect([...order].sort()).toEqual([...members].sort());
    }
    expect(members[0]).toBe('user-0'); // input not mutated
  });

  it('computes payout dates per frequency', () => {
    const start = new Date('2026-01-31T00:00:00Z');
    expect(payoutDateFor(start, 'DAILY', 3).toISOString()).toBe('2026-02-03T00:00:00.000Z');
    expect(payoutDateFor(start, 'WEEKLY', 2).toISOString()).toBe('2026-02-14T00:00:00.000Z');
    expect(payoutDateFor(new Date('2026-01-15T00:00:00Z'), 'MONTHLY', 2).toISOString()).toBe('2026-03-15T00:00:00.000Z');
  });

  it('a member with 2 hands gets 2 payout slots', () => {
    const slots = expandSlots(['a', 'b', 'c'], { b: 2 });
    expect(slots).toHaveLength(4);
    expect(slots.filter((s) => s === 'b')).toHaveLength(2);
  });
});

describe('fee calculation', () => {
  it('₦500,000 at 5% platform + 2% collector → ₦465,000 net', () => {
    expect(calculateAjoFees(500000, 5, 2)).toEqual({ platformFee: 25000, collectorFee: 10000, netPayout: 465000 });
  });
  it('facilitator default: no platform fee, collector keeps their 2%', () => {
    expect(calculateAjoFees(100000, 0, 2)).toEqual({ platformFee: 0, collectorFee: 2000, netPayout: 98000 });
  });
});

describe('defaulter flagging', () => {
  it('first miss → WARNED, second → DEFAULTER', () => {
    const first = nextMemberStatus('CLEAN');
    expect(first).toBe('WARNED');
    expect(nextMemberStatus(first)).toBe('DEFAULTER');
    expect(nextMemberStatus('DEFAULTER')).toBe('DEFAULTER');
  });

  it('respects the pool grace period', () => {
    const due = new Date('2026-03-10T12:00:00Z');
    expect(overdueAfterGrace(due, 2, new Date('2026-03-11T12:00:00Z'))).toBe(false);
    expect(overdueAfterGrace(due, 2, new Date('2026-03-12T12:01:00Z'))).toBe(true);
    expect(overdueAfterGrace(due, 0, new Date('2026-03-10T12:01:00Z'))).toBe(true);
  });
});

describe('instalments', () => {
  it('counts verified and pending money against what is still owed', () => {
    expect(remainingToPay(5000, 2000, 1000)).toBe(2000);
    expect(remainingToPay(5000, 5000, 0)).toBe(0);
    expect(remainingToPay(5000, 4000, 2000)).toBe(0); // never negative
  });
});

describe('trust score', () => {
  it('new members are labelled NEW, not punished', () => {
    expect(computeTrustScore({ verified: 0, onTime: 0, late: 0, missed: 0, completedPools: 0 }).label).toBe('NEW');
    expect(computeTrustScore({ verified: 2, onTime: 2, late: 0, missed: 0, completedPools: 0 }).label).toBe('NEW');
  });
  it('rewards on-time payment, half-credits late, zero for missed', () => {
    expect(computeTrustScore({ verified: 10, onTime: 10, late: 0, missed: 0, completedPools: 1 })).toMatchObject({ score: 100, label: 'GOOD' });
    expect(computeTrustScore({ verified: 8, onTime: 6, late: 2, missed: 0, completedPools: 0 })).toMatchObject({ score: 88, label: 'FAIR' });
    expect(computeTrustScore({ verified: 6, onTime: 3, late: 3, missed: 4, completedPools: 0 }).label).toBe('RISKY');
  });
});

describe('contribution uniqueness', () => {
  it('schema enforces one contribution per (schedule, contributor)', () => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'AjoContribution')!;
    const unique = [...model.uniqueFields, ...model.uniqueIndexes.map((i) => i.fields)];
    expect(unique).toContainEqual(['scheduleId', 'contributorId']);
  });
});

describe('PIN security', () => {
  it('accepts exactly 4 digits', () => {
    expect(isValidPin('1357')).toBe(true);
    for (const bad of ['123', '12345', 'abcd', '', undefined, 1357]) expect(isValidPin(bad)).toBe(false);
  });
  it('hashes with a salt and verifies', () => {
    const h = hashPin('2468');
    expect(h).not.toContain('2468');
    expect(checkPinHash('2468', h)).toBe(true);
    expect(checkPinHash('2469', h)).toBe(false);
    expect(hashPin('2468')).not.toBe(h); // salted
  });
});

describe('multi-country phone numbers', () => {
  it('normalises Nigeria, Ghana and Kenya', () => {
    expect(normalizePhone('0803 123 4567', 'NG')).toBe('+2348031234567');
    expect(normalizePhone('+2348031234567', 'NG')).toBe('+2348031234567');
    expect(normalizePhone('0241234567', 'GH')).toBe('+233241234567');
    expect(normalizePhone('0712345678', 'KE')).toBe('+254712345678');
  });
  it('rejects numbers from the wrong country or too short', () => {
    expect(normalizePhone('0241234567', 'NG')).toBeNull();
    expect(normalizePhone('080312', 'NG')).toBeNull();
  });
});

describe('languages & currency', () => {
  it('every language falls back to English for missing keys and fills placeholders', () => {
    for (const l of LANG_CODES) {
      expect(t(l, 'ussd.menu')).toContain('1.');
      expect(t(l, 'ussd.turn', { amount: '₦5,000', date: '1 Jan', pool: 'P' })).not.toContain('{');
    }
    expect(t('PCM', 'ussd.noDue')).not.toBe(t('EN', 'ussd.noDue'));
  });
  it('formats each currency', () => {
    expect(money(5000, 'NGN')).toBe('₦5,000');
    expect(money(20, 'GHS')).toBe('GH₵20');
    expect(money(1500, 'KES')).toBe('KSh 1,500');
    expect(money(10, 'XOF')).toBe('XOF 10');
  });
});

describe('CSV export', () => {
  it('escapes commas, quotes and newlines', () => {
    expect(toCsv([['a,b', 'say "hi"', 'x\ny', 5, null]])).toBe('"a,b","say ""hi""","x\ny",5,');
  });
});
