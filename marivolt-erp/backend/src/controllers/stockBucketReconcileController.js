import {
  diagnoseOrphanedStockBuckets,
  repairOrphanedStockBuckets,
} from "../services/stockBucketReconcileService.js";

function t(v) {
  return String(v ?? "").trim();
}

export async function diagnoseOrphanStockBuckets(req, res) {
  try {
    const article = t(req.query.article).toUpperCase();
    const warehouse = t(req.query.warehouse || "MAIN").toUpperCase();
    if (!article) return res.status(400).json({ message: "article query param required" });
    const diagnosis = await diagnoseOrphanedStockBuckets({
      companyId: req.companyId,
      article,
      warehouse,
    });
    res.json(diagnosis);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
}

export async function repairOrphanStockBuckets(req, res) {
  try {
    const article = t(req.body.article).toUpperCase();
    const warehouse = t(req.body.warehouse || "MAIN").toUpperCase();
    const reason = t(req.body.reason);
    const dryRun = Boolean(req.body.dryRun);
    if (!article) return res.status(400).json({ message: "article required" });
    const result = await repairOrphanedStockBuckets({
      companyId: req.companyId,
      article,
      warehouse,
      reason,
      dryRun,
      req,
      userEmail: req.user?.email || "",
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message });
  }
}
