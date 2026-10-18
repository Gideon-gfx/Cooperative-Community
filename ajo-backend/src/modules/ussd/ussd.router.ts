import { NextFunction, Request, Response, Router } from 'express';
import crypto from 'crypto';
import { config } from '../../lib/config';
import { safeSms } from '../../lib/notify';
import { handleSms, handleUssd } from './ussd.service';

export const ussdRouter = Router();

/** Provider webhooks can't send our JWT, so they share a secret. In production a secret is mandatory. */
function webhookAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.webhookSecret) {
    if (process.env.NODE_ENV === 'production') return void res.status(503).send('Webhook secret not configured');
    return next();
  }
  const given = String(req.query.key ?? req.headers['x-webhook-key'] ?? '');
  const a = Buffer.from(given);
  const b = Buffer.from(config.webhookSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return void res.status(401).send('Unauthorized');
  next();
}

ussdRouter.post('/ussd', webhookAuth, async (req, res) => {
  const { phoneNumber = '', text = '' } = req.body ?? {};
  try {
    res.type('text/plain').send(await handleUssd({ phoneNumber: String(phoneNumber), text: String(text) }));
  } catch (e) {
    console.error('[ussd]', e);
    res.type('text/plain').send('END Sorry, something went wrong. Please try again.');
  }
});

ussdRouter.post('/sms/inbound', webhookAuth, async (req, res) => {
  const from = String(req.body?.from ?? req.body?.sender ?? '');
  const text = String(req.body?.text ?? req.body?.message ?? req.body?.sms ?? '');
  try {
    const reply = await handleSms({ from, text });
    await safeSms(from.startsWith('+') ? from : `+${from}`, reply);
    res.json({ reply });
  } catch (e) {
    console.error('[sms-inbound]', e);
    res.json({ reply: 'Sorry, something went wrong.' });
  }
});
