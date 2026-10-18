import { startAjoCron } from './ajo.cron';
import { startCcgbCron } from './ccgb.cron';
import { startLedgerCron } from '../modules/ledger/ledger.cron';
import { startBillingCron } from '../modules/billing/billing.cron';
import { startSettlementCron } from '../modules/settlement/settlement.cron';
import { startRecordsCron } from '../modules/records/records.cron';
import { startPaymentsCron } from '../modules/payments/payments.cron';

export function startAllCronJobs() {
  startAjoCron(); // jobs 1-3
  startCcgbCron(); // job 4
  startLedgerCron(); // job 5: chase unconfirmed payments
  startPaymentsCron(); // jobs 6-7: escrow reconciliation, custody tier review
  startBillingCron(); // jobs 8-9: subscriptions + commission invoices
  startRecordsCron(); // job 10: nightly records backup
  startSettlementCron(); // job 11: settlement contribution reminders
  console.log('[cron] 11 jobs scheduled');
}
