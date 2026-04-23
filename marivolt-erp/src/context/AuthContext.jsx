import { createContext, useContext, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, AUTH_KEY } from "../lib/api.js";

const AuthContext = createContext(null);

function loadAuth() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
  } catch {
    return null;
  }
}

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [auth, setAuth] = useState(loadAuth);

  function persist(next) {
    if (next) localStorage.setItem(AUTH_KEY, JSON.stringify({ ...next, ts: Date.now() }));
    else localStorage.removeItem(AUTH_KEY);
    setAuth(next);
  }

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

  const value = useMemo(
    () => ({
      auth,
      isLoggedIn: !!auth?.token && !!auth?.user,
      requiresCompanySelection: !!auth?.requiresCompanySelection && !auth?.token,
      login,
      selectCompany,
      logout,
    }),
    [auth]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
