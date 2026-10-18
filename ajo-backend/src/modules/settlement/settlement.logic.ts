import { addMonthsUtc, daysUntil } from '../billing/billing.logic';

// Pure Settlement Fund rules: the monthly schedule, how payments are matched to months, and how a release is approved.
// There is deliberately nothing here about interest, yield or returns: the fund only ever holds what was paid in.

export interface DueSpec { number: number; dueDate: Date; amountKobo: bigint }

/** One due per month of the agreement, the first a month after it starts and the last on the end date. */
export function scheduleDues(start: Date, months: number, monthlyKobo: bigint): DueSpec[] {
  return Array.from({ length: months }, (_, i) => ({ number: i + 1, dueDate: addMonthsUtc(start, i + 1), amountKobo: monthlyKobo }));
}

export type DueStatus = 'PAID' | 'PARTIAL' | 'UPCOMING' | 'DUE' | 'OVERDUE';
export interface DueState { number: number; dueDate: Date; amountKobo: bigint; paidKobo: bigint; remainingKobo: bigint; status: DueStatus }

/**
 * Matches the master's CONFIRMED payments to the months, oldest first. Nothing is stored: pay one month late and it
 * shows as paid; pay double and the next month is covered. Only confirmed money counts, so a pending payment never does.
 */
export function allocateDues(dues: { number: number; dueDate: Date; amountKobo: bigint }[], confirmedMasterKobo: bigint, now = new Date()): DueState[] {
  let pool = confirmedMasterKobo < 0n ? 0n : confirmedMasterKobo;
  return [...dues].sort((a, b) => a.number - b.number).map((d) => {
    const paid = pool >= d.amountKobo ? d.amountKobo : pool;
    pool -= paid;
    const remaining = d.amountKobo - paid;
    const sameDay = daysUntil(d.dueDate, now) === 0;
    const status: DueStatus = remaining === 0n ? 'PAID' : now > d.dueDate && !sameDay ? 'OVERDUE' : sameDay ? 'DUE' : paid > 0n ? 'PARTIAL' : 'UPCOMING';
    return { number: d.number, dueDate: d.dueDate, amountKobo: d.amountKobo, paidKobo: paid, remainingKobo: remaining, status };
  });
}

/** Money owed so far: every month whose due date has passed. */
export const owedSoFar = (states: DueState[], now = new Date()) => states.filter((s) => s.dueDate <= now).reduce((sum, s) => sum + s.remainingKobo, 0n);

/** Two days late and still unpaid: flagged to the Trust Board. Never any automatic money penalty. */
export const isMissed = (s: DueState, now = new Date()) => s.remainingKobo > 0n && daysUntil(s.dueDate, now) <= -2;

// ── Release approvals ───────────────────────────────────────────────────────

export type Vote = { approverId: string; approve: boolean };

export function tally(votes: Vote[]) {
  return { approvals: votes.filter((v) => v.approve).length, rejections: votes.filter((v) => !v.approve).length };
}

/** Approved at N distinct approvals. Stopped at M rejections. Each person counts once. */
export function decide(votes: Vote[], required: number, rejectionsToStop: number): 'APPROVED' | 'REJECTED' | 'PENDING' {
  const distinct = [...new Map(votes.map((v) => [v.approverId, v])).values()];
  const { approvals, rejections } = tally(distinct);
  if (approvals >= required) return 'APPROVED';
  if (rejections >= rejectionsToStop) return 'REJECTED';
  return 'PENDING';
}

/**
 * Who may NOT approve a release: anyone with a stake in the agreement. The board member must be a different person
 * from the master, the guarantor, the apprentice and the guardian.
 */
export function hasConflict(approverId: string, parties: { masterId: string; apprenticeId: string; guarantorId: string; guardianId?: string | null }): boolean {
  return [parties.masterId, parties.apprenticeId, parties.guarantorId, parties.guardianId].filter(Boolean).includes(approverId);
}

/** The graduate must confirm the destination, and the guardian too if one is on the agreement. */
export function destinationConfirmed(r: { graduateConfirmedAt?: Date | null; guardianConfirmedAt?: Date | null }, guardianId?: string | null): boolean {
  return !!r.graduateConfirmedAt && (!guardianId || !!r.guardianConfirmedAt);
}

/** Bank-confirmed account names are compared loosely: "Adé Túndé Bello" and "BELLO TUNDE ADE" are the same person. */
export const NAME_MATCH_MIN = 0.7;

export const ACTIVE_RELEASE = ['AWAITING_DESTINATION', 'AWAITING_CONFIRMATION', 'AWAITING_APPROVALS', 'DISBURSING'] as const;
export const isActiveRelease = (status: string) => (ACTIVE_RELEASE as readonly string[]).includes(status);
