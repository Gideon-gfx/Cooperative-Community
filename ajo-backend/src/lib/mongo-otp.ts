import { ObjectId } from 'mongodb';
import { getMongoDb } from './mongodb';

export interface OtpCode {
  id: string;
  phoneNumber: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
}

interface StoredOtpCode {
  phoneNumber: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  createdAt: Date;
}

function asOtpCode(document: StoredOtpCode & { _id: ObjectId }): OtpCode {
  const { _id, ...fields } = document;
  return { ...fields, id: _id.toHexString() };
}

async function otpCodes() {
  return (await getMongoDb()).collection<StoredOtpCode>('OtpCode');
}

export async function findOtpCode(phoneNumber: string): Promise<OtpCode | null> {
  const document = await (await otpCodes()).findOne({ phoneNumber });
  return document ? asOtpCode(document) : null;
}

export async function upsertOtpCode(code: Omit<OtpCode, 'id'>): Promise<void> {
  const { phoneNumber, ...fields } = code;
  await (await otpCodes()).updateOne({ phoneNumber }, { $set: fields }, { upsert: true });
}

export async function incrementOtpAttempts(id: string, maxAttempts: number): Promise<void> {
  await (await otpCodes()).updateOne(
    { _id: ObjectId.createFromHexString(id), attempts: { $lt: maxAttempts } },
    { $inc: { attempts: 1 } },
  );
}

export async function consumeOtpCode(id: string, codeHash: string, now: Date, maxAttempts: number): Promise<boolean> {
  const result = await (await otpCodes()).deleteOne({
    _id: ObjectId.createFromHexString(id),
    codeHash,
    expiresAt: { $gte: now },
    attempts: { $lt: maxAttempts },
  });
  return result.deletedCount === 1;
}

export async function deleteOtpCode(phoneNumber: string, codeHash: string): Promise<void> {
  await (await otpCodes()).deleteOne({ phoneNumber, codeHash });
}
