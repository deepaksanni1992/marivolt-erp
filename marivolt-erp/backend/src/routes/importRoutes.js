import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/importController.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel" ||
      /\.xlsx?$/i.test(file.originalname || "");
    if (ok) return cb(null, true);
    cb(new Error("Only Excel files (.xlsx, .xls) are allowed"));
  },
});

/**
 * @param {(req: import("express").Request, res: import("express").Response) => unknown} handler
 */
function excelUpload(handler) {
  return (req, res) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        const msg =
          err instanceof multer.MulterError ? err.message : err.message || "Upload failed";
        return res.status(400).json({ message: msg });
      }
      Promise.resolve(handler(req, res)).catch((e) => {
        console.error("[import]", e);
        if (!res.headersSent) {
          res.status(500).json({ message: e?.message || "Import failed" });
        }
      });
    });
  };
}

const router = express.Router();
router.use(...requireErpAccess);

router.post("/items", excelUpload(c.importItems));
router.post("/mappings", excelUpload(c.importMappings));
router.post("/suppliers", excelUpload(c.importSuppliers));

export default router;
