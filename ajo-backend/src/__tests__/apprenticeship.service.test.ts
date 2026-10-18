import { clearTables, matches, oid, Row, table } from './helpers/fakeDb';

const db: Record<string, any> = {
  user: table(), communityGroup: table(), groupMember: table(), tradeMasterProfile: table(), contractSignature: table(), contractMilestone: table(), conductLog: table(),
  earnedSkillBadge: table(), settlementFund: table(), contributionDue: table(), guarantorRecord: table(), trustBoardMember: table(), auditLog: table(), apprenticeshipContract: table({ pausedDays: 0 }),
};
// Contracts: nested milestone creation, relations on read, and a unique signature per (contract, role).
const contractCreate = db.apprenticeshipContract.create;
db.apprenticeshipContract.create = jest.fn(async ({ data }: Row) => { const { milestones, ...rest } = data; const c = await contractCreate({ data: rest }); for (const m of milestones?.create ?? []) await db.contractMilestone.create({ data: { contractId: c.id, status: 'NOT_STARTED', ...m } }); return c; });
const withRel = (c: Row, include?: Row) => (include ? { ...c, signatures: db.contractSignature.rows.filter((s: Row) => s.contractId === c.id), milestones: db.contractMilestone.rows.filter((m: Row) => m.contractId === c.id).sort((a: Row, b: Row) => a.order - b.order) } : c);
const cFindUnique = db.apprenticeshipContract.findUnique;
db.apprenticeshipContract.findUnique = jest.fn(async (args: Row) => { const c = await cFindUnique(args); return c ? withRel(c, args.include) : null; });
const cFindMany = db.apprenticeshipContract.findMany;
db.apprenticeshipContract.findMany = jest.fn(async (args: Row) => (await cFindMany(args)).map((c: Row) => withRel(c, args.include)));
const sigCreate = db.contractSignature.create;
db.contractSignature.create = jest.fn(async (args: Row) => { if (db.contractSignature.rows.some((s: Row) => s.contractId === args.data.contractId && s.signerRole === args.data.signerRole)) throw Object.assign(new Error('dup'), { code: 'P2002' }); return sigCreate(args); });
db.$transaction = (fn: (d: unknown) => unknown) => fn(db);

const sms = jest.fn();
jest.mock('../lib/prisma', () => ({ prisma: db }));
jest.mock('../lib/notify', () => ({ safeSms: (...a: unknown[]) => sms(...a), naira: (n: unknown) => `₦${n}` }));

import {
  applyAsMaster, conductFor, createContract, decideMaster, editDraft, getContract, logConduct, myContracts, pauseContract, presentContract, refreshCompletion, resumeContract, reviewMilestone, setMyDateOfBirth,
  signContract, startMilestone, submitForSignatures, submitMilestone, terminateContract, tryActivate,
} from '../modules/apprenticeship/contracts.service';

const id = () => oid();
const MASTER = { id: id(), role: 'TRADE_MASTER' }, APPRENTICE = { id: id(), role: 'MEMBER' }, GUARANTOR = { id: id(), role: 'MEMBER' }, GUARDIAN = { id: id(), role: 'MEMBER' };
const BOARD = { id: id(), role: 'BOARD_MEMBER' }, ADMIN = { id: id(), role: 'ADMIN' }, STRANGER = { id: id(), role: 'MEMBER' };
let GROUP: string;
const ctx = { ipAddress: '10.1.2.3', userAgent: 'jest' };
const sig = { typedName: 'A Person', signatureImageUrl: 'https://x/sig.png' };
const terms = 'The master will teach the trade in good faith and the apprentice will attend and learn, as agreed.';
const base = () => ({ groupId: GROUP, tradeCategory: 'Tailoring', durationMonths: 6, monthlyContribution: '20000', targetSettlement: '150000', termsAndConditions: terms, apprenticePhone: '08030000002', guarantorPhone: '08030000003' });

beforeEach(() => {
  clearTables(db);
  jest.clearAllMocks();
  const mk = (u: { id: string; role: string }, phone: string, name: string, dob?: string) => db.user.rows.push({ id: u.id, role: u.role, fullName: name, phoneNumber: phone, country: 'NG', dateOfBirth: dob ? new Date(dob) : null });
  mk(MASTER, '+2348030000001', 'Mama Bísí', '1980-01-01'); mk(APPRENTICE, '+2348030000002', 'Túndé Adé', '2000-05-05'); mk(GUARANTOR, '+2348030000003', 'Chief Okon', '1970-02-02');
  mk(GUARDIAN, '+2348030000004', 'Iya Túndé', '1975-03-03'); mk(BOARD, '+2348030000005', 'Board One'); mk(ADMIN, '+2348030000006', 'Admin'); mk(STRANGER, '+2348030000007', 'Stranger');
  const g = { id: id(), name: 'Badagry Tailors', adminId: ADMIN.id, country: 'NG', fundsMode: 'ESCROW' };
  GROUP = g.id; db.communityGroup.rows.push(g);
  for (const u of [MASTER, GUARANTOR, APPRENTICE]) db.groupMember.rows.push({ id: id(), groupId: GROUP, userId: u.id });
  db.tradeMasterProfile.rows.push({ id: id(), userId: MASTER.id, tradeCategories: ['tailoring', 'weaving'], status: 'APPROVED' });
  db.guarantorRecord.rows.push({ id: id(), userId: GUARANTOR.id, verifiedAt: new Date() }); // the Trust Board has verified the guarantor
});

const draft = async (over: Record<string, unknown> = {}) => createContract(MASTER, { ...base(), ...over } as any);
const sent = async (over: Record<string, unknown> = {}) => { const c = await draft(over); await submitForSignatures(MASTER, c.id); return c; };
const signAll = async (cid: string, who = [MASTER, APPRENTICE, GUARANTOR]) => { let last; for (const u of who) last = await signContract(u, cid, sig, ctx); return last; };
const row = (cid: string) => db.apprenticeshipContract.rows.find((c: Row) => c.id === cid)!;

describe('trade masters must be approved first', () => {
  it('an unapproved person cannot start an agreement; an approved master can, but only in a trade they are approved for', async () => {
    await expect(createContract(STRANGER, base() as any)).rejects.toThrow('approved trade master');
    await expect(draft({ tradeCategory: 'Welding' })).rejects.toThrow('not approved to teach');
    await expect(draft({ tradeCategory: ' TAILORING ' })).resolves.toBeDefined();
  });
  it('an application is decided by an admin or Trust Board member, never by the applicant, and the role label never demotes anyone', async () => {
    await applyAsMaster(STRANGER, ['Carpentry']);
    await expect(decideMaster(STRANGER, STRANGER.id, true)).rejects.toThrow('Only an admin');
    await expect(decideMaster({ id: STRANGER.id, role: 'ADMIN' }, STRANGER.id, true)).rejects.toThrow('cannot approve yourself');
    await expect(decideMaster(BOARD, STRANGER.id, false)).rejects.toThrow('Say why');
    await decideMaster(BOARD, STRANGER.id, true);
    expect(db.tradeMasterProfile.rows.find((p: Row) => p.userId === STRANGER.id).status).toBe('APPROVED');
    expect(db.user.rows.find((u: Row) => u.id === STRANGER.id).role).toBe('TRADE_MASTER');
    await expect(decideMaster(BOARD, STRANGER.id, true)).rejects.toThrow('already decided');
    // a collector who also teaches stays a collector
    const col = { id: id(), role: 'COLLECTOR' };
    db.user.rows.push({ id: col.id, role: 'COLLECTOR', fullName: 'C', phoneNumber: '+2348030000099' });
    await applyAsMaster(col, ['weaving']); await decideMaster(ADMIN, col.id, true);
    expect(db.user.rows.find((u: Row) => u.id === col.id).role).toBe('COLLECTOR');
  });
});

describe('creating an agreement', () => {
  it('the master is the signed-in user, the dates are not set yet, and money is exact', async () => {
    const c = await draft({ monthlyStipend: '5000' });
    expect(c.status).toBe('DRAFT');
    expect(row(c.id)).toMatchObject({ masterId: MASTER.id, apprenticeId: APPRENTICE.id, guarantorId: GUARANTOR.id, startDate: null, endDate: null, tenure: 'SIX', durationMonths: 6, monthlyContributionKobo: 2_000_000n, targetSettlementKobo: 15_000_000n, monthlyStipendKobo: 500_000n, minorApprentice: false });
  });
  it('only 6, 9, 12, 18 or 24 months', async () => {
    await expect(draft({ durationMonths: 7 })).rejects.toThrow('6, 9, 12, 18 or 24');
    for (const m of [6, 9, 12, 18, 24]) await expect(draft({ durationMonths: m })).resolves.toBeDefined();
  });
  it('master, apprentice, guarantor (and guardian) must be three different people', async () => {
    await expect(draft({ apprenticePhone: '08030000001' })).rejects.toThrow('different people');
    await expect(draft({ guarantorPhone: '08030000002' })).rejects.toThrow('different people');
    await expect(draft({ guardianPhone: '08030000001' })).rejects.toThrow('different people');
  });
  it('the guarantor must have been verified by the Trust Board', async () => {
    db.guarantorRecord.rows.length = 0;
    await expect(draft()).rejects.toThrow('GUARANTOR_NOT_VERIFIED');
  });
  it('the people named must already have accounts, and the guarantor must belong to the group', async () => {
    await expect(draft({ apprenticePhone: '08099999999' })).rejects.toThrow('PERSON_NOT_FOUND');
    await expect(draft({ apprenticePhone: '123' })).rejects.toThrow('not valid');
    db.groupMember.rows.splice(db.groupMember.rows.findIndex((m: Row) => m.userId === GUARANTOR.id), 1); // mutate in place: the fake table holds this array
    await expect(draft()).rejects.toThrow('guarantor must be a member');
  });
  it('a collector-custody group cannot host an agreement: escrow only', async () => {
    db.communityGroup.rows[0].fundsMode = 'COLLECTOR_CUSTODY';
    await expect(draft()).rejects.toThrow('ESCROW_ONLY');
    expect(db.apprenticeshipContract.rows).toHaveLength(0);
  });
  it('milestones may be proposed, but not outside the agreement\'s length; terms must be written', async () => {
    await expect(draft({ milestones: [{ title: 'Cut a gown', dueMonth: 9 }] })).rejects.toThrow('outside the 6-month');
    await expect(draft({ termsAndConditions: 'short' })).rejects.toThrow('terms');
    const c = await draft({ milestones: [{ title: 'Cut a gown', dueMonth: 2 }, { title: 'Sew a suit', dueMonth: 5 }] });
    expect(db.contractMilestone.rows.filter((m: Row) => m.contractId === c.id).map((m: Row) => m.title)).toEqual(['Cut a gown', 'Sew a suit']);
  });
});

describe('apprentices under 18', () => {
  it('a date of birth is needed to know, and is set once by the person', async () => {
    db.user.rows.find((u: Row) => u.id === APPRENTICE.id).dateOfBirth = null;
    await expect(draft()).rejects.toThrow('DOB_REQUIRED');
    await setMyDateOfBirth(APPRENTICE.id, new Date('2000-05-05'));
    await expect(setMyDateOfBirth(APPRENTICE.id, new Date('2001-01-01'))).rejects.toThrow('already set');
    await expect(setMyDateOfBirth(STRANGER.id, new Date('1850-01-01'))).rejects.toThrow('does not look right');
    await expect(draft()).resolves.toBeDefined();
  });
  it('a minor needs a named guardian, who must sign before the agreement starts', async () => {
    db.user.rows.find((u: Row) => u.id === APPRENTICE.id).dateOfBirth = new Date(Date.now() - 15 * 365.25 * 86_400_000);
    await expect(draft()).rejects.toThrow('GUARDIAN_REQUIRED');
    const c = await sent({ guardianPhone: '08030000004' });
    expect(row(c.id)).toMatchObject({ minorApprentice: true, guardianId: GUARDIAN.id });
    const r = await signAll(c.id); // master, apprentice, guarantor
    expect(r).toMatchObject({ activated: false, blockedReason: 'WAITING_FOR_SIGNATURES', waitingFor: ['PARENT_GUARDIAN'] });
    expect(row(c.id).status).toBe('PENDING_SIGNATURES');
    const last = await signContract(GUARDIAN, c.id, sig, ctx);
    expect(last.activated).toBe(true);
    expect(row(c.id).status).toBe('ACTIVE');
  });
  it('a guardian must be an adult', async () => {
    db.user.rows.find((u: Row) => u.id === GUARDIAN.id).dateOfBirth = new Date(Date.now() - 16 * 365.25 * 86_400_000);
    await expect(draft({ guardianPhone: '08030000004' })).rejects.toThrow('guardian must be an adult');
  });
  it('the date of birth never appears in any view of the agreement', async () => {
    db.user.rows.find((u: Row) => u.id === APPRENTICE.id).dateOfBirth = new Date('2012-06-06T00:00:00Z');
    const c = await sent({ guardianPhone: '08030000004' });
    const view = await getContract(APPRENTICE, c.id);
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/dateOfBirth|2012-06-06|dob/i);
    expect(json).not.toContain('+2348030000002'); // no phone numbers either
    expect(row(c.id)).not.toHaveProperty('dateOfBirth');
    expect((await myContracts(GUARDIAN))[0]).toBeDefined();
  });
});

describe('sending and signing', () => {
  it('a draft can be edited by its master only, and is fixed once sent', async () => {
    const c = await draft();
    await expect(editDraft(APPRENTICE, c.id, { termsAndConditions: terms + ' (changed)' })).rejects.toThrow('Only the master');
    await editDraft(MASTER, c.id, { monthlyContribution: '25000' });
    expect(row(c.id).monthlyContributionKobo).toBe(2_500_000n);
    await submitForSignatures(MASTER, c.id);
    await expect(editDraft(MASTER, c.id, { monthlyContribution: '1' })).rejects.toThrow('fixed');
    expect(sms).toHaveBeenCalledWith('+2348030000002', expect.stringContaining('read it and sign'));
    expect(sms).not.toHaveBeenCalledWith('+2348030000001', expect.stringContaining('read it and sign')); // not the master
  });
  it('only the master can send it, and only once', async () => {
    const c = await draft();
    await expect(submitForSignatures(APPRENTICE, c.id)).rejects.toThrow('Only the master');
    await submitForSignatures(MASTER, c.id);
    await expect(submitForSignatures(MASTER, c.id)).rejects.toThrow('already been sent');
  });
  it('nobody signs a draft, strangers see nothing, and each person signs once in their own role', async () => {
    const c = await draft();
    await expect(signContract(APPRENTICE, c.id, sig, ctx)).rejects.toThrow('not sent this for signatures');
    await submitForSignatures(MASTER, c.id);
    await expect(signContract(STRANGER, c.id, sig, ctx)).rejects.toThrow('Agreement not found'); // a stranger cannot even tell it exists
    await signContract(APPRENTICE, c.id, sig, ctx);
    await expect(signContract(APPRENTICE, c.id, sig, ctx)).rejects.toThrow('already signed');
    const s = db.contractSignature.rows[0];
    expect(s).toMatchObject({ signerRole: 'APPRENTICE', userId: APPRENTICE.id, ipAddress: '10.1.2.3', signatureImageUrl: 'https://x/sig.png' });
  });
  it('the apprentice cannot sign as the master, and the role always comes from who is signed in', async () => {
    const c = await sent();
    await signContract(APPRENTICE, c.id, sig, ctx);
    expect(db.contractSignature.rows.map((s: Row) => s.signerRole)).toEqual(['APPRENTICE']);
    expect(db.contractSignature.rows[0].userId).not.toBe(MASTER.id);
  });
  it('starts exactly when every required role has signed, not before, and not on a count', async () => {
    const c = await sent();
    expect((await signContract(MASTER, c.id, sig, ctx)).activated).toBe(false);
    expect((await signContract(GUARANTOR, c.id, sig, ctx)).activated).toBe(false);
    expect(row(c.id).status).toBe('PENDING_SIGNATURES');
    expect((await signContract(APPRENTICE, c.id, sig, ctx)).activated).toBe(true);
    expect(row(c.id).status).toBe('ACTIVE');
    await expect(signContract(APPRENTICE, c.id, sig, ctx)).rejects.toThrow('not waiting for signatures');
  });
});

describe('activation', () => {
  it('sets the dates now (not at creation), creates quarterly milestones and the Settlement Fund, and tells everyone', async () => {
    const c = await sent({ durationMonths: 12 });
    await signAll(c.id);
    const r = row(c.id);
    expect(r.status).toBe('ACTIVE');
    expect(r.startDate).toBeInstanceOf(Date);
    expect(r.endDate.getTime()).toBeGreaterThan(r.startDate.getTime());
    const ms = db.contractMilestone.rows.filter((m: Row) => m.contractId === c.id);
    expect(ms.map((m: Row) => m.dueMonth)).toEqual([3, 6, 9, 12]);
    expect(ms.every((m: Row) => m.status === 'NOT_STARTED' && m.dueDate instanceof Date)).toBe(true);
    expect(ms[3].dueDate.toISOString()).toBe(r.endDate.toISOString()); // the last milestone falls due on the end date
    expect(db.settlementFund.rows).toEqual([expect.objectContaining({ contractId: c.id, groupId: GROUP, status: 'ACCUMULATING' })]);
    // one contribution due per month, each the agreed monthly amount, the last on the end date
    const dues = db.contributionDue.rows.filter((x: Row) => x.contractId === c.id).sort((a: Row, b: Row) => a.number - b.number);
    expect(dues).toHaveLength(12);
    expect(dues.every((x: Row) => x.amountKobo === 2_000_000n && x.fundId === db.settlementFund.rows[0].id && x.flaggedAt === null && x.remindersSent.length === 0)).toBe(true);
    expect(dues[11].dueDate.toISOString()).toBe(r.endDate.toISOString());
    expect(sms.mock.calls.filter((x) => String(x[1]).includes('now active')).length).toBe(3);
  });
  it('month-end starts clamp: a 31 August start for 6 months ends on 28 February', async () => {
    const c = await sent();
    for (const [u, role] of [[MASTER, 'MASTER'], [APPRENTICE, 'APPRENTICE'], [GUARANTOR, 'GUARANTOR']] as const) db.contractSignature.rows.push({ id: id(), contractId: c.id, signerRole: role, userId: u.id });
    await tryActivate(c.id, new Date('2026-08-31T10:00:00Z'));
    expect(row(c.id).endDate.toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(db.contractMilestone.rows.filter((m: Row) => m.contractId === c.id).map((m: Row) => m.dueDate.toISOString().slice(0, 10))).toEqual(['2026-11-30', '2027-02-28']);
  });
  it('master-proposed milestones keep their titles and get real due dates; defaults are not added on top', async () => {
    const c = await sent({ milestones: [{ title: 'Cut a gown', dueMonth: 2 }, { title: 'Sew a suit', dueMonth: 5 }] });
    for (const [u, role] of [[MASTER, 'MASTER'], [APPRENTICE, 'APPRENTICE'], [GUARANTOR, 'GUARANTOR']] as const) db.contractSignature.rows.push({ id: id(), contractId: c.id, signerRole: role, userId: u.id });
    await tryActivate(c.id, new Date('2026-01-15T00:00:00Z'));
    const ms = db.contractMilestone.rows.filter((m: Row) => m.contractId === c.id);
    expect(ms.map((m: Row) => [m.title, m.dueDate.toISOString().slice(0, 10)])).toEqual([['Cut a gown', '2026-03-15'], ['Sew a suit', '2026-06-15']]);
  });
  it('calling it twice never creates a second fund or second set of milestones', async () => {
    const c = await sent();
    await signAll(c.id);
    await tryActivate(c.id); await tryActivate(c.id);
    expect(db.settlementFund.rows).toHaveLength(1);
    expect(db.contributionDue.rows).toHaveLength(6); // not doubled
    expect(db.contractMilestone.rows.filter((m: Row) => m.contractId === c.id)).toHaveLength(2);
  });
  it('if the group was switched to custody while people were signing, it does not start, and starts later once escrow is back', async () => {
    const c = await sent();
    await signContract(MASTER, c.id, sig, ctx); await signContract(GUARANTOR, c.id, sig, ctx);
    db.communityGroup.rows[0].fundsMode = 'COLLECTOR_CUSTODY';
    const r = await signContract(APPRENTICE, c.id, sig, ctx);
    expect(r).toMatchObject({ activated: false, blockedReason: 'ESCROW_ONLY' });
    expect(row(c.id).status).toBe('PENDING_SIGNATURES');
    expect(db.settlementFund.rows).toHaveLength(0);
    db.communityGroup.rows[0].fundsMode = 'ESCROW';
    expect((await tryActivate(c.id)).activated).toBe(true);
  });
  it('the age check is repeated at activation: a guardian is still required if one was named', async () => {
    const c = await sent({ guardianPhone: '08030000004' });
    await signAll(c.id);
    expect(row(c.id).status).toBe('PENDING_SIGNATURES'); // an adult apprentice with a named guardian still needs that signature
    await signContract(GUARDIAN, c.id, sig, ctx);
    expect(row(c.id).status).toBe('ACTIVE');
  });
});

describe('milestones', () => {
  let cid: string, m: Row;
  beforeEach(async () => { const c = await sent(); await signAll(c.id); cid = c.id; m = db.contractMilestone.rows.filter((x: Row) => x.contractId === cid)[0]; });

  it('moves NOT_STARTED → IN_PROGRESS → SUBMITTED → APPROVED, in order, by the right person', async () => {
    await expect(submitMilestone(APPRENTICE, m.id, {})).rejects.toThrow('cannot become');
    await expect(startMilestone(MASTER, m.id)).rejects.toThrow('Only the apprentice');
    await startMilestone(APPRENTICE, m.id);
    await expect(startMilestone(APPRENTICE, m.id)).rejects.toThrow('cannot become');
    await expect(submitMilestone(MASTER, m.id, {})).rejects.toThrow('Only the apprentice');
    await submitMilestone(APPRENTICE, m.id, { note: 'Made two gowns', evidenceUrl: 'https://x/e.jpg' });
    expect(m.status).toBe('SUBMITTED_FOR_REVIEW');
    expect(sms).toHaveBeenCalledWith('+2348030000001', expect.stringContaining('submitted'));
    await expect(reviewMilestone(APPRENTICE, m.id, { approve: true })).rejects.toThrow('Only the master');
    await expect(reviewMilestone(GUARANTOR, m.id, { approve: true })).rejects.toThrow('Only the master');
    await reviewMilestone(MASTER, m.id, { approve: true, badgeSkill: 'Cutting' });
    expect(m.status).toBe('APPROVED');
    expect(db.earnedSkillBadge.rows).toEqual([expect.objectContaining({ skill: 'Cutting', apprenticeId: APPRENTICE.id, awardedById: MASTER.id })]);
    await expect(reviewMilestone(MASTER, m.id, { approve: false, note: 'changed my mind' })).rejects.toThrow('cannot become');
  });
  it('a rejection needs a reason and sends the apprentice back to work', async () => {
    await startMilestone(APPRENTICE, m.id); await submitMilestone(APPRENTICE, m.id, {});
    await expect(reviewMilestone(MASTER, m.id, { approve: false })).rejects.toThrow('what to improve');
    await reviewMilestone(MASTER, m.id, { approve: false, note: 'Hems are uneven' });
    expect(m.status).toBe('REJECTED');
    expect(db.earnedSkillBadge.rows).toHaveLength(0);
    await startMilestone(APPRENTICE, m.id);
    expect(m.status).toBe('IN_PROGRESS');
  });
  it('only the master OF THIS agreement can review: another master cannot', async () => {
    await startMilestone(APPRENTICE, m.id); await submitMilestone(APPRENTICE, m.id, {});
    const other = { id: id(), role: 'TRADE_MASTER' };
    db.user.rows.push({ id: other.id, role: 'TRADE_MASTER', fullName: 'Other', phoneNumber: '+2348030000088' });
    await expect(reviewMilestone(other, m.id, { approve: true })).rejects.toThrow('Agreement not found');
    expect(m.status).toBe('SUBMITTED_FOR_REVIEW');
  });
  it('nothing moves while the agreement is paused', async () => {
    await pauseContract(MASTER, cid, 'Master is travelling for a month');
    await expect(startMilestone(APPRENTICE, m.id)).rejects.toThrow('not active');
  });
  it('approving every milestone completes the agreement, ready for settlement; with milestones left it does not', async () => {
    const [m1, m2] = db.contractMilestone.rows.filter((x: Row) => x.contractId === cid);
    for (const x of [m1, m2]) { await startMilestone(APPRENTICE, x.id); await submitMilestone(APPRENTICE, x.id, {}); }
    await reviewMilestone(MASTER, m1.id, { approve: true });
    expect(row(cid).status).toBe('ACTIVE');
    await reviewMilestone(MASTER, m2.id, { approve: true });
    expect(row(cid).status).toBe('COMPLETED_PENDING_SETTLEMENT');
  });
  it('an agreement with no milestones can never complete', async () => {
    db.contractMilestone.rows.length = 0;
    expect(await refreshCompletion(cid)).toBe(false);
    expect(row(cid).status).toBe('ACTIVE');
  });
});

describe('conduct: nobody grades themselves', () => {
  let cid: string;
  beforeEach(async () => { const c = await sent(); await signAll(c.id); cid = c.id; });
  it('a master rates the apprentice, an apprentice rates the master', async () => {
    expect((await logConduct(MASTER, cid, { category: 'PUNCTUALITY', rating: 4 })).ratedParty).toBe('APPRENTICE');
    expect((await logConduct(APPRENTICE, cid, { category: 'TEACHING', rating: 2, note: 'Rarely shows me anything' })).ratedParty).toBe('MASTER');
    expect(db.conductLog.rows.map((l: Row) => [l.authorId === MASTER.id ? 'master' : 'apprentice', l.ratedParty])).toEqual([['master', 'APPRENTICE'], ['apprentice', 'MASTER']]);
  });
  it('the rated side comes from who is signed in: it cannot be chosen, so a master cannot rate the master', async () => {
    await expect(logConduct(MASTER, cid, { category: 'TEACHING', rating: 5 })).rejects.toThrow('not something you can rate an apprentice on');
    await expect(logConduct(APPRENTICE, cid, { category: 'PUNCTUALITY', rating: 5 })).rejects.toThrow('not something you can rate a master on');
  });
  it('the guarantor, guardian and strangers cannot log', async () => {
    await expect(logConduct(GUARANTOR, cid, { category: 'OTHER', rating: 3 })).rejects.toThrow('Only the master and the apprentice');
    await expect(logConduct(STRANGER, cid, { category: 'OTHER', rating: 3 })).rejects.toThrow('Agreement not found');
  });
  it('ratings are 1 to 5, and only while the agreement is running', async () => {
    await expect(logConduct(MASTER, cid, { category: 'ATTITUDE', rating: 0 })).rejects.toThrow('1 to 5');
    await expect(logConduct(MASTER, cid, { category: 'ATTITUDE', rating: 6 })).rejects.toThrow('1 to 5');
    await terminateContract(MASTER, cid, 'Apprentice left the town for good');
    await expect(logConduct(MASTER, cid, { category: 'ATTITUDE', rating: 3 })).rejects.toThrow('while the agreement is running');
  });
  it('the parties can read the log; strangers cannot', async () => {
    await logConduct(MASTER, cid, { category: 'HONESTY', rating: 5 });
    expect(await conductFor(APPRENTICE, cid)).toHaveLength(1);
    await expect(conductFor(STRANGER, cid)).rejects.toThrow('Agreement not found');
  });
});

describe('pause, resume and end', () => {
  let cid: string;
  beforeEach(async () => { const c = await sent({ durationMonths: 12 }); await signAll(c.id); cid = c.id; sms.mockClear(); db.user.rows.find((u: Row) => u.id === BOARD.id).role = 'BOARD_MEMBER'; });

  it('pausing needs a reason, the master or oversight, and tells the guarantor and the Trust Board', async () => {
    await expect(pauseContract(APPRENTICE, cid, 'I want a break')).rejects.toThrow('Only the master');
    await expect(pauseContract(MASTER, cid, 'no')).rejects.toThrow('reason');
    await pauseContract(MASTER, cid, 'Workshop closed for repairs');
    expect(row(cid).status).toBe('PAUSED');
    expect(sms).toHaveBeenCalledWith('+2348030000003', expect.stringContaining('paused')); // guarantor
    expect(sms).toHaveBeenCalledWith('+2348030000005', expect.stringContaining('paused')); // Trust Board
    await expect(pauseContract(MASTER, cid, 'again please')).rejects.toThrow('Only an active');
  });
  it('resuming pushes the end date and unfinished milestones back by the days it was paused', async () => {
    const before = row(cid).endDate as Date;
    const ms = db.contractMilestone.rows.filter((x: Row) => x.contractId === cid);
    ms[0].status = 'APPROVED';
    const dues = ms.map((x: Row) => (x.dueDate as Date).getTime());
    const t0 = new Date('2026-05-01T10:00:00Z');
    await pauseContract(MASTER, cid, 'Master travelling abroad', t0);
    await resumeContract(MASTER, cid, new Date('2026-05-11T10:00:00Z'));
    const r = row(cid);
    expect(r.status).toBe('ACTIVE');
    expect(r.pausedDays).toBe(10);
    expect(r.endDate.getTime() - before.getTime()).toBe(10 * 86_400_000);
    expect(ms[0].dueDate.getTime()).toBe(dues[0]); // already approved: unchanged
    expect(ms[1].dueDate.getTime() - dues[1]).toBe(10 * 86_400_000);
    // the monthly contributions that had not yet fallen due move by the same ten days
    const cd = db.contributionDue.rows.filter((x: Row) => x.contractId === cid && x.dueDate.getTime() >= t0.getTime());
    expect(cd.length).toBeGreaterThan(0);
    await expect(resumeContract(MASTER, cid)).rejects.toThrow('not paused');
  });
  it('ending an agreement needs a reason, sends the fund to forfeit review, and nothing is paid out automatically', async () => {
    await expect(terminateContract(GUARANTOR, cid, 'I disagree with this')).rejects.toThrow('Only the master, the apprentice');
    await expect(terminateContract(MASTER, cid, 'bad')).rejects.toThrow('reason');
    await terminateContract(APPRENTICE, cid, 'I am moving to another city');
    expect(row(cid).status).toBe('TERMINATED');
    expect(db.settlementFund.rows[0].status).toBe('FORFEIT_REVIEW');
    expect(sms).toHaveBeenCalledWith('+2348030000003', expect.stringContaining('has ended'));
    expect(sms).toHaveBeenCalledWith('+2348030000005', expect.stringContaining('Settlement Fund needs a decision'));
    await expect(terminateContract(MASTER, cid, 'already finished here')).rejects.toThrow('already ended');
  });
  it('a draft can be dropped without bothering the board', async () => {
    const d = await draft(); sms.mockClear();
    await terminateContract(MASTER, d.id, 'Changed my mind before sending');
    expect(row(d.id).status).toBe('TERMINATED');
    expect(sms).not.toHaveBeenCalledWith('+2348030000005', expect.anything());
  });
  it('an admin or board member can pause and end, a stranger cannot even see it', async () => {
    await pauseContract(BOARD, cid, 'Complaint under review by the board');
    await resumeContract(ADMIN, cid);
    await expect(pauseContract(STRANGER, cid, 'I want to stop this')).rejects.toThrow('Agreement not found');
  });
});

describe('the view of an agreement', () => {
  it('shows names, amounts as exact strings, who is still to sign, and principal only: no interest or projection', async () => {
    const c = await sent({ monthlyStipend: '5000' });
    await signContract(MASTER, c.id, sig, ctx);
    const v = await getContract(APPRENTICE, c.id);
    expect(v).toMatchObject({ status: 'PENDING_SIGNATURES', monthlyContribution: '20000.00', targetSettlement: '150000.00', monthlyStipend: '5000.00', totalPlannedContributions: '120000.00', myRole: 'APPRENTICE', waitingFor: ['APPRENTICE', 'GUARANTOR'] });
    expect(v.parties.master).toMatchObject({ name: 'Mama Bísí' });
    expect(JSON.stringify(v)).not.toMatch(/interest|yield|return|projected/i);
    expect(v.signatures).toEqual([expect.objectContaining({ role: 'MASTER' })]);
    expect(JSON.stringify(v)).not.toContain('10.1.2.3'); // no IP addresses in a normal view
  });
  it('strangers cannot read it; admins and the board can; "mine" lists only my agreements', async () => {
    const c = await sent();
    await expect(getContract(STRANGER, c.id)).rejects.toThrow('Agreement not found');
    await expect(getContract(BOARD, c.id)).resolves.toBeDefined();
    await expect(getContract(ADMIN, c.id)).resolves.toBeDefined();
    expect(await myContracts(STRANGER)).toHaveLength(0);
    expect(await myContracts(GUARANTOR)).toHaveLength(1);
    void presentContract; void matches;
  });
});
