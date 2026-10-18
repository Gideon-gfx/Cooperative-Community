import { ConductCategory, MilestoneStatus, RatedParty, SignerRole, TenureMonths } from '@prisma/client';
import { addMonthsUtc, DAY_MS } from '../billing/billing.logic';

// Pure apprenticeship rules: tenure, signers, milestones, ratings, dates. No database, so they are easy to test.

export const TENURE_MONTHS: Record<TenureMonths, number> = { SIX: 6, NINE: 9, TWELVE: 12, EIGHTEEN: 18, TWENTY_FOUR: 24 };
export const tenureOf = (months: number): TenureMonths | undefined => (Object.entries(TENURE_MONTHS).find(([, m]) => m === months)?.[0] as TenureMonths | undefined);

// ── Age ─────────────────────────────────────────────────────────────────────

/** Whole years old on a given day (UTC). Used once to decide whether a guardian must sign, then the date is dropped. */
export function ageOn(dob: Date, on = new Date()): number {
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday = on.getUTCMonth() < dob.getUTCMonth() || (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age--;
  return age;
}
export const isMinor = (dob: Date, on = new Date()) => ageOn(dob, on) < 18;

// ── Signers ─────────────────────────────────────────────────────────────────

/** Everyone who must sign before the contract can start. Checked as a SET of roles, never as a count. */
export function requiredRoles(c: { guardianId?: string | null; minorApprentice?: boolean }): SignerRole[] {
  const roles: SignerRole[] = ['MASTER', 'APPRENTICE', 'GUARANTOR'];
  if (c.guardianId || c.minorApprentice) roles.push('PARENT_GUARDIAN');
  return roles;
}

export function missingRoles(c: { guardianId?: string | null; minorApprentice?: boolean }, signed: SignerRole[]): SignerRole[] {
  const have = new Set(signed);
  return requiredRoles(c).filter((r) => !have.has(r));
}

/** Which role this user holds on this contract, if any. A person can hold only one: the parties are always distinct. */
export function roleOf(c: { masterId: string; apprenticeId: string; guarantorId: string; guardianId?: string | null }, userId: string): SignerRole | null {
  if (c.masterId === userId) return 'MASTER';
  if (c.apprenticeId === userId) return 'APPRENTICE';
  if (c.guarantorId === userId) return 'GUARANTOR';
  if (c.guardianId && c.guardianId === userId) return 'PARENT_GUARDIAN';
  return null;
}

export function distinctParties(ids: (string | null | undefined)[]): boolean {
  const real = ids.filter((x): x is string => !!x);
  return new Set(real).size === real.length;
}

// ── Milestones ──────────────────────────────────────────────────────────────

export const MILESTONE_NEXT: Record<MilestoneStatus, MilestoneStatus[]> = {
  NOT_STARTED: ['IN_PROGRESS'],
  IN_PROGRESS: ['SUBMITTED_FOR_REVIEW'],
  SUBMITTED_FOR_REVIEW: ['APPROVED', 'REJECTED'],
  REJECTED: ['IN_PROGRESS'],
  APPROVED: [],
};
export const canMove = (from: MilestoneStatus, to: MilestoneStatus) => MILESTONE_NEXT[from].includes(to);

/** One milestone per quarter. The last one falls due on the end date. */
export function defaultMilestones(months: number): { order: number; title: string; description: string; dueMonth: number }[] {
  const quarters = Math.max(1, Math.round(months / 3));
  return Array.from({ length: quarters }, (_, i) => {
    const from = i * 3 + 1;
    const to = Math.min(months, (i + 1) * 3);
    return { order: i + 1, title: `Months ${from} to ${to}`, description: `What the apprentice should be able to do by the end of month ${to}, agreed with the master.`, dueMonth: to };
  });
}

export const dueDateFor = (start: Date, dueMonth: number) => addMonthsUtc(start, dueMonth);

/**
 * A contract can only graduate when it has at least one milestone and EVERY milestone is approved. A contract with no
 * milestones can never graduate, however much time has passed: there would be nothing to show the apprentice learned.
 */
export function graduationEligible(milestones: { status: MilestoneStatus }[]): boolean {
  return milestones.length >= 1 && milestones.every((m) => m.status === 'APPROVED');
}

// ── Pause / resume ──────────────────────────────────────────────────────────

/** Whole days between two moments, rounded up so a pause of any length costs at least a day. */
export const daysBetween = (from: Date, to: Date) => Math.max(0, Math.ceil((to.getTime() - from.getTime()) / DAY_MS));
export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

// ── Conduct ─────────────────────────────────────────────────────────────────

const ABOUT_APPRENTICE: ConductCategory[] = ['PUNCTUALITY', 'SKILL_PROGRESS', 'HONESTY', 'ATTITUDE', 'SAFETY', 'OTHER'];
const ABOUT_MASTER: ConductCategory[] = ['TEACHING', 'FAIR_TREATMENT', 'WELFARE', 'SAFETY', 'HONESTY', 'OTHER'];

/** Who a rating is about follows from who writes it: a master rates the apprentice, an apprentice rates the master. */
export function ratedPartyFor(authorRole: SignerRole): RatedParty | null {
  return authorRole === 'MASTER' ? 'APPRENTICE' : authorRole === 'APPRENTICE' ? 'MASTER' : null;
}
export const categoryAllowed = (about: RatedParty, c: ConductCategory) => (about === 'APPRENTICE' ? ABOUT_APPRENTICE : ABOUT_MASTER).includes(c);
export const isHonestyFlag = (c: ConductCategory, rating: number) => c === 'HONESTY' && rating <= 2;

export const TERMINAL: string[] = ['GRADUATED', 'TERMINATED'];
