/**
 * S0 — Lightweight in-memory rate limiter (no extra npm dependency).
 * Suitable for single-instance Render/Node deploys. Configure via env.
 */

function envInt(name, fallback) {
  const n = parseInt(String(process.env[name] ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeIdentifier(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

function clientIp(req) {
  const xf = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return xf || req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * @param {{ name: string, windowMs: number, max: number, keyFn?: (req)=>string }} opts
 */
export function createRateLimiter(opts) {
  const store = new Map(); // key -> { count, resetAt }
  const name = opts.name || "limit";
  const windowMs = opts.windowMs;
  const max = opts.max;
  const keyFn = opts.keyFn || ((req) => clientIp(req));

  function prune(now) {
    if (store.size < 5000) return;
    for (const [k, v] of store) {
      if (v.resetAt <= now) store.delete(k);
    }
  }

  function middleware(req, res, next) {
    const now = Date.now();
    prune(now);
    const key = `${name}:${keyFn(req)}`;
    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }
    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
    if (entry.count > max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return res.status(429).json({
        message: "Too many requests. Please try again later.",
        code: "RATE_LIMITED",
      });
    }
    return next();
  }

  middleware._store = store;
  middleware._resetForTests = () => store.clear();
  return middleware;
}

export function authRateLimitersFromEnv() {
  const windowMs = envInt("AUTH_RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000);
  return {
    login: createRateLimiter({
      name: "login",
      windowMs,
      max: envInt("AUTH_RATE_LIMIT_LOGIN_MAX", 10),
      keyFn: (req) =>
        `${clientIp(req)}:${normalizeIdentifier(req.body?.email || req.body?.username || "")}`,
    }),
    totp: createRateLimiter({
      name: "totp",
      windowMs,
      max: envInt("AUTH_RATE_LIMIT_TOTP_MAX", 10),
      keyFn: (req) => `${clientIp(req)}:totp:${normalizeIdentifier(req.body?.twoFactorTicket || "").slice(0, 24)}`,
    }),
    selectCompany: createRateLimiter({
      name: "select_company",
      windowMs,
      max: envInt("AUTH_RATE_LIMIT_SELECT_COMPANY_MAX", 30),
      keyFn: (req) => clientIp(req),
    }),
    adminUserCreate: createRateLimiter({
      name: "admin_user_create",
      windowMs: envInt("AUTH_RATE_LIMIT_ADMIN_CREATE_WINDOW_MS", 60 * 60 * 1000),
      max: envInt("AUTH_RATE_LIMIT_ADMIN_CREATE_MAX", 20),
      keyFn: (req) => `${clientIp(req)}:${normalizeIdentifier(req.user?.email || req.user?.id || "")}`,
    }),
  };
}

/** Test helper: consume limiter until just before / after limit. */
export function consumeLimiter(limiter, req, res, times) {
  const results = [];
  for (let i = 0; i < times; i += 1) {
    let status = 200;
    const fakeRes = {
      setHeader() {},
      status(code) {
        status = code;
        return this;
      },
      json() {
        return this;
      },
    };
    let calledNext = false;
    limiter(req, fakeRes, () => {
      calledNext = true;
    });
    results.push({ status: calledNext ? 200 : status, limited: !calledNext });
  }
  return results;
}

export { clientIp, normalizeIdentifier };
