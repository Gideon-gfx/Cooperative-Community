import { ObjectId, type WithId } from 'mongodb';
import type { User } from '@prisma/client';
import { getMongoDb } from './mongodb';

type StoredUser = Omit<User, 'id'>;
type UserChanges = Partial<Omit<User, 'id' | 'createdAt' | 'updatedAt'>>;

function asUser(document: WithId<StoredUser>): User {
  const { _id, ...fields } = document;
  return { ...fields, id: _id.toHexString() };
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

export async function updateUserById(id: string, changes: UserChanges): Promise<User | null> {
  const collection = await users();
  const _id = objectId(id);
  await collection.updateOne({ _id }, { $set: changes });
  const document = await collection.findOne({ _id });
  return document ? asUser(document) : null;
}
