import cron from 'node-cron';
import { runRecordsBackup } from './repository.service';

export function startRecordsCron() {
  // 02:30 nightly: back up the encrypted vault and the records tables, keep two weeks.
  cron.schedule('30 2 * * *', () => runRecordsBackup().then((r) => console.log('[records] backup', r.dir)).catch((e) => console.error('[records] backup failed', e.message)));
}
