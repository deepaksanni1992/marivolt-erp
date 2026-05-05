import express from "express";
import multer from "multer";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/itemController.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

router.use(...requireErpAccess);

router.get("/facets", c.listItemFacets);
router.get("/", c.listItems);
router.post("/import", upload.single("file"), c.importItems);
router.get("/export", c.exportItems);
router.get("/:article", c.getItem);
router.post("/", c.createItem);
router.put("/:article", c.updateItem);
router.delete("/:article", c.deleteItem);

router.post("/:article/technical", c.createItemTechnical);
router.get("/:article/technical", c.getItemTechnical);
router.put("/:article/technical", c.updateItemTechnical);

router.post("/:article/suppliers", c.createItemSupplier);
router.get("/:article/suppliers", c.listItemSuppliers);
router.put("/:article/suppliers/:id", c.updateItemSupplier);
router.delete("/:article/suppliers/:id", c.deleteItemSupplier);

export default router;
