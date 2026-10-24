import { clearTables, oid, Row, table } from './helpers/fakeDb';

const db: Record<string, any> = {
  user: table(), communityGroup: table(), apprenticeshipContract: table({ pausedDays: 0 }), contractMilestone: table(), settlementFund: table(), contributionDue: table(),
  fundsEntry: table(), providerTransaction: table(), trustBoardMember: table(), settlementRelease: table(), releaseApproval: table(), auditLog: table(),
};
const appr = db.apprenticeshipContract;
const origFind = appr.findUniqueOrThrow;
appr.findUniqueOrThrow = jest.fn(async (args: Row) => { const c = await origFind(args); return args.include ? { ...c, milestones: db.contractMilestone.rows.filter((m: Row) => m.contractId === c.id) } : c; });
const voteCreate = db.releaseApproval.create;
db.releaseApproval.create = jest.fn(async (args: Row) => { if (db.releaseApproval.rows.some((v: Row) => v.releaseId === args.data.releaseId && v.approverId === args.data.approverId)) throw Object.assign(new Error('dup'), { code: 'P2002' }); return voteCreate(args); });

const sms = jest.fn();
const mockContribute = jest.fn();
const mockValidate = jest.fn();
jest.mock('../lib/prisma', () => ({ prisma: db }));
jest.mock('../lib/notify', () => ({ safeSms: (...a: unknown[]) => sms(...a), safeSmsAndEmail: (...a: unknown[]) => a[0] && sms(a[0], a[3]), naira: (n: unknown) => `₦${n}` }));
jest.mock('../modules/payments/payments.service', () => ({ contribute: (...a: unknown[]) => mockContribute(...a) }));
jest.mock('../services/monnify.service', () => ({ ...jest.requireActual('../services/monnify.service'), validateBankAccount: (...a: unknown[]) => mockValidate(...a) }));
jest.mock('../modules/apprenticeship/contracts.service', () => {
  const { roleOf } = jest.requireActual('../modules/apprenticeship/contracts.logic');
  return {
    loadForUser: async (user: { id: string; role: string }, id: string) => {
      const c = db.apprenticeshipContract.rows.find((x: Row) => x.id === id);
      if (!c) throw Object.assign(new Error('Agreement not found'), { status: 404 });
      const role = roleOf(c, user.id);
      if (!role && user.role !== 'ADMIN' && user.role !== 'BOARD_MEMBER') throw Object.assign(new Error('Agreement not found'), { status: 404 });
      return { c: { ...c }, role };
    },
  };
});

import { MonnifyEscrowProvider } from '../modules/payments/monnify-escrow.provider';
import { scheduleDues } from '../modules/settlement/settlement.logic';
import { shiftDues } from '../modules/settlement/settlement.dues';
import {
  approveRelease, boardQueue, cancelRelease, confirmDestination, contributeToFund, executeRelease, fundTotals, onDisbursementSettled, openRelease, proposeDestination, releasePreconditions, retryRelease,
  runSettlementReminders, statement, statementCsv,
} from '../modules/settlement/settlement.service';

const MASTER = { id: oid(), role: 'TRADE_MASTER' }, APPR = { id: oid(), role: 'MEMBER' }, GUAR = { id: oid(), role: 'MEMBER' }, PARENT = { id: oid(), role: 'MEMBER' };
const B1 = { id: oid(), role: 'BOARD_MEMBER' }, B2 = { id: oid(), role: 'BOARD_MEMBER' }, B3 = { id: oid(), role: 'BOARD_MEMBER' }, ADMIN = { id: oid(), role: 'ADMIN' }, DONOR = { id: oid(), role: 'MEMBER' }, STRANGER = { id: oid(), role: 'MEMBER' };
const K = (n: number) => BigInt(n) * 100n;
const DAY = 86_400_000;
let GROUP: string, CID: string, FUND: string;
const release = jest.spyOn(MonnifyEscrowProvider.prototype, 'release');

const addEntry = (payer: string, kobo: bigint, over: Row = {}) => db.fundsEntry.rows.push({ id: oid(), groupId: GROUP, fundsMode: 'ESCROW', type: 'CONTRIBUTION', status: 'CONFIRMED', purposeType: 'SETTLEMENT_FUND', purposeId: FUND, payerUserId: payer, amountKobo: kobo, createdAt: new Date(), ...over });
const contract = () => db.apprenticeshipContract.rows[0];
const fund = () => db.settlementFund.rows[0];
const rel = () => db.settlementRelease.rows[db.settlementRelease.rows.length - 1];

beforeEach(() => {
  clearTables(db);
  jest.clearAllMocks();
  release.mockReset();
  mockValidate.mockResolvedValue({ accountName: 'TUNDE ADE BELLO' });
  const mk = (u: { id: string; role: string }, phone: string, name: string) => db.user.rows.push({ id: u.id, role: u.role, fullName: name, phoneNumber: phone });
  mk(MASTER, '+2348030000001', 'Mama Bísí'); mk(APPR, '+2348030000002', 'Túndé Adé Bello'); mk(GUAR, '+2348030000003', 'Chief Okon'); mk(PARENT, '+2348030000004', 'Iya Túndé');
  mk(B1, '+2348030000011', 'Board One'); mk(B2, '+2348030000012', 'Board Two'); mk(B3, '+2348030000013', 'Board Three'); mk(ADMIN, '+2348030000014', 'Admin'); mk(DONOR, '+2348030000015', 'Donor'); mk(STRANGER, '+2348030000016', 'Stranger');
  GROUP = oid();
  db.communityGroup.rows.push({ id: GROUP, name: 'Fund group', adminId: ADMIN.id }); // no Trust Board of its own: the platform-wide board oversees it
  const start = new Date('2026-01-15T00:00:00Z');
  CID = oid();
  db.apprenticeshipContract.rows.push({ id: CID, masterId: MASTER.id, apprenticeId: APPR.id, guarantorId: GUAR.id, guardianId: null, communityGroupId: GROUP, status: 'ACTIVE', durationMonths: 6, monthlyContributionKobo: K(20_000), tradeCategory: 'tailoring', startDate: start, pausedDays: 0 });
  FUND = oid();
  db.settlementFund.rows.push({ id: FUND, contractId: CID, groupId: GROUP, status: 'ACCUMULATING', releasedAt: null });
  for (const d of scheduleDues(start, 6, K(20_000))) db.contributionDue.rows.push({ id: oid(), contractId: CID, fundId: FUND, ...d, remindersSent: [], flaggedAt: null });
  db.contractMilestone.rows.push({ id: oid(), contractId: CID, status: 'APPROVED' }, { id: oid(), contractId: CID, status: 'APPROVED' });
});

describe('the fund: derived from confirmed money only', () => {
  it('splits master contributions from community match, ignores anything unconfirmed, and subtracts what has gone out', async () => {
    addEntry(MASTER.id, K(40_000)); addEntry(DONOR.id, K(15_000)); addEntry(MASTER.id, K(99_999), { status: 'DECLARED' }); addEntry(MASTER.id, K(99_999), { status: 'DISPUTED' });
    addEntry(APPR.id, K(5_000), { type: 'RELEASE' });
    db.providerTransaction.rows.push({ kind: 'COLLECT', status: 'INITIATED', purposeType: 'SETTLEMENT_FUND', purposeId: FUND, amountKobo: K(20_000) });
    const t = await fundTotals(fund(), MASTER.id);
    expect(t).toMatchObject({ masterConfirmed: K(40_000), communityMatch: K(15_000), contributionsTotal: K(55_000), pendingKobo: K(20_000), releasesKobo: K(5_000), balanceKobo: K(50_000) });
  });
  it('is exact in kobo (no floats): ₦0.01 amounts add up', async () => {
    for (let i = 0; i < 100; i++) addEntry(MASTER.id, 1n);
    expect((await fundTotals(fund(), MASTER.id)).balanceKobo).toBe(100n);
  });
  it('the statement shows principal only: no interest, yield or projected return anywhere', async () => {
    addEntry(MASTER.id, K(20_000));
    const s = await statement(MASTER, CID, new Date('2026-02-20T00:00:00Z'));
    expect(s.totals).toMatchObject({ masterContributions: '20000.00', balance: '20000.00', plannedContributions: '120000.00', stillPlanned: '100000.00' });
    expect(s.dues[0]).toMatchObject({ number: 1, status: 'PAID', paid: '20000.00' });
    expect(JSON.stringify(s)).not.toMatch(/interest|yield|return|projected|invest/i);
    const csv = await statementCsv(MASTER, CID);
    expect(csv).toContain('Community match');
    expect(csv).not.toMatch(/interest|yield|investor/i);
  });
  it('strangers cannot read a statement; the parties and the board can', async () => {
    await expect(statement(STRANGER, CID)).rejects.toThrow('Agreement not found');
    await expect(statement(GUAR, CID)).resolves.toBeDefined();
    await expect(statement(B1, CID)).resolves.toBeDefined();
  });
});

describe('contributing goes through escrow', () => {
  beforeEach(() => mockContribute.mockResolvedValue({ mode: 'ESCROW', notice: 'n', waterfall: {}, result: { kind: 'CHECKOUT', checkoutUrl: 'https://pay/x', paymentReference: 'CCA-1' } }));

  it('the master pays the next unpaid month by default, as a SETTLEMENT_FUND payment against the fund', async () => {
    await contributeToFund(MASTER, CID, {});
    expect(mockContribute).toHaveBeenCalledWith(MASTER, { groupId: GROUP, purposeType: 'SETTLEMENT_FUND', purposeId: FUND, amount: '20000.00' });
  });
  it('pays only what is still owed on that month, and cannot go over the planned total', async () => {
    addEntry(MASTER.id, K(5_000));
    await contributeToFund(MASTER, CID, {});
    expect(mockContribute.mock.calls[0][1].amount).toBe('15000.00');
    await expect(contributeToFund(MASTER, CID, { amount: '200000' })).rejects.toThrow('still planned');
    addEntry(MASTER.id, K(115_000));
    await expect(contributeToFund(MASTER, CID, {})).rejects.toThrow('All the planned contributions');
  });
  it('a community match must be asked for as a match, with an amount; nobody else pays the master\'s months', async () => {
    await expect(contributeToFund(DONOR, CID, { amount: '5000' })).rejects.toThrow('Agreement not found'); // not a party
    await contributeToFund(GUAR, CID, { amount: '5000', asMatch: true });
    expect(mockContribute).toHaveBeenCalledWith(GUAR, expect.objectContaining({ amount: '5000.00', purposeType: 'SETTLEMENT_FUND' }));
    await expect(contributeToFund(GUAR, CID, { amount: '5000' })).rejects.toThrow('Only the master');
    await expect(contributeToFund(GUAR, CID, { asMatch: true })).rejects.toThrow('how much');
  });
  it('only while the agreement is active and the fund is accumulating', async () => {
    contract().status = 'PAUSED';
    await expect(contributeToFund(MASTER, CID, {})).rejects.toThrow('only be made while the agreement is active');
    contract().status = 'ACTIVE'; fund().status = 'READY_FOR_RELEASE';
    await expect(contributeToFund(MASTER, CID, {})).rejects.toThrow('no longer accepting');
    expect(mockContribute).not.toHaveBeenCalled();
  });
});

describe('daily reminders and flags', () => {
  const due2 = () => db.contributionDue.rows.find((d: Row) => d.number === 2); // 15 Mar 2026
  it('reminds 3 days before, on the day, and 2 days late, once each, never for a paid month', async () => {
    addEntry(MASTER.id, K(20_000)); // month 1 is paid
    expect((await runSettlementReminders(new Date('2026-03-12T07:00:00Z'))).reminded).toBe(1);
    expect(sms).toHaveBeenLastCalledWith('+2348030000001', expect.stringContaining('due in 3 days'));
    await runSettlementReminders(new Date('2026-03-12T07:00:00Z'));
    expect(sms).toHaveBeenCalledTimes(1); // not twice
    await runSettlementReminders(new Date('2026-03-15T07:00:00Z'));
    expect(sms).toHaveBeenLastCalledWith('+2348030000001', expect.stringContaining('due today'));
    await runSettlementReminders(new Date('2026-03-17T07:00:00Z'));
    expect(sms).toHaveBeenLastCalledWith('+2348030000001', expect.stringContaining('2 days late'));
    expect(due2().remindersSent).toEqual([3, 0, -2]);
    expect(db.contributionDue.rows.find((d: Row) => d.number === 1).remindersSent).toEqual([]); // the paid month was never nagged
  });
  it('flags a contribution two days late to the Trust Board, once, and never touches any money', async () => {
    const before = JSON.stringify(db.fundsEntry.rows);
    expect((await runSettlementReminders(new Date('2026-03-17T07:00:00Z'))).flagged).toBeGreaterThanOrEqual(1);
    expect(due2().flaggedAt).toBeInstanceOf(Date);
    const first = due2().flaggedAt;
    await runSettlementReminders(new Date('2026-03-20T07:00:00Z'));
    expect(due2().flaggedAt).toBe(first);
    expect(JSON.stringify(db.fundsEntry.rows)).toBe(before);
    expect(db.providerTransaction.rows).toHaveLength(0);
    const q = await boardQueue(B1);
    expect(q.missedContributions.length).toBeGreaterThanOrEqual(1);
    expect(db.auditLog.rows.some((a: Row) => a.action === 'CONTRIBUTION_MISSED_FLAGGED')).toBe(true);
  });
  it('a paid month is never flagged, one day late is not flagged, and a paused agreement is left alone', async () => {
    addEntry(MASTER.id, K(40_000));
    expect((await runSettlementReminders(new Date('2026-03-17T07:00:00Z'))).flagged).toBe(0);
    clearTables({ f: db.fundsEntry });
    expect((await runSettlementReminders(new Date('2026-03-16T07:00:00Z'))).flagged).toBe(1); // month 1 was due 15 Feb: long late; month 2 only one day late
    contract().status = 'PAUSED';
    sms.mockClear();
    expect(await runSettlementReminders(new Date('2026-06-01T07:00:00Z'))).toEqual({ reminded: 0, flagged: 0 });
    expect(sms).not.toHaveBeenCalled();
  });
  it('a pause pushes later months back and restarts their reminders', async () => {
    due2().remindersSent = [3];
    const moved = await shiftDues(CID, new Date('2026-03-01T00:00:00Z'), 10);
    expect(moved).toBe(5); // months 2 to 6
    expect(due2().dueDate.toISOString().slice(0, 10)).toBe('2026-03-25');
    expect(due2().remindersSent).toEqual([]);
    expect(db.contributionDue.rows.find((d: Row) => d.number === 1).dueDate.toISOString().slice(0, 10)).toBe('2026-02-15');
  });
});

describe('release: preconditions', () => {
  const ready = () => { contract().status = 'COMPLETED_PENDING_SETTLEMENT'; addEntry(MASTER.id, K(120_000)); };
  it('lists every reason it cannot start', async () => {
    const p = await releasePreconditions(CID);
    expect(p.unmet.join(' ')).toMatch(/not finished/);
    expect(p.unmet.join(' ')).toMatch(/no confirmed money/);
    db.contractMilestone.rows.length = 0;
    expect((await releasePreconditions(CID)).unmet.join(' ')).toMatch(/at least one/); // no milestones: can never graduate
    db.contractMilestone.rows.push({ id: oid(), contractId: CID, status: 'APPROVED' }, { id: oid(), contractId: CID, status: 'SUBMITTED_FOR_REVIEW' });
    expect((await releasePreconditions(CID)).unmet.join(' ')).toMatch(/Every milestone must be approved/);
  });
  it('a payment under dispute blocks it', async () => {
    ready(); addEntry(MASTER.id, K(1_000), { status: 'DISPUTED' });
    expect((await releasePreconditions(CID)).unmet.join(' ')).toMatch(/under dispute/);
  });
  it('opens the release, marks the fund READY_FOR_RELEASE and tells the graduate and the Trust Board', async () => {
    ready();
    const r = await openRelease(MASTER, CID);
    expect(r.status).toBe('AWAITING_DESTINATION');
    expect(fund().status).toBe('READY_FOR_RELEASE');
    expect(sms).toHaveBeenCalledWith('+2348030000002', expect.stringContaining('ready to be released'));
    expect(sms).toHaveBeenCalledWith('+2348030000011', expect.stringContaining('ready for release'));
    expect(db.auditLog.rows.some((a: Row) => a.action === 'RELEASE_OPENED' && a.meta?.to === 'READY_FOR_RELEASE')).toBe(true);
  });
  it('cannot be opened twice, by strangers, or by the guarantor', async () => {
    ready();
    await openRelease(APPR, CID);
    await expect(openRelease(MASTER, CID)).rejects.toThrow('already in progress');
    await expect(openRelease(STRANGER, CID)).rejects.toThrow('Agreement not found');
    await expect(openRelease(GUAR, CID)).rejects.toThrow('Only the master, the apprentice');
    expect(db.settlementRelease.rows).toHaveLength(1);
  });
  it('an unfinished or terminated agreement cannot release', async () => {
    addEntry(MASTER.id, K(120_000));
    await expect(openRelease(MASTER, CID)).rejects.toThrow('not finished');
    contract().status = 'TERMINATED'; fund().status = 'FORFEIT_REVIEW';
    await expect(openRelease(MASTER, CID)).rejects.toThrow('forfeit review');
  });
});

describe('release: the graduate says where, the bank says whose', () => {
  let rid: string;
  const dest = { kind: 'GRADUATE' as const, bankCode: '058', accountNumber: '0123456789' };
  beforeEach(async () => { contract().status = 'COMPLETED_PENDING_SETTLEMENT'; addEntry(MASTER.id, K(120_000)); rid = (await openRelease(APPR, CID)).id; });

  it('only the graduate proposes; the name stored is the one the BANK returned', async () => {
    await expect(proposeDestination(MASTER, rid, dest)).rejects.toThrow('Only the graduate');
    const r = await proposeDestination(APPR, rid, dest);
    expect(r).toMatchObject({ status: 'AWAITING_CONFIRMATION', accountName: 'TUNDE ADE BELLO', nameMismatch: false });
    expect(mockValidate).toHaveBeenCalledWith('0123456789', '058');
  });
  it('an account in somebody else\'s name is flagged for the graduate and the board, not silently accepted', async () => {
    mockValidate.mockResolvedValue({ accountName: 'KEMI OKAFOR' });
    expect((await proposeDestination(APPR, rid, dest)).nameMismatch).toBe(true);
  });
  it('a bad account, or one the bank cannot confirm, is refused', async () => {
    await expect(proposeDestination(APPR, rid, { ...dest, accountNumber: '123' })).rejects.toThrow('10 digits');
    mockValidate.mockRejectedValue(new Error('no such account'));
    await expect(proposeDestination(APPR, rid, dest)).rejects.toThrow('could not confirm');
  });
  it('a supplier or landlord needs a stated reason', async () => {
    await expect(proposeDestination(APPR, rid, { ...dest, kind: 'LANDLORD' })).rejects.toThrow('what this payment is for');
    await expect(proposeDestination(APPR, rid, { ...dest, kind: 'LANDLORD', note: 'Shop rent for the first year' })).resolves.toMatchObject({ destinationKind: 'LANDLORD' });
  });
  it('changing the destination takes back any confirmation', async () => {
    await proposeDestination(APPR, rid, dest);
    await confirmDestination(APPR, rid);
    expect(rel().status).toBe('AWAITING_APPROVALS');
    await expect(proposeDestination(APPR, rid, dest)).rejects.toThrow('can no longer be changed'); // once confirmed it is fixed
  });
  it('the board cannot approve until the graduate has confirmed the destination', async () => {
    await proposeDestination(APPR, rid, dest);
    await expect(approveRelease(B1, rid, { approve: true })).rejects.toThrow('not waiting for approval');
    expect(release).not.toHaveBeenCalled();
  });
  it('with a guardian on the agreement, the guardian must confirm as well', async () => {
    contract().guardianId = PARENT.id;
    await proposeDestination(APPR, rid, dest);
    await confirmDestination(APPR, rid);
    expect(rel().status).toBe('AWAITING_CONFIRMATION');
    await expect(confirmDestination(GUAR, rid)).rejects.toThrow('Only the graduate and their guardian');
    await confirmDestination(PARENT, rid);
    expect(rel().status).toBe('AWAITING_APPROVALS');
  });
  it('the board is told only once the destination is fully confirmed', async () => {
    await proposeDestination(APPR, rid, dest);
    sms.mockClear();
    await confirmDestination(APPR, rid);
    expect(sms).toHaveBeenCalledWith('+2348030000011', expect.stringContaining('needs your approval'));
  });
});

describe('release: 2 of 3 Trust Board approvals, then the money moves', () => {
  let rid: string;
  const entry = { id: 'ent1', type: 'RELEASE', status: 'DECLARED', purposeId: '', amountKobo: K(120_000) };
  beforeEach(async () => {
    contract().status = 'COMPLETED_PENDING_SETTLEMENT'; addEntry(MASTER.id, K(100_000)); addEntry(DONOR.id, K(20_000));
    rid = (await openRelease(APPR, CID)).id;
    await proposeDestination(APPR, rid, { kind: 'GRADUATE', bankCode: '058', accountNumber: '0123456789' });
    await confirmDestination(APPR, rid);
    entry.purposeId = FUND;
    release.mockResolvedValue(entry as never);
  });

  it('one approval is not enough; the second sends the full confirmed balance to the confirmed account, once', async () => {
    expect(await approveRelease(B1, rid, { approve: true })).toMatchObject({ status: 'AWAITING_APPROVALS', approvals: 1, required: 2 });
    expect(release).not.toHaveBeenCalled();
    const r = await approveRelease(B2, rid, { approve: true });
    expect(r.status).toBe('DISBURSING');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(expect.objectContaining({
      groupId: GROUP, purposeType: 'SETTLEMENT_FUND', purposeId: FUND, actorId: B2.id, recipientUserId: APPR.id, amountKobo: K(120_000),
      destination: { bankCode: '058', accountNumber: '0123456789', accountName: 'TUNDE ADE BELLO' },
    }));
    expect(rel()).toMatchObject({ status: 'DISBURSING', amountKobo: K(120_000), fundsEntryId: 'ent1' });
  });
  it('only a Trust Board member can approve: not an admin, the master, the graduate or a stranger', async () => {
    for (const u of [ADMIN, MASTER, APPR, GUAR, STRANGER]) await expect(approveRelease(u, rid, { approve: true })).rejects.toThrow('Only a Trust Board member');
    expect(db.releaseApproval.rows).toHaveLength(0);
  });
  it('conflict of interest: a board member who is on the agreement cannot approve it', async () => {
    const inside = { id: GUAR.id, role: 'BOARD_MEMBER' }; // the guarantor also happens to sit on the board
    await expect(approveRelease(inside, rid, { approve: true })).rejects.toThrow('part of this agreement');
    const master = { id: MASTER.id, role: 'BOARD_MEMBER' };
    await expect(approveRelease(master, rid, { approve: true })).rejects.toThrow('part of this agreement');
    expect(db.releaseApproval.rows).toHaveLength(0);
  });
  it('the same member cannot vote twice, so one person can never be both approvals', async () => {
    await approveRelease(B1, rid, { approve: true });
    await expect(approveRelease(B1, rid, { approve: true })).rejects.toThrow('already voted');
    expect(release).not.toHaveBeenCalled();
  });
  it('two rejections stop it, and the money stays in the fund, still ready for a new release', async () => {
    await expect(approveRelease(B1, rid, { approve: false })).rejects.toThrow('Say why');
    await approveRelease(B1, rid, { approve: false, note: 'Destination does not match' });
    expect(rel().status).toBe('AWAITING_APPROVALS');
    expect((await approveRelease(B2, rid, { approve: false, note: 'Agree with Board One' })).status).toBe('REJECTED');
    expect(release).not.toHaveBeenCalled();
    expect(fund().status).toBe('READY_FOR_RELEASE');
    expect((await releasePreconditions(CID)).unmet).toEqual([]); // a new release can start
  });
  it('two of three is enough even after one rejection', async () => {
    await approveRelease(B1, rid, { approve: false, note: 'I want more detail' });
    await approveRelease(B2, rid, { approve: true });
    expect((await approveRelease(B3, rid, { approve: true })).status).toBe('DISBURSING');
  });
  it('a release cannot be sent twice: the claim succeeds once, and the partner is asked once', async () => {
    await approveRelease(B1, rid, { approve: true });
    await approveRelease(B2, rid, { approve: true });
    await expect(executeRelease(rid, B2.id)).rejects.toThrow('already being sent');
    await expect(retryRelease(B3, rid)).rejects.toThrow('Nothing to retry');
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('concurrent attempts still send once', async () => {
    await approveRelease(B1, rid, { approve: true });
    const results = await Promise.allSettled([approveRelease(B2, rid, { approve: true }), executeRelease(rid, B3.id), executeRelease(rid, B3.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('if the partner cannot start it (for example escrow is gated), nothing is lost: it goes back to waiting and can be retried by an unconflicted board member', async () => {
    release.mockRejectedValueOnce(Object.assign(new Error('MONNIFY_POOLING_APPROVED is not enabled yet'), { status: 503 }));
    await approveRelease(B1, rid, { approve: true });
    await expect(approveRelease(B2, rid, { approve: true })).rejects.toThrow('not enabled yet');
    expect(rel()).toMatchObject({ status: 'AWAITING_APPROVALS' });
    expect(rel().failureReason).toContain('not enabled yet');
    await expect(retryRelease({ id: GUAR.id, role: 'BOARD_MEMBER' }, rid)).rejects.toThrow('part of this agreement');
    await expect(retryRelease(MASTER, rid)).rejects.toThrow('Only the Trust Board or an admin');
    await retryRelease(B3, rid);
    expect(release).toHaveBeenCalledTimes(2);
    expect(rel().status).toBe('DISBURSING');
  });
  it('nothing is sent if there is no confirmed money left', async () => {
    db.fundsEntry.rows.length = 0;
    await approveRelease(B1, rid, { approve: true });
    await expect(approveRelease(B2, rid, { approve: true })).rejects.toThrow('no confirmed money');
    expect(release).not.toHaveBeenCalled();
  });
  it('a release can be cancelled before it is sent, never after', async () => {
    await expect(cancelRelease(GUAR, rid)).rejects.toThrow('Only the master, the graduate');
    await approveRelease(B1, rid, { approve: true });
    await cancelRelease(APPR, rid);
    expect(rel().status).toBe('CANCELLED');
    await expect(cancelRelease(APPR, rid)).rejects.toThrow('can no longer be cancelled');
  });
  it('every transition is in the audit log', async () => {
    await approveRelease(B1, rid, { approve: true });
    await approveRelease(B2, rid, { approve: true });
    const actions = db.auditLog.rows.map((a: Row) => a.action);
    for (const a of ['RELEASE_OPENED', 'RELEASE_DESTINATION_PROPOSED', 'RELEASE_DESTINATION_CONFIRMED', 'RELEASE_APPROVED_BY', 'RELEASE_DISBURSEMENT_STARTED']) expect(actions).toContain(a);
  });
});

describe('release: the outcome from the payment partner', () => {
  let rid: string;
  const entry = () => ({ id: 'ent1', purposeId: FUND, amountKobo: K(120_000) });
  beforeEach(async () => {
    contract().status = 'COMPLETED_PENDING_SETTLEMENT'; addEntry(MASTER.id, K(120_000));
    rid = (await openRelease(APPR, CID)).id;
    await proposeDestination(APPR, rid, { kind: 'GRADUATE', bankCode: '058', accountNumber: '0123456789' });
    await confirmDestination(APPR, rid);
    release.mockResolvedValue({ id: 'ent1', type: 'RELEASE', status: 'DECLARED', purposeId: FUND, amountKobo: K(120_000) } as never);
    await approveRelease(B1, rid, { approve: true }); await approveRelease(B2, rid, { approve: true });
  });
  it('success completes the release, marks the fund RELEASED and graduates the apprentice, once', async () => {
    expect(await onDisbursementSettled(entry(), true)).toBe(true);
    expect(rel()).toMatchObject({ status: 'RELEASED', amountKobo: K(120_000) });
    expect(fund()).toMatchObject({ status: 'RELEASED' });
    expect(fund().releasedAt).toBeInstanceOf(Date);
    expect(contract().status).toBe('GRADUATED');
    expect(sms).toHaveBeenCalledWith('+2348030000002', expect.stringContaining('has been sent'));
    expect(await onDisbursementSettled(entry(), true)).toBe(false); // a duplicate webhook does nothing
    expect(sms.mock.calls.filter((c) => String(c[1]).includes('has been sent'))).toHaveLength(3);
  });
  it('a released fund cannot be released again', async () => {
    await onDisbursementSettled(entry(), true);
    await expect(openRelease(MASTER, CID)).rejects.toThrow(/not finished|fund is released/);
  });
  it('failure marks the release FAILED, leaves the money in the fund and the agreement as it was, and tells the board', async () => {
    sms.mockClear();
    expect(await onDisbursementSettled(entry(), false, 'Invalid account')).toBe(true);
    expect(rel()).toMatchObject({ status: 'FAILED', failureReason: 'Invalid account' });
    expect(fund().status).toBe('READY_FOR_RELEASE');
    expect(contract().status).toBe('COMPLETED_PENDING_SETTLEMENT');
    expect(sms).toHaveBeenCalledWith('+2348030000011', expect.stringContaining('FAILED'));
    expect((await releasePreconditions(CID)).unmet).toEqual([]); // a fresh release can be opened
    expect((await openRelease(MASTER, CID)).status).toBe('AWAITING_DESTINATION');
  });
  it('an outcome for a fund with nothing being sent is ignored', async () => {
    await onDisbursementSettled(entry(), true);
    expect(await onDisbursementSettled({ id: 'x', purposeId: oid(), amountKobo: 1n }, true)).toBe(false);
  });
});

describe('the board queue never shows a release the viewer has a stake in', () => {
  it('lists releases waiting for a vote and whether this member voted', async () => {
    contract().status = 'COMPLETED_PENDING_SETTLEMENT'; addEntry(MASTER.id, K(50_000));
    const rid = (await openRelease(APPR, CID)).id;
    await proposeDestination(APPR, rid, { kind: 'GRADUATE', bankCode: '058', accountNumber: '0123456789' });
    await confirmDestination(APPR, rid);
    await approveRelease(B1, rid, { approve: true });
    const q1 = await boardQueue(B1), q2 = await boardQueue(B2);
    expect(q1.releases[0]).toMatchObject({ id: rid, iVoted: true, approvals: 1 });
    expect(q2.releases[0]).toMatchObject({ id: rid, iVoted: false });
    expect(JSON.stringify(q2)).not.toContain('0123456789'); // the full account number is never shown
    expect((await boardQueue({ id: GUAR.id, role: 'BOARD_MEMBER' })).releases).toHaveLength(0);
    await expect(boardQueue(MASTER)).rejects.toThrow('Only the Trust Board');
  });
});
