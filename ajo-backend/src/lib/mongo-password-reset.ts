import { ObjectId } from 'mongodb';
import { getMongoDb } from './mongodb';

export interface PasswordResetCode {
  id: string;
  userId: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
}

interface StoredPasswordResetCode {
  userId: ObjectId;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
}

function asPasswordResetCode(document: StoredPasswordResetCode & { _id: ObjectId }): PasswordResetCode {
  return {
    id: document._id.toHexString(),
    userId: document.userId.toHexString(),
    codeHash: document.codeHash,
    expiresAt: document.expiresAt,
    attempts: document.attempts,
    createdAt: document.createdAt,
  };
}

async function passwordResetCodes() {
  return (await getMongoDb()).collection<StoredPasswordResetCode>('PasswordResetCode');
}

export async function findPasswordResetCode(userId: string): Promise<PasswordResetCode | null> {
  const document = await (await passwordResetCodes()).findOne({ userId: ObjectId.createFromHexString(userId) });
  return document ? asPasswordResetCode(document) : null;
}

export async function upsertPasswordResetCode(
  code: Omit<PasswordResetCode, 'id'>,
): Promise<void> {
  const userId = ObjectId.createFromHexString(code.userId);
  await (await passwordResetCodes()).updateOne(
    { userId },
    {
      $set: {
        codeHash: code.codeHash,
        expiresAt: code.expiresAt,
        attempts: code.attempts,
        createdAt: code.createdAt,
      },
    },
    { upsert: true },
  );
}

export async function incrementPasswordResetAttempts(id: string, maxAttempts: number): Promise<void> {
  await (await passwordResetCodes()).updateOne(
    { _id: ObjectId.createFromHexString(id), attempts: { $lt: maxAttempts } },
    { $inc: { attempts: 1 } },
  );
}

export async function consumePasswordResetCode(
  userId: string,
  codeHash: string,
  now: Date,
  maxAttempts: number,
): Promise<boolean> {
  const result = await (await passwordResetCodes()).deleteOne({
    userId: ObjectId.createFromHexString(userId),
    codeHash,
    expiresAt: { $gte: now },
    attempts: { $lt: maxAttempts },
  });
  return result.deletedCount === 1;
}

export async function deletePasswordResetCode(userId: string, codeHash: string): Promise<void> {
  await (await passwordResetCodes()).deleteOne({ userId: ObjectId.createFromHexString(userId), codeHash });
}
