import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requireRole } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/manPriceListController.js";
import { MAN_PRICE_LIST_ADMIN_ROLES } from "../utils/manPriceList.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.use(...requireErpAccess);
router.use(requireRole(...MAN_PRICE_LIST_ADMIN_ROLES));
const manageView = requirePermission("PRICE_LIST", "view");
const manageEdit = requirePermission("PRICE_LIST", "edit");
const manageCreate = requirePermission("PRICE_LIST", "create");
const manageExport = requirePermission("PRICE_LIST", "export");

router.get("/", manageView, c.list);
router.get("/template", manageExport, c.template);
router.get("/export", manageExport, c.exportCsv);
router.post("/import/preview", manageCreate, upload.single("file"), c.preview);
router.post("/import/apply", manageEdit, c.apply);
router.get("/:article", manageView, c.getOne);
router.put("/:article", manageEdit, c.upsert);
router.post("/", manageCreate, c.upsert);

export default router;
