import { decisions } from '../../config/decisions';

// Pure billing rules: dates, prices, reminders, escalation, divergence. No database in here, so they are easy to test.

export const DAY_MS = 24 * 3600 * 1000;

/** Adds calendar months in UTC and clamps to the last day of the month (31 Jan + 1 month = 28/29 Feb, never 3 Mar). */
export function addMonthsUtc(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

export const periodEndFor = (start: Date, interval: 'MONTHLY' | 'YEARLY') => addMonthsUtc(start, interval === 'YEARLY' ? 12 : 1);

const startOfUtcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/**
 * Calendar days from `now` until `end` in UTC: 0 on the day it ends (even hours before the exact time), negative the day after.
 * Reminders are by calendar day, so "on the day" means the morning job on that day, not 24 hours before a timestamp.
 */
export const daysUntil = (end: Date, now: Date) => Math.round((startOfUtcDay(end) - startOfUtcDay(now)) / DAY_MS);

/**
 * Suggested yearly price from the monthly one: 12 months less the annual discount (default 10%), in whole kobo, half-up.
 * It is only a SUGGESTION for the admin screen; the real price is whatever row is in PlanPrice.
 */
export function annualFromMonthly(monthlyKobo: bigint, discountBp = decisions.billing.annualDiscountBp): bigint {
  const num = monthlyKobo * 12n * BigInt(10_000 - discountBp);
  return (num + 5_000n) / 10_000n;
}

/** Monthly-equivalent revenue of a subscription, for MRR. Yearly is spread over 12 months (half-up). */
export function monthlyEquivalent(priceKobo: bigint, interval: 'MONTHLY' | 'YEARLY'): bigint {
  return interval === 'MONTHLY' ? priceKobo : (priceKobo + 6n) / 12n;
}

/**
 * Which renewal reminder to send now: the smallest reminder day that has been reached and not yet sent.
 * Everything larger is marked as sent too, so a job that was down never sends three SMS at once.
 */
export function nextReminder(daysLeft: number, sent: number[], days = decisions.billing.reminderDays): { send: number; markSent: number[] } | null {
  const reached = days.filter((d) => daysLeft <= d && !sent.includes(d));
  if (reached.length === 0) return null;
  const send = Math.min(...reached);
  return { send, markSent: reached };
}

/** Where an unpaid commission invoice stands: 0 none, 1 warned, 2 new cycles blocked, 3 sent to admin review. */
export function escalationLevelFor(daysOverdue: number, c = decisions.billing.commissionInvoice): number {
  if (daysOverdue >= c.adminReviewAfterDays) return 3;
  if (daysOverdue >= c.blockAfterDays) return 2;
  if (daysOverdue >= c.warnAfterDays) return 1;
  return 0;
}

/**
 * How far a collector's confirmed total falls short of what members themselves declared for the same cycles.
 * Members declare their own payments, so a collector cannot quietly under-report to dodge commission.
 */
export function divergence(declaredKobo: bigint, confirmedKobo: bigint, d = decisions.billing.divergence) {
  if (declaredKobo <= 0n || confirmedKobo >= declaredKobo) return { bp: 0, flagged: false };
  const bp = Number(((declaredKobo - confirmedKobo) * 10_000n) / declaredKobo);
  return { bp, flagged: declaredKobo >= d.minDeclaredKobo && bp >= d.thresholdBp };
}

/** The calendar month before `now`, in UTC: [start, end). */
export function previousMonth(now: Date) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end };
}
