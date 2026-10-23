import cron from 'node-cron';
import { Long, ObjectId } from 'mongodb';
import { prisma } from '../../lib/prisma';
import { getMongoDb } from '../../lib/mongodb';
import { safeSms } from '../../lib/notify';
import { koboToNaira } from '../../lib/kobo';

const HOUR = 3600 * 1000;
export const REMIND_AFTER_HOURS = 48;
export const ESCALATE_AFTER_HOURS = 24; // after the reminder

interface NativeFundsEntry {
  _id: ObjectId;
  amountKobo: Long | bigint;
  facilitatorAccountId?: ObjectId | null;
}

function amountAsBigInt(value: Long | bigint): bigint {
  return typeof value === 'bigint' ? value : value.toBigInt();
}

/**
 * Declared payments the facilitator has not answered: remind them after 48h, then tell the platform admins 24h later.
 * The updateMany guards mean a retry or a second server instance never sends twice.
 */
export async function chaseUnconfirmed(now = new Date()) {
  const stale = await prisma.fundsEntry.findMany({
    where: { status: 'DECLARED', type: 'CONTRIBUTION', fundsMode: 'COLLECTOR_CUSTODY', facilitatorAccountId: { not: null }, createdAt: { lt: new Date(now.getTime() - REMIND_AFTER_HOURS * HOUR) }, reminderSentAt: null },
    include: { account: true },
  });
  for (const e of stale) {
    const claimed = await prisma.fundsEntry.updateMany({ where: { id: e.id, reminderSentAt: null }, data: { reminderSentAt: now } });
    if (claimed.count === 0) continue;
    const facilitator = e.account ? await prisma.user.findUnique({ where: { id: e.account.userId } }) : null;
    await safeSms(facilitator?.phoneNumber, `ÀJỌ reminder: a payment of ₦${koboToNaira(e.amountKobo)} has waited ${REMIND_AFTER_HOURS} hours for your confirmation. Please confirm or dispute it in the app.`);
  }

  const overdue = await prisma.fundsEntry.findMany({
    where: { status: 'DECLARED', type: 'CONTRIBUTION', fundsMode: 'COLLECTOR_CUSTODY', reminderSentAt: { lt: new Date(now.getTime() - ESCALATE_AFTER_HOURS * HOUR) }, escalatedAt: null },
  });
  if (overdue.length === 0) return { reminded: stale.length, escalated: 0 };
  const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
  let escalated = 0;
  for (const e of overdue) {
    const claimed = await prisma.fundsEntry.updateMany({ where: { id: e.id, escalatedAt: null }, data: { escalatedAt: now } });
    if (claimed.count === 0) continue;
    escalated++;
    for (const a of admins) await safeSms(a.phoneNumber, `ÀJỌ: a ₦${koboToNaira(e.amountKobo)} payment declared ${REMIND_AFTER_HOURS + ESCALATE_AFTER_HOURS}+ hours ago is still unconfirmed by its facilitator.`);
  }
  return { reminded: stale.length, escalated };
}

export async function chaseUnconfirmedNative(now = new Date()) {
  const db = await getMongoDb();
  const funds = db.collection<NativeFundsEntry>('FundsEntry');
  const stale = await funds.find({
    status: 'DECLARED',
    type: 'CONTRIBUTION',
    fundsMode: 'COLLECTOR_CUSTODY',
    facilitatorAccountId: { $ne: null },
    createdAt: { $lt: new Date(now.getTime() - REMIND_AFTER_HOURS * HOUR) },
    reminderSentAt: null,
  }).toArray();

  for (const entry of stale) {
    const claimed = await funds.updateOne(
      { _id: entry._id, reminderSentAt: null },
      { $set: { reminderSentAt: now } },
    );
    if (!claimed.modifiedCount) continue;
    let phoneNumber: string | null | undefined;
    if (entry.facilitatorAccountId) {
      const account = await db.collection<{ userId: ObjectId }>('FacilitatorAccount').findOne(
        { _id: entry.facilitatorAccountId },
        { projection: { userId: 1 } },
      );
      if (account) {
        const user = await db.collection<{ phoneNumber?: string | null }>('User').findOne(
          { _id: account.userId },
          { projection: { phoneNumber: 1 } },
        );
        phoneNumber = user?.phoneNumber;
      }
    }
    await safeSms(phoneNumber, `ÀJỌ reminder: a payment of ₦${koboToNaira(amountAsBigInt(entry.amountKobo))} has waited ${REMIND_AFTER_HOURS} hours for your confirmation. Please confirm or dispute it in the app.`);
  }

  const overdue = await funds.find({
    status: 'DECLARED',
    type: 'CONTRIBUTION',
    fundsMode: 'COLLECTOR_CUSTODY',
    reminderSentAt: { $lt: new Date(now.getTime() - ESCALATE_AFTER_HOURS * HOUR) },
    escalatedAt: null,
  }).toArray();
  if (overdue.length === 0) return { reminded: stale.length, escalated: 0 };
  const admins = await db.collection<{ phoneNumber?: string | null }>('User').find(
    { role: 'ADMIN' },
    { projection: { phoneNumber: 1 } },
  ).toArray();
  let escalated = 0;
  for (const entry of overdue) {
    const claimed = await funds.updateOne(
      { _id: entry._id, escalatedAt: null },
      { $set: { escalatedAt: now } },
    );
    if (!claimed.modifiedCount) continue;
    escalated++;
    for (const admin of admins) {
      await safeSms(admin.phoneNumber, `ÀJỌ: a ₦${koboToNaira(amountAsBigInt(entry.amountKobo))} payment declared ${REMIND_AFTER_HOURS + ESCALATE_AFTER_HOURS}+ hours ago is still unconfirmed by its facilitator.`);
    }
  }
  return { reminded: stale.length, escalated };
}

export function startLedgerCron() {
  cron.schedule('15 * * * *', () => chaseUnconfirmedNative().catch(console.error));
}
