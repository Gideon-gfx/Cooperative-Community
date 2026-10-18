import cron from 'node-cron';
import { runSettlementReminders } from './settlement.service';

export function startSettlementCron() {
  // 08:00 WAT (07:00 UTC) daily: contribution reminders (3 days before, the day, 2 days late) and flags for the Trust Board.
  cron.schedule('0 7 * * *', () => runSettlementReminders().catch(console.error));
}
