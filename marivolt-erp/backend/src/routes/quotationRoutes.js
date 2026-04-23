import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/quotationController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/", c.listQuotations);
router.get("/:id/print-data", c.getQuotationPrintData);
router.post("/:id/duplicate", c.duplicateQuotation);
router.get("/:id", c.getQuotation);
router.post("/", c.createQuotation);
router.put("/:id", c.updateQuotation);
router.patch("/:id/status", c.patchQuotationStatus);
router.post("/:id/stock-out", c.stockOutFromQuotation);
router.delete("/:id", c.deleteQuotation);

export default router;
