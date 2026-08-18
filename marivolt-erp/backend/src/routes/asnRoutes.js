import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/asnController.js";

const router = express.Router();
router.use(...requireErpAccess);

const asnView = requirePermission("ASN", "view");
const asnCreate = requirePermission("ASN", "create");
const asnEdit = requirePermission("ASN", "edit");
const asnPost = requirePermission("ASN", "post");
const asnCancel = requirePermission("ASN", "cancel");

router.post("/", asnCreate, c.create);
router.get("/", asnView, c.list);
router.get("/:id", asnView, c.getById);
router.patch("/:id", asnEdit, c.patch);
router.post("/:id/ship", asnPost, c.ship);
router.post("/:id/arrive", asnPost, c.arrive);
router.post("/:id/cancel", asnCancel, c.cancel);
router.post("/:id/attachments", asnEdit, c.addAttachment);
router.delete("/:id/attachments/:attachmentId", asnEdit, c.removeAttachment);

export default router;
