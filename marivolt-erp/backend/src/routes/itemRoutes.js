import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requireRole } from "../middleware/auth.js";
import { requirePermission, requireAllPermissions } from "../middleware/permissions.js";
import * as c from "../controllers/itemController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.use(...requireErpAccess);
const itemView = requirePermission("ITEM_MASTER", "view");
const itemCreate = requirePermission("ITEM_MASTER", "create");
const itemEdit = requirePermission("ITEM_MASTER", "edit");
const itemExport = requirePermission("ITEM_MASTER", "export");
const itemDelete = requirePermission("ITEM_MASTER", "delete");
const itemImport = requireAllPermissions(["ITEM_MASTER", "create"], ["ITEM_MASTER", "edit"]);
/** Live User.role only — custom-role matrices cannot bypass this. */
const itemMasterAdmin = requireRole("super_admin", "admin");

router.get("/facets", itemView, c.listItemFacets);
router.get("/", itemView, c.listItems);
router.get("/resolve", itemView, c.resolveItemByTechnicalLookup);
router.post("/resolve", itemView, c.resolveItemByTechnicalLookup);
router.post("/resolve/bulk-import", itemView, upload.single("file"), c.bulkResolveItemLookup);
router.post("/resolve/override", itemMasterAdmin, itemEdit, c.recordResolutionOverride);
router.get("/import/template", itemView, c.downloadItemImportTemplate);
router.post("/import/preview", itemMasterAdmin, itemImport, upload.single("file"), c.previewItemImport);
router.post("/import/apply", itemMasterAdmin, itemImport, upload.single("file"), c.applyItemImport);
router.post("/import", itemMasterAdmin, itemImport, upload.single("file"), c.applyItemImport);
router.get("/export", itemExport, c.exportItems);
router.get("/:article", itemView, c.getItem);
router.get("/:article/compatibility", itemView, c.getItemCompatibility);
router.post("/", itemMasterAdmin, itemCreate, c.createItem);
router.put("/:article", itemMasterAdmin, itemEdit, c.updateItem);
router.delete("/:article", itemMasterAdmin, itemDelete, c.deleteItem);

router.post("/:article/technical", itemMasterAdmin, itemCreate, c.createItemTechnical);
router.get("/:article/technical", itemView, c.getItemTechnical);
router.put("/:article/technical", itemMasterAdmin, itemEdit, c.updateItemTechnical);
router.post("/:article/technical/alternates", itemMasterAdmin, itemEdit, c.addItemAlternate);
router.post("/:article/technical/alternates/remove", itemMasterAdmin, itemEdit, c.removeItemAlternate);
router.post("/:article/technical/alternates/promote", itemMasterAdmin, itemEdit, c.promoteItemAlternate);
router.post("/:article/technical/alternates/status", itemMasterAdmin, itemEdit, c.setItemAlternateStatus);

router.post("/:article/suppliers", itemMasterAdmin, itemCreate, c.createItemSupplier);
router.get("/:article/suppliers", itemView, c.listItemSuppliers);
router.put("/:article/suppliers/:id", itemMasterAdmin, itemEdit, c.updateItemSupplier);
router.delete("/:article/suppliers/:id", itemMasterAdmin, itemDelete, c.deleteItemSupplier);

export default router;
