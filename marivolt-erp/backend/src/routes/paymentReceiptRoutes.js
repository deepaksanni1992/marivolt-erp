import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/paymentReceiptController.js";

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

function uploadPaymentSlip(req, res, next) {
  upload.single("attachment")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "Payment slip exceeds 5 MB." });
      }
      return res.status(400).json({ message: err.message || "Upload error" });
    }
    return next(err);
  });
}

router.use(...requireErpAccess);
const accountsView = requirePermission("ACCOUNTS", "view");
const accountsCreate = requirePermission("ACCOUNTS", "create");
const accountsCancel = requirePermission("ACCOUNTS", "cancel");
const accountsExport = requirePermission("ACCOUNTS", "export");

router.post("/", accountsCreate, uploadPaymentSlip, c.createPaymentReceipt);
router.get("/", accountsView, c.listPaymentReceipts);
router.get("/by-proforma/:proformaInvoiceId", accountsView, c.listPaymentReceiptsByProforma);
router.get("/by-sales-invoice/:salesInvoiceId", accountsView, c.listPaymentReceiptsBySalesInvoice);
router.get("/:id/print", accountsExport, c.getPaymentReceiptPrintData);
router.get("/:id/attachment-url", accountsExport, c.getPaymentReceiptAttachmentUrl);
router.patch("/:id/cancel", accountsCancel, c.cancelPaymentReceipt);
router.get("/:id", accountsView, c.getPaymentReceipt);

export default router;
