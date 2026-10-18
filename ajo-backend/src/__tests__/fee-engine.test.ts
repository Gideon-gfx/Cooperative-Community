import { Prisma } from '@prisma/client';
import { computeWaterfall, payoutFromWaterfalls, pctOf, waterfallToJson } from '../modules/payments/fee-engine';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const sum = (w: ReturnType<typeof computeWaterfall>) => w.platformCommission.add(w.collectorFee).add(w.transportFee).add(w.gatewayFeeFromNet).add(w.net);

describe('fee waterfall', () => {
  it('splits ₦100,000 at 5% platform + ₦2,000 collector fee into the fixed order', () => {
    const w = computeWaterfall({ gross: '100000', platformBp: 500, collectorFee: '2000' });
    expect(waterfallToJson(w)).toMatchObject({ gross: '100000.00', platformCommission: '5000.00', collectorFee: '2000.00', transportFee: '0.00', net: '93000.00' });
  });

  it('includes transport for CCGB', () => {
    const w = computeWaterfall({ gross: '50000', platformBp: 500, transportFee: '17500' });
    expect(w.net.toFixed(2)).toBe('30000.00');
  });

  it('lines always sum exactly to gross, including awkward amounts', () => {
    for (const gross of ['0.01', '1', '333.33', '12345.67', '99999.99', '1000000']) {
      for (const bp of [0, 1, 333, 500, 999]) {
        const w = computeWaterfall({ gross, platformBp: bp, collectorFee: pctOf(gross, 2) });
        expect(sum(w).eq(D(gross))).toBe(true);
      }
    }
  });

  it('rounds half-up to the kobo and puts the remainder in net', () => {
    // 5% of ₦0.10 = 0.005 → rounds half-up to 0.01
    const w = computeWaterfall({ gross: '0.10', platformBp: 500 });
    expect(w.platformCommission.toFixed(2)).toBe('0.01');
    expect(w.net.toFixed(2)).toBe('0.09');
    // 5% of ₦0.09 = 0.0045 → 0.00
    expect(computeWaterfall({ gross: '0.09', platformBp: 500 }).platformCommission.toFixed(2)).toBe('0.00');
  });

  it('is exact where floats are not: 0.1 + 0.2 style amounts', () => {
    const w = computeWaterfall({ gross: '1000.10', platformBp: 500 });
    expect(w.platformCommission.toFixed(2)).toBe('50.01'); // 50.005 → 50.01
    expect(w.net.toFixed(2)).toBe('950.09');
  });

  it('applies commission ONCE: a payout is the sum of nets, never commission again', () => {
    const lines = [1, 2, 3].map(() => computeWaterfall({ gross: '10000', platformBp: 500 }));
    expect(payoutFromWaterfalls(lines).toFixed(2)).toBe('28500.00');
    expect(payoutFromWaterfalls(lines).toFixed(2)).not.toBe('27075.00'); // what a second 5% would give
  });

  it('commission rate comes from the argument, not a hardcoded 5%', () => {
    expect(computeWaterfall({ gross: '10000', platformBp: 0 }).platformCommission.toFixed(2)).toBe('0.00'); // settlement funds default to 0
    expect(computeWaterfall({ gross: '10000', platformBp: 750 }).platformCommission.toFixed(2)).toBe('750.00');
  });

  describe('gateway fee bearer', () => {
    const base = { gross: '10000', platformBp: 500, gatewayFee: '150' };
    it('PLATFORM absorbs it out of its own commission; the group and payer see nothing', () => {
      const w = computeWaterfall({ ...base, gatewayFeeBearer: 'PLATFORM' });
      expect(w.net.toFixed(2)).toBe('9500.00');
      expect(w.payerTotal.toFixed(2)).toBe('10000.00');
      expect(w.platformKeeps.toFixed(2)).toBe('350.00');
    });
    it('GROUP bears it out of net', () => {
      const w = computeWaterfall({ ...base, gatewayFeeBearer: 'GROUP' });
      expect(w.net.toFixed(2)).toBe('9350.00');
      expect(sum(w).eq(D('10000'))).toBe(true);
    });
    it('PAYER pays it on top of the contribution', () => {
      const w = computeWaterfall({ ...base, gatewayFeeBearer: 'PAYER' });
      expect(w.payerTotal.toFixed(2)).toBe('10150.00');
      expect(w.net.toFixed(2)).toBe('9500.00');
    });
  });

  it('refuses nonsense: zero gross, fees over gross, negative fees, absurd rates', () => {
    expect(() => computeWaterfall({ gross: '0', platformBp: 500 })).toThrow();
    expect(() => computeWaterfall({ gross: '100', platformBp: 500, collectorFee: '200' })).toThrow('exceed');
    expect(() => computeWaterfall({ gross: '100', platformBp: 500, collectorFee: '-1' })).toThrow();
    expect(() => computeWaterfall({ gross: '100', platformBp: 20_000 })).toThrow();
    expect(() => computeWaterfall({ gross: '100', platformBp: 5.5 })).toThrow();
  });
});
