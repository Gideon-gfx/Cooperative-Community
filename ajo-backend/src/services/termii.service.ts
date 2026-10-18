import axios from 'axios';
import { config } from '../lib/config';

export async function sendSms(to: string, message: string): Promise<void> {
  const logLine = `[sms:dev] → ${to}: ${message}`;
  console.log(logLine);

  if (!config.termiiApiKey) {
    return;
  }

  await axios.post('https://api.ng.termii.com/api/sms/send', {
    to: to.replace('+', ''),
    from: 'ÀJỌ App',
    sms: message,
    type: 'plain',
    channel: 'generic',
    api_key: config.termiiApiKey,
  });
}
