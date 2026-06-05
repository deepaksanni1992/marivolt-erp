import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission, requireAnyPermission } from "../middleware/permissions.js";
import { getS3EnvPresence, isS3Configured } from "../config/s3.js";
import * as doc from "../controllers/documentController.js";

const router = express.Router();

/** Keep files in RAM only; max 10 MB (aligned with controller validation). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(...requireErpAccess);
const reportsView = requirePermission("REPORTS", "view");
const reportsCreate = requirePermission("REPORTS", "create");
const reportsExport = requirePermission("REPORTS", "export");
const reportsDelete = requirePermission("REPORTS", "delete");

/** Multer wrapper: map LIMIT_FILE_SIZE to a clear API message. */
function uploadSingleFile(req, res, next) {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ message: "File exceeds maximum size of 10 MB." });
      }
      return res.status(400).json({ message: err.message || "Upload error" });
    }
    return next(err);
  });
}

router.post(
  "/upload",
  requireAnyPermission(["REPORTS", "create"], ["CUSTOMS", "create"], ["STORE", "create"]),
  uploadSingleFile,
  doc.uploadDocument,
);
router.get("/", reportsView, doc.listDocuments);
router.get("/s3-status", reportsView, (req, res) => {
  res.json({
    s3Configured: isS3Configured(),
    awsEnvPresence: getS3EnvPresence(),
  });
});
router.get(
  "/:id/download",
  requireAnyPermission(["REPORTS", "export"], ["CUSTOMS", "view"], ["STORE", "export"]),
  doc.downloadDocument,
);
router.get("/:id", reportsView, doc.getDocument);
router.delete("/:id", reportsDelete, doc.deleteDocument);

export default router;
