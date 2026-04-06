import { requireAuth, requireRole } from "./auth.js";

/** Any logged-in ERP user (matches User.role enum). */
export const requireErpAccess = [
  requireAuth,
  requireRole("admin", "staff", "purchase_sales", "accounts_logistics"),
];
