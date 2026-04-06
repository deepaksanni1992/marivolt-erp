import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/itemController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/facets", c.listItemFacets);
router.get("/", c.listItems);
router.post("/import", c.importItems);
router.get("/full/:article", c.getItemFullByArticle);
router.get("/by-code/:code", c.getItemByCode);
router.get("/:id", c.getItem);
router.post("/", c.createItem);
router.put("/:id", c.updateItem);
router.delete("/:id", c.deleteItem);

export default router;
