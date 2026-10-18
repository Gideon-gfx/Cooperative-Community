import { Prisma } from '@prisma/client';
import { decisions } from '../../config/decisions';

type D = Prisma.Decimal;
type DV = Prisma.Decimal.Value;
const Decimal = Prisma.Decimal;

export type GatewayBearer = 'PLATFORM' | 'GROUP' | 'PAYER';

export interface WaterfallInput {
  gross: DV;
  /** Platform commission as basis points (500 = 5%). Comes from PlatformConfig, never hardcoded at the call site. */
  platformBp: number;
  /** Collector / service fee, already worked out in naira. */
  collectorFee?: DV;
  /** CCGB only. */
  transportFee?: DV;
  /** What the payment gateway charges for this payment. */
  gatewayFee?: DV;
  gatewayFeeBearer?: GatewayBearer;
}

export interface Waterfall {
  gross: D;
  platformCommission: D;
  collectorFee: D;
  transportFee: D;
  /** Taken out of the group's net only when the bearer is GROUP. */
  gatewayFeeFromNet: D;
  net: D;
  /** What the payer actually pays: gross, plus the gateway fee only when the PAYER bears it. */
  payerTotal: D;
  /** The platform's commission after absorbing the gateway fee when it is the bearer. Can be negative. */
  platformKeeps: D;
}

const kobo = (v: D): D => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const zero = new Decimal(0);

/**
 * The one place a contribution is split. Fixed order: gross → platform commission → collector fee → transport → net.
 * Exact decimal math, round half-up to the kobo, any rounding remainder lands in net, and the lines always sum to gross.
 * Commission is taken ONCE, on the contribution. Never apply it again to a payout: sum the nets instead.
 */
export function computeWaterfall(i: WaterfallInput): Waterfall {
  const gross = kobo(new Decimal(i.gross));
  if (gross.lte(0)) throw new Error('Gross must be greater than zero');
  if (!Number.isInteger(i.platformBp) || i.platformBp < 0 || i.platformBp > 10_000) throw new Error('Invalid platform commission');

  const platformCommission = kobo(gross.mul(i.platformBp).div(10_000));
  const collectorFee = kobo(new Decimal(i.collectorFee ?? 0));
  const transportFee = kobo(new Decimal(i.transportFee ?? 0));
  const gatewayFee = kobo(new Decimal(i.gatewayFee ?? 0));
  const bearer = i.gatewayFeeBearer ?? decisions.gatewayFeeBearer;
  if ([collectorFee, transportFee, gatewayFee].some((f) => f.lt(0))) throw new Error('Fees cannot be negative');

  const gatewayFeeFromNet = bearer === 'GROUP' ? gatewayFee : zero;
  const net = gross.sub(platformCommission).sub(collectorFee).sub(transportFee).sub(gatewayFeeFromNet);
  if (net.lt(0)) throw new Error('Fees exceed the contribution');

  // The invariant that makes this the single source of truth.
  if (!platformCommission.add(collectorFee).add(transportFee).add(gatewayFeeFromNet).add(net).eq(gross)) throw new Error('Waterfall does not sum to gross');

  return {
    gross, platformCommission, collectorFee, transportFee, gatewayFeeFromNet, net,
    payerTotal: bearer === 'PAYER' ? gross.add(gatewayFee) : gross,
    platformKeeps: bearer === 'PLATFORM' ? platformCommission.sub(gatewayFee) : platformCommission,
  };
}

/** What a recipient is paid for a set of contributions: the sum of their nets. Commission is never re-applied. */
export function payoutFromWaterfalls(lines: Pick<Waterfall, 'net'>[]): D {
  return lines.reduce((s, l) => s.add(l.net), zero);
}

/** Fee % of an amount, in naira, rounded half-up to the kobo. */
export function pctOf(amount: DV, pct: DV): D {
  return kobo(new Decimal(amount).mul(new Decimal(pct)).div(100));
}

export const waterfallToJson = (w: Waterfall) => ({
  gross: w.gross.toFixed(2), platformCommission: w.platformCommission.toFixed(2), collectorFee: w.collectorFee.toFixed(2), transportFee: w.transportFee.toFixed(2),
  gatewayFeeFromNet: w.gatewayFeeFromNet.toFixed(2), net: w.net.toFixed(2), payerTotal: w.payerTotal.toFixed(2),
});
