import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// The trust module against a real MongoDB: unset-field filters, unique indexes and board scoping behave differently here than in the in-memory fake.
jest.mock('../services/termii.service', () => ({ sendSms: async () => undefined }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let rs: MongoMemoryReplSet;
let prisma: any, svc: any, board: any;
const mk = (phone: string, name: string, role = 'MEMBER') => prisma.user.create({ data: { phoneNumber: phone, fullName: name, isVerified: true, role } });

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ binary: { version: '6.0.14' }, instanceOpts: [{ launchTimeout: 60000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const url = `${rs.getUri().split('/?')[0]}/ajo?replicaSet=testset`;
  process.env.DATABASE_URL = url;
  process.env.UPLOAD_DIR = path.join(os.tmpdir(), 'ajo-int-uploads');
  await promisify(execFile)(path.resolve('node_modules/.bin/prisma'), ['db', 'push', '--skip-generate', '--accept-data-loss'], { env: { ...process.env, DATABASE_URL: url }, timeout: 150000 });
  ({ prisma } = require('../lib/prisma'));
  svc = require('../modules/trust/trust.service');
  board = require('../modules/trust/board');
});
afterAll(async () => { await prisma?.$disconnect(); await rs?.stop(); });

describe('trust on a real database', () => {
  it('scores, boards, scoping, appeals and the dashboard', async () => {
    const admin = await mk('+2348090000001', 'Admin', 'ADMIN');
    const master = await mk('+2348090000002', 'Mama Bisi', 'TRADE_MASTER');
    const apprentice = await mk('+2348090000003', 'Tunde');
    const guarantor = await mk('+2348090000004', 'Chief Okon');
    const bA = await mk('+2348090000005', 'Board A', 'BOARD_MEMBER');
    const bGlobal = await mk('+2348090000006', 'Board Global', 'BOARD_MEMBER');
    const group = await prisma.communityGroup.create({ data: { name: 'Badagry Tailors', adminId: admin.id } }); // trustBoardId never written
    const c = await prisma.apprenticeshipContract.create({ data: {
      masterId: master.id, apprenticeId: apprentice.id, guarantorId: guarantor.id, communityGroupId: group.id, tradeCategory: 'tailoring', tenure: 'TWELVE', durationMonths: 12, status: 'ACTIVE', startDate: new Date(),
      monthlyContributionKobo: 1_000_000n, targetSettlementKobo: 12_000_000n, termsAndConditions: 'x'.repeat(40),
    } });
    for (const rating of [5, 5, 5]) await prisma.conductLog.create({ data: { contractId: c.id, authorId: master.id, ratedParty: 'APPRENTICE', category: 'PUNCTUALITY', rating } });
    const bad = await prisma.conductLog.create({ data: { contractId: c.id, authorId: master.id, ratedParty: 'APPRENTICE', category: 'HONESTY', rating: 1 } });

    await svc.recomputeForContract(c.id);
    const mine = await svc.myTrust({ id: apprentice.id, role: 'MEMBER' });
    expect(mine[0]).toMatchObject({ subject: 'APPRENTICE', honestyFlags: 1 });
    expect(JSON.stringify(await svc.publicTrust(apprentice.id))).not.toMatch(/score|honesty/i);

    // A group nobody has assigned to a board is overseen by the platform-wide board (explicit-null and unset-field filters).
    expect((await board.boardMemberIdsFor(group.id)).sort()).toEqual([bA.id, bGlobal.id].sort());
    expect(await board.groupIdsOverseenBy({ id: bGlobal.id, role: 'BOARD_MEMBER' })).toContain(group.id);

    const b = await svc.createBoard({ id: admin.id, role: 'ADMIN' }, { name: 'Badagry Board', community: 'Badagry' });
    const m = await svc.addBoardMember({ id: admin.id, role: 'ADMIN' }, b.id, { phone: '08090000005', title: 'Chief' });
    await svc.decideBoardMember({ id: admin.id, role: 'ADMIN' }, m.id, true);
    await svc.assignGroupToBoard({ id: admin.id, role: 'ADMIN' }, b.id, group.id);
    expect(await board.boardMemberIdsFor(group.id)).toEqual([bA.id]);
    expect(await board.isBoardMemberFor(bGlobal.id, group.id)).toBe(false);

    // Appeal: only the person it is about; upholding removes the flag.
    await expect(svc.appealLog({ id: master.id, role: 'TRADE_MASTER' }, bad.id, 'This is not allowed for the master')).rejects.toThrow();
    const a = await svc.appealLog({ id: apprentice.id, role: 'MEMBER' }, bad.id, 'I was in hospital that week, not dishonest');
    const dash = await svc.boardDashboard({ id: bA.id, role: 'BOARD_MEMBER' });
    expect(dash.appeals.map((x: any) => x.id)).toEqual([a.id]);
    expect((await svc.boardDashboard({ id: bGlobal.id, role: 'BOARD_MEMBER' })).appeals).toEqual([]); // another community's board never sees it
    await expect(svc.resolveAppeal({ id: bGlobal.id, role: 'BOARD_MEMBER' }, a.id, { uphold: true, note: 'Not my community' })).rejects.toThrow();
    await svc.resolveAppeal({ id: bA.id, role: 'BOARD_MEMBER' }, a.id, { uphold: true, note: 'Hospital letter seen by the board' });
    expect((await svc.myTrust({ id: apprentice.id, role: 'MEMBER' }))[0]).toMatchObject({ honestyFlags: 0 });
    await expect(svc.resolveAppeal({ id: bA.id, role: 'BOARD_MEMBER' }, a.id, { uphold: false, note: 'Second decision' })).rejects.toThrow('already decided');

    // Guarantor record on the real unique index
    await svc.verifyGuarantor({ id: bA.id, role: 'BOARD_MEMBER' }, guarantor.id);
    await svc.verifyGuarantor({ id: bA.id, role: 'BOARD_MEMBER' }, guarantor.id);
    expect(await svc.isVerifiedGuarantor(guarantor.id)).toBe(true);
    expect(await prisma.guarantorRecord.count({ where: { userId: guarantor.id } })).toBe(1);
  });
});
