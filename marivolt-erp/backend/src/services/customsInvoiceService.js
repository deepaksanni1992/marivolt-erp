import mongoose from "mongoose";
import CustomsInvoice from "../models/CustomsInvoice.js";
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import SalesInvoice from "../models/SalesInvoice.js";
import {
  allocateCustomsStockFIFO,
  createCustomsMovement,
  customsWithCompanyId,
  isCustomsEnabled,
  resolveMovementCustomsValueSnapshot,
} from "./customsService.js";
import { nextCustomsInvoiceNumber } from "./customsNumberService.js";
import { hasPermission } from "./roleService.js";
import { writeAudit } from "./auditService.js";
import {
  compareSalesVsBoeCustomsUnit,
  roundCustomsMoney,
  resolveValuationMethod,
} from "../utils/customsBoeAverage.js";

/** Default: any negative variance triggers warning / reason requirement. */
const CUSTOMS_LOW_VALUE_WARNING_PERCENT = Number(
  process.env.CUSTOMS_LOW_VALUE_WARNING_PERCENT ?? 0,
);

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

/** Issued document (S1) or legacy issued-like statuses before migration. */
const ELIGIBLE_SALES_INVOICE_STATUSES = new Set(["ISSUED", "DISPATCHED", "PARTIALLY_PAID", "PAID"]);
function isEligibleSalesInvoice(inv) {
  if (String(inv?.documentStatus || "").toUpperCase() === "ISSUED") return true;
  if (String(inv?.documentStatus || "").toUpperCase() === "CANCELLED") return false;
  return ELIGIBLE_SALES_INVOICE_STATUSES.has(String(inv?.status || "").toUpperCase());
}

export function isSalesInvoiceEligibleForCustoms(invoice) {
  return isEligibleSalesInvoice(invoice);
}

async function userCanOverride(req) {
  return hasPermission(req, "CUSTOMS", "override");
}

async function loadSalesInvoice(companyId, salesInvoiceId) {
  if (!mongoose.Types.ObjectId.isValid(String(salesInvoiceId))) {
    throw new Error("Invalid sales invoice id");
  }
  const inv = await SalesInvoice.findOne(customsWithCompanyId(companyId, { _id: salesInvoiceId })).lean();
  if (!inv) throw new Error("Sales invoice not found");
  if (!isSalesInvoiceEligibleForCustoms(inv)) {
    throw new Error(`Sales invoice must be issued/posted (status: ${inv.status})`);
  }
  return inv;
}

async function assertNoActiveCustomsInvoice(companyId, salesInvoiceId, excludeId = null) {
  const filter = customsWithCompanyId(companyId, {
    salesInvoiceId,
    status: { $ne: "CANCELLED" },
  });
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = await CustomsInvoice.findOne(filter).select("_id customsInvoiceNumber status").lean();
  if (existing) {
    throw new Error(
      `Sales invoice already has customs invoice ${existing.customsInvoiceNumber} (${existing.status})`,
    );
  }
}

async function loadLotMaps(lotItemIds) {
  const ids = [...new Set(lotItemIds.filter(Boolean))];
  if (!ids.length) return { lotMap: new Map(), itemMap: new Map() };

  const items = await CustomsLotItem.find({ _id: { $in: ids } }).lean();
  const lotIds = [...new Set(items.map((i) => String(i.customsLotId)))];
  const lots = lotIds.length
    ? await CustomsLot.find({ _id: { $in: lotIds } })
        .select(
          "supplierName documents boeNumber boeDate blNumber awbNumber supplierInvoiceNumber supplierInvoiceDate receivedDate countryOfOrigin currency exchangeRateToAED status companyId valuationMethod customsUnitValue boeDeclaredQty boeDeclaredValue"
        )
        .lean()
    : [];

  return {
    itemMap: new Map(items.map((i) => [String(i._id), i])),
    lotMap: new Map(lots.map((l) => [String(l._id), l])),
  };
}

function buildAllocationRecord({ item, lot, qty, mode, override = {}, remainingAfter = null }) {
  const valuationMethod = resolveValuationMethod(
    item?.valuationMethod || lot?.valuationMethod || override.valuationMethod,
  );
  // Frozen BOE / lot unit value is authoritative for real stock; dummy may supply override.
  const frozenUnit =
    Number(item?.customsUnitValue ?? item?.unitPrice ?? lot?.customsUnitValue ?? lot?.customsUnitPrice) || 0;
  const unitPrice =
    mode === "OVERRIDE_DUMMY"
      ? Number(override.unitPrice ?? override.customsUnitValue ?? frozenUnit) || 0
      : frozenUnit || Number(override.unitPrice) || 0;
  const unitWeightKg =
    Number(override.unitWeightKg ?? override.weightKg ?? item?.unitWeightKg ?? item?.weightKg) || 0;
  const q = Number(qty) || 0;
  const docs = lot?.documents || {};
  const documentLinks = [docs.blDocumentId, docs.supplierInvoiceDocumentId].filter(Boolean);
  const fx =
    Number(override.exchangeRateToAED ?? item?.exchangeRateToAED ?? lot?.exchangeRateToAED) || 0;

  let totalValue;
  if (item && mode !== "OVERRIDE_DUMMY") {
    const snap = resolveMovementCustomsValueSnapshot({ item, qty: q });
    totalValue = snap.customsValue != null ? snap.customsValue : roundCustomsMoney(q * unitPrice);
  } else {
    totalValue = roundCustomsMoney(q * unitPrice);
  }
  const totalWeightKg = q * unitWeightKg;
  const customsValueAED = fx > 0 ? roundCustomsMoney(totalValue * fx) : Number(item?.customsValueAED) || 0;

  return {
    customsLotItemId: item?._id || null,
    customsLotId: item?.customsLotId || lot?._id || null,
    qty: q,
    remainingAfter: remainingAfter == null ? null : Number(remainingAfter),
    boeNumber: t(override.boeNumber || item?.boeNumber || lot?.boeNumber),
    boeDate: override.boeDate || item?.boeDate || lot?.boeDate || null,
    blNumber: t(override.blNumber || item?.blNumber || lot?.blNumber),
    awbNumber: t(override.awbNumber || item?.awbNumber || lot?.awbNumber),
    supplierInvoiceNumber: t(
      override.supplierInvoiceNumber || item?.supplierInvoiceNumber || lot?.supplierInvoiceNumber,
    ),
    supplierInvoiceDate:
      override.supplierInvoiceDate || item?.supplierInvoiceDate || lot?.supplierInvoiceDate || null,
    receivedDate: override.receivedDate || item?.receivedDate || lot?.receivedDate || null,
    supplierName: t(override.supplierName || lot?.supplierName),
    countryOfOrigin: upper(override.countryOfOrigin || item?.countryOfOrigin || lot?.countryOfOrigin),
    hsCode: upper(override.hsCode || item?.hsCode),
    currency: upper(override.currency || item?.currency || lot?.currency || "USD"),
    unitPrice,
    customsUnitValue: unitPrice,
    valuationMethod: mode === "OVERRIDE_DUMMY" ? valuationMethod || "" : valuationMethod,
    weightKg: unitWeightKg,
    unitWeightKg,
    totalWeightKg,
    totalValue,
    exchangeRateToAED: fx,
    customsValueAED,
    allocationMode: mode,
    overrideReason: t(override.overrideReason),
    documentLinks,
  };
}

function resolveSalesLinePriceSnapshot(salesInvoice, line) {
  const salesUnitPrice = Number(line?.price) || 0;
  const salesCurrency = upper(salesInvoice?.currency || "");
  // No document-level FX on Sales Invoice today — AED conversion only when currency is AED.
  const salesUnitPriceAed = salesCurrency === "AED" ? salesUnitPrice : null;
  return { salesUnitPrice, salesCurrency, salesUnitPriceAed };
}

function enrichLineWithRisk(line, salesInvoice, salesLine) {
  const salesSnap = resolveSalesLinePriceSnapshot(salesInvoice, salesLine || {});
  const riskRows = (line.allocations || []).map((a) => {
    const cmp = compareSalesVsBoeCustomsUnit({
      salesUnitPrice: salesSnap.salesUnitPrice,
      salesCurrency: salesSnap.salesCurrency,
      salesUnitPriceAed: salesSnap.salesUnitPriceAed,
      boeCustomsUnitValue: Number(a.customsUnitValue ?? a.unitPrice) || 0,
      boeCurrency: a.currency,
      boeExchangeRateToAed: a.exchangeRateToAED,
    });
    return {
      ...cmp,
      allocationId: a._id,
      boeNumber: a.boeNumber,
      customsUnitValue: Number(a.customsUnitValue ?? a.unitPrice) || 0,
      salesUnitPrice: salesSnap.salesUnitPrice,
      salesCurrency: salesSnap.salesCurrency,
    };
  });
  const hasWarning = riskRows.some((r) => r.comparable && r.warning);
  const needsReason =
    hasWarning &&
    riskRows.some((r) => {
      if (!r.comparable || !r.warning) return false;
      const pct = Math.abs(Number(r.variancePct) || 0);
      return pct >= CUSTOMS_LOW_VALUE_WARNING_PERCENT;
    });
  return {
    ...line,
    ...salesSnap,
    riskComparison: riskRows,
    customsValueRisk: hasWarning,
    customsValueRiskRequiresReason: needsReason,
  };
}

function collectRiskRequiresReason(items = []) {
  return items.some((line) => line.customsValueRiskRequiresReason);
}

function assertManualAllocationAllowed({ item, lot, qty, companyId }) {
  const take = Number(qty) || 0;
  if (take < 0) throw new Error("Allocated quantity cannot be negative");
  if (take <= 0) throw new Error("Allocated quantity must be greater than zero");
  if (!item) throw new Error("Customs lot item not found for allocation");

  if (String(item.companyId) !== String(companyId)) {
    throw new Error("Cannot allocate customs stock from another company");
  }
  if (lot && String(lot.companyId) !== String(companyId)) {
    throw new Error("Cannot allocate customs lot from another company");
  }

  const lotStatus = String(lot?.status || "").toUpperCase();
  const itemStatus = String(item.status || "").toUpperCase();
  if (lotStatus === "CANCELLED" || itemStatus === "CANCELLED") {
    throw new Error("Cannot allocate from a cancelled customs lot");
  }
  if (lotStatus === "CLOSED") {
    throw new Error("Cannot allocate from a closed customs lot");
  }

  // Manual BOE override may choose which lots, but never exceed remaining qty.
  const available = Number(item.qtyAvailable) || 0;
  if (take > available + 1e-6) {
    throw new Error(
      `Allocated qty cannot exceed remaining qty for ${item.articleNumber} (need ${take}, remaining ${available})`,
    );
  }
}

async function fifoAllocateLine({ companyId, articleNumber, partNumber, qty, session }) {
  if (partNumber) {
    try {
      return await allocateCustomsStockFIFO({
        companyId,
        articleNumber,
        qty,
        partNumber,
        session,
      });
    } catch {
      /* retry article-only */
    }
  }
  return allocateCustomsStockFIFO({
    companyId,
    articleNumber,
    qty,
    partNumber: "",
    session,
  });
}

function mapFifoToAllocations(fifoRows, lotMap, itemMap) {
  return fifoRows.map(({ qty, item, customsLotItemId, remainingAfter }) => {
    const lot = lotMap.get(String(item?.customsLotId)) || lotMap.get(String(item?.customsLotId?._id));
    const lotItem = itemMap.get(String(customsLotItemId || item?._id)) || item;
    return buildAllocationRecord({
      item: lotItem,
      lot,
      qty,
      mode: "AUTO_FIFO",
      remainingAfter,
    });
  });
}

async function buildItemsFromSalesInvoice(salesInvoice, { companyId, session, allowOverride, overrideLines }) {
  const overrideMap = new Map();
  for (const row of overrideLines || []) {
    const key = String(row.salesInvoiceLineId || row.lineId || "");
    if (key) overrideMap.set(key, row);
  }

  const items = [];
  const warnings = [];
  for (const line of salesInvoice.lines || []) {
    const lineId = line._id;
    const qtyExported = Number(line.qty) || 0;
    if (qtyExported <= 0) continue;

    const articleNumber = upper(line.article);
    const partNumber = upper(line.partNumber);
    const overrideRow = overrideMap.get(String(lineId));

    let allocations = [];
    if (overrideRow?.allocations?.length) {
      if (!allowOverride && overrideRow.allocations.some((a) => (a.allocationMode || "") === "OVERRIDE_DUMMY" || a.overrideReason)) {
        throw new Error("Manual BOE override / dummy allocation requires CUSTOMS.override (BOE Override) permission");
      }
      const lotItemIds = overrideRow.allocations.map((a) => a.customsLotItemId).filter(Boolean);
      const { lotMap, itemMap } = await loadLotMaps(lotItemIds);
      for (const alloc of overrideRow.allocations) {
        const mode = alloc.allocationMode || (alloc.overrideReason ? "OVERRIDE_DUMMY" : "MANUAL");
        if (mode === "OVERRIDE_DUMMY" || !alloc.customsLotItemId) {
          if (!allowOverride) {
            throw new Error("Override allocation requires CUSTOMS.override (BOE Override) permission");
          }
          allocations.push(
            buildAllocationRecord({
              item: null,
              lot: null,
              qty: Number(alloc.qty) || 0,
              mode: "OVERRIDE_DUMMY",
              override: alloc,
            }),
          );
          continue;
        }
        const item = itemMap.get(String(alloc.customsLotItemId));
        const lot = lotMap.get(String(item?.customsLotId));
        const take = Number(alloc.qty) || 0;
        assertManualAllocationAllowed({ item, lot, qty: take, companyId });
        const remainingAfter = Math.max(0, (Number(item.qtyAvailable) || 0) - take);
        allocations.push(
          buildAllocationRecord({
            item,
            lot,
            qty: take,
            mode: "MANUAL",
            override: alloc,
            remainingAfter,
          }),
        );
      }
    } else {
      try {
        const fifo = await fifoAllocateLine({
          companyId,
          articleNumber,
          partNumber,
          qty: qtyExported,
          session,
        });
        const lotItemIds = fifo.map((f) => f.customsLotItemId);
        const { lotMap, itemMap } = await loadLotMaps(lotItemIds);
        allocations = mapFifoToAllocations(fifo, lotMap, itemMap);
        if (allocations.length > 1) {
          warnings.push({
            articleNumber,
            message: `Split across ${allocations.length} BOE lots (FIFO)`,
          });
        }
      } catch (err) {
        if (!allowOverride) throw err;
        warnings.push({
          articleNumber,
          message: err.message || "Insufficient customs stock — using override placeholder",
        });
        allocations = [
          buildAllocationRecord({
            item: null,
            lot: null,
            qty: qtyExported,
            mode: "OVERRIDE_DUMMY",
            override: { overrideReason: overrideRow?.overrideReason || "Override — insufficient customs stock" },
          }),
        ];
      }
    }

    const allocSum = allocations.reduce((s, a) => s + (Number(a.qty) || 0), 0);
    if (Math.abs(allocSum - qtyExported) > 1e-6) {
      throw new Error(
        `Allocations for article ${articleNumber} must total ${qtyExported} (got ${allocSum})`,
      );
    }

    items.push({
      salesInvoiceLineId: lineId,
      articleNumber,
      partNumber,
      partName: line.description || "",
      description: line.description || "",
      qtyExported,
      ...resolveSalesLinePriceSnapshot(salesInvoice, line),
      allocations,
    });
  }

  return {
    items: items.map((line) => {
      const salesLine = (salesInvoice.lines || []).find(
        (l) => String(l._id) === String(line.salesInvoiceLineId),
      );
      return enrichLineWithRisk(line, salesInvoice, salesLine);
    }),
    warnings,
  };
}

export async function listAvailableCustomsLots(companyId, { articleNumber, partNumber = "" } = {}) {
  if (!articleNumber) throw new Error("articleNumber is required");

  const { getAvailableCustomsLots } = await import("./customsService.js");
  const items = await getAvailableCustomsLots({
    companyId,
    articleNumber,
    partNumber,
    limit: 500,
  });

  const lotIds = [...new Set(items.map((i) => String(i.customsLotId)))];
  const lots = lotIds.length
    ? await CustomsLot.find({ _id: { $in: lotIds } })
        .select(
          "supplierName supplierInvoiceNumber supplierInvoiceDate receivedDate countryOfOrigin documents boeNumber boeDate blNumber awbNumber exchangeRateToAED status"
        )
        .lean()
    : [];
  const lotMap = new Map(lots.map((l) => [String(l._id), l]));

  return items.map((item) => {
    const lot = lotMap.get(String(item.customsLotId)) || {};
    return {
      customsLotItemId: item._id,
      customsLotId: item.customsLotId,
      boeNumber: item.boeNumber || lot.boeNumber || "",
      boeDate: item.boeDate || lot.boeDate || null,
      blNumber: item.blNumber || lot.blNumber || "",
      awbNumber: item.awbNumber || lot.awbNumber || "",
      supplierInvoiceNumber: item.supplierInvoiceNumber || lot.supplierInvoiceNumber || "",
      supplierInvoiceDate: item.supplierInvoiceDate || lot.supplierInvoiceDate || null,
      receivedDate: item.receivedDate || lot.receivedDate || null,
      supplierName: lot.supplierName || "",
      qtyImported: item.qtyImported,
      qtyAvailable: item.qtyAvailable,
      countryOfOrigin: item.countryOfOrigin || lot.countryOfOrigin || "",
      hsCode: item.hsCode || "",
      unitPrice: item.unitPrice || 0,
      customsUnitValue: Number(item.customsUnitValue ?? item.unitPrice) || 0,
      valuationMethod: item.valuationMethod || "",
      unitWeightKg: item.unitWeightKg || item.weightKg || 0,
      exchangeRateToAED: item.exchangeRateToAED || lot.exchangeRateToAED || 0,
      articleNumber: item.articleNumber,
      partNumber: item.partNumber,
      documents: lot.documents || {},
      status: item.status,
      lotStatus: lot.status || "",
    };
  });
}

/** Preview FIFO/manual allocation without creating a draft (CG2). */
export async function previewCustomsAllocationFromSalesInvoice(req, salesInvoiceId, body = {}) {
  if (!isCustomsEnabled()) throw new Error("Customs module is disabled");

  const salesInvoice = await loadSalesInvoice(req.companyId, salesInvoiceId);
  const existing = await CustomsInvoice.findOne(
    customsWithCompanyId(req.companyId, { salesInvoiceId, status: { $ne: "CANCELLED" } }),
  )
    .select("_id customsInvoiceNumber status")
    .lean();

  const allowOverride = await userCanOverride(req);
  const { items, warnings } = await buildItemsFromSalesInvoice(salesInvoice, {
    companyId: req.companyId,
    session: null,
    allowOverride,
    overrideLines: body.items,
  });

  const previewLines = items.map((line) => ({
    articleNumber: line.articleNumber,
    partNumber: line.partNumber,
    description: line.description,
    requestedQty: line.qtyExported,
    salesUnitPrice: line.salesUnitPrice,
    salesCurrency: line.salesCurrency,
    customsValueRisk: line.customsValueRisk,
    customsValueRiskRequiresReason: line.customsValueRiskRequiresReason,
    riskComparison: line.riskComparison,
    allocatedBoeCount: line.allocations.length,
    allocations: line.allocations.map((a) => ({
      boeNumber: a.boeNumber,
      boeDate: a.boeDate,
      allocatedQty: a.qty,
      remainingAfter: a.remainingAfter,
      supplierInvoiceNumber: a.supplierInvoiceNumber,
      supplierInvoiceDate: a.supplierInvoiceDate,
      countryOfOrigin: a.countryOfOrigin,
      hsCode: a.hsCode,
      unitPrice: a.unitPrice,
      customsUnitValue: a.customsUnitValue,
      valuationMethod: a.valuationMethod,
      totalValue: a.totalValue,
      currency: a.currency,
      customsValueAED: a.customsValueAED,
      unitWeightKg: a.unitWeightKg,
      totalWeightKg: a.totalWeightKg,
      allocationMode: a.allocationMode,
      customsLotItemId: a.customsLotItemId,
    })),
    customsValue: line.allocations.reduce((s, a) => s + (Number(a.totalValue) || 0), 0),
    customsValueAED: line.allocations.reduce((s, a) => s + (Number(a.customsValueAED) || 0), 0),
    totalWeightKg: line.allocations.reduce((s, a) => s + (Number(a.totalWeightKg) || 0), 0),
  }));

  return {
    salesInvoiceId: salesInvoice._id,
    salesInvoiceNumber: salesInvoice.invoiceNo || salesInvoice.invoiceNumber,
    customerName: salesInvoice.customerName || "",
    existingCustomsInvoice: existing || null,
    canOverride: allowOverride,
    warnings,
    customsValueRiskRequiresReason: collectRiskRequiresReason(items),
    lines: previewLines,
    totals: {
      requestedQty: previewLines.reduce((s, l) => s + (Number(l.requestedQty) || 0), 0),
      customsValue: previewLines.reduce((s, l) => s + (Number(l.customsValue) || 0), 0),
      customsValueAED: previewLines.reduce((s, l) => s + (Number(l.customsValueAED) || 0), 0),
      totalWeightKg: previewLines.reduce((s, l) => s + (Number(l.totalWeightKg) || 0), 0),
    },
  };
}

export async function createCustomsInvoiceFromSalesInvoice(req, salesInvoiceId, body = {}) {
  if (!isCustomsEnabled()) throw new Error("Customs module is disabled");

  const salesInvoice = await loadSalesInvoice(req.companyId, salesInvoiceId);
  await assertNoActiveCustomsInvoice(req.companyId, salesInvoiceId);

  const allowOverride = await userCanOverride(req);
  const { items } = await buildItemsFromSalesInvoice(salesInvoice, {
    companyId: req.companyId,
    session: null,
    allowOverride,
    overrideLines: body.items,
  });

  const customsInvoiceNumber = await nextCustomsInvoiceNumber({
    companyId: req.companyId,
    companyCode: req.companyCode,
  });

  const [doc] = await CustomsInvoice.create([
    {
      companyId: req.companyId,
      companyCode: upper(req.companyCode || "CMP"),
      customsInvoiceNumber,
      salesInvoiceId: salesInvoice._id,
      salesInvoiceNumber: salesInvoice.invoiceNo || salesInvoice.invoiceNumber,
      customerName: salesInvoice.customerName || "",
      invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : new Date(),
      status: "DRAFT",
      remarks: t(body.remarks),
      customsValueRiskReason: t(body.customsValueRiskReason),
      items,
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    },
  ]);

  await writeAudit(req, {
    action: "CREATE",
    module: "CUSTOMS",
    entityType: "CUSTOMS_INVOICE",
    entityId: doc._id,
    documentNo: doc.customsInvoiceNumber,
    description: `Customs invoice ${doc.customsInvoiceNumber} created from sales invoice ${doc.salesInvoiceNumber}`,
    metadata: { salesInvoiceId: salesInvoice._id, allocation: "AUTO_FIFO" },
  });

  return doc.toObject();
}

export async function updateCustomsInvoiceDraft(req, customsInvoiceId, body = {}) {
  if (!isCustomsEnabled()) throw new Error("Customs module is disabled");
  if (!mongoose.Types.ObjectId.isValid(String(customsInvoiceId))) throw new Error("Invalid customs invoice id");

  const doc = await CustomsInvoice.findOne(
    customsWithCompanyId(req.companyId, { _id: customsInvoiceId }),
  );
  if (!doc) throw new Error("Customs invoice not found");
  if (doc.status !== "DRAFT") throw new Error("Only DRAFT customs invoices can be edited");

  const salesInvoice = await loadSalesInvoice(req.companyId, doc.salesInvoiceId);
  const allowOverride = await userCanOverride(req);

  if (Array.isArray(body.items) && body.items.length) {
    const built = await buildItemsFromSalesInvoice(salesInvoice, {
      companyId: req.companyId,
      session: null,
      allowOverride,
      overrideLines: body.items,
    });
    doc.items = built.items;
  }

  if (body.remarks != null) doc.remarks = t(body.remarks);
  if (body.customsValueRiskReason != null) doc.customsValueRiskReason = t(body.customsValueRiskReason);
  if (body.invoiceDate) doc.invoiceDate = new Date(body.invoiceDate);
  doc.updatedBy = req.user?.email || "";
  await doc.save();

  await writeAudit(req, {
    action: "UPDATE",
    module: "CUSTOMS",
    entityType: "CUSTOMS_INVOICE",
    entityId: doc._id,
    documentNo: doc.customsInvoiceNumber,
    description: `Customs invoice ${doc.customsInvoiceNumber} updated (manual/override allocation)`,
    metadata: { manual: true, boeOverride: allowOverride },
  });

  return doc.toObject();
}

function deriveItemStatus(qtyAvailable, qtyImported) {
  if (qtyAvailable <= 0.000001) return "CONSUMED";
  if (qtyAvailable + 0.000001 < qtyImported) return "PARTIAL";
  return "IN_STOCK";
}

function deriveLotStatusFromItems(items = []) {
  if (!items.length) return "OPEN";
  const active = items.filter((i) => String(i.status) !== "CANCELLED");
  if (!active.length) return "CANCELLED";
  if (active.every((i) => Number(i.qtyAvailable) <= 0.000001)) return "CONSUMED";
  if (active.some((i) => Number(i.qtyConsumed) > 0)) return "PARTIAL";
  return "OPEN";
}

async function refreshCustomsLotStatus(companyId, customsLotId, session) {
  if (!customsLotId) return;
  const lot = await CustomsLot.findOne(customsWithCompanyId(companyId, { _id: customsLotId })).session(
    session,
  );
  if (!lot || String(lot.status).toUpperCase() === "CANCELLED") return;
  const items = await CustomsLotItem.find(
    customsWithCompanyId(companyId, { customsLotId, status: { $ne: "CANCELLED" } }),
  )
    .select("qtyAvailable qtyConsumed status")
    .session(session)
    .lean();
  lot.status = deriveLotStatusFromItems(items);
  await lot.save({ session });
}

export async function finalizeCustomsInvoice(req, customsInvoiceId, body = {}) {
  if (!isCustomsEnabled()) throw new Error("Customs module is disabled");

  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const doc = await CustomsInvoice.findOne(
        customsWithCompanyId(req.companyId, { _id: customsInvoiceId }),
      ).session(session);
      if (!doc) throw new Error("Customs invoice not found");
      // Idempotent: already posted
      if (doc.status === "POSTED") {
        result = doc.toObject();
        return;
      }
      if (doc.status !== "DRAFT") throw new Error("Only DRAFT customs invoices can be finalized");

      // Recompute risk from stored snapshots + sales invoice; require reason when below BOE.
      const salesInvoice = doc.salesInvoiceId
        ? await SalesInvoice.findOne(customsWithCompanyId(req.companyId, { _id: doc.salesInvoiceId }))
            .session(session)
            .lean()
        : null;
      const riskItems = (doc.items || []).map((line) => {
        const salesLine = (salesInvoice?.lines || []).find(
          (l) => String(l._id) === String(line.salesInvoiceLineId),
        );
        return enrichLineWithRisk(line.toObject?.() || line, salesInvoice || {}, salesLine);
      });
      if (collectRiskRequiresReason(riskItems) && !t(doc.customsValueRiskReason || body?.customsValueRiskReason)) {
        throw new Error(
          "Sales price is below BOE Customs Unit Value on one or more lines. Provide customsValueRiskReason before finalization (internal risk note only).",
        );
      }
      if (body?.customsValueRiskReason != null) {
        doc.customsValueRiskReason = t(body.customsValueRiskReason);
      }

      const allowOverride = await userCanOverride(req);
      const touchedLotIds = new Set();

      for (const line of doc.items || []) {
        for (const alloc of line.allocations || []) {
          const qty = Number(alloc.qty) || 0;
          if (qty <= 0) continue;

          if (alloc.allocationMode === "OVERRIDE_DUMMY" || !alloc.customsLotItemId) {
            if (!allowOverride && alloc.allocationMode === "OVERRIDE_DUMMY") {
              throw new Error("Override allocation requires CUSTOMS.override (BOE Override) permission");
            }
            continue;
          }

          const item = await CustomsLotItem.findOne(
            customsWithCompanyId(req.companyId, { _id: alloc.customsLotItemId }),
          ).session(session);
          if (!item) throw new Error("Customs lot item not found during finalize");

          if (qty > Number(item.qtyAvailable) + 1e-6 && !allowOverride) {
            throw new Error(
              `Insufficient customs stock for ${item.articleNumber} (need ${qty}, available ${item.qtyAvailable})`,
            );
          }

          item.qtyAvailable = Math.max(0, Number(item.qtyAvailable) - qty);
          item.qtyConsumed = (Number(item.qtyConsumed) || 0) + qty;
          item.customStockBalance = item.qtyAvailable;
          item.status = deriveItemStatus(item.qtyAvailable, item.qtyImported);
          await item.save({ session });
          touchedLotIds.add(String(item.customsLotId));

          const snap = resolveMovementCustomsValueSnapshot({ item, qty });
          // Prefer allocation snapshot when present (immutable invoice economics).
          const customsUnitValue =
            alloc.customsUnitValue != null && alloc.customsUnitValue !== ""
              ? Number(alloc.customsUnitValue)
              : snap.customsUnitValue;
          const customsValue =
            alloc.totalValue != null && alloc.totalValue !== ""
              ? Number(alloc.totalValue)
              : snap.customsValue;

          await createCustomsMovement({
            session,
            req,
            movementType: "OUTBOUND",
            customsLotId: item.customsLotId,
            customsLotItemId: item._id,
            articleNumber: item.articleNumber,
            partNumber: item.partNumber,
            qty,
            customsUnitValue,
            customsValue,
            currency: alloc.currency || item.currency || "",
            valuationMethod: alloc.valuationMethod || item.valuationMethod || "",
            referenceType: "CUSTOMS_INVOICE",
            referenceId: doc._id,
            referenceNumber: doc.customsInvoiceNumber,
            movementDate: doc.invoiceDate || new Date(),
            remarks: `Outbound for customs invoice ${doc.customsInvoiceNumber} / sales ${doc.salesInvoiceNumber}`,
          });
        }
      }

      for (const lotId of touchedLotIds) {
        await refreshCustomsLotStatus(req.companyId, lotId, session);
      }

      doc.status = "POSTED";
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      result = doc.toObject();
    });

    await writeAudit(req, {
      action: "POST",
      module: "CUSTOMS",
      entityType: "CUSTOMS_INVOICE",
      entityId: customsInvoiceId,
      documentNo: result?.customsInvoiceNumber,
      toStatus: "POSTED",
      description: `Customs invoice ${result?.customsInvoiceNumber} finalized — stock reduced`,
    });

    return result;
  } finally {
    await session.endSession();
  }
}

export async function cancelCustomsInvoice(req, customsInvoiceId, reason = "") {
  if (!isCustomsEnabled()) throw new Error("Customs module is disabled");

  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const doc = await CustomsInvoice.findOne(
        customsWithCompanyId(req.companyId, { _id: customsInvoiceId }),
      ).session(session);
      if (!doc) throw new Error("Customs invoice not found");
      if (doc.status === "CANCELLED") throw new Error("Customs invoice already cancelled");

      if (doc.status === "POSTED") {
        const touchedLotIds = new Set();
        for (const line of doc.items || []) {
          for (const alloc of line.allocations || []) {
            // Restore exact stored allocation qty/BOE — do not recalculate FIFO
            const qty = Number(alloc.qty) || 0;
            if (qty <= 0 || !alloc.customsLotItemId) continue;

            const item = await CustomsLotItem.findOne(
              customsWithCompanyId(req.companyId, { _id: alloc.customsLotItemId }),
            ).session(session);
            if (!item) continue;

            item.qtyAvailable = (Number(item.qtyAvailable) || 0) + qty;
            item.qtyConsumed = Math.max(0, (Number(item.qtyConsumed) || 0) - qty);
            item.customStockBalance = item.qtyAvailable;
            item.status = deriveItemStatus(item.qtyAvailable, item.qtyImported);
            await item.save({ session });
            touchedLotIds.add(String(item.customsLotId));

            await createCustomsMovement({
              session,
              req,
              movementType: "REVERSAL",
              customsLotId: item.customsLotId,
              customsLotItemId: item._id,
              articleNumber: item.articleNumber,
              partNumber: item.partNumber,
              qty,
              customsUnitValue:
                alloc.customsUnitValue != null ? Number(alloc.customsUnitValue) : Number(item.customsUnitValue ?? item.unitPrice) || null,
              customsValue: alloc.totalValue != null ? Number(alloc.totalValue) : null,
              currency: alloc.currency || item.currency || "",
              valuationMethod: alloc.valuationMethod || item.valuationMethod || "",
              referenceType: "CUSTOMS_INVOICE",
              referenceId: doc._id,
              referenceNumber: doc.customsInvoiceNumber,
              movementDate: new Date(),
              remarks: t(reason) || `Customs invoice ${doc.customsInvoiceNumber} cancelled — restore stock`,
            });
          }
        }
        for (const lotId of touchedLotIds) {
          await refreshCustomsLotStatus(req.companyId, lotId, session);
        }
      }

      doc.status = "CANCELLED";
      doc.updatedBy = req.user?.email || "";
      doc.remarks = doc.remarks
        ? `${doc.remarks}\nCancelled: ${t(reason)}`
        : t(reason) || "Cancelled";
      await doc.save({ session });
      result = doc.toObject();
    });

    await writeAudit(req, {
      action: "CANCEL",
      module: "CUSTOMS",
      entityType: "CUSTOMS_INVOICE",
      entityId: customsInvoiceId,
      documentNo: result?.customsInvoiceNumber,
      toStatus: "CANCELLED",
      description: `Customs invoice ${result?.customsInvoiceNumber} cancelled`,
      metadata: { reason: t(reason) },
    });

    return result;
  } finally {
    await session.endSession();
  }
}

export async function getCustomsInvoiceById(companyId, id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw new Error("Invalid id");
  const doc = await CustomsInvoice.findOne(customsWithCompanyId(companyId, { _id: id })).lean();
  if (!doc) throw new Error("Customs invoice not found");
  return doc;
}

export async function getCustomsInvoiceBySalesInvoiceId(companyId, salesInvoiceId) {
  if (!mongoose.Types.ObjectId.isValid(String(salesInvoiceId))) return null;
  return CustomsInvoice.findOne(
    customsWithCompanyId(companyId, {
      salesInvoiceId,
      status: { $ne: "CANCELLED" },
    }),
  )
    .sort({ createdAt: -1 })
    .lean();
}

export async function listCustomsInvoices(companyId, { page = 1, limit = 50, search, status } = {}) {
  const filter = customsWithCompanyId(companyId, {});
  if (status) filter.status = upper(status);
  if (search) {
    const s = t(search);
    filter.$or = [
      { customsInvoiceNumber: new RegExp(s, "i") },
      { salesInvoiceNumber: new RegExp(s, "i") },
      { customerName: new RegExp(s, "i") },
    ];
  }

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    CustomsInvoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CustomsInvoice.countDocuments(filter),
  ]);

  return { items, total, page, limit };
}

export function buildCustomsInvoicePrintRows(invoice) {
  const rows = [];
  for (const line of invoice?.items || []) {
    for (const alloc of line.allocations || []) {
      rows.push({
        articleNumber: line.articleNumber,
        partNumber: line.partNumber,
        description: line.description || line.partName,
        qty: alloc.qty,
        boeNumber: alloc.boeNumber,
        boeDate: alloc.boeDate,
        blNumber: alloc.blNumber,
        awbNumber: alloc.awbNumber,
        supplierInvoiceNumber: alloc.supplierInvoiceNumber,
        supplierInvoiceDate: alloc.supplierInvoiceDate,
        countryOfOrigin: alloc.countryOfOrigin,
        hsCode: alloc.hsCode,
        unitWeightKg: alloc.unitWeightKg || alloc.weightKg,
        totalWeightKg: alloc.totalWeightKg,
        unitPrice: alloc.unitPrice,
        totalValue: alloc.totalValue,
        customsValueAED: alloc.customsValueAED,
        allocationMode: alloc.allocationMode,
      });
    }
  }
  return rows;
}

/** Alias: CUSTOMS.override is the BOE Override permission. */
export async function userHasBoeOverridePermission(req) {
  return userCanOverride(req);
}
