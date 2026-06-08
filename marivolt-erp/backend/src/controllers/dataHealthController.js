import { buildDataHealthDashboard } from "../services/dataHealthService.js";
import { writeAudit } from "../services/auditService.js";
import { hasPermission } from "../services/roleService.js";

export async function getDataHealth(req, res) {
  try {
    const refresh = String(req.query.refresh || "").toLowerCase() === "true";
    const result = await buildDataHealthDashboard(req.companyId, req.companyCode || "", req.query, { refresh });
    writeAudit(req, {
      action: "OTHER",
      module: "REPORTS",
      entityType: "DATA_HEALTH_DASHBOARD",
      documentNo: `HEALTH-${req.companyCode || ""}`,
      description: result.fromCache ? "Data health dashboard viewed (cached)" : "Data health dashboard viewed",
      metadata: {
        healthScore: result.healthScore,
        criticalCount: result.criticalCount,
        majorCount: result.majorCount,
        minorCount: result.minorCount,
        fromCache: !!result.fromCache,
        refresh,
        filters: req.query,
      },
    }).catch(() => {});
    res.json({ enabled: true, ...result });
  } catch (err) {
    res.status(400).json({ message: err.message || "Data health scan failed" });
  }
}

export async function logDataHealthExport(req, res) {
  try {
    const canExport =
      (await hasPermission(req, "REPORTS", "export")) || (await hasPermission(req, "REPORTS", "view"));
    if (!canExport) {
      return res.status(403).json({ message: "Permission denied: REPORTS.export", code: "PERMISSION_DENIED" });
    }
    const format = String(req.body?.format || req.query?.format || "unknown").toLowerCase();
    await writeAudit(req, {
      action: "OTHER",
      module: "REPORTS",
      entityType: "DATA_HEALTH_EXPORT",
      documentNo: `HEALTH-${req.companyCode || ""}`,
      description: `Data health ${format} export`,
      metadata: { format, filters: req.body?.filters || req.query },
    });
    res.json({ ok: true, logged: true });
  } catch (err) {
    res.status(400).json({ message: err.message || "Export log failed" });
  }
}
