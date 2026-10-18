import axios from 'axios';
import { prisma } from '../lib/prisma';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_MESSAGES_PER_REQUEST = 100;

interface ExpoPushTicket {
  status: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

/** Push delivery is best effort: provider errors must not undo a completed payment or payout. */
export async function safePush(userId: string, message: PushMessage): Promise<void> {
  try {
    const devices = await prisma.pushToken.findMany({ where: { userId }, select: { token: true } });
    const tokens = devices.map((device) => device.token);

    for (let i = 0; i < tokens.length; i += MAX_MESSAGES_PER_REQUEST) {
      const batch = tokens.slice(i, i + MAX_MESSAGES_PER_REQUEST);
      const response = await axios.post<{ data?: ExpoPushTicket[] }>(
        EXPO_PUSH_URL,
        batch.map((to) => ({ to, title: message.title, body: message.body, data: message.data })),
        { headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 10_000 },
      );
      const tickets = response.data.data;

      if (!tickets || tickets.length !== batch.length) {
        console.error('[push] Expo returned an unexpected ticket response');
        continue;
      }

      const invalidTokens: string[] = [];
      tickets.forEach((ticket, index) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          invalidTokens.push(batch[index]);
        } else if (ticket.status === 'error') {
          console.error('[push] Expo rejected a notification:', ticket.message ?? ticket.details?.error ?? 'unknown error');
        }
      });

      if (invalidTokens.length) {
        await prisma.pushToken.deleteMany({ where: { userId, token: { in: invalidTokens } } });
      }
    }
  } catch (error) {
    console.error('[push] delivery failed:', error instanceof Error ? error.message : error);
  }
}
