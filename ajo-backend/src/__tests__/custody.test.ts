const mockPrisma: Record<string, any> = {
  collectorKyc: { findUnique: jest.fn(), update: jest.fn(), upsert: jest.fn() },
  communityGroup: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), count: jest.fn() },
  facilitatorAccount: { findUnique: jest.fn(), findMany: jest.fn() },
  fundsEntry: { groupBy: jest.fn(), aggregate: jest.fn(), findMany: jest.fn() },
  ajoPool: { count: jest.fn() },
  groupMember: { count: jest.fn() },
  user: { findUniqueOrThrow: jest.fn() },
  auditLog: { create: jest.fn() },
};
jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
const mockHasSigned = jest.fn();
const mockEnforce = jest.fn();
jest.mock('../modules/consent/consent.service', () => ({ hasSigned: (...a: unknown[]) => mockHasSigned(...a), enforceCustodyConsentAtCycleStart: (...a: unknown[]) => mockEnforce(...a) }));

import { Prisma } from '@prisma/client';
import { decisions, launchGates, tierConfig } from '../config/decisions';
import {
  applyPendingFundsMode, applyPendingTier, approveTier, assertCustodyContribution, assertEscrowOnly, assertPilotLimits, cleanRecord, eligibleTier,
  evaluateDowngrade, requestFundsMode, StubKycProvider, verifyCollectorIdentity,
} from '../modules/payments/custody.service';

const id = (c: string) => c.repeat(24);
const COLLECTOR = id('a'), GROUP = id('b'), ADMIN = id('c'), ACC = id('d');
const N = (n: number) => BigInt(n) * 100n; // naira → kobo

const kyc = (over: Record<string, unknown> = {}) => ({ id: id('9'), userId: COLLECTOR, approvedTier: 1, pendingTier: null, requestedTier: null, bvnVerified: true, ninVerified: false, nameMatch: true, addressAttested: false, entityCertVerified: false, licenseDocsVerified: false, entityAccountName: null, boardEndorsed: false, ...over });
const group = (over: Record<string, unknown> = {}) => ({ id: GROUP, adminId: COLLECTOR, fundsMode: 'COLLECTOR_CUSTODY', registrationStatus: 'IN_PROGRESS', pendingFundsMode: null, ...over });
const held = (kobo: bigint) => mockPrisma.fundsEntry.groupBy.mockResolvedValue([{ type: 'CONTRIBUTION', _sum: { amountKobo: kobo } }]);

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.fundsEntry.aggregate.mockResolvedValue({ _sum: { amountKobo: 0n } });
  mockPrisma.communityGroup.findMany.mockResolvedValue([{ id: GROUP }]);
  mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc());
  mockHasSigned.mockResolvedValue(true);
  mockEnforce.mockResolvedValue([]);
});

describe('tier table (decisions)', () => {
  it('matches the agreed caps', () => {
    expect(tierConfig(1)).toMatchObject({ maxPerGroupKobo: N(500_000), maxPerCollectorKobo: N(1_000_000), minCleanCycles: 0 });
    expect(tierConfig(2)).toMatchObject({ maxPerGroupKobo: N(2_000_000), maxPerCollectorKobo: N(4_000_000), minCleanCycles: 2, needsNin: true, needsAddress: true, needsBoardEndorsement: true });
    expect(tierConfig(3)).toMatchObject({ maxPerGroupKobo: N(5_000_000), maxPerCollectorKobo: N(10_000_000), minCleanCycles: 4, needsEntityDocs: true, entityAccountOnly: true });
  });
  it('gates default closed and biometric KYC is never open', () => {
    const gates = Object.fromEntries(launchGates().map((g) => [g.name, g.open]));
    expect(gates).toEqual({ MONNIFY_POOLING_APPROVED: false, CONSENT_DOCS_APPROVED: false, BILLING_ENFORCED: false, BIOMETRIC_KYC_ENABLED: false });
  });
  it('defaults: 5% commission, 0% on settlement funds, platform bears gateway fees, 5-group / 30-member pilot', () => {
    expect(decisions.defaultPlatformCommissionBp).toBe(500);
    expect(decisions.settlementCommissionBp).toBe(0);
    expect(decisions.gatewayFeeBearer).toBe('PLATFORM');
    expect(decisions.pilot).toEqual({ maxGroups: 5, maxMembersPerGroup: 30 });
  });
});

describe('no biometric data and no raw national ids anywhere in the schema', () => {
  const fields = Prisma.dmmf.datamodel.models.flatMap((m) => m.fields.map((f) => ({ model: m.name, name: f.name, type: f.type })));
  it('has no face, selfie, liveness, fingerprint or biometric fields', () => {
    expect(fields.filter((f) => /face|selfie|liveness|fingerprint|biometric|facial/i.test(f.name))).toEqual([]);
  });
  it('stores no raw BVN or NIN numbers, only outcomes', () => {
    expect(fields.filter((f) => /^(bvn|nin)(number)?$/i.test(f.name))).toEqual([]);
    const kycFields = fields.filter((f) => f.model === 'CollectorKyc').map((f) => f.name);
    expect(kycFields).toEqual(expect.arrayContaining(['bvnVerified', 'ninVerified', 'nameMatch', 'providerRef']));
  });
});

describe('identity check', () => {
  it('stub provider: 11 digits verify, ending 000 fails the name match', async () => {
    const p = new StubKycProvider();
    expect(await p.verifyIdentity({ kind: 'BVN', idNumber: '12345678901' })).toMatchObject({ verified: true, nameMatch: true });
    expect(await p.verifyIdentity({ kind: 'BVN', idNumber: '12345678000' })).toMatchObject({ verified: true, nameMatch: false });
    expect((await p.verifyIdentity({ kind: 'NIN', idNumber: 'abc' })).verified).toBe(false);
  });
  it('keeps the outcome and drops the number: it never reaches the DB or the audit log', async () => {
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ fullName: 'A', phoneNumber: '+234' });
    mockPrisma.collectorKyc.upsert.mockResolvedValue({ id: id('9') });
    await verifyCollectorIdentity(COLLECTOR, 'BVN', '12345678901');
    const written = JSON.stringify([mockPrisma.collectorKyc.upsert.mock.calls, mockPrisma.auditLog.create.mock.calls]);
    expect(written).not.toContain('12345678901');
  });
  it('a name mismatch is reported but never marks the collector verified for tier 1', async () => {
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ fullName: 'A', phoneNumber: '+234' });
    mockPrisma.collectorKyc.upsert.mockResolvedValue({ id: id('9') });
    await expect(verifyCollectorIdentity(COLLECTOR, 'BVN', '12345678000')).rejects.toThrow('does not match');
    expect(mockPrisma.collectorKyc.upsert.mock.calls[0][0].update.nameMatch).toBe(false);
    expect(eligibleTier(kyc({ nameMatch: false }) as never, 10, true)).toBe(0);
  });
});

describe('which tier a collector qualifies for', () => {
  it('none without verification; tier 1 with BVN + name match', () => {
    expect(eligibleTier(null, 0, true)).toBe(0);
    expect(eligibleTier(kyc() as never, 0, true)).toBe(1);
  });
  it('tier 2 needs NIN + address + board endorsement + 2 clean cycles', () => {
    const full = kyc({ ninVerified: true, addressAttested: true, boardEndorsed: true });
    expect(eligibleTier(full as never, 2, true)).toBe(2);
    expect(eligibleTier(full as never, 1, true)).toBe(1);
    expect(eligibleTier(kyc({ ninVerified: true, addressAttested: true }) as never, 5, true)).toBe(1);
    expect(eligibleTier(kyc({ ninVerified: true, boardEndorsed: true }) as never, 5, true)).toBe(1);
  });
  it('tier 3 also needs the entity certificate, licences, an entity account name and 4 clean cycles', () => {
    const t2 = { ninVerified: true, addressAttested: true, boardEndorsed: true };
    const t3 = kyc({ ...t2, entityCertVerified: true, licenseDocsVerified: true, entityAccountName: 'Badagry Traders Co-op' });
    expect(eligibleTier(t3 as never, 4, true)).toBe(3);
    expect(eligibleTier(t3 as never, 3, true)).toBe(2);
    expect(eligibleTier(kyc({ ...t2, entityCertVerified: true, licenseDocsVerified: true }) as never, 9, true)).toBe(2);
  });
  it('an unclean record holds a collector at tier 1', () => {
    const full = kyc({ ninVerified: true, addressAttested: true, boardEndorsed: true });
    expect(eligibleTier(full as never, 9, false)).toBe(1);
  });
});

describe('clean record (trailing window)', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const row = (status: string, confirmedAfterH: number | null) => ({ status, createdAt: new Date('2026-05-20T10:00:00Z'), facilitatorConfirmedAt: confirmedAfterH === null ? null : new Date(new Date('2026-05-20T10:00:00Z').getTime() + confirmedAfterH * 3600_000) });
  beforeEach(() => mockPrisma.facilitatorAccount.findMany.mockResolvedValue([{ id: ACC }]));
  it('a new collector with no entries is clean', async () => {
    mockPrisma.fundsEntry.findMany.mockResolvedValue([]);
    expect((await cleanRecord(COLLECTOR, now)).clean).toBe(true);
  });
  it('under 2% disputes and 95%+ confirmed within 48h is clean', async () => {
    mockPrisma.fundsEntry.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, i) => (i === 0 ? row('DISPUTED', 1) : row('CONFIRMED', 5))));
    expect(await cleanRecord(COLLECTOR, now)).toMatchObject({ clean: true, disputeRateBp: 100 });
  });
  it('2% disputes breaches the limit', async () => {
    mockPrisma.fundsEntry.findMany.mockResolvedValue(Array.from({ length: 100 }, (_, i) => (i < 2 ? row('DISPUTED', 1) : row('CONFIRMED', 5))));
    expect((await cleanRecord(COLLECTOR, now)).clean).toBe(false);
  });
  it('slow or missing confirmations breach the 95% rule', async () => {
    mockPrisma.fundsEntry.findMany.mockResolvedValue([...Array.from({ length: 90 }, () => row('CONFIRMED', 5)), ...Array.from({ length: 10 }, () => row('CONFIRMED', 72))]);
    expect(await cleanRecord(COLLECTOR, now)).toMatchObject({ clean: false, confirmedWithinBp: 9000 });
  });
});

describe('tier upgrades are never automatic', () => {
  beforeEach(() => {
    mockPrisma.facilitatorAccount.findMany.mockResolvedValue([]);
    mockPrisma.fundsEntry.findMany.mockResolvedValue([]);
    mockPrisma.collectorKyc.update.mockResolvedValue({});
  });
  it('an admin cannot approve a tier the collector does not qualify for', async () => {
    mockPrisma.ajoPool.count.mockResolvedValue(0);
    await expect(approveTier(ADMIN, COLLECTOR, 2)).rejects.toThrow('only qualifies for tier 1');
    expect(mockPrisma.collectorKyc.update).not.toHaveBeenCalled();
  });
  it('approves a qualified upgrade and audit-logs it', async () => {
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ ninVerified: true, addressAttested: true, boardEndorsed: true }));
    mockPrisma.ajoPool.count.mockResolvedValue(2);
    await approveTier(ADMIN, COLLECTOR, 2);
    expect(mockPrisma.collectorKyc.update).toHaveBeenCalledWith({ where: { userId: COLLECTOR }, data: expect.objectContaining({ approvedTier: 2 }) });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'CUSTODY_TIER_APPROVED', actorId: ADMIN }) });
  });
});

describe('automatic downgrade', () => {
  const dirty = () => {
    mockPrisma.facilitatorAccount.findMany.mockResolvedValue([{ id: ACC }]);
    mockPrisma.fundsEntry.findMany.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({ status: i < 3 ? 'DISPUTED' : 'CONFIRMED', createdAt: new Date(), facilitatorConfirmedAt: new Date() })));
    mockPrisma.collectorKyc.update.mockImplementation(async ({ data }: any) => ({ ...kyc({ approvedTier: 2 }), ...data }));
  };
  it('a breached record schedules a one-tier drop; the current tier is untouched until the next cycle', async () => {
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ approvedTier: 2 }));
    dirty();
    await evaluateDowngrade(COLLECTOR);
    expect(mockPrisma.collectorKyc.update).toHaveBeenCalledWith({ where: { userId: COLLECTOR }, data: { pendingTier: 1 } });
  });
  it('a clean record schedules nothing, and an already-scheduled drop is not stacked', async () => {
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ approvedTier: 2 }));
    mockPrisma.facilitatorAccount.findMany.mockResolvedValue([]);
    mockPrisma.fundsEntry.findMany.mockResolvedValue([]);
    await evaluateDowngrade(COLLECTOR);
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ approvedTier: 2, pendingTier: 1 }));
    await evaluateDowngrade(COLLECTOR);
    expect(mockPrisma.collectorKyc.update).not.toHaveBeenCalled();
  });
  it('the drop applies only when a new cycle starts', async () => {
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ approvedTier: 2, pendingTier: 1 }));
    mockPrisma.collectorKyc.update.mockResolvedValue({});
    await applyPendingTier(COLLECTOR);
    expect(mockPrisma.collectorKyc.update).toHaveBeenCalledWith({ where: { userId: COLLECTOR }, data: expect.objectContaining({ approvedTier: 1, pendingTier: null }) });
  });
  it('after a drop, a group now over the new cap cannot take more custody money', async () => {
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ approvedTier: 1 }));
    held(N(900_000));
    await expect(assertCustodyContribution({ group: group(), amountKobo: N(1000) })).rejects.toThrow('custody limit');
  });
});

describe('custody caps and conditions (every contribution)', () => {
  it('passes when everything is in order', async () => {
    held(N(100_000));
    await expect(assertCustodyContribution({ group: group(), amountKobo: N(5_000) })).resolves.toBeUndefined();
  });
  it('the per-group cap counts declared-but-unconfirmed money too', async () => {
    held(N(490_000));
    mockPrisma.fundsEntry.aggregate.mockResolvedValue({ _sum: { amountKobo: N(8_000) } });
    await expect(assertCustodyContribution({ group: group(), amountKobo: N(5_000) })).rejects.toThrow('₦500000.00 custody limit');
  });
  it('the collector aggregate cap spans all their groups', async () => {
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ approvedTier: 2, ninVerified: true }));
    mockPrisma.communityGroup.findMany.mockResolvedValue([{ id: id('1') }, { id: id('2') }, { id: id('3') }]);
    held(N(1_500_000)); // 3 groups x 1.5M = 4.5M held, tier 2 allows 4M in total
    await expect(assertCustodyContribution({ group: group(), amountKobo: N(1000) })).rejects.toThrow('across all groups');
  });
  it('rejects an escrow group, an unregistered group, and an unverified collector', async () => {
    await expect(assertCustodyContribution({ group: group({ fundsMode: 'ESCROW' }), amountKobo: 1n })).rejects.toThrow('uses escrow');
    await expect(assertCustodyContribution({ group: group({ registrationStatus: 'UNREGISTERED' }), amountKobo: 1n })).rejects.toThrow('registered');
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(null);
    await expect(assertCustodyContribution({ group: group(), amountKobo: 1n })).rejects.toThrow('not verified');
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ approvedTier: 0 }));
    await expect(assertCustodyContribution({ group: group(), amountKobo: 1n })).rejects.toThrow('not verified');
  });
  it('tier 3 only takes money into an account named for the registered entity', async () => {
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ approvedTier: 3, entityAccountName: 'Badagry Traders Co-op' }));
    held(0n);
    mockPrisma.facilitatorAccount.findUnique.mockResolvedValue({ accountName: 'Ade Personal' });
    await expect(assertCustodyContribution({ group: group(), facilitatorAccountId: ACC, amountKobo: N(1000) })).rejects.toThrow("cooperative's name");
    mockPrisma.facilitatorAccount.findUnique.mockResolvedValue({ accountName: ' badagry traders co-op ' });
    await expect(assertCustodyContribution({ group: group(), facilitatorAccountId: ACC, amountKobo: N(1000) })).resolves.toBeUndefined();
  });
  it('is blocked in production until the consent documents are approved', async () => {
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    held(0n);
    await expect(assertCustodyContribution({ group: group(), amountKobo: 1n })).rejects.toThrow('CONSENT_DOCS_APPROVED');
    process.env.NODE_ENV = old;
  });
});

describe('escrow-only purposes', () => {
  it('the Settlement Fund can never be held in a custody group', () => {
    expect(() => assertEscrowOnly('SETTLEMENT_FUND', { fundsMode: 'COLLECTOR_CUSTODY' })).toThrow('escrow-only');
    expect(() => assertEscrowOnly('SETTLEMENT_FUND', { fundsMode: 'ESCROW' })).not.toThrow();
    expect(() => assertEscrowOnly('AJO', { fundsMode: 'COLLECTOR_CUSTODY' })).not.toThrow();
  });
});

describe('switching funds mode', () => {
  const collector = { id: COLLECTOR, role: 'COLLECTOR' };
  beforeEach(() => mockPrisma.communityGroup.update.mockImplementation(async ({ data }: any) => ({ ...group({ fundsMode: 'ESCROW' }), ...data })));
  it('a request never changes the live mode: it only sets the pending mode', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW' }));
    await requestFundsMode(collector, GROUP, 'COLLECTOR_CUSTODY');
    expect(mockPrisma.communityGroup.update).toHaveBeenCalledWith({ where: { id: GROUP }, data: { pendingFundsMode: 'COLLECTOR_CUSTODY' } });
  });
  it('the new mode only applies at the start of the next cycle, so a group is never mixed-mode', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW', pendingFundsMode: 'COLLECTOR_CUSTODY' }));
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ pendingTier: null }));
    await applyPendingFundsMode(GROUP);
    expect(mockPrisma.communityGroup.update).toHaveBeenCalledWith({ where: { id: GROUP }, data: { fundsMode: 'COLLECTOR_CUSTODY', pendingFundsMode: null, fundsModeLockedUntil: null } });
  });
  it('the collector must have signed the custody agreement before custody can be requested', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW' }));
    mockHasSigned.mockResolvedValue(false);
    await expect(requestFundsMode(collector, GROUP, 'COLLECTOR_CUSTODY')).rejects.toThrow('custody agreement');
    expect(mockHasSigned).toHaveBeenCalledWith(COLLECTOR, 'CUSTODY_COLLECTOR_AGREEMENT', GROUP);
    expect(mockPrisma.communityGroup.update).not.toHaveBeenCalled();
  });
  it('when custody takes effect at the next cycle, members who have not signed the disclosure are exited', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW', pendingFundsMode: 'COLLECTOR_CUSTODY' }));
    await applyPendingFundsMode(GROUP);
    expect(mockEnforce).toHaveBeenCalledWith(GROUP);
  });
  it('going back to escrow exits nobody', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'COLLECTOR_CUSTODY', pendingFundsMode: 'ESCROW' }));
    await applyPendingFundsMode(GROUP);
    expect(mockEnforce).not.toHaveBeenCalled();
  });
  it('only the collector or an admin can ask', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW' }));
    await expect(requestFundsMode({ id: id('7'), role: 'MEMBER' }, GROUP, 'COLLECTOR_CUSTODY')).rejects.toThrow('Only the group collector');
  });
  it('custody needs registration status and a verified collector', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW', registrationStatus: 'UNREGISTERED' }));
    await expect(requestFundsMode(collector, GROUP, 'COLLECTOR_CUSTODY')).rejects.toThrow('registered');
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW' }));
    mockPrisma.collectorKyc.findUnique.mockResolvedValue(kyc({ approvedTier: 0 }));
    await expect(requestFundsMode(collector, GROUP, 'COLLECTOR_CUSTODY')).rejects.toThrow('verification');
  });
  it('going back to escrow needs no checks, and asking for the current mode is rejected', async () => {
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'COLLECTOR_CUSTODY' }));
    await requestFundsMode(collector, GROUP, 'ESCROW');
    expect(mockPrisma.communityGroup.update).toHaveBeenCalledWith({ where: { id: GROUP }, data: { pendingFundsMode: 'ESCROW' } });
    mockPrisma.communityGroup.findUnique.mockResolvedValue(group({ fundsMode: 'ESCROW' }));
    await expect(requestFundsMode(collector, GROUP, 'ESCROW')).rejects.toThrow('already');
  });
});

describe('pilot limits', () => {
  it('caps groups and members until a pilot group is registered', async () => {
    mockPrisma.communityGroup.count.mockResolvedValueOnce(0).mockResolvedValueOnce(5);
    await expect(assertPilotLimits({ newGroup: true })).rejects.toThrow('5 groups');
    mockPrisma.communityGroup.count.mockResolvedValueOnce(0);
    mockPrisma.groupMember.count.mockResolvedValue(30);
    await expect(assertPilotLimits({ groupId: GROUP })).rejects.toThrow('30 members');
  });
  it('lifts once any group is REGISTERED', async () => {
    mockPrisma.communityGroup.count.mockResolvedValue(1);
    await expect(assertPilotLimits({ newGroup: true })).resolves.toBeUndefined();
  });
});
