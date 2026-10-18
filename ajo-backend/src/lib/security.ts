import crypto from 'crypto';
import { promisify } from 'util';
import { prisma } from './prisma';
import { HttpError } from './errors';

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const scrypt = promisify(crypto.scrypt);

export const isValidPin = (pin: unknown): pin is string => typeof pin === 'string' && /^\d{4}$/.test(pin);

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}

export function checkPinHash(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(pin, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, encodedHash] = stored.split(':');
  if (!salt || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(encodedHash ?? '')) return false;
  const expected = Buffer.from(encodedHash, 'hex');
  const actual = await scrypt(password, salt, expected.length) as Buffer;
  return crypto.timingSafeEqual(actual, expected);
}

/** Verifies a user's PIN with lockout after repeated failures. Throws HttpError on failure. */
export async function verifyPin(userId: string, pin: unknown): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new HttpError(404, 'User not found');
  if (!user.pinHash) throw new HttpError(403, 'PIN_REQUIRED: set a 4-digit PIN in Settings first');
  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) throw new HttpError(429, 'Too many wrong PINs. Try again later.');
  if (!isValidPin(pin) || !checkPinHash(pin, user.pinHash)) {
    const fails = user.pinFailedCount + 1;
    await prisma.user.update({
      where: { id: userId },
      data: fails >= MAX_FAILS
        ? { pinFailedCount: 0, pinLockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
        : { pinFailedCount: fails },
    });
    throw new HttpError(401, fails >= MAX_FAILS ? 'Too many wrong PINs. Locked for 15 minutes.' : 'Wrong PIN');
  }
  if (user.pinFailedCount > 0) await prisma.user.update({ where: { id: userId }, data: { pinFailedCount: 0 } });
}

export const randomPin = () => crypto.randomInt(0, 10000).toString().padStart(4, '0');
