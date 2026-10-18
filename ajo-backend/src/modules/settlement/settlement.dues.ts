import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { addDays } from '../apprenticeship/contracts.logic';
import { scheduleDues } from './settlement.logic';

/** Writes the monthly schedule inside the activation transaction. Lists and nulls are written explicitly (MongoDB filters need them). */
export async function createDues(db: Prisma.TransactionClient, input: { contractId: string; fundId: string; start: Date; months: number; monthlyKobo: bigint }) {
  for (const d of scheduleDues(input.start, input.months, input.monthlyKobo)) {
    await db.contributionDue.create({ data: { contractId: input.contractId, fundId: input.fundId, number: d.number, dueDate: d.dueDate, amountKobo: d.amountKobo, remindersSent: [], flaggedAt: null } });
  }
}

/** A pause pushes every month that had not yet fallen due back by the days it lasted. Reminders start over for them. */
export async function shiftDues(contractId: string, from: Date, days: number) {
  if (days <= 0) return 0;
  const dues = await prisma.contributionDue.findMany({ where: { contractId, dueDate: { gte: from } } });
  for (const d of dues) await prisma.contributionDue.update({ where: { id: d.id }, data: { dueDate: addDays(d.dueDate, days), remindersSent: [] } });
  return dues.length;
}
