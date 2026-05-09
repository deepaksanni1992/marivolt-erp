import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/bomController.js";

const router = express.Router();

router.use(...requireErpAccess);
const itemView = requirePermission("ITEM_MASTER", "view");
const itemCreate = requirePermission("ITEM_MASTER", "create");
const itemEdit = requirePermission("ITEM_MASTER", "edit");
const itemDelete = requirePermission("ITEM_MASTER", "delete");

router.get("/", itemView, c.listBoms);
router.get("/reports/summary", itemView, c.bomSummaryReport);
router.get("/by-parent/:parentCode", itemView, c.getBomByParentCode);
router.get("/:id", itemView, c.getBom);
router.post("/", itemCreate, c.createBom);
router.put("/:id", itemEdit, c.updateBom);
router.delete("/:id", itemDelete, c.deleteBom);

export default router;
