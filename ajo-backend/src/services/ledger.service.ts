import { LedgerDirection, LedgerType } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { HttpError } from '../lib/errors';
import { naira, safeSms } from '../lib/notify';
import { round2 } from '../lib/money';
import { audit } from '../lib/audit';

export type PoolRef = { ajoPoolId: string } | { foodPoolId: string } | { campaignId: string };

const where = (ref: PoolRef) => ('ajoPoolId' in ref ? { ajoPoolId: ref.ajoPoolId } : 'foodPoolId' in ref ? { foodPoolId: ref.foodPoolId } : { campaignId: ref.campaignId });
const entityOf = (ref: PoolRef): [string, string] =>
  'ajoPoolId' in ref ? ['AjoPool', ref.ajoPoolId] : 'foodPoolId' in ref ? ['FoodPool', ref.foodPoolId] : ['Campaign', ref.campaignId];

export async function addEntry(ref: PoolRef, direction: LedgerDirection, type: LedgerType, amount: number, createdById: string, note?: string, refId?: string) {
  if (!(amount > 0)) throw new HttpError(400, 'Amount must be positive');
  return prisma.ledgerEntry.create({ data: { ...where(ref), direction, type, amount: round2(amount), note, refId, createdById } });
}

/** Everything a member needs to see about where the pool's money is. */
export async function getLedger(ref: PoolRef) {
  const [entries, last] = await Promise.all([
    prisma.ledgerEntry.findMany({ where: where(ref), orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.fundsAttestation.findFirst({ where: where(ref), orderBy: { createdAt: 'desc' } }),
  ]);
  const all = await prisma.ledgerEntry.groupBy({ by: ['direction'], where: where(ref), _sum: { amount: true } });
  const totalIn = round2(all.find((a) => a.direction === 'IN')?._sum.amount ?? 0);
  const totalOut = round2(all.find((a) => a.direction === 'OUT')?._sum.amount ?? 0);
  const held = round2(totalIn - totalOut);
  return {
    entries,
    totalIn,
    totalOut,
    heldByCollector: held,
    lastAttestation: last && {
      declaredAmount: last.declaredAmount,
      ledgerAmountAtTime: last.ledgerAmount,
      note: last.note,
      proofUrl: last.proofUrl,
      createdAt: last.createdAt,
      mismatch: round2(last.declaredAmount - last.ledgerAmount),
      stale: Date.now() - last.createdAt.getTime() > 7 * 24 * 3600 * 1000,
    },
  };
}

/**
 * The collector declares how much of the pool's money they hold right now. We compare it to the ledger and
 * tell the whole group, including any mismatch, so custody stays visible.
 */
export async function attestFunds(
  ref: PoolRef,
  collectorId: string,
  groupId: string,
  currency: string,
  input: { declaredAmount: number; note?: string; proofUrl?: string },
) {
  const { heldByCollector } = await getLedger(ref);
  const att = await prisma.fundsAttestation.create({
    data: { ...where(ref), declaredAmount: input.declaredAmount, ledgerAmount: heldByCollector, note: input.note, proofUrl: input.proofUrl, createdById: collectorId },
  });
  const diff = round2(input.declaredAmount - heldByCollector);
  await prisma.groupMessage.create({
    data: {
      groupId,
      senderId: collectorId,
      messageType: 'SYSTEM',
      content:
        diff === 0
          ? `🧾 Collector confirms they hold ${naira(input.declaredAmount, currency)}. This matches the ledger.`
          : `⚠️ Collector says they hold ${naira(input.declaredAmount, currency)} but the ledger shows ${naira(heldByCollector, currency)} (difference ${naira(Math.abs(diff), currency)}). Please check the ledger.`,
    },
  });
  if (diff !== 0) {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
    for (const a of admins) await safeSms(a.phoneNumber, `ÀJỌ: a collector's declared balance differs from the ledger by ${naira(Math.abs(diff), currency)}.`);
  }
  const [entity, entityId] = entityOf(ref);
  await audit(collectorId, 'FUNDS_ATTESTED', entity, entityId, { declared: input.declaredAmount, ledger: heldByCollector });
  return { attestation: att, mismatch: diff };
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\n');
}
