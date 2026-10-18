import cron from 'node-cron';
import { chaseCommissionInvoices, generateCommissionInvoices, runSubscriptionCycle } from './billing.service';

export function startBillingCron() {
  // 08:00 WAT (07:00 UTC) daily: renewal reminders, grace and lapse; commission reminders and escalation.
  cron.schedule('0 7 * * *', async () => {
    await runSubscriptionCycle().catch(console.error);
    await chaseCommissionInvoices().catch(console.error);
  });
  // 04:00 on the 1st: cut last month's commission invoices for collectors in custody mode.
  cron.schedule('0 4 1 * *', () => generateCommissionInvoices().catch(console.error));
}
