const mockPrisma = {
  user: { findFirst: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
};
const mockSummary = jest.fn();
const mockRecord = jest.fn();
const mockVerifyPin = jest.fn();

jest.mock('../lib/prisma', () => ({ prisma: mockPrisma }));
jest.mock('../services/member.service', () => ({ getMemberSummary: (...a: unknown[]) => mockSummary(...a) }));
jest.mock('../modules/ajo/ajo.service', () => ({ recordPayment: (...a: unknown[]) => mockRecord(...a), confirmReceipt: jest.fn() }));
jest.mock('../lib/security', () => {
  const real = jest.requireActual('../lib/security');
  return { ...real, verifyPin: (...a: unknown[]) => mockVerifyPin(...a) };
});

import { HttpError } from '../lib/errors';
import { hashPin } from '../lib/security';
import { handleSms, handleUssd } from '../modules/ussd/ussd.service';

const member = (over = {}) => ({ id: 'u1', fullName: 'Ada', phoneNumber: '+2348031234567', preferredLanguage: 'EN', pinHash: hashPin('2468'), pinMustChange: false, ...over });
const summary = {
  due: [{ contributionId: 'c1', poolId: 'p1', pool: 'Market Àjọ', currency: 'NGN', remaining: 5000, dueAt: new Date('2026-03-10'), recipient: 'Bola' }],
  turns: [{ poolId: 'p1', pool: 'Market Àjọ', currency: 'NGN', amount: 40000, date: new Date('2026-04-01') }],
  funds: [{ poolId: 'p1', pool: 'Market Àjọ', currency: 'NGN', held: 15000, totalIn: 60000, totalOut: 45000 }],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockSummary.mockResolvedValue(summary);
  mockVerifyPin.mockResolvedValue(undefined);
});

describe('USSD', () => {
  it('unknown number is told to ask their collector', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    expect(await handleUssd({ phoneNumber: '+2348000000000', text: '' })).toMatch(/^END .*Baba/);
  });

  it('shows the menu to a registered member', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());
    const out = await handleUssd({ phoneNumber: '+2348031234567', text: '' });
    expect(out).toMatch(/^CON /);
    expect(out).toContain('1. Next payment');
  });

  it('reads out the next payment, turn and pool funds (collector custody is visible)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());
    expect(await handleUssd({ phoneNumber: '+2348031234567', text: '1' })).toContain('₦5,000');
    expect(await handleUssd({ phoneNumber: '+2348031234567', text: '2' })).toContain('₦40,000');
    const funds = await handleUssd({ phoneNumber: '+2348031234567', text: '4' });
    expect(funds).toContain('collector holds ₦15,000');
  });

  it('answers in the member\'s language', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member({ preferredLanguage: 'PCM' }));
    expect(await handleUssd({ phoneNumber: '+2348031234567', text: '2' })).toContain('go collect');
  });

  it('records a payment only after the PIN is confirmed', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());
    // 3 → pick #1 → method Transfer → PIN
    expect(await handleUssd({ phoneNumber: '+2348031234567', text: '3*1*1' })).toMatch(/^CON Enter your 4-digit PIN/);
    expect(mockRecord).not.toHaveBeenCalled();
    const out = await handleUssd({ phoneNumber: '+2348031234567', text: '3*1*1*2468' });
    expect(out).toMatch(/^END Recorded/);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ id: 'u1' }), { contributionId: 'c1', method: 'TRANSFER' });
  });

  it('refuses a wrong PIN and records nothing', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());
    mockVerifyPin.mockRejectedValue(new HttpError(401, 'Wrong PIN'));
    expect(await handleUssd({ phoneNumber: '+2348031234567', text: '3*1*2*0000' })).toMatch(/^END Wrong PIN/);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('forces a new account to replace its temporary PIN', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member({ pinMustChange: true }));
    expect(await handleUssd({ phoneNumber: '+2348031234567', text: '' })).toMatch(/^CON Enter the temporary PIN/);
    expect(await handleUssd({ phoneNumber: '+2348031234567', text: '2468' })).toMatch(/^CON Choose a new/);
    expect(await handleUssd({ phoneNumber: '+2348031234567', text: '2468*1357' })).toMatch(/^END PIN saved/);
    expect(mockPrisma.user.update).toHaveBeenCalled();
    // reusing the temporary PIN is rejected
    expect(await handleUssd({ phoneNumber: '+2348031234567', text: '2468*2468' })).toMatch(/^END Invalid/);
  });
});

describe('SMS commands', () => {
  it('BAL, TURN and FUNDS answer from the same data', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());
    expect(await handleSms({ from: '+2348031234567', text: 'bal' })).toContain('₦5,000');
    expect(await handleSms({ from: '+2348031234567', text: 'TURN' })).toContain('₦40,000');
    expect(await handleSms({ from: '+2348031234567', text: 'funds' })).toContain('₦15,000');
  });
  it('PAID needs the PIN', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());
    mockVerifyPin.mockRejectedValue(new HttpError(401, 'Wrong PIN'));
    expect(await handleSms({ from: '+2348031234567', text: 'PAID 1111' })).toContain('Wrong PIN');
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it('unknown commands return help', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(member());
    expect(await handleSms({ from: '+2348031234567', text: 'hello' })).toContain('BAL');
  });
});
