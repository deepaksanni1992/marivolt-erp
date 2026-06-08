import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import * as c from "../controllers/searchController.js";

const router = express.Router();
router.use(...requireErpAccess);

router.get("/global", c.getGlobalSearch);

export default router;
