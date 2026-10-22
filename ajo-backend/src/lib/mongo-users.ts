import { ObjectId, type WithId } from 'mongodb';
import type { User } from '@prisma/client';
import { getMongoDb } from './mongodb';

type StoredUser = Partial<Omit<User, 'id' | 'fullName' | 'role' | 'referredById' | 'createdByAgentId'>> &
  Pick<User, 'fullName' | 'role'> & {
    referredById?: string | ObjectId | null;
    createdByAgentId?: string | ObjectId | null;
  };
type UserChanges = Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>>;

function asUser(document: WithId<StoredUser>): User {
  return {
    id: document._id.toHexString(),
    phoneNumber: document.phoneNumber ?? null,
    email: document.email ?? null,
    fullName: document.fullName,
    role: document.role,
    memberStatus: document.memberStatus ?? 'CLEAN',
    walletBalance: document.walletBalance ?? 0,
    dateOfBirth: document.dateOfBirth ?? null,
    referralCode: document.referralCode ?? null,
    referredById: document.referredById instanceof ObjectId ? document.referredById.toHexString() : document.referredById ?? null,
    bankAccountNo: document.bankAccountNo ?? null,
    bankCode: document.bankCode ?? null,
    locationLat: document.locationLat ?? null,
    locationLng: document.locationLng ?? null,
    locationLabel: document.locationLabel ?? null,
    isVerified: document.isVerified ?? false,
    collectorApproved: document.collectorApproved ?? false,
    country: document.country ?? 'NG',
    preferredLanguage: document.preferredLanguage ?? 'EN',
    reminderHour: document.reminderHour ?? 8,
    pinHash: document.pinHash ?? null,
    passwordHash: document.passwordHash ?? null,
    pinMustChange: document.pinMustChange ?? false,
    pinFailedCount: document.pinFailedCount ?? 0,
    pinLockedUntil: document.pinLockedUntil ?? null,
    accountType: document.accountType ?? 'SELF',
    createdByAgentId: document.createdByAgentId instanceof ObjectId ? document.createdByAgentId.toHexString() : document.createdByAgentId ?? null,
    createdAt: document.createdAt ?? new Date(0),
    updatedAt: document.updatedAt ?? new Date(0),
  };
}

function objectId(id: string): ObjectId {
  if (!ObjectId.isValid(id)) throw new Error(`Invalid user id: ${id}`);
  return ObjectId.createFromHexString(id);
}

async function users() {
  return (await getMongoDb()).collection<StoredUser>('User');
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const document = await (await users()).findOne({ email });
  return document ? asUser(document) : null;
}

export async function findUserByPhone(phoneNumber: string): Promise<User | null> {
  const document = await (await users()).findOne({ phoneNumber });
  return document ? asUser(document) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const document = await (await users()).findOne({ _id: objectId(id) });
  return document ? asUser(document) : null;
}

export async function findUserIdByReferralCode(referralCode: string): Promise<string | null> {
  const document = await (await users()).findOne({ referralCode }, { projection: { _id: 1 } });
  return document?._id.toHexString() ?? null;
}

export async function markUserVerifiedByPhone(phoneNumber: string): Promise<User | null> {
  const collection = await users();
  await collection.updateOne({ phoneNumber }, { $set: { isVerified: true } });
  const document = await collection.findOne({ phoneNumber });
  return document ? asUser(document) : null;
}

export async function createVerifiedPhoneUser(input: {
  phoneNumber: string;
  fullName: string;
  role: User['role'];
  country: string;
  referredById?: string;
}): Promise<User> {
  const now = new Date();
  const result = await (await users()).insertOne({
    phoneNumber: input.phoneNumber,
    fullName: input.fullName,
    role: input.role,
    country: input.country,
    ...(input.referredById ? { referredById: objectId(input.referredById) } : {}),
    memberStatus: 'CLEAN',
    walletBalance: 0,
    isVerified: true,
    collectorApproved: false,
    preferredLanguage: 'EN',
    reminderHour: 8,
    pinMustChange: false,
    pinFailedCount: 0,
    accountType: 'SELF',
    createdAt: now,
    updatedAt: now,
  });
  const created = await (await users()).findOne({ _id: result.insertedId });
  if (!created) throw new Error('Created user could not be read back from MongoDB');
  return asUser(created);
}

export async function createEmailUser(input: {
  email: string;
  passwordHash: string;
  fullName: string;
  role: User['role'];
  country: string;
  referredById?: string;
}): Promise<User> {
  const now = new Date();
  const result = await (await users()).insertOne({
    email: input.email,
    passwordHash: input.passwordHash,
    fullName: input.fullName,
    role: input.role,
    country: input.country,
    ...(input.referredById ? { referredById: objectId(input.referredById) } : {}),
    memberStatus: 'CLEAN',
    walletBalance: 0,
    isVerified: false,
    collectorApproved: false,
    preferredLanguage: 'EN',
    reminderHour: 8,
    pinMustChange: false,
    pinFailedCount: 0,
    accountType: 'SELF',
    createdAt: now,
    updatedAt: now,
  });
  const created = await (await users()).findOne({ _id: result.insertedId });
  if (!created) throw new Error('Created user could not be read back from MongoDB');
  return asUser(created);
}

export async function updateUserById(id: string, changes: UserChanges): Promise<User | null> {
  const collection = await users();
  const _id = objectId(id);
  await collection.updateOne({ _id }, { $set: changes });
  const document = await collection.findOne({ _id });
  return document ? asUser(document) : null;
}
