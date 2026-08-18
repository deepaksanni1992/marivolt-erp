import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission, requireAllPermissions } from "../middleware/permissions.js";
import * as c from "../controllers/asnController.js";
import * as ru from "../controllers/receivingUnitController.js";

const router = express.Router();
router.use(...requireErpAccess);

const asnView = requirePermission("ASN", "view");
const asnCreate = requirePermission("ASN", "create");
const asnEdit = requirePermission("ASN", "edit");
const asnPost = requirePermission("ASN", "post");
const asnCancel = requirePermission("ASN", "cancel");
const asnLabelPrint = requireAllPermissions(["ASN", "view"], ["LABELS", "print"]);
const asnLabelReprint = requireAllPermissions(["ASN", "view"], ["LABELS", "reprint"]);
const asnLabelView = requireAllPermissions(["ASN", "view"], ["LABELS", "view"]);

router.post("/", asnCreate, c.create);
router.get("/", asnView, c.list);
router.get("/:id/receiving-units", asnView, ru.listForAsn);
router.post("/:id/receiving-units/plan", asnLabelPrint, ru.plan);
router.post("/:id/receiving-units/preview", asnLabelView, ru.preview);
router.post("/:id/receiving-units/print", asnLabelPrint, ru.print);
router.post("/:id/receiving-units/:ruId/reprint", asnLabelReprint, ru.reprint);
router.get("/:id", asnView, c.getById);
router.patch("/:id", asnEdit, c.patch);
router.post("/:id/ship", asnPost, c.ship);
router.post("/:id/arrive", asnPost, c.arrive);
router.post("/:id/cancel", asnCancel, c.cancel);
router.post("/:id/attachments", asnEdit, c.addAttachment);
router.delete("/:id/attachments/:attachmentId", asnEdit, c.removeAttachment);

export default router;
