import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api.get('/auth/me').then(setUser).catch(() => setToken(null)).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const login = useCallback(async (email, password, mfaCode, remember = true) => {
    const res = await api.post('/auth/login', { email, password, mfa_code: mfaCode || undefined });
    setToken(res.token, remember);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* already signed out */
    }
    setToken(null);
    setUser(null);
  }, []);

  const replaceSession = useCallback((res) => {
    setToken(res.token);
    setUser(res.user);
  }, []);

  const value = useMemo(() => ({
    user,
    ready,
    login,
    logout,
    replaceSession,
    can: (...perms) => Boolean(user && perms.some((p) => user.permissions.includes(p))),
  }), [user, ready, login, logout, replaceSession]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
