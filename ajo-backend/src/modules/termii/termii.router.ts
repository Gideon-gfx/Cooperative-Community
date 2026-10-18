import { Router } from 'express';
import { config } from '../../lib/config';
import { verifyTermiiWebhookSignature } from '../../services/termii.service';

export const termiiRouter = Router();

termiiRouter.post('/', (req, res) => {
  if (!config.termiiWebhookSecret) {
    return void res.status(503).json({ error: 'Termii webhook secret is not configured' });
  }

  const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
  if (!rawBody || !verifyTermiiWebhookSignature(rawBody, req.header('X-Termii-Signature'))) {
    return void res.status(401).json({ error: 'Invalid Termii signature' });
  }

  res.status(200).json({ received: true });
});
