import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/purchaseReturnController.js";

const router = express.Router();

router.use(...requireErpAccess);

router.get("/", c.listPurchaseReturns);
router.get("/:id", c.getPurchaseReturn);
router.post("/", c.createPurchaseReturn);
router.put("/:id", c.updatePurchaseReturn);
router.post("/:id/post", c.postPurchaseReturn);
router.delete("/:id", c.deletePurchaseReturn);

export default router;
