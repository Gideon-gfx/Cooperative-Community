// Groups created before funds modes existed have no fundsMode/registrationStatus stored, and Prisma will not read a
// required field that is missing. Run this ONCE on any database that already has groups: npm run backfill:funds-mode
// Defaults to ESCROW (the platform default). Set BACKFILL_MODE=COLLECTOR_CUSTODY to keep legacy groups collector-held.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const mode = process.env.BACKFILL_MODE === 'COLLECTOR_CUSTODY' ? 'COLLECTOR_CUSTODY' : 'ESCROW';

(async () => {
  const r = await prisma.$runCommandRaw({
    update: 'CommunityGroup',
    updates: [
      { q: { fundsMode: { $exists: false } }, u: { $set: { fundsMode: mode } }, multi: true },
      { q: { registrationStatus: { $exists: false } }, u: { $set: { registrationStatus: 'UNREGISTERED' } }, multi: true },
    ],
  });
  console.log(`Backfilled legacy groups to ${mode}:`, JSON.stringify(r));
})().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
