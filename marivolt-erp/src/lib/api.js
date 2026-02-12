const rawBase =
  import.meta.env.VITE_API_BASE || "https://marivolt-erp.onrender.com";
export const API_BASE = rawBase.endsWith("/api")
  ? rawBase
  : `${rawBase.replace(/\/$/, "")}/api`;
const AUTH_KEY = "marivoltz_auth_v1";

function getToken() {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    return auth?.token || null;
  } catch {
    return null;
  }
}

async function request(path, options = {}) {
  const token = getToken();

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

export function apiGet(path) {
  return request(path, { method: "GET" });
}

export function apiPost(path, body) {
  return request(path, { method: "POST", body: JSON.stringify(body) });
}

export function apiPut(path, body) {
  return request(path, { method: "PUT", body: JSON.stringify(body) });
}

export function apiDelete(path) {
  return request(path, { method: "DELETE" });
}

export async function apiGetWithQuery(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  });

  const token = getToken();
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
