import express from "express";
import { requireErpAccess } from "../middleware/erpAccess.js";
import { requirePermission } from "../middleware/permissions.js";
import * as c from "../controllers/articleConversionController.js";

const router = express.Router();
router.use(...requireErpAccess);

const view = requirePermission("ARTICLE_CONVERSION", "view");
const create = requirePermission("ARTICLE_CONVERSION", "create");
const approve = requirePermission("ARTICLE_CONVERSION", "approve");
const post = requirePermission("ARTICLE_CONVERSION", "post");
const reverse = requirePermission("ARTICLE_CONVERSION", "reverse");
const admin = requirePermission("ARTICLE_CONVERSION", "admin");
const removeOrCreate = async (req, res, next) => {
  try {
    const { hasPermission, normaliseRoleCode } = await import("../services/roleService.js");
    const role = normaliseRoleCode(req.user?.role || "");
    if (role === "SUPER_ADMIN") return next();
    if (
      (await hasPermission(req, "ARTICLE_CONVERSION", "delete")) ||
      (await hasPermission(req, "ARTICLE_CONVERSION", "create")) ||
      (await hasPermission(req, "ARTICLE_CONVERSION", "admin"))
    ) {
      return next();
    }
    return res.status(403).json({
      message: "Permission denied: ARTICLE_CONVERSION.delete",
      code: "PERMISSION_DENIED",
    });
  } catch {
    return res.status(403).json({ message: "Permission check failed", code: "PERMISSION_DENIED" });
  }
};

// Fall back: STORE.approve may post when ARTICLE_CONVERSION.post not granted — handled in controller for unmapped.
// Routes require ARTICLE_CONVERSION permissions; SUPER_ADMIN / ADMIN defaults include all.

router.get("/meta", view, c.articleConversionMeta);
router.get("/", view, c.listArticleConversions);
router.get("/article-context", view, c.getConversionArticleContext);
router.get("/mappings", view, c.listEquivalenceMappings);
router.post("/mappings", create, c.createEquivalenceMapping);
router.post("/mappings/:id/approve", approve, c.approveEquivalenceMapping);
router.post("/mappings/:id/deactivate", admin, c.deactivateEquivalenceMapping);
router.get("/:id", view, c.getArticleConversion);
router.post("/", create, c.createArticleConversionDraft);
router.post("/:id/approve", approve, c.approveArticleConversion);
router.post("/:id/post", post, c.postArticleConversion);
router.post("/:id/reverse", reverse, c.reverseArticleConversionDoc);
router.post("/:id/cancel", create, c.cancelArticleConversionDraft);
router.delete("/:id", removeOrCreate, c.deleteArticleConversion);

export default router;
