import axios from "axios";

function resolveApiBase() {
  const fromEnv = (
    import.meta.env.VITE_API_BASE_URL ||
    import.meta.env.VITE_API_BASE ||
    ""
  ).trim();
  if (fromEnv) return fromEnv;

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

export const AUTH_KEY = "marivoltz_auth_v1";

function getToken() {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    return auth?.token || null;
  } catch {
    return null;
  }
}

function getActiveCompanyId() {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    return auth?.company?.id || null;
  } catch {
    return null;
  }
}

/** Shared axios instance: base URL includes `/api`, Bearer token on each request. */
export const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const companyId = getActiveCompanyId();
  if (companyId) config.headers["x-company-id"] = companyId;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg =
      err.response?.data?.message ||
      (typeof err.response?.data === "string" ? err.response.data : null) ||
      err.message ||
      "Request failed";
    return Promise.reject(new Error(msg));
  }
);

export function apiGet(path) {
  return api.get(path).then((r) => r.data);
}

export function apiPost(path, body) {
  return api.post(path, body).then((r) => r.data);
}

/** Multipart upload (e.g. Excel). Do not set Content-Type — browser sets boundary. */
export async function apiPostFormData(path, formData) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const url = `${API_BASE}${p}`;
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { method: "POST", headers, body: formData });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text || "Invalid response" };
  }
  if (!res.ok) {
    const msg =
      (typeof body.message === "string" && body.message) ||
      (typeof body.error === "string" && body.error) ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

export function apiPut(path, body) {
  return api.put(path, body).then((r) => r.data);
}

export function apiPatch(path, body) {
  return api.patch(path, body).then((r) => r.data);
}

export function apiDelete(path) {
  return api.delete(path).then((r) => r.data);
}

export function apiGetWithQuery(path, params = {}) {
  return api
    .get(path, {
      params: Object.fromEntries(
        Object.entries(params).filter(
          ([, v]) => v !== undefined && v !== null && v !== ""
        )
      ),
    })
    .then((r) => r.data);
}
