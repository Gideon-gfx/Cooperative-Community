import nodemailer from 'nodemailer';
import { config } from './config';

const SMTP_CONNECTION_TIMEOUT_MS = 5_000;
const SMTP_GREETING_TIMEOUT_MS = 5_000;
const SMTP_SOCKET_TIMEOUT_MS = 8_000;

/**
 * Sends a plain email. Two ways, tried in this order:
 *  1. SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, optional MAIL_FROM). A Gmail address with an App Password works.
 *  2. Resend (RESEND_API_KEY and MAIL_FROM).
 * With neither set it only logs the message outside production, so a developer can read a reset code in the terminal.
 * It never throws: a mail problem must not break the request. It returns whether the mail was handed over.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  try {
    if (config.smtpHost && config.smtpUser && config.smtpPass) {
      const transport = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpPort === 465,
        auth: { user: config.smtpUser, pass: config.smtpPass },
        connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
        greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
        socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      });
      try {
        await transport.sendMail({ from: config.mailFrom || `ÀJỌ <${config.smtpUser}>`, to, subject, text });
        return true;
      } catch (error) {
        console.error('[mail] SMTP send failed', error instanceof Error ? error.message : String(error));
      } finally {
        transport.close();
      }
    }
    if (config.resendApiKey && config.mailFrom) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: config.mailFrom, to, subject, text }),
      });
      if (!res.ok) console.error('[mail] resend failed', res.status);
      return res.ok;
    }
  } catch (e) {
    console.error('[mail] send failed', (e as Error).message);
    return false;
  }
  if (process.env.NODE_ENV !== 'production') console.log(`[mail:dev] no mail service is set up, so nothing was sent. to=${to} subject="${subject}"\n${text}`);
  return false;
}
