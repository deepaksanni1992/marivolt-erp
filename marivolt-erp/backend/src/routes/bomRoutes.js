import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/bomController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/", c.listBoms);
router.get("/by-parent/:parentCode", c.getBomByParentCode);
router.get("/:id", c.getBom);
router.post("/", c.createBom);
router.put("/:id", c.updateBom);
router.delete("/:id", c.deleteBom);

export default router;
