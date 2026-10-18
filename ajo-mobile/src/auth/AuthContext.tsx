import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { setToken, setUnauthorizedHandler, TOKEN_KEY, USER_KEY } from '../api/client';
import { translate, type Lang } from '../i18n';
import AsyncStorage from '@react-native-async-storage/async-storage';

const GUEST_LANG_KEY = 'ajo_guest_lang';

export interface User {
  id: string;
  fullName: string;
  phoneNumber: string | null;
  email: string | null;
  role: 'MEMBER' | 'COLLECTOR' | 'TRANSPORTER' | 'ADMIN' | 'TRADE_MASTER' | 'GUARANTOR' | 'BOARD_MEMBER' | 'FACILITATOR';
  memberStatus: 'CLEAN' | 'WARNED' | 'DEFAULTER';
  walletBalance: number;
  preferredLanguage: Lang;
  reminderHour: number;
  hasPin: boolean;
  collectorApproved: boolean;
  accountType: 'SELF' | 'ASSISTED';
  country: string;
}
interface Ctx {
  user: User | null;
  ready: boolean;
  lang: Lang;
  setGuestLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  login: (token: string, user: User) => Promise<void>;
  updateUser: (patch: Partial<User>) => Promise<void>;
  logout: () => Promise<void>;
}
const AuthContext = createContext<Ctx>(null as unknown as Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [guestLang, setGuestLangState] = useState<Lang>('EN');
  const setGuestLang = useCallback((l: Lang) => {
    setGuestLangState(l);
    AsyncStorage.setItem(GUEST_LANG_KEY, l).catch(() => {});
  }, []);

  const logout = useCallback(async () => {
    await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY), SecureStore.deleteItemAsync(USER_KEY)]);
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    (async () => {
      try {
        const [t, u, g] = await Promise.all([SecureStore.getItemAsync(TOKEN_KEY), SecureStore.getItemAsync(USER_KEY), AsyncStorage.getItem(GUEST_LANG_KEY)]);
        if (g) setGuestLangState(g as Lang);
        if (t && u) { setToken(t); setUser(JSON.parse(u)); }
      } catch { /* treat as logged out */ }
      setReady(true);
    })();
  }, []);

  const login = async (t: string, u: User) => {
    await Promise.all([SecureStore.setItemAsync(TOKEN_KEY, t), SecureStore.setItemAsync(USER_KEY, JSON.stringify(u))]);
    setToken(t);
    setUser(u);
  };
  const updateUser = async (patch: Partial<User>) => {
    if (!user) return;
    const next = { ...user, ...patch };
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(next));
    setUser(next);
  };

  const lang = user?.preferredLanguage ?? guestLang;
  const t = useCallback((key: string, vars?: Record<string, string | number>) => translate(lang, key, vars), [lang]);
  return <AuthContext.Provider value={{ user, ready, lang, setGuestLang, t, login, updateUser, logout }}>{children}</AuthContext.Provider>;
}
export const useAuth = () => useContext(AuthContext);
