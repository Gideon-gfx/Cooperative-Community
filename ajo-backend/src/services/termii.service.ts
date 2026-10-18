import axios from 'axios';
import crypto from 'crypto';
import { config } from '../lib/config';

export async function sendSms(to: string, message: string): Promise<void> {
  if (!config.termiiApiKey) throw new Error('TERMII_API_KEY is not configured');
  if (!config.termiiSenderId) throw new Error('TERMII_SENDER_ID is not configured');

  await axios.post('https://api.ng.termii.com/api/sms/send', {
    to: to.replace('+', ''),
    from: config.termiiSenderId,
    sms: message,
    type: 'plain',
    channel: 'generic',
    api_key: config.termiiApiKey,
  });
}

export function verifyTermiiWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
  if (!signature || !config.termiiWebhookSecret) return false;
  const supplied = signature.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = crypto.createHmac('sha256', config.termiiWebhookSecret).update(rawBody).digest();
  const received = Buffer.from(supplied, 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}
