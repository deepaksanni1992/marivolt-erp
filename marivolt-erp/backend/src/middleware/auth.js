import jwt from "jsonwebtoken";

/**
 * requireAuth:
 * - reads Authorization: Bearer <token>
 * - verifies JWT
 * - sets req.user = decoded payload
 */
export function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [type, token] = header.split(" ");

    if (type !== "Bearer" || !token) {
      return res.status(401).json({ message: "Missing token" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // must include role in token payload
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
 * - compares case-insensitively
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