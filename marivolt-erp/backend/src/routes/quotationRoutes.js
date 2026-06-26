import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/quotationController.js";

const router = express.Router();

router.use(...requireErpAccess);
const salesView = requirePermission("SALES", "view");
const salesCreate = requirePermission("SALES", "create");
const salesEdit = requirePermission("SALES", "edit");
const salesApprove = requirePermission("SALES", "approve");
const salesExport = requirePermission("SALES", "export");
const salesDelete = requirePermission("SALES", "delete");

router.get("/", salesView, c.listQuotations);
router.get("/search-for-oa", salesView, c.searchQuotationsForOA);
router.get("/facets", salesView, c.getQuotationFacets);
router.get("/next-number", salesCreate, c.getNextQuotationNumber);
router.get("/:id/consumption", salesView, c.getQuotationConsumption);
router.get("/:id/oa-source", salesView, c.getQuotationOaSource);
router.get("/:id/print-data", salesExport, c.getQuotationPrintData);
router.post("/:id/duplicate", salesCreate, c.duplicateQuotation);
router.get("/:id", salesView, c.getQuotation);
router.post("/", salesCreate, c.createQuotation);
router.put("/:id", salesEdit, c.updateQuotation);
router.patch("/:id/status", salesApprove, c.patchQuotationStatus);
router.post("/:id/stock-out", salesApprove, c.stockOutFromQuotation);
router.delete("/:id", salesDelete, c.deleteQuotation);

export default router;
