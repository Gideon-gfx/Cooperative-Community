import { createContext, useContext, useState, type ReactNode } from 'react';
import { TOKEN_KEY, USER_KEY } from '../api/client';

export interface User {
  id: string;
  fullName: string;
  phoneNumber: string | null;
  email: string | null;
  role: 'MEMBER' | 'COLLECTOR' | 'TRANSPORTER' | 'ADMIN';
  memberStatus: 'CLEAN' | 'WARNED' | 'DEFAULTER';
  walletBalance: string;
}

interface Ctx {
  user: User | null;
  login: (token: string, user: User) => void;
  logout: () => void;
}

const AuthContext = createContext<Ctx>(null as unknown as Ctx);

function readUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw && localStorage.getItem(TOKEN_KEY) ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(readUser);
  const login = (token: string, u: User) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    setUser(u);
  };
  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  };
  return <AuthContext.Provider value={{ user, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
