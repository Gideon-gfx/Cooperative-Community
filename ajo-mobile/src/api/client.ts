import axios from 'axios';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

export const TOKEN_KEY = 'ajo_token';
export const USER_KEY = 'ajo_user';

/** EXPO_PUBLIC_API_URL wins; otherwise reuse the LAN IP Expo Go is loading the bundle from. */
function resolveBaseUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host ?? 'localhost'}:4000/api`;
}

export const API_URL = resolveBaseUrl();
export const api = axios.create({ baseURL: API_URL, timeout: 20000 });

let token: string | null = null;
let onUnauthorized: () => void = () => {};
export const setToken = (t: string | null) => { token = t; };
export const getToken = () => token;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

api.interceptors.request.use((config) => {
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
api.interceptors.response.use(
  (r) => r,
  async (error) => {
    // A wrong PIN is also a 401, but it must not log the user out.
    const wrongPin = error.config?.url?.includes('/login-pin') || /PIN/i.test(error.response?.data?.error ?? '');
    if (error.response?.status === 401 && token && !wrongPin) {
      await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY), SecureStore.deleteItemAsync(USER_KEY)]);
      setToken(null);
      onUnauthorized();
    }
    return Promise.reject(error);
  },
);

export const errMsg = (e: unknown): string => {
  if (axios.isAxiosError(e)) {
    const data = e.response?.data as { error?: string } | undefined;
    if (data?.error) return data.error.replace(/^PIN_REQUIRED:\s*/, '');
    if (!e.response) return `Cannot reach the server at ${API_URL}. Is the backend running on the same Wi‑Fi?`;
  }
  return 'Something went wrong. Please try again.';
};

/** True when the server says the user has not set a PIN yet. */
export const isPinRequired = (e: unknown): boolean =>
  axios.isAxiosError(e) && /PIN_REQUIRED/.test((e.response?.data as { error?: string } | undefined)?.error ?? '');

export function money(n: number | string, currency = 'NGN'): string {
  const symbols: Record<string, string> = { NGN: '₦', GHS: 'GH₵', KES: 'KSh ' };
  const body = Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  return symbols[currency] !== undefined ? `${symbols[currency]}${body}` : `${currency} ${body}`;
}
export const naira = (n: number | string) => money(n, 'NGN');

export async function uploadFile(file: { uri: string; name: string; type: string }): Promise<string> {
  const fd = new FormData();
  fd.append('file', file as unknown as Blob);
  const { data } = await api.post<{ url: string }>('/uploads', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60000 });
  return data.url;
}
