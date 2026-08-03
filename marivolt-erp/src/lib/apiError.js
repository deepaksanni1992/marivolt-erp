/**
 * Shared API error message resolver for user-facing toasts.
 * Never returns [object Object], undefined, null, stack traces, or HTML pages.
 */

function firstString(...candidates) {
  for (const c of candidates) {
    if (typeof c === "string") {
      const t = c.trim();
      if (t) return t;
    }
  }
  return "";
}

function looksLikeHtml(s) {
  return /<\/?[a-z][\s\S]*>/i.test(s) || /<!DOCTYPE/i.test(s);
}

function looksLikeStack(s) {
  return /\n\s+at\s+\S+/m.test(s) || /Error:\s*.+\n\s+at\s+/m.test(s);
}

function fromValidationArray(arr) {
  if (!Array.isArray(arr) || !arr.length) return "";
  const parts = arr
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") {
        return firstString(item.message, item.msg, item.error, item.reason, item.path && `${item.path}: ${item.message || ""}`);
      }
      return "";
    })
    .filter(Boolean);
  return parts.slice(0, 5).join("; ");
}

function statusFallback(status) {
  switch (Number(status) || 0) {
    case 400:
      return "Validation failed.";
    case 401:
      return "Your session has expired. Please sign in again.";
    case 403:
      return "Permission denied.";
    case 404:
      return "Resource not found.";
    case 409:
      return "Conflict — the record was changed or already exists.";
    case 422:
      return "Validation failed.";
    case 429:
      return "Too many requests. Please wait and try again.";
    case 500:
    case 502:
    case 503:
    case 504:
      return "Server error. Please try again.";
    default:
      return "";
  }
}

function networkFallback(err) {
  const code = err?.code || err?.cause?.code || "";
  const msg = String(err?.message || "");
  if (code === "ECONNABORTED" || /timeout/i.test(msg)) return "Request timed out. Please try again.";
  if (code === "ERR_CANCELED" || code === "ERR_ABORTED" || err?.name === "AbortError" || /aborted/i.test(msg)) {
    return "";
  }
  if (!err?.status && !err?.response && (/Network Error/i.test(msg) || code === "ERR_NETWORK")) {
    return "Network unavailable. Check your connection.";
  }
  return "";
}

/**
 * @param {unknown} err
 * @param {string} [fallback]
 * @returns {string}
 */
export function resolveApiErrorMessage(err, fallback = "Request failed") {
  if (err == null) return fallback;

  if (typeof err === "string") {
    const t = err.trim();
    if (!t || looksLikeHtml(t) || looksLikeStack(t)) return fallback;
    return t;
  }

  const status = err.status ?? err.response?.status ?? 0;
  const data = err.body ?? err.response?.data ?? err.data;

  const fromData =
    data == null
      ? ""
      : typeof data === "string"
        ? data.trim()
        : firstString(
            data.message,
            data.error,
            typeof data.error === "object" ? data.error?.message : "",
            fromValidationArray(data.errors),
            fromValidationArray(data.violations),
            fromValidationArray(data.reasons),
            fromValidationArray(data.details)
          );

  const network = networkFallback(err);
  if (network === "" && (err?.code === "ERR_CANCELED" || err?.name === "AbortError")) {
    return ""; // aborted — callers may skip toast
  }

  let msg = firstString(fromData, err.message, network, statusFallback(status), fallback);

  if (looksLikeHtml(msg) || looksLikeStack(msg)) {
    msg = statusFallback(status) || fallback;
  }

  // Avoid leaking auth headers / tokens if somehow embedded
  if (/bearer\s+[a-z0-9._-]+/i.test(msg) || /authorization:\s*/i.test(msg)) {
    msg = statusFallback(status) || fallback;
  }

  if (!msg || msg === "undefined" || msg === "null" || msg === "[object Object]") {
    return statusFallback(status) || fallback;
  }

  return msg;
}

/**
 * Safe display string for alert shim / unknown values.
 */
export function safeNotifyText(value, fallback = "Notification") {
  if (value == null) return fallback;
  if (typeof value === "string") {
    const t = value.trim();
    return t && t !== "[object Object]" ? t : fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return resolveApiErrorMessage(value, fallback);
  if (typeof value === "object") {
    const fromObj = firstString(value.message, value.error, value.title);
    if (fromObj) return fromObj;
    try {
      const json = JSON.stringify(value);
      if (json && json !== "{}" && json.length < 400) return json;
    } catch {
      /* ignore */
    }
  }
  return fallback;
}

export default resolveApiErrorMessage;
