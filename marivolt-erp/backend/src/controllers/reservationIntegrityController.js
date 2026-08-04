import {
  validateStockBuckets,
  validateAllStock,
  listReservationIntegrityIssues,
  issuesToCsv,
  calculateExpectedReservation,
  calculateExpectedPacked,
  calculateAvailable,
} from "../services/reservationIntegrityService.js";
import {
  diagnoseReservationRepair,
  repairReservationIntegrity,
} from "../services/repairReservationIntegrity.js";

function t(v) {
  return String(v ?? "").trim();
}

function safeMessage(err) {
  const msg = String(err?.message || "Request failed");
  // Never leak Mongo internals / stack fragments to clients
  if (/E11000|MongoServerError|Cast to ObjectId|bson/i.test(msg)) {
    return "Invalid request or data conflict";
  }
  return msg.slice(0, 500);
}

function normalizeArticle(v) {
  const a = t(v).toUpperCase();
  if (!a) return "";
  if (a.length > 64 || !/^[A-Z0-9._\-/#]+$/i.test(a)) {
    const err = new Error("Invalid article");
    err.statusCode = 400;
    throw err;
  }
  return a;
}

function normalizeWarehouse(v, fallback = "") {
  const w = t(v).toUpperCase() || fallback;
  if (!w) return "";
  if (w.length > 32 || !/^[A-Z0-9._\-]+$/i.test(w)) {
    const err = new Error("Invalid warehouse");
    err.statusCode = 400;
    throw err;
  }
  return w;
}

/**
 * GET /api/admin/stock/reservation-integrity
 * Always scoped to the authenticated company (req.companyId).
 */
export async function getReservationIntegrity(req, res) {
  try {
    const includeHealthy =
      String(req.query.includeHealthy || "false").toLowerCase() === "true";
    const status = t(req.query.status) || "OPEN";
    const warehouse = normalizeWarehouse(req.query.warehouse);
    const article = req.query.article ? normalizeArticle(req.query.article) : "";

    const report = await listReservationIntegrityIssues({
      companyId: req.companyId,
      warehouse: warehouse || undefined,
      article: article || undefined,
      issueType: t(req.query.issueType) || undefined,
      severity: t(req.query.severity) || undefined,
      status: status === "ALL" ? "ALL" : status,
      page: Number(req.query.page) || 1,
      limit: Number(req.query.limit) || 100,
    });

    if (
      report.total === 0 &&
      String(req.query.liveScan || "").toLowerCase() === "true"
    ) {
      const live = await validateAllStock({
        companyId: req.companyId,
        warehouse: warehouse || undefined,
        article: article || undefined,
        includeHealthy,
        persist: true,
      });
      const refreshed = await listReservationIntegrityIssues({
        companyId: req.companyId,
        warehouse: warehouse || undefined,
        article: article || undefined,
        issueType: t(req.query.issueType) || undefined,
        severity: t(req.query.severity) || undefined,
        status: status === "ALL" ? "ALL" : status,
        page: Number(req.query.page) || 1,
        limit: Number(req.query.limit) || 100,
      });
      if (String(req.query.format || "").toLowerCase() === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="reservation-integrity.csv"'
        );
        return res.send(issuesToCsv(refreshed.items || []));
      }
      return res.json({ ...refreshed, liveScan: live.summary });
    }

    if (String(req.query.format || "").toLowerCase() === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="reservation-integrity.csv"'
      );
      return res.send(issuesToCsv(report.items || []));
    }
    res.json(report);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: safeMessage(err) });
  }
}

/**
 * POST /api/admin/stock/reservation-integrity/validate
 */
export async function postReservationIntegrityValidate(req, res) {
  try {
    const body = req.body || {};
    const warehouse = normalizeWarehouse(body.warehouse || req.query.warehouse, "MAIN");
    const articleRaw = t(body.article || req.query.article);
    const article = articleRaw ? normalizeArticle(articleRaw) : "";

    if (body.all === true || String(body.all).toLowerCase() === "true") {
      const report = await validateAllStock({
        companyId: req.companyId,
        warehouse: t(body.warehouse) ? warehouse : undefined,
        article: article || undefined,
        includeHealthy: Boolean(body.includeHealthy),
        persist: true,
      });
      return res.json(report);
    }

    if (!article) {
      return res.status(400).json({ message: "article is required unless all=true" });
    }

    const row = await validateStockBuckets(req.companyId, warehouse || "MAIN", article, {
      persist: true,
    });
    res.json(row);
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: safeMessage(err) });
  }
}

/**
 * GET /api/admin/stock/reservation-integrity/article/:article
 */
export async function getReservationIntegrityArticle(req, res) {
  try {
    const article = normalizeArticle(req.params.article);
    const warehouse = normalizeWarehouse(req.query.warehouse, "MAIN") || "MAIN";
    const [reserved, packed, available, validated] = await Promise.all([
      calculateExpectedReservation(req.companyId, warehouse, article),
      calculateExpectedPacked(req.companyId, warehouse, article),
      calculateAvailable(req.companyId, warehouse, article),
      validateStockBuckets(req.companyId, warehouse, article, { persist: false }),
    ]);
    res.json({ reserved, packed, available, validated });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: safeMessage(err) });
  }
}

/**
 * POST /api/admin/stock/reservation-integrity/repair-diagnose
 * Dry-run diagnose only — always uses authenticated company.
 */
export async function postReservationIntegrityRepairDiagnose(req, res) {
  try {
    const body = req.body || {};
    const article = normalizeArticle(body.article);
    const warehouse = normalizeWarehouse(body.warehouse, "MAIN") || "MAIN";
    const result = await diagnoseReservationRepair({
      companyId: req.companyId,
      warehouse,
      article,
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: safeMessage(err) });
  }
}

/**
 * POST /api/admin/stock/reservation-integrity/repair
 * Requires body.apply === true. Always scoped to authenticated company.
 */
export async function postReservationIntegrityRepair(req, res) {
  try {
    const body = req.body || {};
    if (body.apply !== true && String(body.apply).toLowerCase() !== "true") {
      return res.status(400).json({
        message: "Repair requires explicit apply:true. Use repair-diagnose for dry-run.",
      });
    }
    const article = normalizeArticle(body.article);
    const warehouse = normalizeWarehouse(body.warehouse, "MAIN") || "MAIN";
    const repairedBy =
      req.user?.email || req.user?.name || req.userEmail || "admin-api";
    const result = await repairReservationIntegrity({
      companyId: req.companyId,
      warehouse,
      article,
      apply: true,
      repairedBy,
      reason: t(body.reason),
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: safeMessage(err) });
  }
}
