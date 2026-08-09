import { requireAuth, requireCompanyContext, requireRole } from "./auth.js";
import { USER_ROLES } from "../utils/authAdminPolicy.js";

/**
 * Any logged-in ERP user with a recognised User.role enum value.
 * Phase-10 roles (sales/purchase/store/store_operator/…) must be included
 * here or permission matrices never get evaluated (403 at the gate).
 */
export const requireErpAccess = [
  requireAuth,
  requireCompanyContext,
  requireRole(...USER_ROLES),
];
