import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './lib/config';
import { errorHandler } from './middleware/error.middleware';
import { authRouter } from './modules/auth/auth.controller';
import { groupsRouter } from './modules/groups/groups.controller';
import { ajoRouter } from './modules/ajo/ajo.router';
import { ccgbRouter } from './modules/ccgb/ccgb.router';
import { uploadRouter } from './modules/uploads/uploads.router';
import { agentRouter } from './modules/agent/agent.router';
import { disputesRouter } from './modules/disputes/disputes.router';
import { usersRouter } from './modules/users/users.router';
import { adminBillingRouter, billingRouter } from './modules/billing/billing.router';
import { trustRouter } from './modules/trust/trust.router';
import { settlementRouter } from './modules/settlement/settlement.router';
import { contractsRouter } from './modules/apprenticeship/contracts.router';
import { recordsRouter } from './modules/records/records.router';
import { consentRouter } from './modules/consent/consent.router';
import { ledgerRouter } from './modules/ledger/ledger.router';
import { feesRouter, paymentsRouter } from './modules/payments/payments.router';
import { campaignsRouter } from './modules/campaigns/campaigns.router';
import { ussdRouter } from './modules/ussd/ussd.router';
import { termiiRouter } from './modules/termii/termii.router';
import { UPLOAD_ROOT } from './services/storage.service';

const app = express();
const webRoot = path.resolve(__dirname, '../public');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } })); // uploaded files are loaded by the apps
app.use('/files', express.static(UPLOAD_ROOT));
app.use(cors());
// The raw body is kept for the Monnify webhook: its HMAC signature is computed over the exact bytes received.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
app.use(express.urlencoded({ extended: false })); // USSD providers post form-encoded bodies
if (process.env.NODE_ENV !== 'test') {
  app.use('/api/', rateLimit({ windowMs: 60_000, limit: 300 }));
  app.use('/api/auth/request-otp', rateLimit({ windowMs: 10 * 60_000, limit: 5 }));
  app.use('/api/auth/verify-otp', rateLimit({ windowMs: 10 * 60_000, limit: 10 }));
  app.use('/api/auth/forgot-password', rateLimit({ windowMs: 10 * 60_000, limit: 5 }));
  app.use('/api/auth/forgot-pin', rateLimit({ windowMs: 10 * 60_000, limit: 5 }));
  app.use('/api/auth/verify-reset-code', rateLimit({ windowMs: 10 * 60_000, limit: 15 }));
  app.use('/api/auth/reset-pin', rateLimit({ windowMs: 10 * 60_000, limit: 10 }));
  app.use('/api/auth/reset-password', rateLimit({ windowMs: 10 * 60_000, limit: 10 }));
  app.use('/api/auth/login-pin', rateLimit({ windowMs: 10 * 60_000, limit: 20 }));
  app.use('/api/auth/register', rateLimit({ windowMs: 10 * 60_000, limit: 5 }));
  app.use('/api/auth/login-email', rateLimit({ windowMs: 10 * 60_000, limit: 20 }));
}

app.get('/health', (_req, res) => void res.json({ ok: true }));
app.use('/webhook', termiiRouter);
app.use('/api/auth', authRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/ajo', ajoRouter);
app.use('/api/ccgb', ccgbRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/ledger', ledgerRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/consent', consentRouter);
app.use('/api/billing', billingRouter);
app.use('/api/records', recordsRouter);
app.use('/api/contracts', contractsRouter);
app.use('/api/settlement', settlementRouter);
app.use('/api/trust', trustRouter);
app.use('/api/admin', adminBillingRouter);
app.use('/api/fees', feesRouter);
app.use('/api/uploads', uploadRouter);
app.use('/api/agent', agentRouter);
app.use('/api/disputes', disputesRouter);
app.use('/api/users', usersRouter);
app.use('/api', ussdRouter); // /api/ussd and /api/sms/inbound (provider webhooks)
app.use(express.static(webRoot, { index: false }));
app.get('/{*path}', (req, res, next) => {
  if (req.path === '/api' || req.path.startsWith('/api/') || req.path === '/files' || req.path.startsWith('/files/')) {
    return next();
  }
  res.sendFile(path.join(webRoot, 'index.html'), (error) => {
    if (error) next(error);
  });
});
app.use(errorHandler);


export { app };
