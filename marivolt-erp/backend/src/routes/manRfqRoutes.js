import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requireAllPermissions } from "../middleware/permissions.js";
import * as c from "../controllers/manRfqController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.use(...requireErpAccess);
const manRfqAccess = requireAllPermissions(["SALES", "create"], ["MAN_ENGINE", "create"]);

router.get("/models", manRfqAccess, c.listModels);
router.get("/items/:article", manRfqAccess, c.itemSnapshot);
router.post("/match", manRfqAccess, upload.single("file"), c.match);
router.post("/availability", manRfqAccess, c.availability);
router.post("/quotations", manRfqAccess, c.createQuotation);

export default router;
