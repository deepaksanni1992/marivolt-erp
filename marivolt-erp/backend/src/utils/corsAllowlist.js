/**
 * S0 — Exact-origin CORS allowlist (no wildcard *.vercel.app in production).
 */

export function parseCorsAllowedOrigins(envValue) {
  return String(envValue || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isProductionNodeEnv(nodeEnv = process.env.NODE_ENV) {
  return String(nodeEnv || "").toLowerCase() === "production";
}

/**
 * Build the effective allowlist.
 * - Always include CORS_ALLOWED_ORIGINS (exact).
 * - Include CLIENT_URL if set (exact, legacy).
 * - Localhost origins only when NOT production.
 */
export function buildCorsAllowlist({
  corsAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS,
  clientUrl = process.env.CLIENT_URL,
  nodeEnv = process.env.NODE_ENV,
} = {}) {
  const exact = new Set(parseCorsAllowedOrigins(corsAllowedOrigins));
  if (clientUrl && String(clientUrl).trim()) {
    exact.add(String(clientUrl).trim());
  }
  if (!isProductionNodeEnv(nodeEnv)) {
    for (const o of [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174",
    ]) {
      exact.add(o);
    }
  }
  return exact;
}

/**
 * Returns true if origin is allowed.
 * Missing Origin (same-origin / server-to-server) is allowed.
 */
export function isCorsOriginAllowed(origin, allowlist) {
  if (!origin) return true;
  return allowlist.has(String(origin));
}

export function createCorsOriginDelegate(options = {}) {
  const allowlist = buildCorsAllowlist(options);
  return function corsOrigin(origin, callback) {
    if (isCorsOriginAllowed(origin, allowlist)) {
      return callback(null, true);
    }
    // Do not log Authorization or cookies — origin only.
    console.warn(`[cors] rejected origin: ${String(origin || "").slice(0, 200)}`);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  };
}
