import { sendSms } from '../services/termii.service';
import { sendEmail } from './mailer';
import { money } from './money';

/** Fire-and-forget SMS; a failed SMS must never break a state change. */
export async function safeSms(to: string | null | undefined, message: string): Promise<void> {
  if (!to) return;
  try {
    await sendSms(to, message);
  } catch (err) {
    console.error('[sms] delivery failed:', (err as Error).message);
  }
}

/** Transactional email is best-effort and never interrupts the underlying state change. */
export async function safeEmail(to: string | null | undefined, subject: string, message: string): Promise<void> {
  if (!to) return;
  if (!(await sendEmail(to, subject, message))) {
    console.error('[mail] transactional notification delivery failed');
  }
}

export async function safeSmsAndEmail(
  phone: string | null | undefined,
  email: string | null | undefined,
  subject: string,
  message: string,
): Promise<void> {
  await Promise.all([safeSms(phone, message), safeEmail(email, subject, message)]);
}

export const naira = (n: number | string | { toString(): string }, currency = 'NGN') => money(Number(n.toString()), currency);
