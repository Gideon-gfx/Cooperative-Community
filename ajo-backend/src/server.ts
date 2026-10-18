import { app } from './app';
import { config } from './lib/config';
import { startAllCronJobs } from './cron';
import { logLaunchGates } from './config/decisions';
import { ensureEmailUniqueIndex } from './lib/prisma';
import { registerTrustListeners } from './modules/trust/trust.service';
import { seedPlanPrices } from './modules/billing/billing.service';
import { seedConsentDocuments } from './modules/consent/consent.service';

app.listen(config.port, '0.0.0.0', () => {
  console.log(`ÀJỌ API listening on :${config.port}`);
  logLaunchGates();
  ensureEmailUniqueIndex().catch((e) => console.error('[db] could not make the email/phone indexes', (e as Error).message));
  registerTrustListeners(); // trust scores refresh when conduct, milestones, payments or outcomes change
  seedPlanPrices().then((n) => n && console.log(`[billing] seeded ${n} plan price(s). Edit them in the admin screen.`)).catch((e) => console.error('[billing] seed failed', e.message));
  seedConsentDocuments().then((n) => n && console.log(`[consent] seeded ${n} placeholder document(s). They are DRAFTS and need lawyer review.`)).catch((e) => console.error('[consent] seed failed', e.message));
  startAllCronJobs();
});
