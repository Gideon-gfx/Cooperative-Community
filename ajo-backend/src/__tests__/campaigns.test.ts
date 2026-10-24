const mockPrisma = {
  groupMember: { findUnique: jest.fn() },
  communityGroup: { findUniqueOrThrow: jest.fn() },
  campaign: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  campaignGift: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  ledgerEntry: { create: jest.fn() },
  groupMessage: { create: jest.fn() },
  user: { findUniqueOrThrow: jest.fn(), findUnique: jest.fn() },
  auditLog: { create: jest.fn() },
};
jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../lib/notify', () => ({ safeSms: jest.fn(), safeSmsAndEmail: jest.fn(), naira: (n: unknown) => `₦${n}` }));

import { createCampaign, giveGift, recordDelivery, verifyGift } from '../modules/campaigns/campaigns.service';

const id = (c: string) => c.repeat(24);
const HOST = id('a'), MEMBER = id('b'), CAMP = id('c'), GROUP = id('d'), OPT = id('e'), GIFT = id('f');

function campaign(over: Record<string, unknown> = {}) {
  return { id: CAMP, groupId: GROUP, hostId: HOST, kind: 'ASO_EBI', title: 'Wedding', status: 'OPEN', closesAt: null, partAmount: 25000, recipientName: null, recipientUserId: null, options: [{ id: OPT, label: 'Gele + wrapper' }], ...over };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockPrisma.groupMember.findUnique.mockResolvedValue({ id: 'm' });
  mockPrisma.communityGroup.findUniqueOrThrow.mockResolvedValue({ id: GROUP, name: 'Church', currency: 'NGN', adminId: HOST });
  mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ id: HOST, fullName: 'Mama Bísí', phoneNumber: '+2348011111111' });
});

describe('createCampaign', () => {
  it('aṣọ ẹbí needs a part amount and at least one outfit', async () => {
    await expect(createCampaign(HOST, { groupId: GROUP, kind: 'ASO_EBI', occasion: 'WEDDING', title: 'Wedding' })).rejects.toThrow('how much');
    await expect(createCampaign(HOST, { groupId: GROUP, kind: 'ASO_EBI', occasion: 'WEDDING', title: 'Wedding', partAmount: 25000 })).rejects.toThrow('outfit');
  });
  it('help needs a named recipient', async () => {
    await expect(createCampaign(HOST, { groupId: GROUP, kind: 'HELP', occasion: 'MEDICAL', title: 'Surgery fund' })).rejects.toThrow('who the help is for');
  });
  it('rejects an occasion that does not belong to the kind', async () => {
    await expect(createCampaign(HOST, { groupId: GROUP, kind: 'HELP', occasion: 'WEDDING', title: 'Surgery fund', recipientName: 'Ade' })).rejects.toThrow('occasion');
  });
});

describe('general collections (OTHER)', () => {
  it('need only a title: no recipient, no outfits, no fixed part', async () => {
    mockPrisma.communityGroup.findUniqueOrThrow.mockResolvedValue({ id: GROUP, name: 'Street', currency: 'NGN' });
    mockPrisma.campaign.create.mockResolvedValue({ id: CAMP });
    await createCampaign(HOST, { groupId: GROUP, kind: 'OTHER', occasion: 'COMMUNITY', title: 'New borehole' });
    expect(mockPrisma.campaign.create).toHaveBeenCalled();
  });
  it('members choose their own amount', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(campaign({ kind: 'OTHER', partAmount: null, options: [] }));
    mockPrisma.campaignGift.create.mockResolvedValue({ id: GIFT });
    await giveGift(MEMBER, CAMP, { kind: 'MONEY', amount: 3000 });
    expect(mockPrisma.campaignGift.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 3000 }) });
  });
});

describe('custom occasion', () => {
  it('keeps the typed name only when the occasion is OTHER', async () => {
    mockPrisma.communityGroup.findUniqueOrThrow.mockResolvedValue({ id: GROUP, name: 'Church', currency: 'NGN' });
    mockPrisma.campaign.create.mockResolvedValue({ id: CAMP });
    const base = { groupId: GROUP, kind: 'ASO_EBI' as const, title: 'Party', partAmount: 5000, options: [{ label: 'Gele' }] };
    await createCampaign(HOST, { ...base, occasion: 'OTHER', occasionLabel: '  House warming ' });
    expect(mockPrisma.campaign.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ occasion: 'OTHER', occasionLabel: 'House warming' }) }));
    await createCampaign(HOST, { ...base, occasion: 'WEDDING', occasionLabel: 'ignored' });
    expect(mockPrisma.campaign.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ occasion: 'WEDDING', occasionLabel: undefined }) }));
  });
});

describe('giveGift', () => {
  it('aṣọ ẹbí always charges the host-set part, whatever the client sends', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(campaign());
    mockPrisma.campaignGift.findFirst.mockResolvedValue(null);
    mockPrisma.campaignGift.create.mockResolvedValue({ id: GIFT });
    await giveGift(MEMBER, CAMP, { kind: 'MONEY', optionId: OPT, amount: 1 });
    expect(mockPrisma.campaignGift.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: 25000, optionId: OPT, userId: MEMBER }) });
  });
  it('a member cannot pay twice for the same aṣọ ẹbí', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(campaign());
    mockPrisma.campaignGift.findFirst.mockResolvedValue({ id: GIFT });
    await expect(giveGift(MEMBER, CAMP, { kind: 'MONEY', optionId: OPT })).rejects.toThrow('Already paid');
  });
  it('only the host can record a gift for someone else', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(campaign());
    await expect(giveGift(MEMBER, CAMP, { kind: 'MONEY', optionId: OPT, forUserId: id('9') })).rejects.toThrow('Only the host');
  });
  it('closed contributions take no gifts', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(campaign({ status: 'CLOSED' }));
    await expect(giveGift(MEMBER, CAMP, { kind: 'MONEY', optionId: OPT })).rejects.toThrow('closed');
  });
});

describe('verifyGift', () => {
  const gift = { id: GIFT, campaignId: CAMP, userId: MEMBER, recordedById: MEMBER, kind: 'MONEY', amount: 25000, method: 'CASH', status: 'PENDING' };
  beforeEach(() => {
    mockPrisma.campaignGift.findUnique.mockResolvedValue(gift);
    mockPrisma.campaign.findUnique.mockResolvedValue(campaign());
    mockPrisma.user.findUniqueOrThrow.mockResolvedValue({ id: MEMBER, fullName: 'Túndé', phoneNumber: '+2348022222222' });
    mockPrisma.campaignGift.update.mockResolvedValue({ ...gift, status: 'VERIFIED', receiptNo: 'CA-FFFFFF' });
  });
  it('confirming a money gift puts it in the ledger and gives a receipt', async () => {
    const done = await verifyGift(HOST, GIFT);
    expect(done.receiptNo).toBe('CA-FFFFFF');
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ campaignId: CAMP, direction: 'IN', amount: 25000 }) });
  });
  it('only the host can confirm', async () => {
    await expect(verifyGift(MEMBER, GIFT)).rejects.toThrow('Only the host');
  });
  it('a food pledge is confirmed without touching the money ledger', async () => {
    mockPrisma.campaignGift.findUnique.mockResolvedValue({ ...gift, kind: 'FOOD', amount: 0, foodNote: '2 bags rice' });
    await verifyGift(HOST, GIFT);
    expect(mockPrisma.ledgerEntry.create).not.toHaveBeenCalled();
  });
});

describe('recordDelivery', () => {
  it('help delivery records money out, completes the collection and tells the group', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(campaign({ kind: 'HELP', recipientName: 'Ìyá Ade', partAmount: null, options: [] }));
    mockPrisma.campaign.update.mockResolvedValue({ id: CAMP, status: 'COMPLETED' });
    await recordDelivery(HOST, CAMP, { amount: 86000, note: '5 bags rice' });
    expect(mockPrisma.ledgerEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ campaignId: CAMP, direction: 'OUT', type: 'PAYOUT', amount: 86000 }) });
    expect(mockPrisma.campaign.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETED', deliveredAmount: 86000 }) }));
    expect(mockPrisma.groupMessage.create).toHaveBeenCalled();
  });
  it('aṣọ ẹbí has no delivery step', async () => {
    mockPrisma.campaign.findUnique.mockResolvedValue(campaign());
    await expect(recordDelivery(HOST, CAMP, { amount: 1 })).rejects.toThrow('Only help');
  });
});
