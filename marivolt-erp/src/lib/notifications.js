/**
 * Imperative notification API — safe to call from components, libs, and non-React code.
 * ToastProvider registers the handlers; until mounted, messages queue briefly.
 *
 * Optional opts:
 * - duration: ms (0 = persistent until dismissed)
 * - title: string
 * - dedupeKey: string — suppress identical key within dedupeWindowMs
 * - dedupeWindowMs: number (default 1500)
 * - replace: boolean — replace an existing toast with the same dedupeKey
 */

import { resolveApiErrorMessage, safeNotifyText } from "./apiError.js";

const DEFAULT_DURATION = {
  success: 3500,
  error: 5000,
  warning: 5000,
  info: 4000,
};

const DEFAULT_DEDUPE_MS = 1500;

let toastHandler = null;
let confirmHandler = null;
const pendingToasts = [];
/** @type {Map<string, number>} */
const recentDedupe = new Map();

function emit(toast) {
  if (typeof toastHandler === "function") {
    toastHandler(toast);
    return;
  }
  pendingToasts.push(toast);
  if (pendingToasts.length > 40) pendingToasts.shift();
}

export function registerToastHandler(fn) {
  toastHandler = fn;
  if (fn && pendingToasts.length) {
    const queued = pendingToasts.splice(0, pendingToasts.length);
    queued.forEach((t) => fn(t));
  }
  return () => {
    if (toastHandler === fn) toastHandler = null;
  };
}

export function registerConfirmHandler(fn) {
  confirmHandler = fn;
  return () => {
    if (confirmHandler === fn) confirmHandler = null;
  };
}

function pruneDedupe(now) {
  for (const [k, ts] of recentDedupe) {
    if (now - ts > 10_000) recentDedupe.delete(k);
  }
}

function shouldDedupe(key, windowMs, now) {
  if (!key) return false;
  pruneDedupe(now);
  const prev = recentDedupe.get(key);
  if (prev != null && now - prev < windowMs) return true;
  recentDedupe.set(key, now);
  return false;
}

function push(type, message, opts = {}) {
  const text = safeNotifyText(message, "Notification");
  const now = Date.now();
  const dedupeKey =
    opts.dedupeKey ||
    (opts.dedupe === false ? "" : `${type}:${text}`);
  const windowMs = opts.dedupeWindowMs ?? DEFAULT_DEDUPE_MS;

  if (!opts.replace && shouldDedupe(dedupeKey, windowMs, now)) {
    return null;
  }

  if (opts.replace && dedupeKey) {
    recentDedupe.set(dedupeKey, now);
  }

  const toast = {
    id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
    type,
    message: text,
    duration: opts.duration === 0 ? 0 : opts.duration ?? DEFAULT_DURATION[type] ?? 4000,
    title: opts.title || "",
    dedupeKey: dedupeKey || undefined,
    replace: Boolean(opts.replace),
  };
  emit(toast);
  return toast.id;
}

export const notify = {
  success(message, opts) {
    return push("success", message, opts);
  },
  error(message, opts) {
    return push("error", message, opts);
  },
  warning(message, opts) {
    return push("warning", message, opts);
  },
  info(message, opts) {
    return push("info", message, opts);
  },
  /**
   * @param {'success'|'error'|'warning'|'info'} type
   */
  show(type, message, opts) {
    const fn = notify[type] || notify.info;
    return fn(message, opts);
  },
  /**
   * Normalize API/network errors into a single error toast.
   * Uses dedupeKey so parallel 401s do not storm.
   */
  fromError(err, opts = {}) {
    const message = resolveApiErrorMessage(err, opts.fallback || "Request failed");
    if (!message) return null; // aborted
    const status = err?.status ?? err?.response?.status ?? 0;
    const dedupeKey =
      opts.dedupeKey ||
      (status === 401
        ? "auth:session-expired"
        : status === 403
          ? "auth:permission-denied"
          : undefined);
    return notify.error(message, { ...opts, dedupeKey, dedupeWindowMs: opts.dedupeWindowMs ?? 4000 });
  },
};

/**
 * Promise-based confirmation dialog (replaces window.confirm).
 * @returns {Promise<boolean>}
 */
export function confirmDialog(options = {}) {
  const opts =
    typeof options === "string"
      ? { message: options }
      : options || {};
  const text = `${opts.title || ""} ${opts.message || ""}`;
  const danger =
    opts.danger ??
    /\b(delete|cancel|reverse|archive|remove|destroy|void|disable)\b/i.test(text);
  const normalized = {
    title: opts.title || (danger ? "Confirm action" : "Confirm"),
    message: opts.message || "Are you sure?",
    confirmLabel: opts.confirmLabel || "Yes",
    cancelLabel: opts.cancelLabel || "No",
    danger,
  };
  if (typeof confirmHandler === "function") {
    return confirmHandler(normalized);
  }
  // Fallback before provider mounts (should be rare)
  return Promise.resolve(window.confirm(normalized.message || normalized.title));
}

/** Convenience aliases matching ERP action language */
export const toastSuccess = (m, o) => notify.success(m, o);
export const toastError = (m, o) => notify.error(m, o);
export const toastWarning = (m, o) => notify.warning(m, o);
export const toastInfo = (m, o) => notify.info(m, o);

export { resolveApiErrorMessage, safeNotifyText } from "./apiError.js";

export default notify;
