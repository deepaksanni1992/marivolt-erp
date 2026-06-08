import { buildArticleTraceability } from "../services/articleTraceabilityService.js";
import { hasPermission } from "../services/roleService.js";

export async function getArticleTraceability(req, res) {
  try {
    const result = await buildArticleTraceability(req, req.query);
    res.json({
      enabled: true,
      companyCode: req.companyCode || "",
      ...result,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || "Traceability lookup failed" });
  }
}

export async function getArticleTraceabilityExportMeta(req, res) {
  try {
    const canExport =
      (await hasPermission(req, "TRACEABILITY", "article_export")) ||
      (await hasPermission(req, "TRACEABILITY", "export"));
    res.json({ canExport });
  } catch (err) {
    res.status(400).json({ message: err.message || "Export check failed" });
  }
}
