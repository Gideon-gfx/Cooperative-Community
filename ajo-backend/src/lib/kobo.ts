import { Prisma } from '@prisma/client';
import { HttpError } from './errors';

/** Max a single declaration may be: ₦1 billion. Stops typos and overflow games. */
const MAX_KOBO = 100_000_000_000n;

/**
 * Parses a naira amount ("1250.50" or 1250.5) into kobo using exact decimal arithmetic, so money never
 * passes through a JS float. Rejects NaN, more than 2 decimals, zero/negative (unless allowSigned) and huge values.
 */
export function nairaToKobo(input: string | number, opts: { allowSigned?: boolean } = {}): bigint {
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(typeof input === 'number' ? input.toString() : input.trim());
  } catch {
    throw new HttpError(400, 'Invalid amount');
  }
  if (!d.isFinite()) throw new HttpError(400, 'Invalid amount');
  if (d.decimalPlaces() > 2) throw new HttpError(400, 'Amount can have at most 2 decimal places');
  const kobo = BigInt(d.mul(100).toFixed(0));
  if (kobo === 0n || (kobo < 0n && !opts.allowSigned)) throw new HttpError(400, 'Amount must be greater than zero');
  if (kobo > MAX_KOBO || kobo < -MAX_KOBO) throw new HttpError(400, 'Amount is too large');
  return kobo;
}

/** "125050" kobo → "1250.50". Always a string so JSON never loses precision. */
export function koboToNaira(kobo: bigint): string {
  return new Prisma.Decimal(kobo.toString()).div(100).toFixed(2);
}
