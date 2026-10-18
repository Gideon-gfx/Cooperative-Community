import axios from 'axios';

export const TOKEN_KEY = 'ajo_token';
export const USER_KEY = 'ajo_user';

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '/api',
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      if (window.location.pathname !== '/auth') window.location.href = '/auth';
    }
    return Promise.reject(error);
  },
);

export const errMsg = (e: unknown): string =>
  (axios.isAxiosError(e) && (e.response?.data as { error?: string } | undefined)?.error) || 'Something went wrong. Please try again.';

/** Uploads a proof/receipt image and returns its URL. */
export async function uploadFile(file: File): Promise<string> {
  const fd = new FormData();
  fd.append('file', file);
  const { data } = await api.post<{ url: string }>('/uploads', fd);
  return data.url;
}

export const naira = (n: number | string) => `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
