import { createContext, useContext, useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, loadStoredAuth, persistStoredAuth } from "../lib/api.js";

const AuthContext = createContext(null);

function loadAuth() {
  return loadStoredAuth();
}

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [auth, setAuth] = useState(() => loadAuth());
  const [authReady, setAuthReady] = useState(() => !loadAuth()?.token);

  const persist = useCallback((next) => {
    persistStoredAuth(next);
    setAuth(next);
  }, []);

  useEffect(() => {
    const stored = loadAuth();
    if (!stored?.token) {
      setAuthReady(true);
      return;
    }
    if (!stored?.user) {
      queryClient.clear();
      persist(null);
      setAuthReady(true);
      return;
    }

    let cancelled = false;
    api
      .get("/auth/companies")
      .then(() => {
        if (!cancelled) setAuthReady(true);
      })
      .catch((err) => {
        if (!cancelled) {
          const status = err?.status ?? err?.response?.status ?? 0;
          if (status === 401 || status === 403) {
            queryClient.clear();
            persist(null);
          }
          setAuthReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [queryClient, persist]);

  async function login(identifier, password) {
    const { data } = await api.post("/auth/login", { email: identifier, password });
    if (data?.token) {
      persist(data);
    } else {
      persist({
        user: data?.user || null,
        companies: data?.companies || [],
        loginTicket: data?.loginTicket || null,
        requiresCompanySelection: !!data?.requiresCompanySelection,
      });
    }
    return data;
  }

  async function selectCompany(companyId) {
    if (auth?.loginTicket) {
      const { data } = await api.post("/auth/select-company", {
        loginTicket: auth.loginTicket,
        companyId,
      });
      persist(data);
      return data;
    }
    const { data } = await api.post("/auth/switch-company", { companyId });
    persist(data);
    queryClient.clear();
    return data;
  }

  function logout() {
    queryClient.clear();
    persist(null);
  }

  const value = {
    auth,
    authReady,
    isLoggedIn: !!auth?.token && !!auth?.user,
    requiresCompanySelection: !!auth?.requiresCompanySelection && !auth?.token,
    login,
    selectCompany,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
