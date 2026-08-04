import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import OrderAllocation from "../models/OrderAllocation.js";
import ItemSupplier from "../models/itemSupplierModel.js";
import * as stockService from "./stockService.js";
import { deriveAvailableQty } from "./stockExpectedBuckets.js";

/** PO statuses that reserve converted quantity from Order Allocation lines. */
export const ACTIVE_PO_STATUSES = [
  "DRAFT",
  "SAVED",
  "SENT",
  "REJECTED",
  "PARTIAL_RECEIVED",
  "RECEIVED",
  "CLOSED",
];

export const PO_CONVERSION_STATUS = {
  NOT_CONVERTED: "NOT_CONVERTED",
  PARTIALLY_CONVERTED: "PARTIALLY_CONVERTED",
  FULLY_CONVERTED: "FULLY_CONVERTED",
};

export function computeAllocatedStockQty(orderedQty, stock = {}) {
  const ordered = Math.max(0, Number(orderedQty) || 0);
  const onHand = Math.max(0, Number(stock.onHandQty) || 0);
  return Math.min(ordered, onHand);
}

export function computeSuggestedPurchaseQty(orderedQty, allocatedStockQty) {
  const ordered = Math.max(0, Number(orderedQty) || 0);
  const allocated = Math.max(0, Number(allocatedStockQty) || 0);
  return Math.max(0, ordered - allocated);
}

export function computeRemainingConvertibleQty(orderedQty, activeConvertedQty) {
  const ordered = Math.max(0, Number(orderedQty) || 0);
  const converted = Math.max(0, Number(activeConvertedQty) || 0);
  return Math.max(0, ordered - converted);
}

export function derivePoConversionStatus(orderedQty, activeConvertedQty) {
  const ordered = Math.max(0, Number(orderedQty) || 0);
  const converted = Math.max(0, Number(activeConvertedQty) || 0);
  if (converted <= 0) return PO_CONVERSION_STATUS.NOT_CONVERTED;
  if (converted >= ordered - 1e-6) return PO_CONVERSION_STATUS.FULLY_CONVERTED;
  return PO_CONVERSION_STATUS.PARTIALLY_CONVERTED;
}

async function fetchPurchaseIntelligenceForArticle(companyId, article) {
  const art = String(article || "").trim().toUpperCase();
  if (!art) {
    return {
      preferredSupplier: "",
      lastSupplier: "",
      lastPurchasePrice: null,
      lastPurchaseDate: null,
      preferredLeadTime: "",
      lastLeadTime: "",
      preferredPrice: null,
      supplierPartNumber: "",
    };
  }

  const [preferred, recentPos] = await Promise.all([
    ItemSupplier.findOne({ companyId, article: art }).sort({ updatedAt: -1 }).lean(),
    PurchaseOrder.find({
      companyId,
      status: { $ne: "CANCELLED" },
      "lines.article": art,
    })
      .sort({ orderDate: -1, createdAt: -1 })
      .limit(5)
      .lean(),
  ]);

  let lastSupplier = "";
  let lastPurchasePrice = null;
  let lastPurchaseDate = null;
  let lastLeadTime = "";

  for (const po of recentPos) {
    const match = (po.lines || []).find((l) => String(l.article || "").trim().toUpperCase() === art);
    if (!match) continue;
    lastSupplier = po.supplierName || "";
    lastPurchasePrice = Number(match.unitPrice) || 0;
    lastPurchaseDate = po.orderDate || null;
    lastLeadTime = match.leadTime || "";
    break;
  }

  return {
    preferredSupplier: preferred?.supplierName || "",
    lastSupplier: lastSupplier || preferred?.supplierName || "",
    lastPurchasePrice: lastPurchasePrice ?? (preferred?.price != null ? Number(preferred.price) : null),
    lastPurchaseDate,
    preferredLeadTime: preferred?.leadTime || "",
    lastLeadTime: lastLeadTime || preferred?.leadTime || "",
    preferredPrice: preferred?.price != null ? Number(preferred.price) : null,
    supplierPartNumber: preferred?.supplierPartNumber || "",
  };
}

export async function sumActivePoQtyByAllocationLine(companyId, allocationId) {
  const pos = await PurchaseOrder.find({
    companyId,
    sourceOrderAllocationId: allocationId,
    status: { $in: ACTIVE_PO_STATUSES },
  })
    .select("poNumber poNo status lines supplierName orderDate grandTotal createdBy")
    .lean();

  const byLineId = new Map();
  const linkedPos = [];

  for (const po of pos) {
    let linkedLineCount = 0;
    for (const line of po.lines || []) {
      const lineId = String(line.sourceOrderAllocationLineId || "");
      if (!lineId) continue;
      linkedLineCount += 1;
      const qty = Number(line.sourceConvertedQty ?? line.qty) || 0;
      const entry = byLineId.get(lineId) || { activeConvertedQty: 0, poNumbers: [] };
      entry.activeConvertedQty += qty;
      if (po.poNumber && !entry.poNumbers.includes(po.poNumber)) {
        entry.poNumbers.push(po.poNumber);
      }
      byLineId.set(lineId, entry);
    }
    if (linkedLineCount > 0) {
      linkedPos.push({
        _id: po._id,
        poNumber: po.poNumber || po.poNo,
        supplierName: po.supplierName || "",
        orderDate: po.orderDate,
        status: po.status,
        linkedLineCount,
        grandTotal: Number(po.grandTotal) || 0,
        createdBy: po.createdBy || "",
      });
    }
  }

  return { byLineId, linkedPos };
}

export async function sumCancelledPoQtyByAllocationLine(companyId, allocationId) {
  const pos = await PurchaseOrder.find({
    companyId,
    sourceOrderAllocationId: allocationId,
    status: "CANCELLED",
  })
    .select("poNumber lines")
    .lean();

  const byLineId = new Map();
  for (const po of pos) {
    for (const line of po.lines || []) {
      const lineId = String(line.sourceOrderAllocationLineId || "");
      if (!lineId) continue;
      const qty = Number(line.sourceConvertedQty ?? line.qty) || 0;
      const entry = byLineId.get(lineId) || { cancelledConvertedQty: 0, poNumbers: [] };
      entry.cancelledConvertedQty += qty;
      if (po.poNumber && !entry.poNumbers.includes(po.poNumber)) {
        entry.poNumbers.push(po.poNumber);
      }
      byLineId.set(lineId, entry);
    }
  }
  return byLineId;
}

async function loadAllocationForCompany(companyId, allocationId) {
  if (!mongoose.Types.ObjectId.isValid(String(allocationId || ""))) {
    throw new Error("Invalid order allocation id");
  }
  const allocation = await OrderAllocation.findOne({ companyId, _id: allocationId }).lean();
  if (!allocation) throw new Error("Order allocation not found");
  return allocation;
}

export async function buildOrderAllocationPoEligibility(companyId, allocationId) {
  const allocation = await loadAllocationForCompany(companyId, allocationId);
  const cancelled = String(allocation.status || "").toUpperCase() === "CANCELLED";
  const wh = String(allocation.warehouse || "MAIN").toUpperCase();

  const [{ byLineId: activeByLine }, cancelledByLine] = await Promise.all([
    sumActivePoQtyByAllocationLine(companyId, allocation._id),
    sumCancelledPoQtyByAllocationLine(companyId, allocation._id),
  ]);

  const lines = [];
  for (const line of allocation.lines || []) {
    const lineId = String(line._id || "");
    const orderedQty = Number(line.qty) || 0;
    const activeEntry = activeByLine.get(lineId) || { activeConvertedQty: 0, poNumbers: [] };
    const cancelledEntry = cancelledByLine.get(lineId) || { cancelledConvertedQty: 0, poNumbers: [] };
    const activeConvertedQty = activeEntry.activeConvertedQty;
    const alreadyConvertedToPoQty = activeConvertedQty;
    const remainingConvertibleQty = computeRemainingConvertibleQty(orderedQty, activeConvertedQty);

    let stock = { availableQty: 0, onHandQty: 0, reservedQty: 0 };
    try {
      stock = await stockService.getStockBalance({
        companyId,
        article: line.article,
        warehouse: wh,
      });
    } catch {
      /* optional */
    }

    const availableStockQty = deriveAvailableQty({
      onHandQty: stock.onHandQty,
      reservedQty: stock.reservedQty,
      allocatedQty: stock.allocatedQty,
      packedQty: stock.packedQty,
    });
    const allocatedStockQty = computeAllocatedStockQty(orderedQty, stock);
    const suggestedPurchaseQty = computeSuggestedPurchaseQty(orderedQty, allocatedStockQty);
    const conversionStatus = derivePoConversionStatus(orderedQty, activeConvertedQty);
    const purchaseIntelligence = await fetchPurchaseIntelligenceForArticle(companyId, line.article);

    lines.push({
      allocationLineId: line._id,
      serialNo: line.serialNo,
      article: line.article,
      description: line.description || "",
      partNumber: line.partNumber || "",
      materialCode: line.materialCode || "",
      uom: line.uom || "PCS",
      orderedQty,
      availableStockQty,
      allocatedStockQty,
      suggestedPurchaseQty,
      alreadyConvertedToPoQty,
      activeConvertedQty,
      cancelledConvertedQty: cancelledEntry.cancelledConvertedQty,
      remainingConvertibleQty,
      /** @deprecated use remainingConvertibleQty */
      remainingEligibleQty: remainingConvertibleQty,
      defaultRequestedQty: suggestedPurchaseQty > 0 ? suggestedPurchaseQty : remainingConvertibleQty,
      conversionStatus,
      linkedPoNumbers: activeEntry.poNumbers,
      cancelledPoNumbers: cancelledEntry.poNumbers,
      remarks: line.remarks || "",
      existingSupplier: purchaseIntelligence.lastSupplier || purchaseIntelligence.preferredSupplier || "",
      purchaseIntelligence,
      eligible: !cancelled && orderedQty > 0 && remainingConvertibleQty > 0,
    });
  }

  const eligibleLineCount = lines.filter((l) => l.eligible).length;

  return {
    allocation: {
      _id: allocation._id,
      allocationNo: allocation.allocationNo,
      allocationDate: allocation.allocationDate,
      status: allocation.status,
      customerName: allocation.customerName,
      currency: allocation.currency,
      linkedQuotationId: allocation.linkedQuotationId,
      linkedQuotationNo: allocation.linkedQuotationNo,
      linkedOAId: allocation.linkedOAId,
      linkedOANo: allocation.linkedOANo,
      linkedProformaId: allocation.linkedProformaId,
      linkedProformaNo: allocation.linkedProformaNo,
      vertical: allocation.vertical,
      engine: allocation.engine,
      model: allocation.model,
      config: allocation.config,
      esn: allocation.esn,
      warehouse: allocation.warehouse,
      cancelled,
    },
    lines,
    eligibleLineCount,
    canConvertToPo: !cancelled && lines.some((l) => l.orderedQty > 0 && l.remainingConvertibleQty > 0),
  };
}

export async function listLinkedPurchaseOrdersForAllocation(companyId, allocationId) {
  await loadAllocationForCompany(companyId, allocationId);
  const { linkedPos } = await sumActivePoQtyByAllocationLine(companyId, allocationId);
  const cancelledPos = await PurchaseOrder.find({
    companyId,
    sourceOrderAllocationId: allocationId,
    status: "CANCELLED",
  })
    .select("poNumber poNo supplierName orderDate status grandTotal createdBy lines")
    .lean();

  const cancelledSummaries = cancelledPos.map((po) => ({
    _id: po._id,
    poNumber: po.poNumber || po.poNo,
    supplierName: po.supplierName || "",
    orderDate: po.orderDate,
    status: po.status,
    linkedLineCount: (po.lines || []).filter((l) => l.sourceOrderAllocationLineId).length,
    grandTotal: Number(po.grandTotal) || 0,
    createdBy: po.createdBy || "",
  }));

  return {
    active: linkedPos.sort((a, b) => String(b.orderDate || "").localeCompare(String(a.orderDate || ""))),
    cancelled: cancelledSummaries,
  };
}

export function applyAllocationSourceHeader(body, allocation) {
  if (!allocation?._id) return body;
  body.sourceType = "ORDER_ALLOCATION";
  body.sourceOrderAllocationId = allocation._id;
  body.sourceOrderAllocationNumber = allocation.allocationNo || "";
  body.sourceQuotationId = allocation.linkedQuotationId || null;
  body.sourceQuotationNumber = allocation.linkedQuotationNo || "";
  body.sourceOAId = allocation.linkedOAId || null;
  body.sourceOANumber = allocation.linkedOANo || "";
  body.sourceCustomerName = allocation.customerName || "";
  if (!body.vertical && allocation.vertical) body.vertical = allocation.vertical;
  if (!body.engine && allocation.engine) body.engine = allocation.engine;
  if (!body.brand && allocation.engine) body.brand = allocation.engine;
  if (!body.model && allocation.model) body.model = allocation.model;
  if (!body.config && allocation.config) body.config = allocation.config;
  if (!body.esn && allocation.esn) body.esn = allocation.esn;
  if (!body.currency && allocation.currency) body.currency = allocation.currency;
  if (!body.intRef) body.intRef = allocation.allocationNo || "";
  return body;
}

export function stampAllocationSourceOnPoLines(poLines, allocation, linkedInputs = []) {
  if (!allocation?._id) return poLines;
  const inputByLineId = new Map(
    (linkedInputs || []).map((row) => [String(row.sourceOrderAllocationLineId || ""), row])
  );
  const allocLineById = new Map((allocation.lines || []).map((l) => [String(l._id), l]));

  return (poLines || []).map((line) => {
    const sourceLineId = String(line.sourceOrderAllocationLineId || "");
    if (!sourceLineId) return line;
    const allocLine = allocLineById.get(sourceLineId);
    if (!allocLine) return { ...line, sourceOrderAllocationLineId: null };

    const convertedQty = Number(line.qty) || 0;
    const requestedQty = Number(line.sourceRequestedQty ?? convertedQty) || convertedQty;

    return {
      ...line,
      sourceOrderAllocationLineId: allocLine._id,
      sourceArticle: allocLine.article,
      sourceRequestedQty: requestedQty,
      sourceConvertedQty: convertedQty,
    };
  });
}

export async function validatePurchaseOrderAllocationLinks({
  companyId,
  allocationId,
  lines,
  excludePoId = null,
}) {
  if (!allocationId) return { ok: true, linkedLines: [] };

  const allocation = await loadAllocationForCompany(companyId, allocationId);
  if (String(allocation.status || "").toUpperCase() === "CANCELLED") {
    throw new Error("Cannot create purchase orders from a cancelled order allocation.");
  }

  const eligibility = await buildOrderAllocationPoEligibility(companyId, allocation._id);
  const eligibleByLineId = new Map(eligibility.lines.map((l) => [String(l.allocationLineId), l]));

  const allocLineById = new Map((allocation.lines || []).map((l) => [String(l._id), l]));
  const linkedLines = [];
  const errors = [];

  for (const raw of lines || []) {
    const sourceLineId = String(raw.sourceOrderAllocationLineId || "");
    if (!sourceLineId) continue;

    const allocLine = allocLineById.get(sourceLineId);
    if (!allocLine) {
      errors.push(`Source allocation line ${sourceLineId} no longer exists.`);
      continue;
    }

    const convertedQty = Number(raw.qty ?? raw.sourceConvertedQty) || 0;
    if (!(convertedQty > 0)) {
      errors.push(`Linked line for article ${allocLine.article} must have quantity greater than zero.`);
      continue;
    }

    const eligible = eligibleByLineId.get(sourceLineId);
    const orderedQty = Number(allocLine.qty) || 0;
    let remaining = eligible?.remainingConvertibleQty ?? computeRemainingConvertibleQty(orderedQty, 0);

    if (excludePoId) {
      const existingPo = await PurchaseOrder.findOne({ companyId, _id: excludePoId }).lean();
      if (existingPo && String(existingPo.sourceOrderAllocationId) === String(allocation._id)) {
        const prev = (existingPo.lines || []).find(
          (l) => String(l.sourceOrderAllocationLineId) === sourceLineId
        );
        if (prev) {
          remaining += Number(prev.sourceConvertedQty ?? prev.qty) || 0;
        }
      }
    }

    if (convertedQty > remaining + 1e-6) {
      errors.push(
        `Requested quantity (${convertedQty}) for article ${allocLine.article} exceeds remaining convertible quantity (${remaining}).`
      );
      continue;
    }

    linkedLines.push({
      sourceOrderAllocationLineId: allocLine._id,
      sourceArticle: allocLine.article,
      sourceRequestedQty: Number(raw.sourceRequestedQty ?? convertedQty) || convertedQty,
      sourceConvertedQty: convertedQty,
      qty: convertedQty,
    });
  }

  if (errors.length) {
    const err = new Error(
      errors.length === 1
        ? errors[0]
        : "The available quantity for one or more Order Allocation lines has changed. Refresh the Order Allocation and try again."
    );
    err.details = errors;
    throw err;
  }

  return { ok: true, allocation, linkedLines };
}

export const ALLOCATION_QTY_CHANGED_MESSAGE =
  "The available quantity for one or more Order Allocation lines has changed. Refresh the Order Allocation and try again.";
