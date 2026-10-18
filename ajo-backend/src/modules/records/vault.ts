import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../../lib/config';
import { HttpError } from '../../lib/errors';

// The records vault. Scans and documents contain other people's personal information, so they are:
//  - encrypted at rest (AES-256-GCM), in a folder that is NOT served as static files,
//  - read only through short-lived signed URLs, and every read is logged by the caller.

export const VAULT_ROOT = path.resolve(process.cwd(), process.env.RECORDS_VAULT_DIR || 'records-vault');

let devKeyWarned = false;
function key(): Buffer {
  const hex = process.env.RECORDS_ENCRYPTION_KEY;
  if (hex) {
    const k = Buffer.from(hex, hex.length === 64 ? 'hex' : 'base64');
    if (k.length !== 32) throw new Error('RECORDS_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64)');
    return k;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('RECORDS_ENCRYPTION_KEY is required in production');
  if (!devKeyWarned) { console.warn('[records] RECORDS_ENCRYPTION_KEY not set: deriving a DEV key. Set a real one before storing real records.'); devKeyWarned = true; }
  return crypto.createHash('sha256').update(`dev-records-key:${config.jwtSecret}`).digest();
}

export const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

/** iv(12) | tag(16) | ciphertext. A fresh random IV per file. */
export function encrypt(plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function decrypt(blob: Buffer): Buffer {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

/** Stores an encrypted copy and returns its vault key. The key is a random name: it reveals nothing about the file. */
export async function vaultPut(plain: Buffer): Promise<string> {
  const vaultKey = `${crypto.randomUUID()}.enc`;
  await fs.mkdir(VAULT_ROOT, { recursive: true });
  await fs.writeFile(path.join(VAULT_ROOT, vaultKey), encrypt(plain));
  return vaultKey;
}

export async function vaultGet(vaultKey: string): Promise<Buffer> {
  if (!/^[\w-]+\.enc$/.test(vaultKey)) throw new HttpError(400, 'Bad file key');
  try {
    return decrypt(await fs.readFile(path.join(VAULT_ROOT, vaultKey)));
  } catch {
    throw new HttpError(404, 'File not found or could not be read');
  }
}

// ── Signed, expiring links ──────────────────────────────────────────────────

const sigKey = () => crypto.createHash('sha256').update(`records-url:${config.jwtSecret}`).digest();
export const URL_TTL_SECONDS = 10 * 60;

export interface FileClaim { pageId: string; exp: number; groupId: string; uid: string }

/** A link that works for ten minutes. Who may ask for one is decided where it is issued; every use is logged. */
export function signFileToken(c: Omit<FileClaim, 'exp'>, now = Date.now(), ttl = URL_TTL_SECONDS): string {
  const body = Buffer.from(JSON.stringify({ ...c, exp: Math.floor(now / 1000) + ttl })).toString('base64url');
  const mac = crypto.createHmac('sha256', sigKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyFileToken(token: string, now = Date.now()): FileClaim {
  const [body, mac] = token.split('.');
  if (!body || !mac) throw new HttpError(401, 'Invalid link');
  const expect = crypto.createHmac('sha256', sigKey()).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Invalid link');
  const claim = JSON.parse(Buffer.from(body, 'base64url').toString()) as FileClaim;
  if (claim.exp < Math.floor(now / 1000)) throw new HttpError(401, 'This link has expired. Open the record again.');
  return claim;
}
