import AsyncStorage from '@react-native-async-storage/async-storage';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { api } from './api/client';

/**
 * Small JSON actions (send a message, record a payment) made without network are kept here and retried.
 * File uploads are NOT queued: the phone would need to keep the file, so those just report the error.
 */
const KEY = 'ajo_outbox_v1';
export interface Queued { id: string; method: 'post' | 'patch'; url: string; body?: unknown; label: string; createdAt: number }

let listeners: ((n: number) => void)[] = [];
let flushing = false;

async function read(): Promise<Queued[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(KEY)) ?? '[]');
  } catch {
    return [];
  }
}
async function write(q: Queued[]) {
  await AsyncStorage.setItem(KEY, JSON.stringify(q));
  listeners.forEach((l) => l(q.length));
}

const isNetworkError = (e: unknown) => axios.isAxiosError(e) && !e.response;

/** Sends now; if the network is down, queues it and returns { queued: true }. Real server errors still throw. */
export async function postOrQueue<T = unknown>(method: 'post' | 'patch', url: string, body: unknown, label: string): Promise<{ queued: boolean; data?: T }> {
  try {
    const res = await api.request<T>({ method, url, data: body });
    return { queued: false, data: res.data };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    await write([...(await read()), { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, method, url, body, label, createdAt: Date.now() }]);
    return { queued: true };
  }
}

/** Retries queued actions in order. Stops at the first network failure; drops ones the server rejects for good. */
export async function flushOutbox(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    let q = await read();
    while (q.length) {
      const item = q[0];
      try {
        await api.request({ method: item.method, url: item.url, data: item.body });
        sent++;
      } catch (e) {
        if (isNetworkError(e)) break;
        // The server answered with an error (already recorded, no longer allowed…): retrying would never succeed.
      }
      q = q.slice(1);
      await write(q);
    }
  } finally {
    flushing = false;
  }
  return sent;
}

export function useOutboxCount(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    read().then((q) => setN(q.length));
    listeners.push(setN);
    return () => { listeners = listeners.filter((l) => l !== setN); };
  }, []);
  return n;
}

/** Retries on launch, when the app returns to the foreground, and every 30 s. */
export function useOutboxFlusher(enabled: boolean, onSent?: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const run = () => flushOutbox().then((n) => n > 0 && onSent?.());
    run();
    const t = setInterval(run, 30000);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && run());
    return () => { clearInterval(t); sub.remove(); };
  }, [enabled]);
}
