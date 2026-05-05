import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/grnController.js";

const router = express.Router();
router.use(...requireErpAccess);

router.post("/", c.createGrn);
router.get("/", c.listGrn);
router.get("/:grnNo", c.getGrn);
router.put("/:grnNo", c.updateGrn);
router.post("/:grnNo/post", c.postGrn);
router.post("/:grnNo/cancel", c.cancelGrn);

export default router;
