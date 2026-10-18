import { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/** Append-only record of sensitive actions. Never throws: auditing must not break the action. */
export async function audit(actorId: string | null, action: string, entity: string, entityId?: string, meta?: Prisma.InputJsonValue) {
  try {
    await prisma.auditLog.create({ data: { actorId, action, entity, entityId, meta } });
  } catch (e) {
    console.error('[audit] failed', (e as Error).message);
  }
}
