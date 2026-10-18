import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { config } from '../lib/config';

export const UPLOAD_ROOT = path.resolve(process.cwd(), config.uploadDir);

/** PUBLIC_BASE_URL if set, otherwise this machine's LAN address (so a phone on the same Wi‑Fi can open the file). */
export function publicBaseUrl(): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/$/, '');
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return `http://${a.address}:${config.port}`;
  }
  return `http://localhost:${config.port}`;
}

/** Saves a file under uploads/<folder>/ and returns its public URL (served at /files). */
export async function saveFile(buffer: Buffer, folder: string, ext: string, baseName?: string): Promise<string> {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const safeName = (baseName ?? crypto.randomUUID()).replace(/[^\w-]/g, '_');
  const name = `${safeName}-${crypto.randomBytes(4).toString('hex')}.${safeExt}`;
  const dir = path.join(UPLOAD_ROOT, folder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), buffer);
  return `${publicBaseUrl()}/files/${folder}/${name}`;
}
