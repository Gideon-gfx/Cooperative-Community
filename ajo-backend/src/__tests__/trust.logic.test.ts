import { computeTrust, HONESTY_PENALTY, MIN_EVIDENCE, onTimeDues, publicView, ratingToPercent, ratio, tierFor, WEIGHTS } from '../modules/trust/trust.logic';

const d = (s: string) => new Date(s);
const K = (n: number) => BigInt(n) * 100n;
const c = (value: number | null, evidence = 5) => ({ value, evidence });

describe('the formula', () => {
  it('apprentice: conduct 40%, milestones 40%, completion 20%', () => {
    expect(WEIGHTS.APPRENTICE.map((w) => [w.key, w.weight])).toEqual([['masterRatings', 40], ['milestones', 40], ['completion', 20]]);
    const r = computeTrust('APPRENTICE', { honestyFlags: 0, components: { masterRatings: c(80), milestones: c(100), completion: c(100) } });
    expect(r.score).toBe(92); // 0.4*80 + 0.4*100 + 0.2*100
    expect(r.tier).toBe('EXEMPLARY');
  });
  it('master: apprentice ratings 40%, on-time contributions 30%, graduation 30%', () => {
    expect(WEIGHTS.MASTER.map((w) => [w.key, w.weight])).toEqual([['apprenticeRatings', 40], ['onTime', 30], ['graduation', 30]]);
    const r = computeTrust('MASTER', { honestyFlags: 0, components: { apprenticeRatings: c(60), onTime: c(100), graduation: c(50) } });
    expect(r.score).toBe(69); // 0.4*60 + 0.3*100 + 0.3*50
    expect(r.tier).toBe('FAIR');
  });
  it('a part with no evidence yet is left out and the weights are re-spread, so nobody is marked down for what has not happened', () => {
    const r = computeTrust('APPRENTICE', { honestyFlags: 0, components: { masterRatings: c(80), milestones: c(100), completion: c(null, 0) } });
    expect(r.score).toBe(90); // (80*40 + 100*40) / 80
    expect(r.components.map((x) => x.effectiveWeight)).toEqual([50, 50, 0]);
    const m = computeTrust('MASTER', { honestyFlags: 0, components: { apprenticeRatings: c(100), onTime: c(50), graduation: c(null, 0) } });
    expect(m.score).toBe(79); // (100*40 + 50*30) / 70 = 78.57
    expect(m.tier).toBe('HIGH_TRUST');
  });
});

describe('cold start: no made-up scores', () => {
  it('a new person with nothing is UNRATED with no number', () => {
    const r = computeTrust('APPRENTICE', { honestyFlags: 0, components: { masterRatings: c(null, 0), milestones: c(null, 0), completion: c(null, 0) } });
    expect(r).toMatchObject({ score: null, tier: 'UNRATED' });
  });
  it(`fewer than ${MIN_EVIDENCE} real data points is still UNRATED, even if what exists looks perfect`, () => {
    const r = computeTrust('APPRENTICE', { honestyFlags: 0, components: { masterRatings: c(100, 2), milestones: c(null, 0), completion: c(null, 0) } });
    expect(r).toMatchObject({ score: null, tier: 'UNRATED' });
    expect(computeTrust('APPRENTICE', { honestyFlags: 0, components: { masterRatings: c(100, 3) } }).tier).toBe('EXEMPLARY');
  });
  it('it is never a fake 70', () => {
    for (const subject of ['APPRENTICE', 'MASTER'] as const) expect(computeTrust(subject, { honestyFlags: 0, components: {} }).score).toBeNull();
  });
});

describe('honesty flags', () => {
  const base = { masterRatings: c(80), milestones: c(100), completion: c(100) };
  it('each one takes 15 off', () => {
    expect(HONESTY_PENALTY).toBe(15);
    expect(computeTrust('APPRENTICE', { honestyFlags: 1, components: base })).toMatchObject({ score: 77, deduction: 15, tier: 'FAIR' }); // 92 - 15 drops it a tier
    expect(computeTrust('APPRENTICE', { honestyFlags: 2, components: base }).score).toBe(62);
    expect(computeTrust('APPRENTICE', { honestyFlags: 3, components: base })).toMatchObject({ score: 47, tier: 'AT_RISK' });
  });
  it('the score never goes below 0', () => {
    expect(computeTrust('APPRENTICE', { honestyFlags: 20, components: base })).toMatchObject({ score: 0, tier: 'CRITICAL' });
  });
  it('flags on their own cannot give an unrated person a score', () => {
    expect(computeTrust('MASTER', { honestyFlags: 2, components: {} })).toMatchObject({ score: null, tier: 'UNRATED', deduction: 0 });
  });
});

describe('tiers', () => {
  it('EXEMPLARY ≥90, HIGH_TRUST ≥78, FAIR ≥60, AT_RISK ≥45, CRITICAL below', () => {
    expect([100, 90, 89, 78, 77, 60, 59, 45, 44, 0].map(tierFor)).toEqual(['EXEMPLARY', 'EXEMPLARY', 'HIGH_TRUST', 'HIGH_TRUST', 'FAIR', 'FAIR', 'AT_RISK', 'AT_RISK', 'CRITICAL', 'CRITICAL']);
  });
});

describe('inputs', () => {
  it('turns 1 to 5 ratings into a percentage of the top mark', () => {
    expect([[5], [4], [3], [1], [5, 3], []].map((r) => ratingToPercent(r))).toEqual([100, 80, 60, 20, 80, null]);
  });
  it('turns counts into percentages, and nothing into nothing', () => {
    expect([ratio(3, 4), ratio(0, 5), ratio(0, 0)]).toEqual([75, 0, null]);
  });
  it('on-time contributions: a month is on time if everything due up to it was paid by its date', () => {
    const dues = [1, 2, 3, 4].map((n) => ({ dueDate: d(`2026-0${n}-10T00:00:00Z`), amountKobo: K(10_000) }));
    const pays = [{ at: d('2026-01-09T00:00:00Z'), kobo: K(10_000) }, { at: d('2026-02-15T00:00:00Z'), kobo: K(10_000) }, { at: d('2026-03-09T00:00:00Z'), kobo: K(20_000) }];
    // Jan on time; Feb paid 5 days late; Mar: cumulative paid by 10 Mar is 30,000 of 30,000 owed: on time; Apr not yet due
    expect(onTimeDues(dues, pays, d('2026-03-20T00:00:00Z'))).toEqual({ onTime: 2, total: 3 });
    // By 10 April 40,000 is owed and 40,000 has been paid, so April is on time too: catching up counts for the months that follow, not for February
    expect(onTimeDues(dues, pays, d('2026-04-20T00:00:00Z'))).toEqual({ onTime: 3, total: 4 });
  });
  it('months not yet due are not counted at all', () => {
    expect(onTimeDues([{ dueDate: d('2030-01-01T00:00:00Z'), amountKobo: K(1) }], [], d('2026-01-01T00:00:00Z'))).toEqual({ onTime: 0, total: 0 });
  });
});

describe('privacy', () => {
  it('the public view is a tier and badges, with no number and no working', () => {
    const v = publicView({ tier: 'HIGH_TRUST' }, ['Cutting']);
    expect(v).toEqual({ tier: 'HIGH_TRUST', badges: ['Cutting'] });
    expect(Object.keys(v)).not.toContain('score');
  });
});
