import { isCustomsEnabled } from "../config/customsConfig.js";
import CustomsLot from "../models/CustomsLot.js";
import CustomsMovement from "../models/CustomsMovement.js";
import { hasPermission } from "../services/roleService.js";
import {
  customsWithCompanyId,
  listCustomsLedgerPage,
  listCustomsStockPage,
} from "../services/customsService.js";
import {
  getCustomsReconciliationDetail,
  listCustomsReconciliationPage,
} from "../services/customsReconciliationService.js";
import { buildCustomsDashboard } from "../services/customsDashboardService.js";
import { writeAudit } from "../services/auditService.js";
import * as allocReports from "../services/customsAllocationReportsService.js";

function disabled(res) {
  return res.status(404).json({
    message: "Customs module is disabled. Set CUSTOMS_ENABLED=true to enable.",
    enabled: false,
  });
}

function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const exportAll = String(req.query.exportAll || "").toLowerCase() === "true";
  const cap = exportAll ? 5000 : 200;
  const limit = Math.min(cap, Math.max(1, Number(req.query.limit) || 50));
  return { page, limit, skip: (page - 1) * limit, maxLimit: cap };
}

function stockFilters(req) {
  return {
    search: req.query.search,
    articleNumber: req.query.articleNumber,
    partNumber: req.query.partNumber,
    status: req.query.status,
    supplier: req.query.supplier,
    countryOfOrigin: req.query.countryOfOrigin || req.query.coo,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    companyCode: req.query.companyCode,
  };
}

function ledgerFilters(req) {
  return {
    search: req.query.search,
    articleNumber: req.query.articleNumber || req.query.article,
    partNumber: req.query.partNumber,
    supplier: req.query.supplier,
    boeNumber: req.query.boeNumber || req.query.boe,
    blNumber: req.query.blNumber || req.query.bl,
    awbNumber: req.query.awbNumber || req.query.awb,
    movementType: req.query.movementType,
    referenceType: req.query.referenceType,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  };
}

export async function getCustomsLedger(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const paging = parsePaging(req);
    const result = await listCustomsLedgerPage(req.companyId, ledgerFilters(req), paging);
    res.json({
      enabled: true,
      companyCode: req.companyCode || "",
      ...result,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load customs ledger" });
  }
}

export async function getCustomsStock(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const paging = parsePaging(req);
    const result = await listCustomsStockPage(req.companyId, stockFilters(req), paging);
    res.json({
      enabled: true,
      companyCode: req.companyCode || "",
      ...result,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load customs stock" });
  }
}

export async function listCustomsLots(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const { page, limit, skip } = parsePaging(req);
    const filter = customsWithCompanyId(req.companyId, {});
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.search) {
      const s = String(req.query.search).trim();
      filter.$or = [
        { customsLotRef: new RegExp(s, "i") },
        { grnNo: new RegExp(s, "i") },
        { boeNumber: new RegExp(s, "i") },
        { blNumber: new RegExp(s, "i") },
        { awbNumber: new RegExp(s, "i") },
        { supplierInvoiceNumber: new RegExp(s, "i") },
      ];
    }
    const [items, total] = await Promise.all([
      CustomsLot.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CustomsLot.countDocuments(filter),
    ]);
    res.json({ enabled: true, items, total, page, limit });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load customs lots" });
  }
}

export async function listCustomsMovements(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const { page, limit, skip } = parsePaging(req);
    const filter = customsWithCompanyId(req.companyId, {});
    if (req.query.movementType) {
      filter.movementType = String(req.query.movementType).toUpperCase();
    }
    if (req.query.referenceNumber) {
      filter.referenceNumber = new RegExp(String(req.query.referenceNumber).trim(), "i");
    }
    const [items, total] = await Promise.all([
      CustomsMovement.find(filter).sort({ movementDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      CustomsMovement.countDocuments(filter),
    ]);
    res.json({ enabled: true, items, total, page, limit });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load customs movements" });
  }
}

function reconciliationFilters(req) {
  return {
    search: req.query.search,
    article: req.query.article || req.query.articleNumber,
    partNumber: req.query.partNumber,
    supplier: req.query.supplier,
    boe: req.query.boe || req.query.boeNumber,
    bl: req.query.bl || req.query.blNumber,
    awb: req.query.awb || req.query.awbNumber,
    status: req.query.status,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    onlyMismatches: req.query.onlyMismatches || req.query.onlyMismatch,
  };
}

export async function getCustomsReconciliation(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const exportAll = String(req.query.exportAll || "").toLowerCase() === "true";
    if (exportAll) {
      const canExport =
        (await hasPermission(req, "CUSTOMS", "reconciliation_export")) ||
        (await hasPermission(req, "CUSTOMS", "reconcile")) ||
        (await hasPermission(req, "CUSTOMS", "export"));
      if (!canExport) {
        return res.status(403).json({
          message: "Permission denied: CUSTOMS.reconciliation_export",
          code: "PERMISSION_DENIED",
        });
      }
    }
    const paging = parsePaging(req);
    const result = await listCustomsReconciliationPage(
      req.companyId,
      req.companyCode || "",
      reconciliationFilters(req),
      paging,
    );
    res.json({
      enabled: true,
      companyCode: req.companyCode || "",
      ...result,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to build reconciliation" });
  }
}

export async function getCustomsReconciliationDetailHandler(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const article = req.query.article || req.query.articleNumber;
    const partNumber = req.query.partNumber || "";
    const detail = await getCustomsReconciliationDetail(req.companyId, article, partNumber);
    res.json({ enabled: true, ...detail });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load reconciliation detail" });
  }
}

export async function getCustomsStatus(req, res) {
  res.json({ enabled: isCustomsEnabled() });
}

function dashboardFilters(req) {
  return {
    article: req.query.article || req.query.articleNumber,
    supplier: req.query.supplier,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
  };
}

export async function getCustomsDashboard(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const result = await buildCustomsDashboard(req.companyId, req.companyCode || "", dashboardFilters(req));
    res.json({
      enabled: true,
      companyCode: req.companyCode || "",
      ...result,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load customs dashboard" });
  }
}

export async function logCustomsDashboardExport(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const canExport =
      (await hasPermission(req, "CUSTOMS", "export")) ||
      (await hasPermission(req, "CUSTOMS", "reconciliation_export")) ||
      (await hasPermission(req, "CUSTOMS", "reconcile"));
    if (!canExport) {
      return res.status(403).json({
        message: "Permission denied: CUSTOMS.export",
        code: "PERMISSION_DENIED",
      });
    }
    const format = String(req.body?.format || req.query?.format || "unknown").toLowerCase();
    await writeAudit(req, {
      action: "OTHER",
      module: "CUSTOMS",
      entityType: "CUSTOMS_DASHBOARD",
      documentNo: `DASHBOARD-${req.companyCode || ""}`,
      description: `Customs dashboard ${format} export`,
      metadata: {
        format,
        filters: req.body?.filters || dashboardFilters(req),
        companyCode: req.companyCode || "",
      },
    });
    res.json({ ok: true, logged: true });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to log export" });
  }
}

export async function getBoeBalanceReport(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const result = await allocReports.reportBoeBalance(req.companyId, {
      search: req.query.search,
      articleNumber: req.query.articleNumber || req.query.article,
    });
    res.json({ enabled: true, ...result });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load BOE balance" });
  }
}

export async function getLotBalanceReport(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const result = await allocReports.reportLotBalance(req.companyId, {
      search: req.query.search,
      status: req.query.status,
    });
    res.json({ enabled: true, ...result });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load lot balance" });
  }
}

export async function getConsumptionReport(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const result = await allocReports.reportCustomsConsumption(req.companyId, {
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      articleNumber: req.query.articleNumber || req.query.article,
    });
    res.json({ enabled: true, ...result });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load consumption report" });
  }
}

export async function getTraceabilityReport(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const result = await allocReports.reportCustomsTraceability(req.companyId, {
      articleNumber: req.query.articleNumber || req.query.article,
      boeNumber: req.query.boeNumber || req.query.boe,
    });
    res.json({ enabled: true, ...result });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load traceability report" });
  }
}
