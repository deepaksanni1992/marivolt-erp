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
import { requirePermission } from "../middleware/permissions.js";
import * as masters from "../controllers/masterDataController.js";
import * as roles from "../controllers/rolesController.js";
import * as settings from "../controllers/settingsController.js";
import * as approvals from "../controllers/approvalController.js";
import * as activity from "../controllers/userActivityController.js";
import * as stockBuckets from "../controllers/stockBucketReconcileController.js";
import * as stockBucketIntegrity from "../controllers/stockBucketIntegrityController.js";

const adminRoles = ["super_admin", "company_admin", "admin"];

const router = express.Router();

// /admin/companies — S0: membership-scoped list/get; admin-only update; super-only create.
// No requireCompanyContext so company switch / settings still work with token company.
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
const settingsView = requirePermission("SETTINGS", "view");
const settingsCreate = requirePermission("SETTINGS", "create");
const settingsEdit = requirePermission("SETTINGS", "edit");
const settingsApprove = requirePermission("SETTINGS", "approve");
const settingsDelete = requirePermission("SETTINGS", "delete");
const auditView = requirePermission("AUDIT", "view");

// Roles + permissions — `me/permissions` open to all, mutations to admins.
router.get("/me/permissions", roles.getMyPermissions);
router.get("/roles", settingsView, roles.listRoles);
router.get("/roles/:id", settingsView, roles.getRole);
router.post("/roles", settingsCreate, requireRole(...adminRoles), roles.createRole);
router.put("/roles/:id", settingsEdit, requireRole(...adminRoles), roles.updateRole);
router.delete("/roles/:id", settingsDelete, requireRole(...adminRoles), roles.deleteRole);

router.get("/branches", settingsView, masters.listBranches);
router.get("/branches/:id", settingsView, masters.getBranch);
router.post("/branches", settingsCreate, requireRole(...adminRoles), masters.createBranch);
router.put("/branches/:id", settingsEdit, requireRole(...adminRoles), masters.updateBranch);
router.delete("/branches/:id", settingsDelete, requireRole(...adminRoles), masters.deleteBranch);

router.get("/warehouses", settingsView, masters.listWarehouses);
router.get("/warehouses/:id", settingsView, masters.getWarehouse);
router.post("/warehouses", settingsCreate, requireRole(...adminRoles), masters.createWarehouse);
router.put("/warehouses/:id", settingsEdit, requireRole(...adminRoles), masters.updateWarehouse);
router.delete(
  "/warehouses/:id",
  settingsDelete,
  requireRole(...adminRoles),
  masters.deleteWarehouse
);

router.get("/settings", settingsView, settings.listSettings);
router.post("/settings", settingsEdit, requireRole(...adminRoles), settings.upsertSetting);
router.delete(
  "/settings/:id",
  settingsDelete,
  requireRole(...adminRoles),
  settings.deleteSetting
);

router.get("/number-series", settingsView, settings.listNumberSeries);
router.post(
  "/number-series",
  settingsEdit,
  requireRole(...adminRoles),
  settings.upsertNumberSeries
);
router.delete(
  "/number-series/:id",
  settingsDelete,
  requireRole(...adminRoles),
  settings.deleteNumberSeries
);

router.get("/approval-rules", settingsView, approvals.listApprovalRules);
router.post(
  "/approval-rules",
  settingsCreate,
  requireRole(...adminRoles),
  approvals.upsertApprovalRule
);
router.put(
  "/approval-rules/:id",
  settingsEdit,
  requireRole(...adminRoles),
  approvals.upsertApprovalRule
);
router.delete(
  "/approval-rules/:id",
  settingsDelete,
  requireRole(...adminRoles),
  approvals.deleteApprovalRule
);

router.get("/approval-requests", settingsView, approvals.listApprovalRequests);
router.get("/approval-requests/:id", settingsView, approvals.getApprovalRequest);
router.patch(
  "/approval-requests/:id/decide",
  settingsApprove,
  requireRole(...adminRoles),
  approvals.decideApprovalRequest
);

router.get("/activity", auditView, requireRole(...adminRoles), activity.listUserActivity);

/** Read-only orphaned reserved/packed diagnosis (admin). Does not mutate. */
router.get(
  "/stock/orphan-buckets",
  settingsView,
  requireRole(...adminRoles),
  stockBuckets.diagnoseOrphanStockBuckets
);
/**
 * Controlled projection repair for orphaned reserved/packed buckets.
 * Body: { article, warehouse?, reason, dryRun? } — never auto-runs.
 */
router.post(
  "/stock/orphan-buckets/repair",
  settingsApprove,
  requireRole(...adminRoles),
  stockBuckets.repairOrphanStockBuckets
);

/** Global stock bucket integrity — read-only scan + dry-run repair preview. */
router.get(
  "/stock/bucket-integrity",
  settingsView,
  requireRole(...adminRoles),
  stockBucketIntegrity.getBucketIntegrity
);
router.post(
  "/stock/bucket-integrity/repair-preview",
  settingsView,
  requireRole(...adminRoles),
  stockBucketIntegrity.postBucketIntegrityRepairPreview
);
router.post(
  "/stock/bucket-integrity/repair",
  settingsApprove,
  requireRole(...adminRoles),
  stockBucketIntegrity.postBucketIntegrityRepair
);

export default router;
