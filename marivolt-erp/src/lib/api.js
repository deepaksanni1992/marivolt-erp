function resolveApiBase() {
  const fromEnv = (
    import.meta.env.VITE_API_BASE_URL ||
    import.meta.env.VITE_API_BASE ||
    ""
  ).trim();
  if (fromEnv) return fromEnv;

  // Local dev: avoid a blank app if .env was not copied; backend default is port 5000.
  if (import.meta.env.DEV) {
    console.warn(
      "[api] VITE_API_BASE_URL / VITE_API_BASE not set — using http://localhost:5000. Add them to .env for a different API URL."
    );
    return "http://localhost:5000";
  }

  return "";
}

const rawBase = resolveApiBase();

if (!rawBase) {
  throw new Error(
    "VITE_API_BASE_URL or VITE_API_BASE is not configured. " +
      "On Vercel, add Environment Variable VITE_API_BASE_URL = your backend origin (no /api suffix), e.g. https://your-api.onrender.com — then redeploy."
  );
}

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
    let message = text;
    try {
      const body = JSON.parse(text);
      if (body && typeof body.message === "string") message = body.message;
    } catch (_) {}
    throw new Error(message);
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

  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const body = JSON.parse(text);
      if (body && typeof body.message === "string") message = body.message;
    } catch (_) {}
    throw new Error(message);
  }
  return res.json();
}
