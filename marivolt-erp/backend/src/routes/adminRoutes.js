/**
 * Admin routes — Phase-10.
 *
 * Mounts:
 *   /api/admin/companies              CRUD
 *   /api/admin/branches               CRUD
 *   /api/admin/warehouses             CRUD
 *   /api/admin/roles                  CRUD + me/permissions
 *   /api/admin/settings               key/value
 *   /api/admin/number-series          configurable numbering
 *   /api/admin/approval-rules         CRUD
 *   /api/admin/approval-requests      list + decide
 *   /api/admin/activity               read-only audit of auth events
 *
 * All routes require ERP access; settings/admin actions also require
 * the legacy super_admin / company_admin / admin role enum so that
 * existing user grants keep working.
 */
import express from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as masters from "../controllers/masterDataController.js";
import * as roles from "../controllers/rolesController.js";
import * as settings from "../controllers/settingsController.js";
import * as approvals from "../controllers/approvalController.js";
import * as activity from "../controllers/userActivityController.js";

const adminRoles = ["super_admin", "company_admin", "admin"];

const router = express.Router();

// /admin/companies endpoints — listing must be reachable without
// `requireCompanyContext` because super_admin uses it before/after
// switching companies. Mutations still require the admin enum.
router.get("/companies", requireAuth, masters.listCompanies);
router.get("/companies/:id", requireAuth, masters.getCompany);
router.post(
  "/companies",
  requireAuth,
  requireRole("super_admin"),
  masters.createCompany
);
router.put(
  "/companies/:id",
  requireAuth,
  requireRole(...adminRoles),
  masters.updateCompany
);

// Everything else lives inside the active company context.
router.use(...requireErpAccess);

// Roles + permissions — `me/permissions` open to all, mutations to admins.
router.get("/me/permissions", roles.getMyPermissions);
router.get("/roles", roles.listRoles);
router.get("/roles/:id", roles.getRole);
router.post("/roles", requireRole(...adminRoles), roles.createRole);
router.put("/roles/:id", requireRole(...adminRoles), roles.updateRole);
router.delete("/roles/:id", requireRole(...adminRoles), roles.deleteRole);

router.get("/branches", masters.listBranches);
router.get("/branches/:id", masters.getBranch);
router.post("/branches", requireRole(...adminRoles), masters.createBranch);
router.put("/branches/:id", requireRole(...adminRoles), masters.updateBranch);
router.delete("/branches/:id", requireRole(...adminRoles), masters.deleteBranch);

router.get("/warehouses", masters.listWarehouses);
router.get("/warehouses/:id", masters.getWarehouse);
router.post("/warehouses", requireRole(...adminRoles), masters.createWarehouse);
router.put("/warehouses/:id", requireRole(...adminRoles), masters.updateWarehouse);
router.delete(
  "/warehouses/:id",
  requireRole(...adminRoles),
  masters.deleteWarehouse
);

router.get("/settings", settings.listSettings);
router.post("/settings", requireRole(...adminRoles), settings.upsertSetting);
router.delete(
  "/settings/:id",
  requireRole(...adminRoles),
  settings.deleteSetting
);

router.get("/number-series", settings.listNumberSeries);
router.post(
  "/number-series",
  requireRole(...adminRoles),
  settings.upsertNumberSeries
);
router.delete(
  "/number-series/:id",
  requireRole(...adminRoles),
  settings.deleteNumberSeries
);

router.get("/approval-rules", approvals.listApprovalRules);
router.post(
  "/approval-rules",
  requireRole(...adminRoles),
  approvals.upsertApprovalRule
);
router.put(
  "/approval-rules/:id",
  requireRole(...adminRoles),
  approvals.upsertApprovalRule
);
router.delete(
  "/approval-rules/:id",
  requireRole(...adminRoles),
  approvals.deleteApprovalRule
);

router.get("/approval-requests", approvals.listApprovalRequests);
router.get("/approval-requests/:id", approvals.getApprovalRequest);
router.patch(
  "/approval-requests/:id/decide",
  requireRole(...adminRoles),
  approvals.decideApprovalRequest
);

router.get("/activity", requireRole(...adminRoles), activity.listUserActivity);

export default router;
