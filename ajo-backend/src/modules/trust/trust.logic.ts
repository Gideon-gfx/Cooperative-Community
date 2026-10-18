import { TrustSubject, TrustTier } from '@prisma/client';

// Pure trust-score rules. A score is a summary of what really happened, never a guess: with too little evidence a person is
// UNRATED rather than shown a made-up number.

export const WEIGHTS: Record<TrustSubject, { key: string; label: string; weight: number }[]> = {
  APPRENTICE: [
    { key: 'masterRatings', label: 'How the master rates their conduct', weight: 40 },
    { key: 'milestones', label: 'Milestones passed', weight: 40 },
    { key: 'completion', label: 'Finishing what they start', weight: 20 },
  ],
  MASTER: [
    { key: 'apprenticeRatings', label: 'How apprentices rate the master', weight: 40 },
    { key: 'onTime', label: 'Paying into the Settlement Fund on time', weight: 30 },
    { key: 'graduation', label: 'Apprentices who graduate', weight: 30 },
  ],
};

export const HONESTY_PENALTY = 15;
/** Fewer than this many real data points and the person is UNRATED. */
export const MIN_EVIDENCE = 3;

export const TIERS: { tier: Exclude<TrustTier, 'UNRATED'>; min: number }[] = [
  { tier: 'EXEMPLARY', min: 90 }, { tier: 'HIGH_TRUST', min: 78 }, { tier: 'FAIR', min: 60 }, { tier: 'AT_RISK', min: 45 }, { tier: 'CRITICAL', min: 0 },
];
export const tierFor = (score: number): TrustTier => TIERS.find((t) => score >= t.min)!.tier;

/** Ratings are 1 to 5. An average of 5 is 100, 4 is 80, 3 is 60, 1 is 20. */
export const ratingToPercent = (ratings: number[]): number | null => (ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length / 5) * 100) : null);
export const ratio = (good: number, total: number): number | null => (total > 0 ? Math.round((good / total) * 100) : null);

export interface TrustInput {
  /** Each component's value (0-100) and how many real data points stand behind it. Missing = no evidence yet. */
  components: Record<string, { value: number | null; evidence: number }>;
  /** Ratings about this person in the HONESTY category that were 2 or lower (appealed-and-upheld ones already removed). */
  honestyFlags: number;
}

export interface TrustResult {
  score: number | null;
  tier: TrustTier;
  honestyFlags: number;
  deduction: number;
  evidence: number;
  components: { key: string; label: string; weight: number; effectiveWeight: number; value: number | null; evidence: number }[];
}

/**
 * Weighted average of the parts that have evidence, with the weights re-spread over those parts (so a person with no
 * milestones yet is not marked down for it). Each honesty flag then takes 15 off. Fewer than MIN_EVIDENCE data points in
 * total is UNRATED: no number, no tier colour.
 */
export function computeTrust(subject: TrustSubject, input: TrustInput): TrustResult {
  const spec = WEIGHTS[subject];
  const have = spec.filter((s) => input.components[s.key]?.value != null);
  const totalWeight = have.reduce((n, s) => n + s.weight, 0);
  const evidence = spec.reduce((n, s) => n + (input.components[s.key]?.evidence ?? 0), 0);
  const components = spec.map((s) => ({ key: s.key, label: s.label, weight: s.weight, effectiveWeight: have.includes(s) && totalWeight ? Math.round((s.weight / totalWeight) * 100) : 0, value: input.components[s.key]?.value ?? null, evidence: input.components[s.key]?.evidence ?? 0 }));
  if (!have.length || evidence < MIN_EVIDENCE) return { score: null, tier: 'UNRATED', honestyFlags: input.honestyFlags, deduction: 0, evidence, components };
  const base = have.reduce((n, s) => n + (input.components[s.key].value as number) * s.weight, 0) / totalWeight;
  const deduction = input.honestyFlags * HONESTY_PENALTY;
  const score = Math.max(0, Math.min(100, Math.round(base - deduction)));
  return { score, tier: tierFor(score), honestyFlags: input.honestyFlags, deduction, evidence, components };
}

/**
 * On-time rate for a master's monthly contributions. A month is on time if, by its due date, the master had paid in at
 * least the total due up to and including that month. Months not yet due are not counted.
 */
export function onTimeDues(dues: { dueDate: Date; amountKobo: bigint }[], payments: { at: Date; kobo: bigint }[], now = new Date()) {
  const sorted = [...dues].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
  let owed = 0n, onTime = 0, total = 0;
  for (const d of sorted) {
    if (d.dueDate > now) break;
    owed += d.amountKobo;
    total++;
    const paidByThen = payments.filter((p) => p.at <= d.dueDate).reduce((n, p) => n + p.kobo, 0n);
    if (paidByThen >= owed) onTime++;
  }
  return { onTime, total };
}

export const isHonestyFlag = (category: string, rating: number) => category === 'HONESTY' && rating <= 2;

/** What each audience may see. The public sees a tier and badges; the person themselves and the board see the working. */
export function publicView(r: { tier: TrustTier }, badges: string[]) {
  return { tier: r.tier, badges };
}
