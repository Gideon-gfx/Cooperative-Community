import { Prisma } from '@prisma/client';
import { ObjectId, type Document } from 'mongodb';
import { prisma } from './prisma';
import { getMongoDb } from './mongodb';

/** Append-only record of sensitive actions. Never throws: auditing must not break the action. */
export async function audit(actorId: string | null, action: string, entity: string, entityId?: string, meta?: Prisma.InputJsonValue) {
  try {
    await prisma.auditLog.create({ data: { actorId, action, entity, entityId, meta } });
  } catch (error) {
    console.error('[audit] failed', error instanceof Error ? error.message : String(error));
  }
}

/** Login auditing shares the native connection path with the authentication query. */
export async function auditNative(actorId: string, action: string, entity: string, entityId: string) {
  try {
    await (await getMongoDb()).collection('AuditLog').insertOne({
      actorId: ObjectId.createFromHexString(actorId),
      action,
      entity,
      entityId,
      createdAt: new Date(),
    });
  } catch (error) {
    console.error('[audit] failed', error instanceof Error ? error.message : String(error));
  }
}
