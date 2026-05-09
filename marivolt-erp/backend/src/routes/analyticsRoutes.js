import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import {
  exportAnalyticsSection,
  getAnalyticsDashboard,
  getAnalyticsDrilldown,
} from "../controllers/analyticsController.js";

const router = express.Router();

router.use(...requireErpAccess);

const reportsView = requirePermission("REPORTS", "view");

router.get("/dashboard", reportsView, getAnalyticsDashboard);
router.get("/drilldown/:type", reportsView, getAnalyticsDrilldown);
router.get("/export/:section", reportsView, exportAnalyticsSection);
router.get("/export/sales", reportsView, (req, res) => exportAnalyticsSection({ ...req, params: { section: "sales" } }, res));
router.get("/export/inventory", reportsView, (req, res) => exportAnalyticsSection({ ...req, params: { section: "inventory" } }, res));
router.get("/export/procurement", reportsView, (req, res) => exportAnalyticsSection({ ...req, params: { section: "procurement" } }, res));
router.get("/export/accounts", reportsView, (req, res) => exportAnalyticsSection({ ...req, params: { section: "accounts" } }, res));
router.get("/export/logistics", reportsView, (req, res) => exportAnalyticsSection({ ...req, params: { section: "logistics" } }, res));

export default router;

