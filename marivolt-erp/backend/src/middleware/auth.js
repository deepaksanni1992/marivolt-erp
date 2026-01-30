import jwt from "jsonwebtoken";

export function requireRole(roles = []) {
    return (req, res, next) => {
      if (!req.user) {
        return res.status(401).json({ message: "Unauthorized" });
      }
  
      // normalize (case-insensitive)
      const userRole = String(req.user.role || "").toLowerCase();
      const allowedRoles = roles.map(r => String(r).toLowerCase());
  
      // ❗ block ONLY if role is NOT allowed
      if (allowedRoles.length && !allowedRoles.includes(userRole)) {
        return res.status(403).json({ message: "Forbidden" });
      }
  
      next();
    };
  }
  