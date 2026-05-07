import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
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

router.post("/", uploadPaymentSlip, c.createPaymentReceipt);
router.get("/", c.listPaymentReceipts);
router.get("/by-proforma/:proformaInvoiceId", c.listPaymentReceiptsByProforma);
router.get("/:id/attachment-url", c.getPaymentReceiptAttachmentUrl);
router.patch("/:id/cancel", c.cancelPaymentReceipt);
router.get("/:id", c.getPaymentReceipt);

export default router;
