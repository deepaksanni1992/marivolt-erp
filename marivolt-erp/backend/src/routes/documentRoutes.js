import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { isS3Configured } from "../config/s3.js";
import * as doc from "../controllers/documentController.js";

const router = express.Router();

/** Keep files in RAM only; max 10 MB (aligned with controller validation). */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(...requireErpAccess);

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

router.post("/upload", uploadSingleFile, doc.uploadDocument);
router.get("/", doc.listDocuments);
/** Before /:id — lets the UI show why View/Download may fail on a given server */
router.get("/s3-status", (req, res) => {
  res.json({ s3Configured: isS3Configured() });
});
/** More specific routes before /:id */
router.get("/:id/download", doc.downloadDocument);
router.get("/:id", doc.getDocument);
router.delete("/:id", doc.deleteDocument);

export default router;
