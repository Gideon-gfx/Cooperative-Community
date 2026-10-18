import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { dissolveFoodPool, lockAndProcessPool } from '../modules/ccgb/ccgb.service';

/** JOB 4 — hourly food pool deadline check. */
export function startCcgbCron() {
  cron.schedule('0 * * * *', async () => {
    const pools = await prisma.foodPool.findMany({ where: { status: 'COLLECTING', liveWindowEnd: { lt: new Date() } } });
    for (const p of pools) {
      try {
        if (p.currentMembers < p.targetMembers) await dissolveFoodPool(p.id);
        else await lockAndProcessPool(p.id);
      } catch (e) {
        console.error(`[ccgb-cron] pool ${p.id}:`, (e as Error).message);
      }
    }
  });
}
