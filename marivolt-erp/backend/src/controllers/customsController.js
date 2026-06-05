import { isCustomsEnabled } from "../config/customsConfig.js";
import CustomsLot from "../models/CustomsLot.js";
import CustomsMovement from "../models/CustomsMovement.js";
import {
  buildCustomsReconciliation,
  customsWithCompanyId,
  listCustomsLedgerPage,
  listCustomsStockPage,
} from "../services/customsService.js";

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

export async function getCustomsReconciliation(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const rows = await buildCustomsReconciliation(req.companyId);
    const mismatches = rows.filter((r) => r.actionRequired);
    res.json({
      enabled: true,
      items: rows,
      total: rows.length,
      mismatchCount: mismatches.length,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to build reconciliation" });
  }
}

export async function getCustomsStatus(req, res) {
  res.json({ enabled: isCustomsEnabled() });
}
