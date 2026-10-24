process.env.CCGB_PLATFORM_FEE_RATE = '0.05'; // the default is 0 (facilitator); tests exercise the fee path

const mockPrisma = {
  foodPool: { findUnique: jest.fn(), updateMany: jest.fn() },
  foodPollVote: { groupBy: jest.fn() },
  ccgbProduct: { findMany: jest.fn(), findUniqueOrThrow: jest.fn() },
  foodPurchaseOrder: { create: jest.fn() },
  foodPoolMember: { update: jest.fn() },
  groupMessage: { create: jest.fn() },
  user: { findMany: jest.fn(), update: jest.fn() },
  auditLog: { create: jest.fn() },
  commissionAccrual: { updateMany: jest.fn() },
};

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../lib/notify', () => ({ safeSms: jest.fn(), safeSmsAndEmail: jest.fn(), naira: (n: unknown) => `₦${n}` }));

import { calculateTransportFee, haversineDistanceKm } from '../modules/ccgb/ccgb.logistics';
import { dissolveFoodPool, lockAndProcessPool, pickWinner, sizeOrder, supplierPayable } from '../modules/ccgb/ccgb.service';

beforeEach(() => jest.clearAllMocks());

describe('logistics', () => {
  it('haversine Lagos → Ibadan (great-circle distance)', () => {
    const km = haversineDistanceKm(6.5244, 3.3792, 7.3775, 3.947);
    // Straight-line distance is ~114 km; the ~128 km figure is the road distance.
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(130);
  });

  it('50 km → ₦5000 + 50 × ₦250 = ₦17,500', () => {
    const dLat = ((50 / 6371) * 180) / Math.PI;
    expect(haversineDistanceKm(6.5, 3.3, 6.5 + dLat, 3.3)).toBeCloseTo(50, 5);
    expect(calculateTransportFee(6.5, 3.3, 6.5 + dLat, 3.3)).toBe(17500);
  });

  it('rounds up to the nearest ₦100', () => {
    expect(calculateTransportFee(6.5, 3.3, 6.5, 3.3)).toBe(5000);
    expect(calculateTransportFee(6.5, 3.3, 6.5, 3.4) % 100).toBe(0);
  });
});

describe('vote tie-break', () => {
  it('equal votes → lowest unit price wins', () => {
    expect(pickWinner([{ productId: 'A', votes: 3, unitPrice: 8000 }, { productId: 'B', votes: 3, unitPrice: 6000 }])?.productId).toBe('B');
  });
  it('more votes beats lower price', () => {
    expect(pickWinner([{ productId: 'A', votes: 4, unitPrice: 9000 }, { productId: 'B', votes: 3, unitPrice: 1000 }])?.productId).toBe('A');
  });
});

describe('order sizing & price lock', () => {
  it('buys whole units at the locked price and reports the leftover', () => {
    expect(sizeOrder(30000, 7000, 50)).toEqual({ units: 4, orderAmount: 28000, orderKg: 200, leftover: 2000 });
  });
});

describe('supplier payment protection', () => {
  it('pays in full when the delivery is complete (within 2% tolerance)', () => {
    expect(supplierPayable(28000, 200, 200)).toBe(28000);
    expect(supplierPayable(28000, 200, 197)).toBe(28000);
    expect(supplierPayable(28000, 200, null)).toBe(28000);
  });
  it('reduces the payable amount in proportion to a short delivery', () => {
    expect(supplierPayable(28000, 200, 150)).toBe(21000);
  });
});

describe('dissolveFoodPool', () => {
  it('3 verified members, target 10 → DISSOLVED and 3 refunds owed by the collector', async () => {
    const members = [1, 2, 3].map((i) => ({ id: `m${i}`, userId: `u${i}`, shares: 1, isPaidVerified: true, user: { phoneNumber: `+234800000000${i}` } }));
    members.push({ id: 'm4', userId: 'u4', shares: 1, isPaidVerified: false, user: { phoneNumber: '+2348000000004' } }); // never paid → nothing owed
    mockPrisma.foodPool.findUnique.mockResolvedValue({
      id: 'p1', groupId: 'g1', contributionAmt: 5000, targetMembers: 10, currentMembers: 4, members,
      group: { currency: 'NGN', admin: { fullName: 'Baba', phoneNumber: '+2348099999999' } },
    });
    mockPrisma.foodPool.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.commissionAccrual.updateMany.mockResolvedValue({ count: 0 });

    const result = await dissolveFoodPool('p1');

    expect(mockPrisma.foodPool.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'DISSOLVED' } }));
    expect(mockPrisma.foodPoolMember.update).toHaveBeenCalledTimes(3);
    expect(mockPrisma.foodPoolMember.update).toHaveBeenCalledWith({ where: { id: 'm1' }, data: { refundDue: 5000 } });
    expect(result.refunded).toBe(3);
  });
});

describe('lockAndProcessPool', () => {
  it('10 members: picks winner, deducts transport + fee, sizes the order, creates purchase order', async () => {
    const dLat = ((50 / 6371) * 180) / Math.PI; // hub is 50 km from supplier → ₦17,500 transport
    mockPrisma.foodPool.findUnique.mockResolvedValue({
      id: 'p1', groupId: 'g1', status: 'COLLECTING', totalFund: 50000, supplierDepositPct: 50, communityHubAddr: 'Community Hall',
      group: { currency: 'NGN', admin: { fullName: 'Baba', locationLat: 6.5 + dLat, locationLng: 3.3 } },
      members: Array.from({ length: 10 }, (_, i) => ({ user: { phoneNumber: `+23480000000${i}` } })),
    });
    mockPrisma.foodPollVote.groupBy.mockResolvedValue([{ productId: 'A', _count: { _all: 4 } }, { productId: 'B', _count: { _all: 6 } }]);
    const products = [
      { id: 'A', name: 'Rice', unitPrice: 9000, supplier: { businessName: 'S1' } },
      { id: 'B', name: 'Beans', unitPrice: 7000, supplier: { businessName: 'S1' } },
    ];
    mockPrisma.ccgbProduct.findMany.mockResolvedValue(products);
    mockPrisma.ccgbProduct.findUniqueOrThrow.mockResolvedValue({
      ...products[1], supplierId: 's1', kgWeightPerUnit: 50,
      supplier: { businessName: 'S1', locationLat: 6.5, locationLng: 3.3, user: { phoneNumber: '+2348011111111' } },
    });
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'd1', phoneNumber: '+2348022222222', locationLat: 6.5, locationLng: 3.31 }]);
    mockPrisma.foodPool.updateMany.mockResolvedValue({ count: 1 });

    const res = await lockAndProcessPool('p1');

    expect(res).toMatchObject({ winnerProductId: 'B', transportFee: 17500, platformFee: 2500, netFoodBudget: 30000, driverId: 'd1', units: 4, orderAmount: 28000, leftover: 2000 });
    expect(mockPrisma.foodPool.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'LOCKED', winningProductId: 'B', netFoodBudget: 30000, lockedUnitPrice: 7000, orderUnits: 4, orderKg: 200, leftoverAmt: 2000 }) }),
    );
    expect(mockPrisma.foodPurchaseOrder.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ poolId: 'p1', productId: 'B', orderAmount: 28000, transportFee: 17500 }),
    });
  });
});
