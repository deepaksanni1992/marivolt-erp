import {
  runStockBucketIntegrityAudit,
  previewBucketIntegrityRepair,
  applyBucketIntegrityRepair,
  auditRowsToCsv,
} from "../services/stockBucketIntegrityService.js";

function t(v) {
  return String(v ?? "").trim();
}

/**
 * GET /api/admin/stock/bucket-integrity — read-only global diagnostic.
 */
export async function getBucketIntegrity(req, res) {
  try {
    const includeHealthy =
      String(req.query.includeHealthy || "false").toLowerCase() === "true";
    const mismatchTypes = t(req.query.mismatchType || req.query.mismatchTypes)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const report = await runStockBucketIntegrityAudit({
      companyId: req.query.company ? undefined : req.companyId,
      companyCode: t(req.query.company || req.query.companyCode) || undefined,
      warehouse: t(req.query.warehouse || req.query.warehouseCode) || undefined,
      article: t(req.query.article).toUpperCase() || undefined,
      status: t(req.query.status) || undefined,
      mismatchTypes: mismatchTypes.length ? mismatchTypes : null,
      includeHealthy,
      limit: Number(req.query.limit) || 200,
      page: Number(req.query.page) || 1,
    });
    if (String(req.query.format || "").toLowerCase() === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="stock-bucket-integrity.csv"'
      );
      return res.send(auditRowsToCsv(report.rows || []));
    }
    res.json(report);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
}

/**
 * POST /api/admin/stock/bucket-integrity/repair-preview — dry-run only.
 */
export async function postBucketIntegrityRepairPreview(req, res) {
  try {
    const body = req.body || {};
    const result = await previewBucketIntegrityRepair({
      companyId: body.companyCode ? undefined : req.companyId,
      companyCode: t(body.companyCode) || undefined,
      warehouseCode: t(body.warehouseCode || body.warehouse) || undefined,
      mismatchTypes: Array.isArray(body.mismatchTypes) ? body.mismatchTypes : undefined,
      articles: Array.isArray(body.articles) ? body.articles : [],
      maxRows: body.maxRows,
      reason: t(body.reason),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message });
  }
}

/**
 * POST /api/admin/stock/bucket-integrity/repair
 * Requires STOCK_BUCKET_BULK_REPAIR_ENABLED=true + prior preview token.
 */
export async function postBucketIntegrityRepair(req, res) {
  try {
    const body = req.body || {};
    const result = await applyBucketIntegrityRepair({
      previewToken: t(body.previewToken || body.previewId),
      reason: t(body.reason),
      dryRun: Boolean(body.dryRun),
      maxRows: body.maxRows,
      req,
      userEmail: req.user?.email || "",
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({
      message: err.message,
      code: err.code || undefined,
      mutated: false,
    });
  }
}
