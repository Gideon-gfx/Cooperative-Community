import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { naira, safeSms } from '../lib/notify';
import { sendEmail } from '../lib/mailer';
import { t, type Lang } from '../lib/i18n';
import { DAY_MS } from '../modules/ajo/ajo.logic';
import { buildDigests, flagDefaulter } from '../modules/ajo/ajo.service';

// UTC offsets (no DST in these countries) so "today" and "the member's preferred hour" are local.
const UTC_OFFSET: Record<string, number> = { NG: 1, GH: 0, KE: 3 };

const localHour = (country: string, now = new Date()) => (now.getUTCHours() + (UTC_OFFSET[country] ?? 1) + 24) % 24;

/** Start/end (UTC instants) of the local calendar day `offsetDays` from today. */
function localDayRange(country: string, offsetDays: number, now = new Date()) {
  const off = UTC_OFFSET[country] ?? 1;
  const local = new Date(now.getTime() + off * 3600 * 1000);
  const startUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offsetDays) - off * 3600 * 1000;
  return { gte: new Date(startUtc), lt: new Date(startUtc + DAY_MS) };
}

/** Sends the 2-day and same-day reminders, each at the hour the member chose, in the language they chose. */
export async function sendDueReminders(now = new Date()) {
  for (const country of Object.keys(UTC_OFFSET)) {
    const hour = localHour(country, now);
    for (const [offset, key] of [[2, 'remind.soon'], [0, 'remind.today']] as const) {
      const rows = await prisma.ajoContribution.findMany({
        where: {
          status: 'PENDING',
          dueAt: localDayRange(country, offset, now),
          contributor: { country, reminderHour: hour },
        },
        include: { contributor: true, payments: true, schedule: { include: { recipient: true } }, ajoPool: { include: { group: { select: { currency: true } } } } },
      });
      for (const c of rows) {
        const pending = c.payments.filter((p) => p.status !== 'REJECTED').reduce((s, p) => s + p.amount, 0);
        const remaining = c.amount - c.paidAmount - pending;
        if (remaining <= 0) continue;
        await safeSms(c.contributor.phoneNumber, t(c.contributor.preferredLanguage as Lang, key, { amount: naira(remaining, c.ajoPool.group.currency), recipient: c.schedule.recipient.fullName }));
      }
    }
  }
}

export function startAjoCron() {
  // Hourly: each member is reminded at their own preferred hour.
  cron.schedule('0 * * * *', () => sendDueReminders().catch(console.error));
  // 23:00 WAT: flag contributions that are past due + grace and have no payment recorded.
  cron.schedule(
    '0 23 * * *',
    async () => {
      const overdue = await prisma.ajoContribution.findMany({
        where: { status: 'PENDING', payments: { none: {} }, dueAt: { lt: new Date() } },
        select: { scheduleId: true },
        distinct: ['scheduleId'],
      });
      for (const { scheduleId } of overdue) await flagDefaulter(scheduleId).catch(console.error);
    },
    { timezone: 'Africa/Lagos' },
  );
  // Sunday 18:00 WAT: transparency digest, one line per pool.
  cron.schedule('0 18 * * 0', () => sendWeeklyDigest().catch(console.error), { timezone: 'Africa/Lagos' });
}

export async function sendWeeklyDigest() {
  const byUser = new Map<string, { phone: string | null; email: string | null; lines: string[] }>();
  for (const digest of await buildDigests()) {
    const entry = byUser.get(digest.userId) ?? { phone: digest.phone, email: digest.email, lines: [] };
    entry.lines.push(digest.line);
    byUser.set(digest.userId, entry);
  }
  for (const { phone, email, lines } of byUser.values()) {
    const body = `ÀJỌ weekly update:\n${lines.join('\n')}`;
    if (phone) await safeSms(phone, body);
    if (email) await sendEmail(email, 'Your ÀJỌ weekly update', body);
  }
}


