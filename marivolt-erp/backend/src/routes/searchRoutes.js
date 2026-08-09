import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requireAnyPermission, denyRoles } from "../middleware/permissions.js";
import * as c from "../controllers/searchController.js";

const router = express.Router();
router.use(...requireErpAccess);
/** Global ERP search is not a Store floor tool — operators stay on Store module. */
router.use(denyRoles("STORE_OPERATOR"));
router.get(
  "/global",
  requireAnyPermission(
    ["REPORTS", "view"],
    ["SALES", "view"],
    ["PURCHASE", "view"],
    ["STORE", "view"],
    ["ACCOUNTS", "view"],
    ["CUSTOMS", "view"],
    ["ITEM_MASTER", "view"]
  ),
  c.getGlobalSearch
);

export default router;
