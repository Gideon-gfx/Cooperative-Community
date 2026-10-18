import { ageOn, canMove, categoryAllowed, dueDateFor, daysBetween, addDays, defaultMilestones, distinctParties, graduationEligible, isHonestyFlag, isMinor, missingRoles, ratedPartyFor, requiredRoles, roleOf, tenureOf, TENURE_MONTHS } from '../modules/apprenticeship/contracts.logic';
import { addMonthsUtc } from '../modules/billing/billing.logic';

const d = (s: string) => new Date(s);

describe('tenure', () => {
  it('is 6, 9, 12, 18 or 24 months and nothing else', () => {
    expect(Object.values(TENURE_MONTHS)).toEqual([6, 9, 12, 18, 24]);
    expect(tenureOf(12)).toBe('TWELVE');
    for (const bad of [0, 1, 5, 7, 10, 36]) expect(tenureOf(bad)).toBeUndefined();
  });
});

describe('age', () => {
  it('counts whole years, including the day before a birthday', () => {
    expect(ageOn(d('2008-06-15T00:00:00Z'), d('2026-06-14T00:00:00Z'))).toBe(17);
    expect(ageOn(d('2008-06-15T00:00:00Z'), d('2026-06-15T00:00:00Z'))).toBe(18);
    expect(isMinor(d('2008-06-15T00:00:00Z'), d('2026-06-14T00:00:00Z'))).toBe(true);
    expect(isMinor(d('2008-06-15T00:00:00Z'), d('2026-06-15T00:00:00Z'))).toBe(false);
  });
  it('a leap-day birthday is handled', () => {
    expect(ageOn(d('2008-02-29T00:00:00Z'), d('2026-02-28T00:00:00Z'))).toBe(17);
    expect(ageOn(d('2008-02-29T00:00:00Z'), d('2026-03-01T00:00:00Z'))).toBe(18);
  });
});

describe('who must sign (checked as a set of roles)', () => {
  it('an adult needs master, apprentice and guarantor; a named or required guardian adds the fourth', () => {
    expect(requiredRoles({})).toEqual(['MASTER', 'APPRENTICE', 'GUARANTOR']);
    expect(requiredRoles({ minorApprentice: true })).toContain('PARENT_GUARDIAN');
    expect(requiredRoles({ guardianId: 'g' })).toContain('PARENT_GUARDIAN');
  });
  it('three signatures are not enough if they are the wrong three', () => {
    expect(missingRoles({ minorApprentice: true, guardianId: 'g' }, ['MASTER', 'APPRENTICE', 'GUARANTOR'])).toEqual(['PARENT_GUARDIAN']);
    expect(missingRoles({}, ['MASTER', 'MASTER', 'APPRENTICE'])).toEqual(['GUARANTOR']);
    expect(missingRoles({}, ['MASTER', 'APPRENTICE', 'GUARANTOR'])).toEqual([]);
    expect(missingRoles({}, [])).toEqual(['MASTER', 'APPRENTICE', 'GUARANTOR']);
  });
  it('knows each person\'s one role, and that strangers have none', () => {
    const c = { masterId: 'm', apprenticeId: 'a', guarantorId: 'g', guardianId: 'p' };
    expect(['m', 'a', 'g', 'p', 'x'].map((u) => roleOf(c, u))).toEqual(['MASTER', 'APPRENTICE', 'GUARANTOR', 'PARENT_GUARDIAN', null]);
  });
  it('the parties must be different people', () => {
    expect(distinctParties(['m', 'a', 'g', null])).toBe(true);
    expect(distinctParties(['m', 'a', 'm'])).toBe(false);
    expect(distinctParties(['m', 'a', 'g', 'a'])).toBe(false);
  });
});

describe('milestone transitions', () => {
  it('only the agreed moves are allowed', () => {
    expect(canMove('NOT_STARTED', 'IN_PROGRESS')).toBe(true);
    expect(canMove('IN_PROGRESS', 'SUBMITTED_FOR_REVIEW')).toBe(true);
    expect(canMove('SUBMITTED_FOR_REVIEW', 'APPROVED')).toBe(true);
    expect(canMove('SUBMITTED_FOR_REVIEW', 'REJECTED')).toBe(true);
    expect(canMove('REJECTED', 'IN_PROGRESS')).toBe(true);
  });
  it('nothing can skip a step, go backwards, or leave APPROVED', () => {
    expect(canMove('NOT_STARTED', 'SUBMITTED_FOR_REVIEW')).toBe(false);
    expect(canMove('NOT_STARTED', 'APPROVED')).toBe(false);
    expect(canMove('IN_PROGRESS', 'APPROVED')).toBe(false);
    expect(canMove('SUBMITTED_FOR_REVIEW', 'IN_PROGRESS')).toBe(false);
    expect(canMove('APPROVED', 'REJECTED')).toBe(false);
    expect(canMove('APPROVED', 'IN_PROGRESS')).toBe(false);
  });
  it('a default milestone every quarter, the last one on the final month', () => {
    expect(defaultMilestones(6).map((m) => m.dueMonth)).toEqual([3, 6]);
    expect(defaultMilestones(9).map((m) => m.dueMonth)).toEqual([3, 6, 9]);
    expect(defaultMilestones(12)).toHaveLength(4);
    expect(defaultMilestones(18).map((m) => m.dueMonth)).toEqual([3, 6, 9, 12, 15, 18]);
    expect(defaultMilestones(24)).toHaveLength(8);
    expect(defaultMilestones(24)[7]).toMatchObject({ order: 8, dueMonth: 24 });
  });
  it('a contract with no milestones can never graduate; one with any unapproved milestone cannot either', () => {
    expect(graduationEligible([])).toBe(false);
    expect(graduationEligible([{ status: 'APPROVED' }, { status: 'SUBMITTED_FOR_REVIEW' }])).toBe(false);
    expect(graduationEligible([{ status: 'APPROVED' }, { status: 'REJECTED' }])).toBe(false);
    expect(graduationEligible([{ status: 'APPROVED' }])).toBe(true);
    expect(graduationEligible([{ status: 'APPROVED' }, { status: 'APPROVED' }])).toBe(true);
  });
});

describe('date maths', () => {
  it('month-end starts clamp instead of rolling over', () => {
    expect(addMonthsUtc(d('2026-01-31T10:00:00Z'), 6).toISOString()).toBe('2026-07-31T10:00:00.000Z');
    expect(addMonthsUtc(d('2026-08-31T10:00:00Z'), 6).toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(addMonthsUtc(d('2027-08-31T10:00:00Z'), 6).toISOString()).toBe('2028-02-29T10:00:00.000Z'); // leap year
    expect(addMonthsUtc(d('2026-03-31T10:00:00Z'), 24).toISOString()).toBe('2028-03-31T10:00:00.000Z');
    expect(addMonthsUtc(d('2028-02-29T00:00:00Z'), 12).toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });
  it('milestone due dates are start + N months, so a 31 Jan start gives 30 Apr then 31 Jul', () => {
    const start = d('2026-01-31T00:00:00Z');
    expect(defaultMilestones(6).map((m) => dueDateFor(start, m.dueMonth).toISOString().slice(0, 10))).toEqual(['2026-04-30', '2026-07-31']);
  });
  it('a pause of any length costs whole days', () => {
    expect(daysBetween(d('2026-03-01T10:00:00Z'), d('2026-03-01T10:00:01Z'))).toBe(1);
    expect(daysBetween(d('2026-03-01T10:00:00Z'), d('2026-03-11T10:00:00Z'))).toBe(10);
    expect(daysBetween(d('2026-03-11T00:00:00Z'), d('2026-03-01T00:00:00Z'))).toBe(0);
    expect(addDays(d('2026-03-01T00:00:00Z'), 10).toISOString()).toBe('2026-03-11T00:00:00.000Z');
  });
});

describe('conduct ratings', () => {
  it('who a rating is about follows from who writes it', () => {
    expect(ratedPartyFor('MASTER')).toBe('APPRENTICE');
    expect(ratedPartyFor('APPRENTICE')).toBe('MASTER');
    expect(ratedPartyFor('GUARANTOR')).toBeNull();
    expect(ratedPartyFor('PARENT_GUARDIAN')).toBeNull();
  });
  it('each side can only be rated on things that make sense', () => {
    expect(categoryAllowed('APPRENTICE', 'PUNCTUALITY')).toBe(true);
    expect(categoryAllowed('APPRENTICE', 'TEACHING')).toBe(false);
    expect(categoryAllowed('MASTER', 'TEACHING')).toBe(true);
    expect(categoryAllowed('MASTER', 'PUNCTUALITY')).toBe(false);
    expect(categoryAllowed('MASTER', 'HONESTY')).toBe(true);
  });
  it('an honesty rating of 2 or less is a flag', () => {
    expect(isHonestyFlag('HONESTY', 2)).toBe(true);
    expect(isHonestyFlag('HONESTY', 3)).toBe(false);
    expect(isHonestyFlag('ATTITUDE', 1)).toBe(false);
  });
});
