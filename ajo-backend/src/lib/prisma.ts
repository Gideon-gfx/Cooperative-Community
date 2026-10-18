import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

let emailIndexPromise: Promise<unknown> | undefined;

/**
 * Email-only accounts have no phone number, and email-free (phone) accounts have no email. A plain unique index treats a
 * missing value as one shared "null", so only ONE such account could ever exist. Both indexes are therefore partial:
 * unique among accounts that actually have the value. Prisma's own full index on phoneNumber is dropped.
 */
export function ensureEmailUniqueIndex(): Promise<unknown> {
  if (!emailIndexPromise) {
    emailIndexPromise = (async () => {
      await prisma.$runCommandRaw({ dropIndexes: 'User', index: 'User_phoneNumber_key' }).catch(() => undefined); // already dropped, or never made
      await prisma.$runCommandRaw({
        createIndexes: 'User',
        indexes: [
          { key: { email: 1 }, name: 'user_email_unique_non_null', unique: true, partialFilterExpression: { email: { $type: 'string' } } },
          { key: { referralCode: 1 }, name: 'user_referral_unique_non_null', unique: true, partialFilterExpression: { referralCode: { $type: 'string' } } },
          { key: { phoneNumber: 1 }, name: 'user_phone_unique_non_null', unique: true, partialFilterExpression: { phoneNumber: { $type: 'string' } } },
        ],
      });
    })().catch((error: unknown) => {
      emailIndexPromise = undefined;
      throw error;
    });
  }
  return emailIndexPromise;
}
