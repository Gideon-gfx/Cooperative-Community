import crypto from 'crypto';

export type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type Status = 'CLEAN' | 'WARNED' | 'DEFAULTER';

/** Unbiased Fisher-Yates shuffle using a CSPRNG. Returns a new array. */
export function shuffle<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Payout date for the n-th (1-based) slot: DAILY +n days, WEEKLY +7n days, MONTHLY +n months. */
export function payoutDateFor(start: Date, freq: Frequency, n: number): Date {
  const d = new Date(start);
  if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + n);
  else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7 * n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return d;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function calculateAjoFees(totalCollected: number, platformFeePct: number, collectorFeePct: number) {
  const platformFee = round2((totalCollected * platformFeePct) / 100);
  const collectorFee = round2((totalCollected * collectorFeePct) / 100);
  const netPayout = round2(totalCollected - platformFee - collectorFee);
  return { platformFee, collectorFee, netPayout };
}

/** First miss → WARNED; second (and beyond) → DEFAULTER. */
export function nextMemberStatus(current: Status): Status {
  return current === 'CLEAN' ? 'WARNED' : 'DEFAULTER';
}

export interface TrustInput { verified: number; onTime: number; late: number; missed: number; completedPools: number }
export interface TrustResult { score: number; onTimePct: number; label: 'NEW' | 'GOOD' | 'FAIR' | 'RISKY'; verified: number; late: number; missed: number; completedPools: number }

/**
 * 0–100 reliability score from payment history. New members (no history) are labelled NEW rather than punished.
 * On-time payments count fully, late ones half, missed ones zero.
 */
export function computeTrustScore(i: TrustInput): TrustResult {
  const total = i.verified + i.missed;
  if (total === 0) return { score: 0, onTimePct: 0, label: 'NEW', verified: 0, late: 0, missed: 0, completedPools: i.completedPools };
  const points = i.onTime + i.late * 0.5;
  const score = Math.round((points / total) * 100);
  const onTimePct = Math.round((i.onTime / total) * 100);
  const label = total < 3 ? 'NEW' : score >= 90 ? 'GOOD' : score >= 70 ? 'FAIR' : 'RISKY';
  return { score, onTimePct, label, verified: i.verified, late: i.late, missed: i.missed, completedPools: i.completedPools };
}

/** Amount still unpaid on a contribution, counting both verified and still-pending payments. */
export function remainingToPay(due: number, verifiedPaid: number, pending: number): number {
  return Math.max(0, round2(due - verifiedPaid - pending));
}

/** A contribution becomes overdue only after the pool's grace period. */
export function overdueAfterGrace(dueAt: Date, graceDays: number, now = new Date()): boolean {
  return dueAt.getTime() + graceDays * DAY_MS < now.getTime();
}


/** Expands members into payout slots; a member with `hands` > 1 gets that many slots. */
export function expandSlots(memberIds: string[], hands: Record<string, number> = {}): string[] {
  return memberIds.flatMap((id) => Array.from({ length: Math.max(1, hands[id] ?? 1) }, () => id));
}
