import jwt from "jsonwebtoken";
import User from "../models/User.js";

/** Safe user projection — never passwordHash / 2FA secrets / tokens. */
export const AUTH_USER_SAFE_SELECT =
  "name email username role roleIds allowedCompanies defaultCompany isActive permissionOverrides";

/**
 * Phase 2: tokenVersion / session revocation is not in this pass.
 * Role changes and deleted users are enforced by reloading the live user
 * on every authenticated request instead.
 */

export async function loadActiveAuthUser(id) {
  if (!id) return null;
  return User.findById(id).select(AUTH_USER_SAFE_SELECT).lean();
}

function allowedCompanyIdList(user) {
  return (user?.allowedCompanies || []).map((x) => String(x)).filter(Boolean);
}

/**
 * Build req.user from a verified JWT payload + live Mongo user.
 * Does not check token company membership — that belongs in
 * requireCompanyContext so /auth/companies and company-switch still work
 * after a company is removed from the user.
 */
export function authorizeDecodedUser(decoded, user) {
  if (!decoded?.id) {
    return { ok: false, status: 401, body: { message: "Invalid token", code: "INVALID_TOKEN" } };
  }
  if (decoded.purpose) {
    return { ok: false, status: 401, body: { message: "Invalid token", code: "INVALID_TOKEN" } };
  }
  if (!user) {
    return { ok: false, status: 401, body: { message: "Invalid token", code: "USER_NOT_FOUND" } };
  }
  if (user.isActive === false) {
    return { ok: false, status: 403, body: { message: "Account disabled", code: "USER_INACTIVE" } };
  }
  const liveRole = String(user.role || "").trim();
  if (!liveRole) {
    return { ok: false, status: 401, body: { message: "Invalid token", code: "INVALID_IDENTITY" } };
  }

  const allowedCompanyIds = allowedCompanyIdList(user);
  return {
    ok: true,
    reqUser: {
      id: String(user._id || decoded.id),
      role: liveRole,
      email: user.email || "",
      username: user.username || "",
      companyId: String(decoded.companyId || "").trim(),
      companyCode: String(decoded.companyCode || "").trim().toUpperCase(),
      allowedCompanyIds,
      roleIds: (user.roleIds || []).map((x) => String(x)),
    },
    authUser: user,
  };
}

/**
 * requireAuth:
 * - reads Authorization: Bearer <token>
 * - verifies JWT
 * - reloads the live user (deleted / inactive sessions fail closed)
 * - sets req.user from the database role, not the stale JWT role
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({ message: "Missing token" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "Invalid token" });
    }

    const loader = typeof req.loadAuthUser === "function" ? req.loadAuthUser : loadActiveAuthUser;
    let user;
    try {
      user = await loader(decoded?.id);
    } catch (err) {
      console.warn("[auth] user lookup failed", err?.message || "unknown error");
      return res.status(401).json({ message: "Invalid token", code: "AUTH_LOOKUP_FAILED" });
    }

    const result = authorizeDecodedUser(decoded, user);
    if (!result.ok) {
      return res.status(result.status).json(result.body);
    }
    req.user = result.reqUser;
    req.authUser = result.authUser;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

/** Ensure request has validated company context from token/header. */
export function requireCompanyContext(req, res, next) {
  const tokenCompanyId = String(req.user?.companyId || "").trim();
  if (!tokenCompanyId) {
    return res.status(403).json({ message: "Company context missing in token" });
  }

  const headerCompanyId = String(req.headers["x-company-id"] || "").trim();
  if (headerCompanyId && headerCompanyId !== tokenCompanyId) {
    return res.status(403).json({ message: "Company mismatch" });
  }

  const allowed = Array.isArray(req.user?.allowedCompanyIds) ? req.user.allowedCompanyIds : [];
  if (!allowed.includes(tokenCompanyId)) {
    return res.status(403).json({
      message: "Company access revoked",
      code: "COMPANY_ACCESS_DENIED",
    });
  }

  req.companyId = tokenCompanyId;
  req.companyCode = String(req.user?.companyCode || "").trim().toUpperCase();
  next();
}

export function scopeToCompany(req, extra = {}) {
  return { ...extra, companyId: req.companyId };
}

/**
 * requireRole:
 * - accepts requireRole("admin") OR requireRole(["admin","manager"]) OR requireRole("admin","manager")
 * - compares case-insensitively against the live database role
 */
export function requireRole(...roles) {
  const allowed = roles
    .flat()
    .map((r) => String(r).toLowerCase().trim())
    .filter(Boolean);

  return (req, res, next) => {
    const userRole = String(req.user?.role || "")
      .toLowerCase()
      .trim();

    if (!userRole) {
      return res.status(403).json({ message: "Forbidden (no role)" });
    }

    if (!allowed.includes(userRole)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    next();
  };
}
