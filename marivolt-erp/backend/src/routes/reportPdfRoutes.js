import { Router } from "express";
import express from "express";
import { requireAuth, requireCompanyContext } from "../middleware/auth.js";
import { requireAnyPermission } from "../middleware/permissions.js";
import { postReportPdf } from "../controllers/reportPdfController.js";

const router = Router();

/**
 * HTML→PDF helper used by report / picking-sheet UIs.
 * Must not be auth-only: require a real module view/export permission.
 * STORE.view|export allows Store operators to print GRN / picking sheets.
 */
router.post(
  "/pdf",
  express.json({ limit: "12mb" }),
  requireAuth,
  requireCompanyContext,
  requireAnyPermission(
    ["REPORTS", "view"],
    ["REPORTS", "export"],
    ["SALES", "view"],
    ["PURCHASE", "view"],
    ["STORE", "view"],
    ["STORE", "export"],
    ["ACCOUNTS", "view"],
    ["CUSTOMS", "view"],
    ["SETTINGS", "view"]
  ),
  postReportPdf
);

export default router;
