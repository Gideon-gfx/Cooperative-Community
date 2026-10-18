// Creates one demo facilitator with a verified bank account, so the declare → confirm flow can be tried end to end.
// Safe to run twice. Run: npm run seed:facilitator
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

const prisma = new PrismaClient();

(async () => {
  const phoneNumber = '+2348000000001';
  const user = await prisma.user.upsert({
    where: { phoneNumber },
    update: { role: 'FACILITATOR' },
    create: { phoneNumber, fullName: 'Demo Facilitator', role: 'FACILITATOR', isVerified: true, collectorApproved: true },
  });
  const existing = await prisma.facilitatorAccount.findFirst({ where: { userId: user.id } });
  const account =
    existing ??
    (await prisma.facilitatorAccount.create({ data: { userId: user.id, bankName: 'Demo Bank', accountNumber: '0123456789', accountName: 'Demo Facilitator', isVerifiedByAdmin: true } }));
  console.log(`Facilitator ${user.fullName} (${user.phoneNumber}) · account ${account.bankName} ${account.accountNumber} · verified=${account.isVerifiedByAdmin}`);
})()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
