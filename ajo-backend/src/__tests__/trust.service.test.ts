import { clearTables, oid, Row, table } from './helpers/fakeDb';

const db: Record<string, any> = {
  user: table(), communityGroup: table(), groupMember: table(), apprenticeshipContract: table({ pausedDays: 0 }), conductLog: table({ excluded: false }), contractMilestone: table(), settlementFund: table(), contributionDue: table(),
  fundsEntry: table(), earnedSkillBadge: table(), trustScore: table(), guarantorRecord: table(), trustBoard: table(), trustBoardMember: table(), conductAppeal: table({ status: 'OPEN' }), tradeMasterProfile: table(),
  settlementRelease: table(), releaseApproval: table(), facilitatorAccount: table(), collectorKyc: table(), ajoPool: table(), auditLog: table(),
};
const appealCreate = db.conductAppeal.create;
db.conductAppeal.create = jest.fn(async (args: Row) => { if (db.conductAppeal.rows.some((a: Row) => a.conductLogId === args.data.conductLogId)) throw Object.assign(new Error('dup'), { code: 'P2002' }); return appealCreate(args); });
const sms = jest.fn();
jest.mock('../lib/prisma', () => ({ prisma: db }));
jest.mock('../lib/notify', () => ({ safeSms: (...a: unknown[]) => sms(...a), naira: (n: unknown) => `₦${n}` }));

import { boardIdOfGroup, boardMemberIdsFor, groupIdsOverseenBy, isBoardMemberFor } from '../modules/trust/board';
import { emitContractChanged } from '../modules/apprenticeship/contract.events';
import {
  addBoardMember, appealLog, assignGroupToBoard, boardDashboard, collectorProfile, createBoard, decideBoardMember, isVerifiedGuarantor, myTrust, publicTrust, recomputeForContract, recomputeGuarantor,
  recomputeTrust, registerTrustListeners, resolveAppeal, trustForBoard, verifyGuarantor,
} from '../modules/trust/trust.service';

const MASTER = { id: oid(), role: 'TRADE_MASTER' }, APPR = { id: oid(), role: 'MEMBER' }, GUAR = { id: oid(), role: 'MEMBER' }, ADMIN = { id: oid(), role: 'ADMIN' };
const BA = { id: oid(), role: 'BOARD_MEMBER' }, BB = { id: oid(), role: 'BOARD_MEMBER' }, BGLOBAL = { id: oid(), role: 'BOARD_MEMBER' }, STRANGER = { id: oid(), role: 'MEMBER' };
let GROUP: string, CID: string;
const K = (n: number) => BigInt(n) * 100n;
const contract = () => db.apprenticeshipContract.rows[0];
const log = (over: Row) => { const l = { id: oid(), contractId: CID, authorId: MASTER.id, ratedParty: 'APPRENTICE', category: 'PUNCTUALITY', rating: 4, excluded: false, ...over }; db.conductLog.rows.push(l); return l; };
const score = (userId: string, subject: string) => db.trustScore.rows.find((s: Row) => s.userId === userId && s.subject === subject);

beforeEach(() => {
  clearTables(db);
  jest.clearAllMocks();
  const mk = (u: { id: string; role: string }, phone: string, name: string) => db.user.rows.push({ id: u.id, role: u.role, fullName: name, phoneNumber: phone });
  mk(MASTER, '+2348030000001', 'Mama Bísí'); mk(APPR, '+2348030000002', 'Túndé'); mk(GUAR, '+2348030000003', 'Chief Okon'); mk(ADMIN, '+2348030000004', 'Admin');
  mk(BA, '+2348030000011', 'Board A'); mk(BB, '+2348030000012', 'Board B'); mk(BGLOBAL, '+2348030000013', 'Board Global'); mk(STRANGER, '+2348030000014', 'Stranger');
  GROUP = oid(); db.communityGroup.rows.push({ id: GROUP, name: 'Badagry Tailors', adminId: ADMIN.id });
  CID = oid();
  db.apprenticeshipContract.rows.push({ id: CID, masterId: MASTER.id, apprenticeId: APPR.id, guarantorId: GUAR.id, guardianId: null, communityGroupId: GROUP, status: 'ACTIVE', startDate: new Date('2026-01-01'), statusChangedById: null });
});

describe('who counts toward a score: nobody grades themselves', () => {
  it('only the master\'s ratings count about the apprentice, and only the apprentice\'s about the master', async () => {
    log({ rating: 5 }); log({ rating: 5 }); log({ rating: 5 }); // master about apprentice: valid
    log({ authorId: APPR.id, ratedParty: 'APPRENTICE', rating: 1 }); // the apprentice rating themselves: ignored
    log({ authorId: MASTER.id, ratedParty: 'MASTER', rating: 5 }); log({ authorId: MASTER.id, ratedParty: 'MASTER', rating: 5 }); log({ authorId: MASTER.id, ratedParty: 'MASTER', rating: 5 }); // the master rating the master: ignored
    const a = await recomputeTrust(APPR.id, 'APPRENTICE');
    expect(a.score).toBe(100); // the bogus 1 never entered
    const m = await recomputeTrust(MASTER.id, 'MASTER');
    expect(m.tier).toBe('UNRATED'); // self-praise cannot rate a master
    expect(m.score).toBeNull();
    log({ authorId: APPR.id, ratedParty: 'MASTER', rating: 2 }); log({ authorId: APPR.id, ratedParty: 'MASTER', rating: 2 }); log({ authorId: APPR.id, ratedParty: 'MASTER', rating: 2 });
    expect((await recomputeTrust(MASTER.id, 'MASTER')).score).toBe(40); // only the apprentice's 2/5 = 40
  });
  it('a rating removed on appeal no longer counts', async () => {
    log({ rating: 5 }); log({ rating: 5 }); log({ rating: 5 }); const bad = log({ rating: 1 });
    expect((await recomputeTrust(APPR.id, 'APPRENTICE')).score).toBe(80); // avg 4 → 80
    bad.excluded = true;
    expect((await recomputeTrust(APPR.id, 'APPRENTICE')).score).toBe(100);
  });
  it('honesty ratings of 2 or lower are counted as flags and take 15 off each', async () => {
    log({ rating: 5 }); log({ rating: 5 }); log({ rating: 5 }); log({ category: 'HONESTY', rating: 2 });
    const r = await recomputeTrust(APPR.id, 'APPRENTICE');
    expect(r.honestyFlags).toBe(1);
    // average (5+5+5+2)/4 = 4.25 → 85, less 15
    expect(r.score).toBe(70);
    log({ category: 'ATTITUDE', rating: 1 }); // a low rating in another category is not an honesty flag
    expect((await recomputeTrust(APPR.id, 'APPRENTICE')).honestyFlags).toBe(1);
  });
});

describe('milestones and finishing', () => {
  it('milestones: approved ÷ (approved + overdue and not approved)', async () => {
    const past = new Date(Date.now() - 86_400_000), future = new Date(Date.now() + 86_400_000 * 30);
    db.contractMilestone.rows.push({ id: oid(), contractId: CID, status: 'APPROVED', dueDate: past }, { id: oid(), contractId: CID, status: 'APPROVED', dueDate: past }, { id: oid(), contractId: CID, status: 'IN_PROGRESS', dueDate: past }, { id: oid(), contractId: CID, status: 'NOT_STARTED', dueDate: future });
    const r = await recomputeTrust(APPR.id, 'APPRENTICE');
    expect((r.breakdown as any).components.find((c: Row) => c.key === 'milestones')).toMatchObject({ value: 67, evidence: 3 }); // 2 of 3; the future one is not counted
  });
  it('an apprentice who walks away is marked down; one whose master ended the agreement is not', async () => {
    contract().status = 'TERMINATED'; contract().statusChangedById = MASTER.id;
    expect(((await recomputeTrust(APPR.id, 'APPRENTICE')).breakdown as any).components.find((c: Row) => c.key === 'completion').value).toBeNull();
    contract().statusChangedById = APPR.id;
    expect(((await recomputeTrust(APPR.id, 'APPRENTICE')).breakdown as any).components.find((c: Row) => c.key === 'completion')).toMatchObject({ value: 0, evidence: 1 });
  });
  it('a master\'s graduation rate counts every ending, whoever ended it', async () => {
    contract().status = 'GRADUATED';
    db.apprenticeshipContract.rows.push({ id: oid(), masterId: MASTER.id, apprenticeId: STRANGER.id, guarantorId: GUAR.id, communityGroupId: GROUP, status: 'TERMINATED', startDate: new Date(), statusChangedById: STRANGER.id });
    expect(((await recomputeTrust(MASTER.id, 'MASTER')).breakdown as any).components.find((c: Row) => c.key === 'graduation')).toMatchObject({ value: 50, evidence: 2 });
  });
  it('a master\'s on-time rate comes from when the confirmed payments actually arrived', async () => {
    const fund = { id: oid(), contractId: CID, groupId: GROUP }; db.settlementFund.rows.push(fund);
    const mk = (n: number) => ({ id: oid(), fundId: fund.id, dueDate: new Date(Date.now() - (5 - n) * 86_400_000 * 10), amountKobo: K(10_000), number: n });
    db.contributionDue.rows.push(mk(1), mk(2), mk(3), mk(4));
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000);
    db.fundsEntry.rows.push({ id: oid(), purposeType: 'SETTLEMENT_FUND', purposeId: fund.id, type: 'CONTRIBUTION', status: 'CONFIRMED', payerUserId: MASTER.id, amountKobo: K(20_000), createdAt: at(45) }); // months 1 and 2 on time
    db.fundsEntry.rows.push({ id: oid(), purposeType: 'SETTLEMENT_FUND', purposeId: fund.id, type: 'CONTRIBUTION', status: 'CONFIRMED', payerUserId: MASTER.id, amountKobo: K(20_000), createdAt: at(1) }); // months 3 and 4 caught up late
    const comp = ((await recomputeTrust(MASTER.id, 'MASTER')).breakdown as any).components.find((c: Row) => c.key === 'onTime');
    expect(comp).toMatchObject({ value: 50, evidence: 4 });
  });
  it('a payment by someone else (a community match) does not make the master look punctual', async () => {
    const fund = { id: oid(), contractId: CID, groupId: GROUP }; db.settlementFund.rows.push(fund);
    db.contributionDue.rows.push({ id: oid(), fundId: fund.id, dueDate: new Date(Date.now() - 86_400_000), amountKobo: K(10_000), number: 1 });
    db.fundsEntry.rows.push({ id: oid(), purposeType: 'SETTLEMENT_FUND', purposeId: fund.id, type: 'CONTRIBUTION', status: 'CONFIRMED', payerUserId: STRANGER.id, amountKobo: K(10_000), createdAt: new Date(Date.now() - 2 * 86_400_000) });
    expect(((await recomputeTrust(MASTER.id, 'MASTER')).breakdown as any).components.find((c: Row) => c.key === 'onTime').value).toBe(0);
  });
});

describe('scores refresh on events, not on every read', () => {
  it('a brand-new person is UNRATED, and reading twice does not recompute', async () => {
    const first = await myTrust(APPR);
    expect(first[0]).toMatchObject({ subject: 'APPRENTICE', score: null, tier: 'UNRATED' });
    const reads = db.conductLog.findMany.mock.calls.length;
    await myTrust(APPR); await myTrust(APPR);
    expect(db.conductLog.findMany.mock.calls.length).toBe(reads);
  });
  it('an event refreshes both people and the guarantor\'s record', async () => {
    log({ rating: 5 }); log({ rating: 5 }); log({ rating: 5 });
    await recomputeForContract(CID);
    expect(score(APPR.id, 'APPRENTICE')).toMatchObject({ score: 100, tier: 'EXEMPLARY' });
    expect(score(MASTER.id, 'MASTER')).toBeDefined();
    expect(db.guarantorRecord.rows.find((g: Row) => g.userId === GUAR.id)).toMatchObject({ contractsGuaranteed: 1, active: 1 });
  });
  it('a contract event wakes the listener, which recomputes', async () => {
    registerTrustListeners();
    log({ rating: 5 }); log({ rating: 5 }); log({ rating: 5 });
    emitContractChanged(CID);
    await new Promise((r) => setTimeout(r, 20));
    expect(score(APPR.id, 'APPRENTICE')?.tier).toBe('EXEMPLARY');
  });
  it('you only get scores for roles you have actually held', async () => {
    expect((await myTrust(STRANGER))).toEqual([]);
    expect((await myTrust(MASTER)).map((s) => s.subject)).toEqual(['MASTER']);
  });
});

describe('privacy: the public sees a tier and badges, the person and the board see the working', () => {
  beforeEach(async () => {
    log({ rating: 5 }); log({ rating: 5 }); log({ rating: 5 });
    db.earnedSkillBadge.rows.push({ id: oid(), apprenticeId: APPR.id, skill: 'Cutting' }, { id: oid(), apprenticeId: APPR.id, skill: 'Cutting' }, { id: oid(), apprenticeId: APPR.id, skill: 'Hemming' });
    await recomputeForContract(CID);
  });
  it('the public view has a tier and unique badges and nothing numeric', async () => {
    const p = await publicTrust(APPR.id);
    expect(p.asApprentice).toEqual({ tier: 'EXEMPLARY', badges: ['Cutting', 'Hemming'] });
    expect(JSON.stringify(p)).not.toMatch(/score|breakdown|honesty|rating|"100"/i);
  });
  it('the person sees their own breakdown', async () => {
    const mine = await myTrust(APPR);
    expect(mine[0].score).toBe(100);
    expect(JSON.stringify(mine[0].breakdown)).toContain('masterRatings');
  });
  it('the board and admins can see anyone\'s breakdown; ordinary members cannot', async () => {
    expect((await trustForBoard(BA, APPR.id))[0].score).toBe(100);
    expect((await trustForBoard(ADMIN, APPR.id))).toHaveLength(1);
    await expect(trustForBoard(STRANGER, APPR.id)).rejects.toThrow('Only an admin or a Trust Board member');
    await expect(trustForBoard(GUAR, APPR.id)).rejects.toThrow('Only an admin or a Trust Board member');
  });
});

describe('appeals', () => {
  let bad: Row;
  beforeEach(() => { bad = log({ rating: 1, category: 'HONESTY' }); log({ rating: 5 }); log({ rating: 5 }); log({ rating: 5 }); });
  it('only the person a rating is about can appeal it, once, with a real reason', async () => {
    await expect(appealLog(MASTER, bad.id, 'This is unfair to the apprentice')).rejects.toThrow('Only the person a rating is about');
    await expect(appealLog(STRANGER, bad.id, 'I just do not like it at all')).rejects.toThrow('Only the person a rating is about');
    await expect(appealLog(APPR, bad.id, 'short')).rejects.toThrow('Explain');
    await appealLog(APPR, bad.id, 'I was in hospital that week, not dishonest');
    await expect(appealLog(APPR, bad.id, 'Trying a second time here')).rejects.toThrow('already been appealed');
    expect(db.auditLog.rows.some((a: Row) => a.action === 'CONDUCT_APPEALED')).toBe(true);
  });
  it('the master can appeal a rating about the master', async () => {
    const aboutMaster = log({ authorId: APPR.id, ratedParty: 'MASTER', rating: 1 });
    await expect(appealLog(MASTER, aboutMaster.id, 'The apprentice was angry at a fair correction')).resolves.toBeDefined();
  });
  it('upholding removes the rating and the honesty flag from the score; dismissing leaves it', async () => {
    const before = await recomputeTrust(APPR.id, 'APPRENTICE');
    expect(before.honestyFlags).toBe(1);
    const a = await appealLog(APPR, bad.id, 'I was in hospital that week, not dishonest');
    await resolveAppeal(BA, a.id, { uphold: true, note: 'Hospital letter seen by the board' });
    expect(bad.excluded).toBe(true);
    expect(score(APPR.id, 'APPRENTICE')).toMatchObject({ honestyFlags: 0, score: 100 });
    expect(sms).toHaveBeenCalledWith('+2348030000002', expect.stringContaining('upheld'));
    await expect(resolveAppeal(BB, a.id, { uphold: false, note: 'Changing my mind later' })).rejects.toThrow('already decided');
  });
  it('dismissing keeps the rating', async () => {
    const a = await appealLog(APPR, bad.id, 'I was in hospital that week, not dishonest');
    await resolveAppeal(BA, a.id, { uphold: false, note: 'No evidence was given to the board' });
    expect(bad.excluded).toBe(false);
    expect(score(APPR.id, 'APPRENTICE').honestyFlags).toBe(1);
  });
  it('only the board or an admin decides, with a written reason, and never someone in the agreement', async () => {
    const a = await appealLog(APPR, bad.id, 'I was in hospital that week, not dishonest');
    await expect(resolveAppeal(STRANGER, a.id, { uphold: true, note: 'I like this person a lot' })).rejects.toThrow('Only the Trust Board or an admin');
    await expect(resolveAppeal(BA, a.id, { uphold: true, note: 'no' })).rejects.toThrow('reason');
    await expect(resolveAppeal({ id: MASTER.id, role: 'BOARD_MEMBER' }, a.id, { uphold: false, note: 'I am the master here' })).rejects.toThrow('part of this agreement');
    await expect(resolveAppeal({ id: GUAR.id, role: 'ADMIN' }, a.id, { uphold: true, note: 'Guarantor deciding' })).rejects.toThrow('part of this agreement');
  });
  it('a board member of a DIFFERENT community cannot decide this one', async () => {
    const board = await createBoard(ADMIN, { name: 'Ikorodu Board', community: 'Ikorodu' });
    const other = await createBoard(ADMIN, { name: 'Badagry Board', community: 'Badagry' });
    for (const [b, u] of [[board, BA], [other, BB]] as const) { const m = await addBoardMember(ADMIN, b.id, { phone: u === BA ? '08030000011' : '08030000012', title: 'Chief' }); await decideBoardMember(ADMIN, m.id, true); }
    await assignGroupToBoard(ADMIN, other.id, GROUP);
    const a = await appealLog(APPR, bad.id, 'I was in hospital that week, not dishonest');
    await expect(resolveAppeal(BA, a.id, { uphold: true, note: 'From another community' })).rejects.toThrow("not your community's");
    await expect(resolveAppeal(BB, a.id, { uphold: true, note: 'Seen the hospital letter' })).resolves.toMatchObject({ status: 'UPHELD' });
  });
});

describe('boards and who sits on them', () => {
  it('an admin makes a board, adds a person, and approves them separately; nobody approves themselves', async () => {
    await expect(createBoard(BA, { name: 'My board', community: 'Badagry' })).rejects.toThrow('Only an admin');
    const board = await createBoard(ADMIN, { name: 'Badagry Trust Board', community: 'Badagry' });
    await expect(addBoardMember(BA, board.id, { phone: '08030000011', title: 'Chief' })).rejects.toThrow('Only an admin');
    await expect(addBoardMember(ADMIN, board.id, { phone: '08099999999', title: 'Chief' })).rejects.toThrow('sign up');
    const m = await addBoardMember(ADMIN, board.id, { phone: '08030000014', title: 'Iyaloja (market leader)' });
    expect(m.status).toBe('PENDING');
    expect(db.user.rows.find((u: Row) => u.id === STRANGER.id).role).toBe('MEMBER'); // pending is not yet a board member
    await decideBoardMember(ADMIN, m.id, true);
    expect(db.user.rows.find((u: Row) => u.id === STRANGER.id).role).toBe('BOARD_MEMBER');
    const self = await addBoardMember(ADMIN, board.id, { phone: '08030000004', title: 'Admin' });
    await expect(decideBoardMember(ADMIN, self.id, true)).rejects.toThrow('cannot approve yourself');
    await decideBoardMember(ADMIN, m.id, false);
    expect(db.user.rows.find((u: Row) => u.id === STRANGER.id).role).toBe('MEMBER'); // removal gives the role back
  });
  it('a group with a board is overseen by that board\'s approved members only; one without falls back to the platform-wide board', async () => {
    expect((await boardMemberIdsFor(GROUP)).sort()).toEqual([BA.id, BB.id, BGLOBAL.id].sort()); // no board yet: every board-role user
    const board = await createBoard(ADMIN, { name: 'Badagry Board', community: 'Badagry' });
    const m = await addBoardMember(ADMIN, board.id, { phone: '08030000011', title: 'Chief' }); await decideBoardMember(ADMIN, m.id, true);
    await addBoardMember(ADMIN, board.id, { phone: '08030000012', title: 'Pending person' }); // not approved
    expect(await boardMemberIdsFor(GROUP)).toHaveLength(2); // BA now sits on a board so no longer acts for board-less groups; BB and BGLOBAL still do
    await assignGroupToBoard(ADMIN, board.id, GROUP);
    expect(await boardIdOfGroup(GROUP)).toBe(board.id);
    expect(await boardMemberIdsFor(GROUP)).toEqual([BA.id]);
    expect(await isBoardMemberFor(BA.id, GROUP)).toBe(true);
    expect(await isBoardMemberFor(BB.id, GROUP)).toBe(false);
    expect(await isBoardMemberFor(BGLOBAL.id, GROUP)).toBe(false);
    // BA now belongs to a board, so BA no longer acts for groups that have none
    const otherGroup = oid(); db.communityGroup.rows.push({ id: otherGroup, name: 'Other', adminId: ADMIN.id });
    expect((await boardMemberIdsFor(otherGroup)).sort()).toEqual([BB.id, BGLOBAL.id].sort());
  });
  it('what a board member oversees: their board\'s groups; admins see all', async () => {
    const board = await createBoard(ADMIN, { name: 'B', community: 'Badagry' });
    const m = await addBoardMember(ADMIN, board.id, { phone: '08030000011', title: 'Chief' }); await decideBoardMember(ADMIN, m.id, true);
    await assignGroupToBoard(ADMIN, board.id, GROUP);
    const free = oid(); db.communityGroup.rows.push({ id: free, name: 'Free', adminId: ADMIN.id });
    expect(await groupIdsOverseenBy(BA)).toEqual([GROUP]);
    expect(await groupIdsOverseenBy(BGLOBAL)).toEqual([free]);
    expect(await groupIdsOverseenBy(ADMIN)).toBe('ALL');
  });
});

describe('guarantors', () => {
  it('are verified by the board or an admin, never by themselves or an ordinary member', async () => {
    expect(await isVerifiedGuarantor(GUAR.id)).toBe(false);
    await expect(verifyGuarantor(STRANGER, GUAR.id)).rejects.toThrow('Only an admin or a Trust Board member');
    await expect(verifyGuarantor({ id: GUAR.id, role: 'BOARD_MEMBER' }, GUAR.id)).rejects.toThrow('yourself');
    await verifyGuarantor(BA, GUAR.id);
    expect(await isVerifiedGuarantor(GUAR.id)).toBe(true);
  });
  it('their record counts what they guaranteed and how it ended: reputation only, nothing staked', async () => {
    db.apprenticeshipContract.rows.push(
      { id: oid(), masterId: MASTER.id, apprenticeId: STRANGER.id, guarantorId: GUAR.id, communityGroupId: GROUP, status: 'GRADUATED', startDate: new Date() },
      { id: oid(), masterId: MASTER.id, apprenticeId: STRANGER.id, guarantorId: GUAR.id, communityGroupId: GROUP, status: 'TERMINATED', startDate: new Date() },
      { id: oid(), masterId: MASTER.id, apprenticeId: STRANGER.id, guarantorId: GUAR.id, communityGroupId: GROUP, status: 'DRAFT', startDate: null },
    );
    const r = await recomputeGuarantor(GUAR.id);
    expect(r).toMatchObject({ contractsGuaranteed: 3, active: 1, completed: 1, terminated: 1 });
    expect(Object.keys(r).join()).not.toMatch(/stake|wallet|balance|bond/i);
  });
});

describe('the collector\'s record on group screens', () => {
  it('shows custody dispute rate and on-time confirmation to the group\'s members only', async () => {
    db.groupMember.rows.push({ id: oid(), groupId: GROUP, userId: APPR.id });
    db.facilitatorAccount.rows.push({ id: 'acc1', userId: ADMIN.id });
    const t = new Date();
    for (let i = 0; i < 10; i++) db.fundsEntry.rows.push({ id: oid(), facilitatorAccountId: 'acc1', type: 'CONTRIBUTION', status: i === 0 ? 'DISPUTED' : 'CONFIRMED', createdAt: t, facilitatorConfirmedAt: new Date(t.getTime() + (i === 9 ? 72 : 2) * 3600_000) });
    const p = await collectorProfile(APPR, GROUP);
    expect(p).toMatchObject({ disputeRatePct: '10.0', onTimeConfirmationPct: '90.0', entriesInWindow: 10, cleanRecord: false, collector: 'Admin' });
    await expect(collectorProfile(STRANGER, GROUP)).rejects.toThrow('Only members');
    await expect(collectorProfile(BA, GROUP)).resolves.toBeDefined(); // the board can see it too
  });
});

describe('the board dashboard', () => {
  it('gathers what needs attention in the communities the member oversees, and hides appeals they are party to', async () => {
    db.tradeMasterProfile.rows.push({ id: oid(), userId: STRANGER.id, tradeCategories: ['weaving'], status: 'PENDING', appliedAt: new Date() });
    contract().status = 'PAUSED'; contract().statusReason = 'Workshop closed';
    db.fundsEntry.rows.push({ id: oid(), groupId: GROUP, status: 'DISPUTED', type: 'CONTRIBUTION', amountKobo: K(5_000), fundsMode: 'ESCROW', disputeNote: 'Not me', createdAt: new Date() });
    const bad = log({ rating: 1 });
    const a = await appealLog(APPR, bad.id, 'I was in hospital that week, not dishonest');
    db.guarantorRecord.rows.push({ id: oid(), userId: GUAR.id, verifiedAt: null });
    const dash = await boardDashboard(BA);
    expect(dash.pendingMasters).toEqual([expect.objectContaining({ name: 'Stranger' })]);
    expect(dash.pausedOrEnded).toEqual([expect.objectContaining({ status: 'PAUSED', reason: 'Workshop closed' })]);
    expect(dash.disputedPayments).toEqual([expect.objectContaining({ amount: '5000.00', note: 'Not me' })]);
    expect(dash.appeals.map((x) => x.id)).toEqual([a.id]);
    expect(dash.guarantorsToVerify).toEqual([expect.objectContaining({ name: 'Chief Okon' })]);
    const involved = await boardDashboard({ id: MASTER.id, role: 'BOARD_MEMBER' });
    expect(involved.appeals).toEqual([]); // a party never sees an appeal about their own agreement
    await expect(boardDashboard(STRANGER)).rejects.toThrow('Only an admin or a Trust Board member');
  });
});
