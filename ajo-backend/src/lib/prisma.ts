import { PrismaClient } from '@prisma/client';
import { getMongoDb } from './mongodb';

export const prisma = new PrismaClient();

let emailIndexPromise: Promise<unknown> | undefined;

/**
 * Email-only accounts have no phone number, and email-free (phone) accounts have no email. A plain unique index treats a
 * missing value as one shared "null", so only ONE such account could ever exist. Both indexes are therefore partial:
 * unique among accounts that actually have the value. The old full index on phoneNumber is dropped.
 */
export function ensureEmailUniqueIndex(): Promise<unknown> {
  if (!emailIndexPromise) {
    emailIndexPromise = (async () => {
      const users = (await getMongoDb()).collection('User');
      const indexes = await users.listIndexes().toArray();
      if (indexes.some((index) => index.name === 'User_phoneNumber_key')) await users.dropIndex('User_phoneNumber_key');
      await users.createIndexes([
        { key: { email: 1 }, name: 'user_email_unique_non_null', unique: true, partialFilterExpression: { email: { $type: 'string' } } },
        { key: { referralCode: 1 }, name: 'user_referral_unique_non_null', unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } },
        { key: { phoneNumber: 1 }, name: 'user_phone_unique_non_null', unique: true, partialFilterExpression: { phoneNumber: { $type: 'string' } } },
      ]);
    })().catch((error: unknown) => {
      emailIndexPromise = undefined;
      throw error;
    });
  }
  return emailIndexPromise;
}
