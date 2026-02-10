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
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
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