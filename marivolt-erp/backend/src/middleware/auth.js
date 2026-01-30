import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return res.status(401).json({ message: "Missing token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, role, email }
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
}

export function requireRole(roles = []) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Unauthorized" });

    const userRole = String(req.user.role || "").toLowerCase();
    const allowedRoles = roles.map((r) => String(r).toLowerCase());

    if (allowedRoles.length && !allowedRoles.includes(userRole)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    next();
  };
}
