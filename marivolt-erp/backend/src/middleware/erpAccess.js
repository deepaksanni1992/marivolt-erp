import { requireAuth, requireCompanyContext, requireRole } from "./auth.js";

/** Any logged-in ERP user (matches User.role enum). */
export const requireErpAccess = [
  requireAuth,
  requireCompanyContext,
  requireRole("super_admin", "company_admin", "admin", "staff", "purchase_sales", "accounts_logistics"),
];
