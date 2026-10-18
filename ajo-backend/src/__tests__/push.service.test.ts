jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../lib/prisma', () => ({
  prisma: { pushToken: { findMany: jest.fn(), deleteMany: jest.fn() } },
}));

import axios from 'axios';
import { prisma } from '../lib/prisma';
import { safePush } from '../services/push.service';

const findTokens = jest.mocked(prisma.pushToken.findMany);
const deleteTokens = jest.mocked(prisma.pushToken.deleteMany);
const post = jest.mocked(axios.post);

describe('safePush', () => {
  beforeEach(() => jest.clearAllMocks());

  it('sends the notification to each registered Expo token', async () => {
    findTokens.mockResolvedValue([{ token: 'ExpoPushToken[device]' }] as never);
    post.mockResolvedValue({ data: { data: [{ status: 'ok' }] } } as never);

    await safePush('user-id', { title: 'Payment due', body: 'Review ÀJỌ', data: { kind: 'DUE', poolId: 'pool-id' } });

    expect(post).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      [{ to: 'ExpoPushToken[device]', title: 'Payment due', body: 'Review ÀJỌ', data: { kind: 'DUE', poolId: 'pool-id' } }],
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it('removes tokens Expo reports as unregistered', async () => {
    findTokens.mockResolvedValue([{ token: 'ExpoPushToken[expired]' }] as never);
    post.mockResolvedValue({ data: { data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] } } as never);

    await safePush('user-id', { title: 'Payment due', body: 'Review ÀJỌ', data: { kind: 'DUE', poolId: 'pool-id' } });

    expect(deleteTokens).toHaveBeenCalledWith({ where: { userId: 'user-id', token: { in: ['ExpoPushToken[expired]'] } } });
  });
});
