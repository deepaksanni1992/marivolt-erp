import axios from "axios";
import { resolveApiErrorMessage } from "./apiError.js";

/** True when the ERP UI is opened on this machine (any port). Used at runtime in the browser bundle. */
export function isRunningUiOnLocalhost() {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

/** Vite dev (5173/5174) and preview (4173/4174) default ports — same-origin `/api` uses vite.config proxy. */
function isViteDefaultDevOrPreviewPort() {
  if (typeof window === "undefined") return false;
  const port = String(window.location.port || "");
  return ["5173", "5174", "4173", "4174"].includes(port);
}

/**
 * Base origin for the API (no `/api` suffix here; API_BASE adds it).
 *
 * Uses same-origin `/api` when:
 * - `import.meta.env.DEV` (Vite `npm run dev`), or
 * - URL uses Vite default dev/preview ports (e.g. `vite preview` on `http://192.168.x.x:4173` — `DEV` is false but proxy still applies), or
 * - Hostname is localhost / 127.0.0.1 / ::1 (covers default http/https ports with empty `location.port`).
 *
 * That way `backend/.env` applies via the proxy instead of a baked-in Render URL.
 *
 * Set `VITE_USE_REMOTE_API_WHILE_LOCAL=true` only if you intentionally want local UI → remote API.
 *
 * Deployed sites (e.g. *.vercel.app) use `VITE_API_BASE_URL` from the build.
 */
function resolveApiBase() {
  const forceRemoteWhileLocal =
    String(import.meta.env.VITE_USE_REMOTE_API_WHILE_LOCAL || "").trim() === "true";

  if (!forceRemoteWhileLocal) {
    if (import.meta.env.DEV) {
      return "/api";
    }
    if (typeof window !== "undefined") {
      if (isViteDefaultDevOrPreviewPort()) {
        return "/api";
      }
      if (isRunningUiOnLocalhost()) {
        return "/api";
      }
    }
  }

  const fromEnv = (
    import.meta.env.VITE_API_BASE_URL ||
    import.meta.env.VITE_API_BASE ||
    ""
  ).trim();

  if (!fromEnv) {
    return "";
  }
  return fromEnv;
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

/** True when requests go to same-origin `/api` (Vite proxy → local backend), not a full remote URL. */
export function isUsingSameOriginApiProxy() {
  return typeof API_BASE === "string" && API_BASE.startsWith("/");
}

export const AUTH_KEY = "marivoltz_auth_v1";

/**
 * Auth lives in sessionStorage (tab scope). Opening the ERP in a new tab or from a
 * shared link does not inherit another tab’s login. legacy localStorage entries are removed.
 */
if (typeof window !== "undefined") {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    /* ignore */
  }
}

export function loadStoredAuth() {
  if (typeof window === "undefined") return null;
  try {
    return JSON.parse(sessionStorage.getItem(AUTH_KEY) || "null");
  } catch {
    return null;
  }
}

export function persistStoredAuth(next) {
  if (typeof window === "undefined") return;
  try {
    if (next) {
      sessionStorage.setItem(AUTH_KEY, JSON.stringify({ ...next, ts: Date.now() }));
    } else {
      sessionStorage.removeItem(AUTH_KEY);
    }
    localStorage.removeItem(AUTH_KEY);
  } catch {
    /* quota / private mode */
  }
}

function getToken() {
  return loadStoredAuth()?.token || null;
}

function getActiveCompanyId() {
  const id = loadStoredAuth()?.company?.id;
  return id || null;
}

/** Shared axios instance: base URL includes `/api`, Bearer token on each request. */
export const api = axios.create({
  baseURL: API_BASE,
  headers: { "Content-Type": "application/json" },
});

api.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const url = String(config.url || "");
  const isAuthPath =
    url.includes("/auth/login") ||
    url.includes("/auth/2fa/verify-login") ||
    url.includes("/auth/select-company") ||
    url.includes("/auth/switch-company");
  const companyId = getActiveCompanyId();
  if (companyId && !isAuthPath) config.headers["x-company-id"] = companyId;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const msg = resolveApiErrorMessage(err, "Request failed") || "Request failed";
    const wrapped = new Error(msg);
    wrapped.status = err.response?.status || 0;
    if (err.response?.data && typeof err.response.data === "object") {
      if (err.response.data.code) wrapped.code = err.response.data.code;
      if (err.response.data.violations) wrapped.violations = err.response.data.violations;
      if (err.response.data.reasons) wrapped.reasons = err.response.data.reasons;
      if (err.response.data.errors) wrapped.errors = err.response.data.errors;
      if (err.response.data.details) wrapped.details = err.response.data.details;
      if (err.response.data.shortages) wrapped.shortages = err.response.data.shortages;
      wrapped.body = err.response.data;
    }
    if (err.code) wrapped.code = wrapped.code || err.code;
    return Promise.reject(wrapped);
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
  const companyId = getActiveCompanyId();
  if (companyId) headers["x-company-id"] = companyId;

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
      resolveApiErrorMessage(
        { message: body?.message, body, status: res.status, response: { status: res.status, data: body } },
        `Request failed (${res.status})`
      ) || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    if (body?.code) err.code = body.code;
    err.body = body;
    throw err;
  }
  return body;
}

export function apiPut(path, body) {
  return api.put(path, body).then((r) => r.data);
}

export function apiPatch(path, body) {
  return api.patch(path, body).then((r) => r.data);
}

export function apiDelete(path, body) {
  return api.delete(path, body != null ? { data: body } : undefined).then((r) => r.data);
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
