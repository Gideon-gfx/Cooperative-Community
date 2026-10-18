import { sendSms } from '../services/termii.service';
import { money } from './money';

/** Fire-and-forget SMS; a failed SMS must never break a state change. */
export async function safeSms(to: string | null | undefined, message: string): Promise<void> {
  if (!to) return;
  try {
    await sendSms(to, message);
  } catch (err) {
    console.error(`[sms] failed to ${to}:`, (err as Error).message);
  }
}

export const naira = (n: number | string | { toString(): string }, currency = 'NGN') => money(Number(n.toString()), currency);
