import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/itemController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.use(...requireErpAccess);
const itemView = requirePermission("ITEM_MASTER", "view");
const itemCreate = requirePermission("ITEM_MASTER", "create");
const itemEdit = requirePermission("ITEM_MASTER", "edit");
const itemExport = requirePermission("ITEM_MASTER", "export");
const itemDelete = requirePermission("ITEM_MASTER", "delete");

router.get("/facets", itemView, c.listItemFacets);
router.get("/", itemView, c.listItems);
router.post("/import", itemCreate, upload.single("file"), c.importItems);
router.get("/export", itemExport, c.exportItems);
router.get("/:article", itemView, c.getItem);
router.get("/:article/compatibility", itemView, c.getItemCompatibility);
router.post("/", itemCreate, c.createItem);
router.put("/:article", itemEdit, c.updateItem);
router.delete("/:article", itemDelete, c.deleteItem);

router.post("/:article/technical", itemCreate, c.createItemTechnical);
router.get("/:article/technical", itemView, c.getItemTechnical);
router.put("/:article/technical", itemEdit, c.updateItemTechnical);

router.post("/:article/suppliers", itemCreate, c.createItemSupplier);
router.get("/:article/suppliers", itemView, c.listItemSuppliers);
router.put("/:article/suppliers/:id", itemEdit, c.updateItemSupplier);
router.delete("/:article/suppliers/:id", itemDelete, c.deleteItemSupplier);

export default router;
