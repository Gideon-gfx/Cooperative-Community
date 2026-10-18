import fs from 'fs';
import path from 'path';
import { allocateDues, decide, destinationConfirmed, hasConflict, isActiveRelease, isMissed, owedSoFar, scheduleDues, tally } from '../modules/settlement/settlement.logic';
import { daysUntil, nextReminder } from '../modules/billing/billing.logic';

const d = (s: string) => new Date(s);
const K = (n: number) => BigInt(n) * 100n;

describe('the monthly schedule', () => {
  it('one due per month, the first a month after the start and the last on the end date', () => {
    const dues = scheduleDues(d('2026-01-15T00:00:00Z'), 6, K(20_000));
    expect(dues).toHaveLength(6);
    expect(dues.map((x) => x.dueDate.toISOString().slice(0, 10))).toEqual(['2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15', '2026-07-15']);
    expect(dues.every((x) => x.amountKobo === K(20_000))).toBe(true);
    expect(dues.map((x) => x.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it('month-end starts clamp: 31 January gives 28 February, then 31 March', () => {
    expect(scheduleDues(d('2026-01-31T00:00:00Z'), 3, K(1)).map((x) => x.dueDate.toISOString().slice(0, 10))).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });
  it('runs for the whole tenure', () => {
    for (const m of [6, 9, 12, 18, 24]) expect(scheduleDues(d('2026-01-01T00:00:00Z'), m, K(1))).toHaveLength(m);
  });
});

describe('matching confirmed payments to months, oldest first', () => {
  const dues = scheduleDues(d('2026-01-01T00:00:00Z'), 4, K(10_000));
  const statuses = (paid: bigint, now: string) => allocateDues(dues, paid, d(now)).map((s) => s.status);

  it('nothing paid: past months are overdue, today is due, later ones upcoming', () => {
    expect(statuses(0n, '2026-03-02T00:00:00Z')).toEqual(['OVERDUE', 'OVERDUE', 'UPCOMING', 'UPCOMING']);
    expect(statuses(0n, '2026-03-01T08:00:00Z')).toEqual(['OVERDUE', 'DUE', 'UPCOMING', 'UPCOMING']); // month 2 falls due on 1 March
  });
  it('payment fills the oldest month first', () => {
    const s = allocateDues(dues, K(15_000), d('2026-03-02T00:00:00Z'));
    expect(s.map((x) => x.paidKobo)).toEqual([K(10_000), K(5_000), 0n, 0n]);
    expect(s.map((x) => x.status)).toEqual(['PAID', 'OVERDUE', 'UPCOMING', 'UPCOMING']);
    expect(s[1].remainingKobo).toBe(K(5_000));
  });
  it('paying a month late makes it paid; paying ahead covers the next months', () => {
    expect(statuses(K(10_000), '2026-02-20T00:00:00Z')).toEqual(['PAID', 'UPCOMING', 'UPCOMING', 'UPCOMING']);
    expect(statuses(K(30_000), '2026-01-10T00:00:00Z')).toEqual(['PAID', 'PAID', 'PAID', 'UPCOMING']);
  });
  it('a part payment on a month still to come shows as partial', () => {
    expect(statuses(K(4_000), '2026-01-10T00:00:00Z')[0]).toBe('PARTIAL');
  });
  it('paying more than everything marks all paid and never goes negative', () => {
    const s = allocateDues(dues, K(999_999), d('2026-12-01T00:00:00Z'));
    expect(s.every((x) => x.status === 'PAID' && x.remainingKobo === 0n)).toBe(true);
    expect(allocateDues(dues, -5n, d('2026-01-01T00:00:00Z')).every((x) => x.paidKobo === 0n)).toBe(true);
  });
  it('adds up exactly: allocated money equals what was paid, never more', () => {
    const s = allocateDues(dues, K(25_000), d('2026-12-01T00:00:00Z'));
    expect(s.reduce((t, x) => t + x.paidKobo, 0n)).toBe(K(25_000));
  });
  it('what is owed so far is the unpaid part of every month already due', () => {
    expect(owedSoFar(allocateDues(dues, K(10_000), d('2026-03-02T00:00:00Z')), d('2026-03-02T00:00:00Z'))).toBe(K(10_000)); // month 2 unpaid; month 3 not yet due... month 3 is due 1 Apr
    expect(owedSoFar(allocateDues(dues, 0n, d('2026-04-02T00:00:00Z')), d('2026-04-02T00:00:00Z'))).toBe(K(30_000));
  });
  it('is flagged only when it is two days late AND unpaid', () => {
    const s = allocateDues(dues, 0n, d('2026-02-03T00:00:00Z'));
    expect(isMissed(s[0], d('2026-02-02T00:00:00Z'))).toBe(false); // due 1 Feb: one day late
    expect(isMissed(s[0], d('2026-02-03T00:00:00Z'))).toBe(true); // two days late
    expect(isMissed(allocateDues(dues, K(10_000), d('2026-02-03T00:00:00Z'))[0], d('2026-02-03T00:00:00Z'))).toBe(false); // paid
  });
});

describe('reminder windows: 3 days before, on the day, 2 days late', () => {
  const due = d('2026-03-10T00:00:00Z');
  const days = [3, 0, -2];
  const at = (now: string, sent: number[] = []) => nextReminder(daysUntil(due, d(now)), sent, days);
  it('nothing earlier than 3 days before', () => expect(at('2026-03-06T07:00:00Z')).toBeNull());
  it('3 days before', () => expect(at('2026-03-07T07:00:00Z')).toEqual({ send: 3, markSent: [3] }));
  it('on the day', () => expect(at('2026-03-10T07:00:00Z', [3])).toEqual({ send: 0, markSent: [0] }));
  it('one day late: nothing new', () => expect(at('2026-03-11T07:00:00Z', [3, 0])).toBeNull());
  it('two days late', () => expect(at('2026-03-12T07:00:00Z', [3, 0])).toEqual({ send: -2, markSent: [-2] }));
  it('never sent twice, and downtime sends one message, not three', () => {
    expect(at('2026-03-12T07:00:00Z', [3, 0, -2])).toBeNull();
    expect(at('2026-03-12T07:00:00Z')).toEqual({ send: -2, markSent: [3, 0, -2] });
  });
});

describe('release approvals: 2 distinct board members', () => {
  const v = (id: string, approve: boolean) => ({ approverId: id, approve });
  it('needs two different approvals', () => {
    expect(decide([v('a', true)], 2, 2)).toBe('PENDING');
    expect(decide([v('a', true), v('b', true)], 2, 2)).toBe('APPROVED');
    expect(decide([v('a', true), v('b', true), v('c', true)], 2, 2)).toBe('APPROVED');
  });
  it('one person voting twice still counts once', () => {
    expect(decide([v('a', true), v('a', true)], 2, 2)).toBe('PENDING');
  });
  it('one rejection does not stop it; two do', () => {
    expect(decide([v('a', false)], 2, 2)).toBe('PENDING');
    expect(decide([v('a', false), v('b', true)], 2, 2)).toBe('PENDING');
    expect(decide([v('a', false), v('b', false)], 2, 2)).toBe('REJECTED');
    expect(decide([v('a', false), v('b', true), v('c', true)], 2, 2)).toBe('APPROVED'); // two of three is enough
  });
  it('tallies', () => expect(tally([v('a', true), v('b', false), v('c', true)])).toEqual({ approvals: 2, rejections: 1 }));
  it('anyone with a stake in the agreement is barred from approving', () => {
    const parties = { masterId: 'm', apprenticeId: 'a', guarantorId: 'g', guardianId: 'p' };
    for (const id of ['m', 'a', 'g', 'p']) expect(hasConflict(id, parties)).toBe(true);
    expect(hasConflict('board1', parties)).toBe(false);
    expect(hasConflict('p', { ...parties, guardianId: null })).toBe(false);
  });
  it('the destination needs the graduate, and the guardian too when there is one', () => {
    const now = new Date();
    expect(destinationConfirmed({ graduateConfirmedAt: now }, null)).toBe(true);
    expect(destinationConfirmed({ graduateConfirmedAt: now }, 'p')).toBe(false);
    expect(destinationConfirmed({ graduateConfirmedAt: now, guardianConfirmedAt: now }, 'p')).toBe(true);
    expect(destinationConfirmed({ guardianConfirmedAt: now }, 'p')).toBe(false);
  });
  it('knows which release states are still live', () => {
    for (const s of ['AWAITING_DESTINATION', 'AWAITING_CONFIRMATION', 'AWAITING_APPROVALS', 'DISBURSING']) expect(isActiveRelease(s)).toBe(true);
    for (const s of ['RELEASED', 'FAILED', 'REJECTED', 'CANCELLED']) expect(isActiveRelease(s)).toBe(false);
  });
});

describe('no interest, no yield, no investors', () => {
  const dir = path.join(__dirname, '..', 'modules', 'settlement');
  const code = fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n').replace(/does not promise any return or interest/g, '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  // The one allowed mention is the plain disclaimer printed on statements: "does not promise any return or interest".
  it('the settlement code never speaks of interest, yield, returns, investors or the old 12% idea', () => {
    expect(code).not.toMatch(/\binterest\b|\byield\b|\binvestor|\bdiaspora|\bAPY\b|projected\s+return|12\s*%/i);
  });
  it('has no investor or yield endpoints', () => {
    expect(code).not.toMatch(/\.(get|post|put|patch)\(\s*'\/[^']*(invest|yield|interest|vault)/i);
  });
});
