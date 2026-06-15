import mongoose from "mongoose";
import Quotation from "../models/Quotation.js";
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
import SalesInvoice from "../models/SalesInvoice.js";
import SalesDispatch from "../models/SalesDispatch.js";
import StorePacking from "../models/StorePacking.js";
import StoreDispatch from "../models/StoreDispatch.js";
import Cipl from "../models/Cipl.js";
import OrderAllocation from "../models/OrderAllocation.js";
import Rts from "../models/Rts.js";
import StockBalance from "../models/StockBalance.js";
import GRN from "../models/GRN.js";
import PaymentReceipt from "../models/PaymentReceipt.js";
import Customer from "../models/Customer.js";
import Company from "../models/Company.js";
import Item from "../models/Item.js";
import CustomerLedgerEntry from "../models/CustomerLedgerEntry.js";
import { nextSalesDocNumber, nextUniqueSalesDocNumber } from "../utils/salesDocNumber.js";
import { formatDuplicateKeyError } from "../utils/mongoErrors.js";
import * as stockService from "../services/stockService.js";
import {
  DOC_TYPES,
  assertTransition,
  blockTransition,
  canonicalStatus,
} from "../services/docLifecycle.js";
import { writeAudit, writeStatusChange } from "../services/auditService.js";
import {
  postSalesInvoiceReceivable,
  reverseSalesInvoiceReceivable,
} from "../services/customerReceivableService.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";

const { withTransaction } = stockService;

function t(v) {
  return String(v ?? "").trim();
}

/**
 * Phase-4 helpers — wrap the per-line stockService calls used by the
 * sales flow controllers. These keep the existing controller code
 * concise while allowing each flow to enforce article-level dedup
 * (matching the legacy salesStockService behaviour).
 */
function dedupeLines(lines) {
  const byArticle = new Map();
  for (const ln of lines || []) {
    const code = String(ln?.article || "").trim().toUpperCase();
    const q = Number(ln?.qty) || 0;
    if (!code || !(q > 0)) continue;
    byArticle.set(code, (byArticle.get(code) || 0) + q);
  }
  return byArticle;
}

/**
 * Reserves stock for every line, dedup-by-article, and returns a Set
 * of articles whose available bucket dropped below zero so the caller
 * can stamp `OrderAllocation.lines[i].isNegativeAllocation`.
 */
async function reserveAllocationLines({
  session,
  companyId,
  warehouse,
  lines,
  referenceType,
  referenceNo,
  customerName,
  remarks,
  createdBy,
  allowNegative,
  sourceModule = "SALES",
}) {
  const negativeArticles = new Set();
  const ledgerIds = [];
  for (const [article, qty] of dedupeLines(lines)) {
    const ledger = await stockService.allocateStock({
      session,
      companyId,
      article,
      warehouse,
      qty,
      customerName,
      referenceType,
      referenceNo,
      remarks,
      createdBy,
      sourceModule,
      allowNegative,
    });
    ledgerIds.push(ledger._id);
    if (ledger.isNegativeAllocation) negativeArticles.add(article);
  }
  return { ledgerIds, negativeArticles };
}

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

async function enrichSalesDispatchesWithInvoiceStatus(companyId, items) {
  if (!items?.length) return items;
  const ids = [...new Set(items.map((d) => d.linkedSalesInvoiceId).filter(Boolean).map(String))];
  if (!ids.length) {
    return items.map((d) => ({ ...d, linkedInvoiceStatus: null }));
  }
  const invoices = await SalesInvoice.find({
    companyId,
    _id: { $in: ids },
  })
    .select("status paymentTerms")
    .lean();
  const map = Object.fromEntries(invoices.map((i) => [String(i._id), i]));
  return items.map((d) => ({
    ...d,
    linkedInvoiceStatus: map[String(d.linkedSalesInvoiceId)]?.status ?? null,
  }));
}

function normalizeLines(lines = []) {
  return (lines || [])
    .map((line) => {
    const serialNo = Number(line.serialNo) || 0;
    const qty = Number(line.qty) || 0;
    const price = Number(line.price ?? line.salePrice) || 0;
    const totalPrice = qty * price;
    return {
      serialNo,
      packingLineId: mongoose.Types.ObjectId.isValid(String(line.packingLineId || ""))
        ? new mongoose.Types.ObjectId(String(line.packingLineId))
        : null,
      allocationLineId: mongoose.Types.ObjectId.isValid(String(line.allocationLineId || ""))
        ? new mongoose.Types.ObjectId(String(line.allocationLineId))
        : null,
      article: String(line.article || line.itemCode || "").trim().toUpperCase(),
      partNumber: String(line.partNumber || line.partNo || "").trim(),
      description: String(line.description || ""),
      uom: String(line.uom || line.unit || "PCS").trim() || "PCS",
      qty,
      price,
      totalPrice,
      remarks: String(line.remarks || ""),
      materialCode: String(line.materialCode || "").trim(),
      availability: String(line.availability || "").trim(),
    };
  })
    .filter((line) => line.article && line.description && line.uom && line.qty > 0 && line.price >= 0)
    .map((line, idx) => ({ ...line, serialNo: idx + 1 }));
}

function computeTotals(lines = [], source = {}) {
  let subTotal = 0;
  for (const line of lines) {
    subTotal += Number(line.totalPrice) || 0;
  }
  const discountType = String(source?.discountType || "NONE").toUpperCase();
  const discountValue = Math.max(0, Number(source?.discountValue) || 0);
  let discountTotal = Math.max(0, Number(source?.discountTotal) || 0);
  if (discountType === "PERCENT") {
    discountTotal = Math.min(subTotal, (subTotal * discountValue) / 100);
  } else if (discountType === "FLAT") {
    discountTotal = Math.min(subTotal, discountValue);
  } else if (discountTotal > 0) {
    discountTotal = Math.min(subTotal, discountTotal);
  } else {
    discountTotal = 0;
  }
  const taxTotal = Math.max(0, Number(source?.taxTotal) || 0);
  const packingCost = Math.max(0, Number(source?.packingCost) || 0);
  const clearanceCost = Math.max(0, Number(source?.clearanceCost) || 0);
  return {
    subTotal,
    discountType: ["PERCENT", "FLAT"].includes(discountType) ? discountType : "NONE",
    discountValue: ["PERCENT", "FLAT"].includes(discountType) ? discountValue : 0,
    discountTotal,
    taxTotal,
    packingCost,
    clearanceCost,
    grandTotal: subTotal - discountTotal + taxTotal + packingCost + clearanceCost,
  };
}

const POSTED_STORE_PACKING_STATUSES = ["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED"];
const POSTED_STORE_DISPATCH_STATUSES = ["POSTED", "PARTIALLY_DISPATCHED", "FULLY_DISPATCHED"];

async function invoicedQtyByPackingLine(companyId, packingId, session = null) {
  const q = SalesInvoice.find({
    companyId,
    linkedStorePackingId: packingId,
    status: { $ne: "CANCELLED" },
  }).select("lines");
  if (session) q.session(session);
  const invoices = await q.lean();
  const map = new Map();
  for (const inv of invoices) {
    for (const line of inv.lines || []) {
      if (!line.packingLineId) continue;
      const key = String(line.packingLineId);
      map.set(key, (map.get(key) || 0) + (Number(line.qty) || 0));
    }
  }
  return map;
}

async function recalcPackingInvoiceStatus({ companyId, packingId, session = null }) {
  const q = StorePacking.findOne({ companyId, _id: packingId });
  if (session) q.session(session);
  const packing = await q;
  if (!packing) return null;
  const invoicedByLine = await invoicedQtyByPackingLine(companyId, packing._id, session);
  const packedQty = (packing.lines || []).reduce((sum, line) => sum + (Number(line.packQty) || 0), 0);
  const invoicedQty = (packing.lines || []).reduce((sum, line) => sum + (invoicedByLine.get(String(line._id)) || 0), 0);
  const invoiceQuery = SalesInvoice.find({
    companyId,
    linkedStorePackingId: packing._id,
    status: { $ne: "CANCELLED" },
  }).select("_id invoiceNo invoiceDate");
  if (session) invoiceQuery.session(session);
  const invoices = await invoiceQuery.sort({ invoiceDate: 1 }).lean();
  packing.invoiceStatus =
    invoicedQty <= 0 ? "NOT_INVOICED" : invoicedQty >= packedQty - 1e-6 ? "FULLY_INVOICED" : "PARTIALLY_INVOICED";
  packing.linkedSalesInvoiceIds = invoices.map((inv) => inv._id);
  packing.linkedSalesInvoiceNos = invoices.map((inv) => inv.invoiceNo).filter(Boolean);
  packing.lastInvoicedAt = invoices.length ? invoices[invoices.length - 1].invoiceDate || new Date() : null;
  await packing.save({ session });
  return packing;
}

async function allocationFulfilmentSnapshot(companyId, allocation, session = null) {
  if (!allocation?._id) {
    return {
      allocatedQty: 0,
      packedQty: 0,
      pendingPackingQty: 0,
      invoicedQty: 0,
      pendingInvoiceQty: 0,
      dispatchedQty: 0,
      pendingDispatchQty: 0,
      packingStatus: "NOT_PACKED",
      invoiceStatus: "NOT_INVOICED",
      dispatchStatus: "NOT_DISPATCHED",
    };
  }
  const allocationId = allocation._id;
  const qPacking = StorePacking.find({
    companyId,
    allocationId,
    status: { $in: POSTED_STORE_PACKING_STATUSES },
  }).select("packingNo lines");
  const qInvoice = SalesInvoice.find({
    companyId,
    linkedOrderAllocationId: allocationId,
    status: { $ne: "CANCELLED" },
  }).select("invoiceNo lines");
  const qDispatch = StoreDispatch.find({
    companyId,
    allocationId,
    status: { $in: POSTED_STORE_DISPATCH_STATUSES },
  }).select("dispatchNo lines");
  if (session) {
    qPacking.session(session);
    qInvoice.session(session);
    qDispatch.session(session);
  }
  const [packings, invoices, dispatches] = await Promise.all([qPacking.lean(), qInvoice.lean(), qDispatch.lean()]);
  const allocatedQty = (allocation.lines || []).reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
  const packedQty = packings.reduce(
    (sum, packing) => sum + (packing.lines || []).reduce((lineSum, line) => lineSum + (Number(line.packQty) || 0), 0),
    0
  );
  const invoicedQty = invoices.reduce(
    (sum, invoice) => sum + (invoice.lines || []).reduce((lineSum, line) => lineSum + (Number(line.qty) || 0), 0),
    0
  );
  const dispatchedQty = dispatches.reduce(
    (sum, dispatch) => sum + (dispatch.lines || []).reduce((lineSum, line) => lineSum + (Number(line.dispatchQty) || 0), 0),
    0
  );
  const packingStatus =
    packedQty <= 0 ? "NOT_PACKED" : packedQty >= allocatedQty - 1e-6 ? "FULLY_PACKED" : "PARTIALLY_PACKED";
  const invoiceStatus =
    invoicedQty <= 0 ? "NOT_INVOICED" : invoicedQty >= packedQty - 1e-6 ? "FULLY_INVOICED" : "PARTIALLY_INVOICED";
  const dispatchStatus =
    dispatchedQty <= 0 ? "NOT_DISPATCHED" : dispatchedQty >= invoicedQty - 1e-6 ? "DISPATCHED" : "PARTIALLY_DISPATCHED";
  return {
    allocatedQty,
    packedQty,
    pendingPackingQty: Math.max(0, allocatedQty - packedQty),
    invoicedQty,
    pendingInvoiceQty: Math.max(0, packedQty - invoicedQty),
    dispatchedQty,
    pendingDispatchQty: Math.max(0, invoicedQty - dispatchedQty),
    packingStatus,
    invoiceStatus,
    dispatchStatus,
    packingNos: [...new Set(packings.map((p) => p.packingNo).filter(Boolean))],
    invoiceNos: [...new Set(invoices.map((i) => i.invoiceNo).filter(Boolean))],
    dispatchNos: [...new Set(dispatches.map((d) => d.dispatchNo).filter(Boolean))],
  };
}

async function persistAllocationFulfilment(companyId, allocation, session = null) {
  const snapshot = await allocationFulfilmentSnapshot(companyId, allocation, session);
  allocation.packingStatus = snapshot.packingStatus;
  allocation.invoiceStatus = snapshot.invoiceStatus;
  allocation.dispatchStatus = snapshot.dispatchStatus;
  return snapshot;
}

function packedInvoiceLineFromPackingLine(packingLine, allocationLine, pendingQty) {
  const qty = Math.max(0, Number(pendingQty) || 0);
  const price = Number(allocationLine?.price ?? allocationLine?.salePrice ?? 0) || 0;
  return {
    packingLineId: packingLine._id,
    allocationLineId: packingLine.allocationLineId || allocationLine?._id || null,
    article: packingLine.article,
    partNumber: packingLine.spn || allocationLine?.partNumber || "",
    description: packingLine.description || allocationLine?.description || packingLine.article || "",
    uom: packingLine.uom || allocationLine?.uom || "PCS",
    qty,
    price,
    totalPrice: qty * price,
    remarks: packingLine.remarks || "",
    materialCode: packingLine.materialCode || allocationLine?.materialCode || "",
    availability: allocationLine?.availability || "",
  };
}

async function firstReadyPackingForAllocation(req, allocationId) {
  const packings = await StorePacking.find(
    withCompany(req, {
      allocationId,
      status: { $in: POSTED_STORE_PACKING_STATUSES },
      invoiceStatus: { $ne: "FULLY_INVOICED" },
    })
  )
    .sort({ packingDate: 1 })
    .lean();
  for (const packing of packings) {
    const invoicedByLine = await invoicedQtyByPackingLine(req.companyId, packing._id);
    let pendingInvoiceQty = 0;
    for (const line of packing.lines || []) {
      pendingInvoiceQty += Math.max(0, (Number(line.packQty) || 0) - (invoicedByLine.get(String(line._id)) || 0));
    }
    if (pendingInvoiceQty > 0) return { packing, pendingInvoiceQty };
  }
  return null;
}

async function applyLinkedQuotationDiscountFallback(req, docs = [], { persistModel = null } = {}) {
  const rows = Array.isArray(docs) ? docs : [];
  if (!rows.length) return rows;
  const needsFallback = rows.filter((doc) => {
    const subTotal = Number(doc?.subTotal) || 0;
    const discountTotal = Number(doc?.discountTotal) || 0;
    const packingCost = Number(doc?.packingCost) || 0;
    const clearanceCost = Number(doc?.clearanceCost) || 0;
    return subTotal > 0 && doc?.linkedQuotationId && (discountTotal <= 0 || packingCost <= 0 || clearanceCost <= 0);
  });
  if (!needsFallback.length) return rows;
  const quotationIds = [...new Set(needsFallback.map((doc) => String(doc.linkedQuotationId)).filter(Boolean))];
  if (!quotationIds.length) return rows;
  const quotations = await Quotation.find(
    withCompany(req, { _id: { $in: quotationIds } }),
    { _id: 1, discountType: 1, discountValue: 1, discountTotal: 1, taxTotal: 1, packingCost: 1, clearanceCost: 1 }
  ).lean();
  const byQuotationId = new Map(quotations.map((q) => [String(q._id), q]));
  const out = rows.map((doc) => {
    const q = byQuotationId.get(String(doc.linkedQuotationId || ""));
    if (!q) return doc;
    const subTotal = Number(doc.subTotal) || 0;
    const currentDiscount = Number(doc.discountTotal) || 0;
    const currentPacking = Math.max(0, Number(doc.packingCost) || 0);
    const currentClearance = Math.max(0, Number(doc.clearanceCost) || 0);
    const currentDiscountType = String(doc.discountType || "NONE").toUpperCase();
    const currentDiscountValue = Math.max(0, Number(doc.discountValue) || 0);
    if (subTotal <= 0) return doc;
    const quoteDiscountType = String(q.discountType || "NONE").toUpperCase();
    const quoteDiscountValue = Math.max(0, Number(q.discountValue) || 0);
    const quoteDiscount = Math.max(0, Number(q.discountTotal) || 0);
    const discountType =
      ["PERCENT", "FLAT"].includes(currentDiscountType) ? currentDiscountType : ["PERCENT", "FLAT"].includes(quoteDiscountType) ? quoteDiscountType : "NONE";
    const discountValue =
      ["PERCENT", "FLAT"].includes(currentDiscountType) && currentDiscountValue > 0
        ? currentDiscountValue
        : ["PERCENT", "FLAT"].includes(quoteDiscountType)
          ? quoteDiscountValue
          : 0;
    const discountTotal =
      currentDiscount > 0
        ? Math.min(subTotal, currentDiscount)
        : ["PERCENT", "FLAT"].includes(discountType)
          ? discountType === "PERCENT"
            ? Math.min(subTotal, (subTotal * discountValue) / 100)
            : Math.min(subTotal, discountValue)
          : Math.min(subTotal, quoteDiscount);
    const taxTotal = Math.max(0, Number(doc.taxTotal) || Number(q.taxTotal) || 0);
    const packingCost = currentPacking > 0 ? currentPacking : Math.max(0, Number(q.packingCost) || 0);
    const clearanceCost = currentClearance > 0 ? currentClearance : Math.max(0, Number(q.clearanceCost) || 0);
    const changed =
      Math.abs(discountTotal - currentDiscount) > 0.000001 ||
      discountType !== currentDiscountType ||
      Math.abs(discountValue - currentDiscountValue) > 0.000001 ||
      Math.abs(taxTotal - (Number(doc.taxTotal) || 0)) > 0.000001 ||
      Math.abs(packingCost - currentPacking) > 0.000001 ||
      Math.abs(clearanceCost - currentClearance) > 0.000001;
    if (!changed) return doc;
    const grandTotal = subTotal - discountTotal + taxTotal + packingCost + clearanceCost;
    return { ...doc, discountType, discountValue, discountTotal, taxTotal, packingCost, clearanceCost, grandTotal, _discountBackfilled: true };
  });
  if (persistModel) {
    const ops = out
      .filter((doc) => doc._discountBackfilled && doc._id)
      .map((doc) => ({
        updateOne: {
          filter: withCompany(req, { _id: doc._id }),
          update: {
            $set: {
              discountType: doc.discountType || "NONE",
              discountValue: Number(doc.discountValue) || 0,
              discountTotal: Number(doc.discountTotal) || 0,
              taxTotal: Number(doc.taxTotal) || 0,
              packingCost: Number(doc.packingCost) || 0,
              clearanceCost: Number(doc.clearanceCost) || 0,
              grandTotal: Number(doc.grandTotal) || 0,
              updatedBy: req.user?.email || "",
            },
          },
        },
      }));
    if (ops.length) await persistModel.bulkWrite(ops, { ordered: false });
  }
  return out.map((doc) => {
    if (!doc._discountBackfilled) return doc;
    const { _discountBackfilled, ...rest } = doc;
    return rest;
  });
}

async function syncProformaPaymentState(req, proforma) {
  if (!proforma?._id) return proforma;
  const receipts = await PaymentReceipt.find(
    withCompany(req, {
      status: { $ne: "CANCELLED" },
      "allocations.targetType": "PROFORMA_INVOICE",
      "allocations.targetId": proforma._id,
    }),
    { allocations: 1 }
  ).lean();
  let totalReceived = 0;
  for (const r of receipts) {
    for (const a of r.allocations || []) {
      if (
        String(a.targetType || "") === "PROFORMA_INVOICE" &&
        String(a.targetId || "") === String(proforma._id)
      ) {
        totalReceived += Math.max(0, Number(a.allocatedAmount) || 0);
      }
    }
  }
  totalReceived = Math.max(0, totalReceived);
  const grandTotal = Math.max(0, Number(proforma.grandTotal) || 0);
  const balanceAmount = Math.max(0, grandTotal - totalReceived);
  let paymentStatus = "UNPAID";
  if (totalReceived > 0 && totalReceived < grandTotal) paymentStatus = "PARTIALLY_PAID";
  if (totalReceived >= grandTotal && grandTotal > 0) paymentStatus = "PAID";

  const persisted = String(proforma.paymentStatus || "").toUpperCase();
  const persistedTotal = Number(proforma.totalReceivedAmount || 0);
  const status = String(proforma.status || "").toUpperCase();
  let dirty = false;
  if (persisted !== paymentStatus || Math.abs(persistedTotal - totalReceived) > 0.0001) {
    proforma.totalReceivedAmount = totalReceived;
    proforma.balanceAmount = balanceAmount;
    proforma.paymentStatus = paymentStatus;
    dirty = true;
  }
  if (paymentStatus === "PAID" && !["PAID_PENDING_SHIPMENT", "CONVERTED", "CANCELLED"].includes(status)) {
    proforma.status = "PAID_PENDING_SHIPMENT";
    proforma.paidAt = proforma.paidAt || new Date();
    proforma.paidBy = proforma.paidBy || req.user?.email || "";
    dirty = true;
  } else if (paymentStatus !== "PAID" && status === "PAID_PENDING_SHIPMENT") {
    proforma.status = "ISSUED";
    proforma.paidAt = null;
    proforma.paidBy = "";
    dirty = true;
  }
  if (dirty) {
    proforma.updatedBy = req.user?.email || proforma.updatedBy || "";
    await proforma.save();
  }
  return proforma;
}

async function enrichProformasWithPaymentState(req, docs = []) {
  const rows = Array.isArray(docs) ? docs : [];
  if (!rows.length) return rows;
  const ids = [...new Set(rows.map((x) => String(x._id || "")).filter(Boolean))];
  if (!ids.length) return rows;
  // Sum allocations per proforma across all non-cancelled receipts.
  // Active receipt statuses are POSTED, PARTIALLY_ALLOCATED, FULLY_ALLOCATED — only CANCELLED is excluded.
  // We aggregate from allocations[] so multi-allocation receipts contribute only their proforma share.
  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const sums = await PaymentReceipt.aggregate([
    {
      $match: withCompany(req, {
        status: { $ne: "CANCELLED" },
        "allocations.targetType": "PROFORMA_INVOICE",
        "allocations.targetId": { $in: objectIds },
      }),
    },
    { $unwind: "$allocations" },
    {
      $match: {
        "allocations.targetType": "PROFORMA_INVOICE",
        "allocations.targetId": { $in: objectIds },
      },
    },
    {
      $group: {
        _id: "$allocations.targetId",
        total: { $sum: "$allocations.allocatedAmount" },
      },
    },
  ]);
  const byId = new Map(sums.map((x) => [String(x._id), Math.max(0, Number(x.total) || 0)]));
  return rows.map((doc) => {
    const grandTotal = Math.max(0, Number(doc.grandTotal) || 0);
    const totalReceivedAmount = byId.get(String(doc._id)) ?? Math.max(0, Number(doc.totalReceivedAmount) || 0);
    const balanceAmount = Math.max(0, grandTotal - totalReceivedAmount);
    const paymentStatus = totalReceivedAmount >= grandTotal && grandTotal > 0 ? "PAID" : totalReceivedAmount > 0 ? "PARTIALLY_PAID" : "UNPAID";
    return { ...doc, totalReceivedAmount, balanceAmount, paymentStatus };
  });
}

function validateConversionSource(doc, messagePrefix = "document") {
  if (!doc) throw new Error("Source document not found");
  if (doc.status === "CANCELLED" || doc.status === "REJECTED") {
    throw new Error(`Cannot convert ${messagePrefix} with status ${doc.status}`);
  }
}

function requireApprovedQuotationForConversion(quotation) {
  const st = String(quotation?.status || "").toUpperCase();
  if (st !== "APPROVED") {
    throw new Error("Quotation must be APPROVED before it can be converted to OA, Proforma, or CIPL");
  }
}

const OA_CANCELABLE_STATUSES = new Set(["ACTIVE", "APPROVED", "CONFIRMED", "CONVERTED"]);
const OA_DOWNSTREAM_BLOCK_MESSAGE = "Cannot cancel OA because active downstream document exists.";

function isOAEditLocked(doc, { hasActiveProforma = null } = {}) {
  if (!doc) return true;
  const st = String(doc.status || "").toUpperCase();
  if (["APPROVED", "CONVERTED", "CLOSED", "CANCELLED"].includes(st)) return true;
  const conv = Array.isArray(doc.convertedTo) ? doc.convertedTo.map(String) : [];
  if (conv.includes("SALES_INVOICE")) return true;
  if (hasActiveProforma === true) return true;
  if (hasActiveProforma === false) return false;
  return conv.includes("PROFORMA");
}

function isOACancelableStatus(status = "") {
  return OA_CANCELABLE_STATUSES.has(String(status || "").toUpperCase());
}

async function activeProformaIdsForOAs(req, oaIds = []) {
  if (!oaIds.length) return new Set();
  const rows = await ProformaInvoice.find(
    withCompany(req, { linkedOAId: { $in: oaIds }, status: { $ne: "CANCELLED" } })
  )
    .select("linkedOAId")
    .lean();
  return new Set(rows.map((r) => String(r.linkedOAId || "")).filter(Boolean));
}

async function findActiveDownstreamForOA(req, oaId) {
  const oaOid = mongoose.Types.ObjectId.isValid(oaId) ? new mongoose.Types.ObjectId(String(oaId)) : null;
  if (!oaOid) return null;

  const activePi = await ProformaInvoice.findOne(
    withCompany(req, { linkedOAId: oaOid, status: { $ne: "CANCELLED" } })
  )
    .select("proformaNo")
    .lean();
  if (activePi) return { kind: "proforma", ref: activePi.proformaNo };

  const activeAlloc = await OrderAllocation.findOne(
    withCompany(req, { linkedOAId: oaOid, status: { $ne: "CANCELLED" } })
  )
    .select("allocationNo _id")
    .lean();
  if (activeAlloc) return { kind: "order allocation", ref: activeAlloc.allocationNo };

  const allocRows = await OrderAllocation.find(withCompany(req, { linkedOAId: oaOid }))
    .select("_id allocationNo")
    .lean();
  const allocIds = allocRows.map((a) => a._id).filter(Boolean);
  if (allocIds.length) {
    const activePacking = await StorePacking.findOne({
      companyId: req.companyId,
      allocationId: { $in: allocIds },
      status: { $in: POSTED_STORE_PACKING_STATUSES },
    })
      .select("packingNo")
      .lean();
    if (activePacking) return { kind: "packing", ref: activePacking.packingNo };

    const activeDispatch = await StoreDispatch.findOne({
      companyId: req.companyId,
      allocationId: { $in: allocIds },
      status: { $in: POSTED_STORE_DISPATCH_STATUSES },
    })
      .select("dispatchNo")
      .lean();
    if (activeDispatch) return { kind: "dispatch", ref: activeDispatch.dispatchNo };

    const activeSiViaAlloc = await SalesInvoice.findOne(
      withCompany(req, { linkedOrderAllocationId: { $in: allocIds }, status: { $ne: "CANCELLED" } })
    )
      .select("invoiceNo")
      .lean();
    if (activeSiViaAlloc) return { kind: "sales invoice", ref: activeSiViaAlloc.invoiceNo };
  }

  const activeSi = await SalesInvoice.findOne(
    withCompany(req, { linkedOAId: oaOid, status: { $ne: "CANCELLED" } })
  )
    .select("invoiceNo")
    .lean();
  if (activeSi) return { kind: "sales invoice", ref: activeSi.invoiceNo };

  return null;
}

async function releaseQuotationFromCancelledOA(req, oa, session = null) {
  if (!oa?.linkedQuotationId) return null;
  const q = Quotation.findOne(withCompany(req, { _id: oa.linkedQuotationId }));
  if (session) q.session(session);
  const quotation = await q;
  if (!quotation) return null;
  const qStatus = String(quotation.status || "").toUpperCase();
  if (qStatus === "CONVERTED") {
    quotation.status = "APPROVED";
    quotation.convertedTo = (quotation.convertedTo || []).filter((x) => String(x).toUpperCase() !== "OA");
    quotation.updatedBy = req.user?.email || "";
    await quotation.save({ session });
  }
  return quotation;
}

async function tryReleaseOAAfterProformaCancel(req, proforma, session = null) {
  if (!proforma?.linkedOAId) return;
  const oaQ = OrderAcknowledgement.findOne(withCompany(req, { _id: proforma.linkedOAId }));
  if (session) oaQ.session(session);
  const oa = await oaQ;
  if (!oa) return;
  await releaseOAIfNoActiveProforma(req, oa, session);
}

async function releaseOAIfNoActiveProforma(req, oa, session = null) {
  if (!oa || String(oa.status || "").toUpperCase() === "CANCELLED") return false;
  const activePi = await ProformaInvoice.findOne(
    withCompany(req, { linkedOAId: oa._id, status: { $ne: "CANCELLED" } })
  )
    .session(session || null)
    .lean();
  if (activePi) return false;

  const conv = (oa.convertedTo || []).map(String);
  const hadProforma = conv.includes("PROFORMA");
  if (!hadProforma && String(oa.status || "").toUpperCase() !== "APPROVED") return false;

  oa.convertedTo = conv.filter((x) => x.toUpperCase() !== "PROFORMA");
  const nextConv = (oa.convertedTo || []).map(String);
  if (!nextConv.includes("SALES_INVOICE") && !nextConv.includes("ORDER_ALLOCATION")) {
    oa.status = "ACTIVE";
  }
  oa.updatedBy = req.user?.email || "";
  await oa.save({ session });
  return true;
}

async function enrichOAsWithCancelEligibility(req, oas = []) {
  if (!oas.length) return oas;
  const ids = oas.map((o) => o._id).filter(Boolean);
  const activePiOaIds = await activeProformaIdsForOAs(req, ids);

  return Promise.all(
    oas.map(async (oaRaw) => {
      let oa = oaRaw;
      if (oaRaw?._id && !activePiOaIds.has(String(oaRaw._id))) {
        const live = await OrderAcknowledgement.findOne(withCompany(req, { _id: oaRaw._id }));
        if (live && (await releaseOAIfNoActiveProforma(req, live))) {
          oa = live.toObject();
        }
      }
      const st = String(oa.status || "").toUpperCase();
      const hasActiveProforma = activePiOaIds.has(String(oa._id));
      let canCancelOA = false;
      let cancelOABlockReason = "";

      if (st === "CANCELLED") {
        cancelOABlockReason = "Order acknowledgement is already cancelled.";
      } else if (!isOACancelableStatus(st)) {
        cancelOABlockReason = "Only approved or active order acknowledgements can be cancelled.";
      } else {
        const downstream = await findActiveDownstreamForOA(req, oa._id);
        if (downstream) {
          cancelOABlockReason = OA_DOWNSTREAM_BLOCK_MESSAGE;
        } else {
          canCancelOA = true;
        }
      }

      return {
        ...oa,
        hasActiveProforma,
        canCancelOA,
        cancelOABlockReason,
      };
    })
  );
}

/** Only DRAFT proformas are editable (matches Sales UI). */
function isProformaEditable(doc) {
  return doc && String(doc.status || "").toUpperCase() === "DRAFT";
}

function normalizeWeight(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function attachUnitWeightFromItems(req, lines = []) {
  if (!lines.length) return lines;
  const articles = Array.from(new Set(lines.map((l) => String(l.article || "").trim().toUpperCase()).filter(Boolean)));
  if (!articles.length) return lines;
  const items = await Item.find(withCompany(req, { itemCode: { $in: articles } }))
    .select("itemCode weightKg")
    .lean();
  const byCode = new Map(items.map((it) => [String(it.itemCode || "").toUpperCase(), normalizeWeight(it.weightKg)]));
  return lines.map((line) => {
    const fromItem = byCode.get(String(line.article || "").toUpperCase());
    return {
      ...line,
      unitWeightKg: normalizeWeight(line.unitWeightKg) ?? fromItem ?? null,
    };
  });
}

async function attachRtsDefaultsFromItems(req, lines = []) {
  if (!lines.length) return lines;
  const articles = Array.from(new Set(lines.map((l) => String(l.article || "").trim().toUpperCase()).filter(Boolean)));
  if (!articles.length) {
    return lines.map((line) => ({
      ...line,
      coo: String(line.coo || "").trim() || "Germany",
    }));
  }
  const items = await Item.find(withCompany(req, { itemCode: { $in: articles } }))
    .select("itemCode weightKg coo")
    .lean();
  const byCode = new Map(
    items.map((it) => [
      String(it.itemCode || "").toUpperCase(),
      {
        weightKg: normalizeWeight(it.weightKg),
        coo: String(it.coo || "").trim(),
      },
    ])
  );
  return lines.map((line) => {
    const fromItem = byCode.get(String(line.article || "").toUpperCase()) || {};
    const unitWeightKg = normalizeWeight(line.unitWeightKg) ?? fromItem.weightKg ?? null;
    const coo = String(line.coo || "").trim() || fromItem.coo || "Germany";
    return {
      ...line,
      unitWeightKg,
      coo,
      totalWeightKg: unitWeightKg == null ? null : (Number(line.qty) || 0) * unitWeightKg,
    };
  });
}

async function approvedRtsByAllocation(req, allocationId, session = null) {
  const q = Rts.find(
    withCompany(req, {
      linkedOrderAllocationId: allocationId,
      status: "APPROVED",
    })
  );
  if (session) q.session(session);
  return q.lean();
}

/** RTS quantities that count toward allocation line fulfilment (excludes DRAFT / CANCELLED). */
async function postedRtsByAllocation(req, allocationId, session = null) {
  const q = Rts.find(
    withCompany(req, {
      linkedOrderAllocationId: allocationId,
      status: { $in: ["APPROVED", "CONVERTED_TO_INVOICE"] },
    })
  );
  if (session) q.session(session);
  return q.lean();
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Advance-payment customers must have a paid/approved proforma on the OA before stock reservation.
 */
async function assertOaReadyForStockAllocation(req, oa, session) {
  const name = String(oa.customerName || "").trim();
  if (!name) throw new Error("OA has no customer name; cannot determine payment terms.");
  const cust = await Customer.findOne({
    companyId: req.companyId,
    name: new RegExp(`^${escapeRegex(name)}$`, "i"),
  })
    .session(session || null)
    .lean();
  const terms = String(cust?.paymentTerms || "CREDIT").toUpperCase();
  if (terms !== "ADVANCE") return;
  const paidPi = await ProformaInvoice.findOne(
    withCompany(req, {
      linkedOAId: oa._id,
      status: { $in: ["PAID_PENDING_SHIPMENT", "APPROVED"] },
    })
  )
    .session(session || null)
    .lean();
  if (!paidPi) {
    throw new Error(
      "Advance payment customer: create a proforma from this OA, mark payment received, then allocate stock."
    );
  }
}

function shippedQtyMapForAllocation(approvedRtsDocs = []) {
  const shipped = new Map();
  for (const doc of approvedRtsDocs) {
    for (const line of doc.lines || []) {
      const key = String(line.allocationLineId || "");
      const prev = shipped.get(key) || 0;
      shipped.set(key, prev + (Number(line.qty) || 0));
    }
  }
  return shipped;
}

function isRtsEditable(doc) {
  if (!doc) return false;
  return !doc.linkedSalesInvoiceId;
}

function normalizeRtsPackingDetails(raw = {}) {
  const boxesRaw = Array.isArray(raw?.boxes) ? raw.boxes : [];
  const boxes = boxesRaw
    .map((b, idx) => {
      const count = Math.max(1, Number(b?.count || 1) || 1);
      const materialInput = String(b?.material || "").trim().toUpperCase();
      let material = materialInput;
      if (material === "PLUBOARD") material = "PLYWOOD";
      const allowed = ["WOODEN", "CARDBOARD", "PLYWOOD", "PALLET", "OTHER"];
      if (!allowed.includes(material)) material = material ? "OTHER" : "";
      return {
        serialNo: idx + 1,
        material,
        count,
        dimensionsMm: String(b?.dimensionsMm || "").trim(),
        remarks: String(b?.remarks || "").trim(),
      };
    })
    .filter((b) => b.material || b.dimensionsMm || b.count > 0 || b.remarks);

  const computedBoxCount = boxes.reduce((acc, b) => acc + (Number(b.count) || 0), 0);
  const fallbackCount = Number(raw?.boxCount || 0);
  return {
    totalWeightKg: Number(raw?.totalWeightKg || 0),
    boxCount: computedBoxCount || fallbackCount,
    boxDimensionsMm: String(raw?.boxDimensionsMm || boxes[0]?.dimensionsMm || "").trim(),
    boxes,
  };
}

const PENDING_QUOTATION_STATUSES = ["DRAFT", "SENT"];
const PENDING_OA_STATUSES = ["DRAFT", "ACTIVE", "CONFIRMED"];

function parseDateRange(query, fromKey = "dateFrom", toKey = "dateTo") {
  const range = {};
  if (query[fromKey]) {
    const from = new Date(String(query[fromKey]));
    if (!Number.isNaN(from.getTime())) range.$gte = from;
  }
  if (query[toKey]) {
    const to = new Date(String(query[toKey]));
    if (!Number.isNaN(to.getTime())) {
      to.setHours(23, 59, 59, 999);
      range.$lte = to;
    }
  }
  return Object.keys(range).length ? range : null;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export async function getSalesSummary(req, res) {
  try {
    const companyFilter = withCompany(req);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [
      totalQuotations,
      pendingQuotations,
      totalOA,
      pendingOA,
      totalProformas,
      totalSalesInvoices,
      unpaidSalesInvoices,
      totalCipl,
      salesValueAgg,
      monthSalesAgg,
    ] = await Promise.all([
      Quotation.countDocuments(companyFilter),
      Quotation.countDocuments(withCompany(req, { status: { $in: ["DRAFT", "SENT"] } })),
      OrderAcknowledgement.countDocuments(companyFilter),
      OrderAcknowledgement.countDocuments(withCompany(req, { status: { $in: ["DRAFT", "CONFIRMED"] } })),
      ProformaInvoice.countDocuments(companyFilter),
      SalesInvoice.countDocuments(companyFilter),
      SalesInvoice.countDocuments(withCompany(req, { status: { $in: ["DRAFT", "ISSUED", "PARTIALLY_PAID"] } })),
      Cipl.countDocuments(companyFilter),
      SalesInvoice.aggregate([
        { $match: companyFilter },
        { $group: { _id: null, total: { $sum: { $ifNull: ["$grandTotal", 0] } } } },
      ]),
      SalesInvoice.aggregate([
        { $match: withCompany(req, { invoiceDate: { $gte: monthStart } }) },
        { $group: { _id: null, total: { $sum: { $ifNull: ["$grandTotal", 0] } } } },
      ]),
    ]);

    res.json({
      totalQuotations,
      pendingQuotations,
      totalOA,
      pendingOA,
      totalProformas,
      totalSalesInvoices,
      unpaidSalesInvoices,
      totalCipl,
      totalSalesValue: Number(salesValueAgg?.[0]?.total || 0),
      thisMonthSales: Number(monthSalesAgg?.[0]?.total || 0),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportQuotationSummary(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const q = String(req.query.search || "").trim();
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.quotationDate = dateRange;
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.engine) filter.engine = new RegExp(String(req.query.engine).trim(), "i");
    if (req.query.model) filter.model = new RegExp(String(req.query.model).trim(), "i");
    if (req.query.esn) filter.esn = new RegExp(String(req.query.esn).trim(), "i");
    if (q) {
      filter.$or = [
        { quotationNo: new RegExp(q, "i") },
        { customerName: new RegExp(q, "i") },
        { customerReference: new RegExp(q, "i") },
        { engine: new RegExp(q, "i") },
        { model: new RegExp(q, "i") },
        { esn: new RegExp(q, "i") },
      ];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      Quotation.find(filter)
        .sort({ quotationDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Quotation.countDocuments(filter),
      Quotation.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalQuotedValue: { $sum: { $ifNull: ["$grandTotal", 0] } },
            approvedCount: { $sum: { $cond: [{ $eq: ["$status", "APPROVED"] }, 1, 0] } },
            rejectedCount: { $sum: { $cond: [{ $eq: ["$status", "REJECTED"] }, 1, 0] } },
            convertedCount: { $sum: { $cond: [{ $eq: ["$status", "CONVERTED"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const rows = rowsRaw.map((doc) => ({
      _id: doc._id,
      quotationNo: doc.quotationNo,
      quotationDate: doc.quotationDate,
      customerName: doc.customerName,
      customerReference: doc.customerReference || "",
      vertical: doc.vertical || "",
      engine: doc.engine || "",
      model: doc.model || "",
      config: doc.config || "",
      esn: doc.esn || "",
      lineItems: Array.isArray(doc.lines) ? doc.lines.length : 0,
      totalAmount: toNumber(doc.grandTotal),
      status: doc.status || "DRAFT",
    }));
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalQuotations: total,
        totalQuotedValue: toNumber(summary.totalQuotedValue),
        approvedQuotations: toNumber(summary.approvedCount),
        rejectedQuotations: toNumber(summary.rejectedCount),
        convertedQuotations: toNumber(summary.convertedCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPendingQuotation(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req, { status: { $in: PENDING_QUOTATION_STATUSES } });
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.quotationDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ quotationNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { remarks: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      Quotation.find(filter).sort({ quotationDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Quotation.countDocuments(filter),
      Quotation.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: { $ifNull: ["$grandTotal", 0] } },
            draftCount: { $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] } },
            sentCount: { $sum: { $cond: [{ $eq: ["$status", "SENT"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const now = Date.now();
    const rows = rowsRaw.map((doc) => {
      const baseDate = doc.quotationDate ? new Date(doc.quotationDate).getTime() : now;
      const ageDays = Math.max(0, Math.floor((now - baseDate) / 86400000));
      return {
        _id: doc._id,
        quotationNo: doc.quotationNo,
        quotationDate: doc.quotationDate,
        customerName: doc.customerName,
        vertical: doc.vertical || "",
        engine: doc.engine || "",
        model: doc.model || "",
        config: doc.config || "",
        esn: doc.esn || "",
        articleCount: Array.isArray(doc.lines) ? doc.lines.length : 0,
        totalAmount: toNumber(doc.grandTotal),
        ageDays,
        status: doc.status || "DRAFT",
        followUpRemarks: String(doc.remarks || "").trim(),
      };
    });
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalPendingQuotations: total,
        totalPendingValue: toNumber(summary.totalAmount),
        draftCount: toNumber(summary.draftCount),
        sentCount: toNumber(summary.sentCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportOrderAcknowledgement(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.oaDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ oaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedQuotationNo: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      OrderAcknowledgement.find(filter).sort({ oaDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAcknowledgement.countDocuments(filter),
      OrderAcknowledgement.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            confirmedCount: { $sum: { $cond: [{ $eq: ["$status", "CONFIRMED"] }, 1, 0] } },
            closedCount: { $sum: { $cond: [{ $eq: ["$status", "CLOSED"] }, 1, 0] } },
            totalAmount: { $sum: { $ifNull: ["$grandTotal", 0] } },
          },
        },
      ]),
    ]);

    const rows = rowsRaw.map((doc) => ({
      _id: doc._id,
      oaNo: doc.oaNo,
      oaDate: doc.oaDate,
      linkedQuotationNo: doc.linkedQuotationNo || "",
      customerName: doc.customerName,
      customerPORef: doc.customerPORef || "",
      deliveryTerms: doc.deliverySchedule || "",
      vertical: doc.vertical || "",
      engine: doc.engine || "",
      model: doc.model || "",
      config: doc.config || "",
      esn: doc.esn || "",
      status: doc.status || "DRAFT",
      totalAmount: toNumber(doc.grandTotal),
    }));
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalOaCount: total,
        confirmedOaCount: toNumber(summary.confirmedCount),
        closedOaCount: toNumber(summary.closedCount),
        totalOaValue: toNumber(summary.totalAmount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPendingOrderAcknowledgement(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req, { status: { $in: PENDING_OA_STATUSES } });
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.oaDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ oaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedQuotationNo: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      OrderAcknowledgement.find(filter).sort({ oaDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAcknowledgement.countDocuments(filter),
      OrderAcknowledgement.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: { $ifNull: ["$grandTotal", 0] } },
            draftCount: { $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] } },
            confirmedCount: { $sum: { $cond: [{ $eq: ["$status", "CONFIRMED"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const now = Date.now();
    const rows = rowsRaw.map((doc) => {
      const baseDate = doc.oaDate ? new Date(doc.oaDate).getTime() : now;
      const ageDays = Math.max(0, Math.floor((now - baseDate) / 86400000));
      return {
        _id: doc._id,
        oaNo: doc.oaNo,
        customerName: doc.customerName,
        linkedQuotationNo: doc.linkedQuotationNo || "",
        vertical: doc.vertical || "",
        engine: doc.engine || "",
        model: doc.model || "",
        config: doc.config || "",
        esn: doc.esn || "",
        amount: toNumber(doc.grandTotal),
        ageDays,
        status: doc.status || "DRAFT",
      };
    });
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalPendingOaCount: total,
        totalPendingOaValue: toNumber(summary.totalAmount),
        draftCount: toNumber(summary.draftCount),
        confirmedCount: toNumber(summary.confirmedCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportProforma(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.proformaDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ proformaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedOANo: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      ProformaInvoice.find(filter).sort({ proformaDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      ProformaInvoice.countDocuments(filter),
      ProformaInvoice.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: { $ifNull: ["$grandTotal", 0] } },
            openCount: { $sum: { $cond: [{ $in: ["$status", ["DRAFT", "ISSUED", "PAID_PENDING_SHIPMENT"]] }, 1, 0] } },
            convertedCount: { $sum: { $cond: [{ $eq: ["$status", "CONVERTED"] }, 1, 0] } },
            cancelledCount: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
          },
        },
      ]),
    ]);
    const summary = summaryAgg?.[0] || {};
    const rows = rowsRaw.map((doc) => ({
      _id: doc._id,
      proformaNo: doc.proformaNo,
      proformaDate: doc.proformaDate,
      linkedQuotationNo: doc.linkedQuotationNo || "",
      linkedOANo: doc.linkedOANo || "",
      customerName: doc.customerName,
      vertical: doc.vertical || "",
      engine: doc.engine || "",
      model: doc.model || "",
      config: doc.config || "",
      esn: doc.esn || "",
      amount: toNumber(doc.grandTotal),
      status: doc.status || "DRAFT",
      validity: doc.validity || "",
      paymentTerms: doc.paymentTerms || "",
    }));
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalProformas: total,
        totalProformaValue: toNumber(summary.totalAmount),
        openProformas: toNumber(summary.openCount),
        convertedProformas: toNumber(summary.convertedCount),
        cancelledProformas: toNumber(summary.cancelledCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPendingProformaPayment(req, res) {
  try {
    const filter = withCompany(req, {
      status: { $nin: ["CANCELLED", "CONVERTED"] },
      paymentStatus: { $ne: "PAID" },
    });
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ proformaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedOANo: new RegExp(q, "i") }];
    }
    const rows = await ProformaInvoice.find(filter).sort({ proformaDate: -1, createdAt: -1 }).limit(500).lean();
    const items = rows.map((doc) => ({
      _id: doc._id,
      proformaNo: doc.proformaNo,
      proformaDate: doc.proformaDate,
      linkedOANo: doc.linkedOANo || "",
      customerName: doc.customerName,
      currency: doc.currency || "USD",
      amount: toNumber(doc.grandTotal),
      paidAmount: toNumber(doc.totalReceivedAmount),
      balanceAmount: toNumber(doc.balanceAmount || Math.max(0, (Number(doc.grandTotal) || 0) - (Number(doc.totalReceivedAmount) || 0))),
      paymentStatus: doc.paymentStatus || "UNPAID",
      status: doc.status || "DRAFT",
    }));
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPendingAllocation(req, res) {
  try {
    const q = String(req.query.search || "").trim();
    const [oas, proformas, allocations] = await Promise.all([
      OrderAcknowledgement.find(withCompany(req, { status: { $nin: ["CANCELLED", "CONVERTED", "CLOSED"] } })).lean(),
      ProformaInvoice.find(withCompany(req, { status: { $in: ["APPROVED", "PAID_PENDING_SHIPMENT"] } })).lean(),
      OrderAllocation.find(withCompany(req, { status: { $ne: "CANCELLED" } }))
        .select("linkedOAId linkedProformaId")
        .lean(),
    ]);
    const allocatedOaIds = new Set(allocations.map((a) => String(a.linkedOAId || "")).filter(Boolean));
    const allocatedPiIds = new Set(allocations.map((a) => String(a.linkedProformaId || "")).filter(Boolean));
    const items = [];
    for (const oa of oas) {
      if (allocatedOaIds.has(String(oa._id))) continue;
      if (q && !new RegExp(q, "i").test(`${oa.oaNo} ${oa.customerName}`)) continue;
      items.push({
        sourceType: "OA",
        sourceNo: oa.oaNo,
        sourceDate: oa.oaDate,
        customerName: oa.customerName,
        paymentTerms: oa.paymentTerms || "",
        amount: toNumber(oa.grandTotal),
        status: oa.status || "ACTIVE",
      });
    }
    for (const pi of proformas) {
      if (allocatedPiIds.has(String(pi._id))) continue;
      if (q && !new RegExp(q, "i").test(`${pi.proformaNo} ${pi.customerName} ${pi.linkedOANo}`)) continue;
      items.push({
        sourceType: "PI",
        sourceNo: pi.proformaNo,
        sourceDate: pi.proformaDate,
        linkedOANo: pi.linkedOANo || "",
        customerName: pi.customerName,
        paymentTerms: pi.paymentTerms || "",
        amount: toNumber(pi.grandTotal),
        status: pi.status || "APPROVED",
      });
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportSalesInvoiceSummary(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.invoiceDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ invoiceNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedProformaNo: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      SalesInvoice.find(filter).sort({ invoiceDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      SalesInvoice.countDocuments(filter),
      SalesInvoice.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalInvoicedValue: { $sum: { $ifNull: ["$grandTotal", 0] } },
            paidValue: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, { $ifNull: ["$grandTotal", 0] }, 0] } },
            unpaidValue: { $sum: { $cond: [{ $ne: ["$status", "PAID"] }, { $ifNull: ["$grandTotal", 0] }, 0] } },
            overdueInvoicesCount: { $sum: 0 },
          },
        },
      ]),
    ]);
    const rows = rowsRaw.map((doc) => {
      const invoiceValue = toNumber(doc.grandTotal);
      const paidAmount = doc.status === "PAID" ? invoiceValue : 0;
      const balanceAmount = Math.max(0, invoiceValue - paidAmount);
      return {
        _id: doc._id,
        invoiceNo: doc.invoiceNo,
        invoiceDate: doc.invoiceDate,
        customerName: doc.customerName,
        linkedProformaNo: doc.linkedProformaNo || "",
        linkedOANo: doc.linkedOANo || "",
        vertical: doc.vertical || "",
        engine: doc.engine || "",
        model: doc.model || "",
        config: doc.config || "",
        esn: doc.esn || "",
        currency: doc.currency || "USD",
        invoiceValue,
        paidAmount,
        balanceAmount,
        paymentStatus: doc.status || "DRAFT",
      };
    });
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalInvoices: total,
        totalInvoicedValue: toNumber(summary.totalInvoicedValue),
        paidValue: toNumber(summary.paidValue),
        unpaidValue: toNumber(summary.unpaidValue),
        overdueInvoicesCount: toNumber(summary.overdueInvoicesCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportSalesInvoiceArticleWise(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const match = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) match.invoiceDate = dateRange;
    if (req.query.customer) match.customerName = new RegExp(String(req.query.customer).trim(), "i");
    const q = String(req.query.search || req.query.article || "").trim();

    const pipeline = [
      { $match: match },
      { $unwind: "$lines" },
      ...(q ? [{ $match: { "lines.article": new RegExp(q, "i") } }] : []),
      {
        $group: {
          _id: "$lines.article",
          description: { $first: "$lines.description" },
          totalQtySold: { $sum: { $ifNull: ["$lines.qty", 0] } },
          totalSalesValue: { $sum: { $ifNull: ["$lines.totalPrice", 0] } },
          invoices: { $addToSet: "$invoiceNo" },
          customers: { $addToSet: "$customerName" },
          avgSellingPrice: { $avg: { $ifNull: ["$lines.price", 0] } },
        },
      },
      { $sort: { totalSalesValue: -1 } },
    ];
    const rowsAgg = await SalesInvoice.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]);
    const totalAgg = await SalesInvoice.aggregate([...pipeline, { $count: "count" }]);
    const summaryAgg = await SalesInvoice.aggregate([
      ...pipeline,
      {
        $group: {
          _id: null,
          totalQtySold: { $sum: "$totalQtySold" },
          totalSalesValue: { $sum: "$totalSalesValue" },
          articleCount: { $sum: 1 },
        },
      },
    ]);

    const rows = rowsAgg.map((r) => ({
      _id: r._id || "",
      article: r._id || "-",
      description: r.description || "",
      totalQtySold: toNumber(r.totalQtySold),
      totalSalesValue: toNumber(r.totalSalesValue),
      invoiceCount: Array.isArray(r.invoices) ? r.invoices.length : 0,
      customersCount: Array.isArray(r.customers) ? r.customers.length : 0,
      avgSellingPrice: toNumber(r.avgSellingPrice),
    }));
    const summary = summaryAgg?.[0] || {};
    const total = toNumber(totalAgg?.[0]?.count || 0);
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalArticles: toNumber(summary.articleCount),
        totalQtySold: toNumber(summary.totalQtySold),
        totalSalesValue: toNumber(summary.totalSalesValue),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportSalesBranchWise(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const match = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) match.invoiceDate = dateRange;
    if (req.query.customer) match.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) match.status = String(req.query.status).toUpperCase();
    if (req.query.search) match.invoiceNo = new RegExp(String(req.query.search).trim(), "i");

    const pipeline = [
      { $match: match },
      { $unwind: { path: "$lines", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$_id",
          branch: { $first: { $ifNull: ["$branch", "UNSPECIFIED"] } },
          customerName: { $first: "$customerName" },
          status: { $first: "$status" },
          grandTotal: { $first: { $ifNull: ["$grandTotal", 0] } },
          qty: { $sum: { $ifNull: ["$lines.qty", 0] } },
        },
      },
      {
        $group: {
          _id: "$branch",
          noOfInvoices: { $sum: 1 },
          customers: { $addToSet: "$customerName" },
          totalQtySold: { $sum: "$qty" },
          totalSalesValue: { $sum: "$grandTotal" },
          paidAmount: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, "$grandTotal", 0] } },
          unpaidAmount: { $sum: { $cond: [{ $ne: ["$status", "PAID"] }, "$grandTotal", 0] } },
        },
      },
      { $sort: { totalSalesValue: -1 } },
    ];
    const rowsAgg = await SalesInvoice.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]);
    const totalAgg = await SalesInvoice.aggregate([...pipeline, { $count: "count" }]);
    const summaryAgg = await SalesInvoice.aggregate([
      ...pipeline,
      {
        $group: {
          _id: null,
          totalSalesValue: { $sum: "$totalSalesValue" },
          paidAmount: { $sum: "$paidAmount" },
          unpaidAmount: { $sum: "$unpaidAmount" },
        },
      },
    ]);

    const rows = rowsAgg.map((r) => ({
      _id: r._id || "UNSPECIFIED",
      branch: r._id || "UNSPECIFIED",
      noOfInvoices: toNumber(r.noOfInvoices),
      noOfCustomers: Array.isArray(r.customers) ? r.customers.length : 0,
      totalQtySold: toNumber(r.totalQtySold),
      totalSalesValue: toNumber(r.totalSalesValue),
      paidAmount: toNumber(r.paidAmount),
      unpaidAmount: toNumber(r.unpaidAmount),
    }));
    const summary = summaryAgg?.[0] || {};
    const total = toNumber(totalAgg?.[0]?.count || 0);
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalBranches: total,
        totalSalesValue: toNumber(summary.totalSalesValue),
        paidAmount: toNumber(summary.paidAmount),
        unpaidAmount: toNumber(summary.unpaidAmount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportCipl(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.ciplDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [
        { ciplNo: new RegExp(q, "i") },
        { customerName: new RegExp(q, "i") },
        { linkedSalesInvoiceNo: new RegExp(q, "i") },
        { linkedQuotationNo: new RegExp(q, "i") },
        { linkedOANo: new RegExp(q, "i") },
      ];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      Cipl.find(filter).sort({ ciplDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Cipl.countDocuments(filter),
      Cipl.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalExportValue: { $sum: { $ifNull: ["$grandTotal", 0] } },
            totalPackages: { $sum: { $size: { $ifNull: ["$lines", []] } } },
            totalGrossWeight: { $sum: 0 },
          },
        },
      ]),
    ]);
    const rows = rowsRaw.map((doc) => ({
      _id: doc._id,
      ciplNo: doc.ciplNo,
      date: doc.ciplDate,
      customerOrConsignee: doc.consigneeName || doc.customerName,
      linkedReference: doc.linkedSalesInvoiceNo || doc.linkedQuotationNo || doc.linkedOANo || "",
      destination: doc.finalDestination || "-",
      portOfLoading: doc.portOfLoading || "-",
      portOfDischarge: doc.portOfDischarge || "-",
      vertical: doc.vertical || "",
      engine: doc.engine || "",
      model: doc.model || "",
      config: doc.config || "",
      esn: doc.esn || "",
      packageCount: Array.isArray(doc.lines) ? doc.lines.length : 0,
      netWeight: toNumber(doc.netWeight),
      grossWeight: toNumber(doc.grossWeight),
      value: toNumber(doc.grandTotal),
      status: doc.status || "DRAFT",
    }));
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalCiplCount: total,
        totalExportValue: toNumber(summary.totalExportValue),
        totalPackages: toNumber(summary.totalPackages),
        totalGrossWeight: toNumber(summary.totalGrossWeight),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listCustomers(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ name: new RegExp(q, "i") }, { contactName: new RegExp(q, "i") }, { email: new RegExp(q, "i") }];
    }
    const [items, total] = await Promise.all([
      Customer.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      Customer.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createCustomer(req, res) {
  try {
    const body = { ...req.body };
    body.companyId = req.companyId;
    if (!String(body.name || "").trim()) {
      return res.status(400).json({ message: "Customer name is required" });
    }
    const doc = await Customer.create(body);
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: formatDuplicateKeyError(err, "Customer") });
  }
}

export async function updateCustomer(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const allowed = ["name", "contactName", "phone", "email", "address", "paymentTerms", "notes"];
    const payload = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) payload[key] = req.body[key];
    }
    const doc = await Customer.findOneAndUpdate(withCompany(req, { _id: id }), payload, {
      new: true,
      runValidators: true,
    });
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: formatDuplicateKeyError(err, "Customer") });
  }
}

export async function deleteCustomer(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await Customer.findOneAndDelete(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listOAs(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ oaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    const [itemsRaw, total] = await Promise.all([
      OrderAcknowledgement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAcknowledgement.countDocuments(filter),
    ]);
    const items = await applyLinkedQuotationDiscountFallback(req, itemsRaw, { persistModel: OrderAcknowledgement });
    const enriched = await enrichOAsWithCancelEligibility(req, items);
    res.json({ items: enriched, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getOA(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await OrderAcknowledgement.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    const [patched] = await applyLinkedQuotationDiscountFallback(req, [doc], { persistModel: OrderAcknowledgement });
    const [enriched] = await enrichOAsWithCancelEligibility(req, [patched || doc]);
    res.json(enriched || patched || doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getOAPrintData(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const [docRaw, company] = await Promise.all([
      OrderAcknowledgement.findOne(withCompany(req, { _id: id })).lean(),
      Company.findById(req.companyId).lean(),
    ]);
    if (!docRaw) return res.status(404).json({ message: "Not found" });
    const [doc] = await applyLinkedQuotationDiscountFallback(req, [docRaw], { persistModel: OrderAcknowledgement });
    res.json({
      orderAcknowledgement: doc,
      company: {
        companyName: company?.name || "",
        code: company?.code || "",
        logo: company?.logoUrl || "",
        address: company?.address || "",
        email: company?.email || "",
        phone: company?.phone || "",
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getOAPdfData(req, res) {
  return getOAPrintData(req, res);
}

export async function createOA(req, res) {
  try {
    const body = { ...req.body };
    const lines = normalizeLines(body.lines || []);
    if (!lines.length) return res.status(400).json({ message: "OA requires at least one line" });
    const oaNo =
      body.oaNo ||
      (await nextUniqueSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "ORDER_ACK",
        model: OrderAcknowledgement,
        field: "oaNo",
      }));
    const totals = computeTotals(lines, body);
    const doc = await OrderAcknowledgement.create({
      ...body,
      lines,
      ...totals,
      oaNo,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateOA(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    const activePiIds = await activeProformaIdsForOAs(req, [doc._id]);
    const hasActiveProforma = activePiIds.has(String(doc._id));
    if (isOAEditLocked(doc, { hasActiveProforma })) {
      return res.status(400).json({
        message:
          "This order acknowledgement is locked after conversion to Proforma or Sales Invoice (or finalized status); it cannot be edited.",
      });
    }
    const allowed = [
      "oaDate",
      "customerName",
      "customerPORef",
      "acknowledgementNotes",
      "deliverySchedule",
      "paymentTerms",
      "incoterm",
      "dispatchTerms",
      "currency",
      "lines",
      "packingCost",
      "clearanceCost",
      "vertical",
      "engine",
      "model",
      "config",
      "esn",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    if (req.body.customerPODate !== undefined) {
      const raw = req.body.customerPODate;
      doc.customerPODate = raw === "" || raw === null || raw === undefined ? null : new Date(raw);
    }
    if (req.body.status !== undefined) {
      const st = String(req.body.status || "").toUpperCase();
      if (["APPROVED", "CONVERTED"].includes(st)) {
        return res.status(400).json({
          message: "Status APPROVED is set automatically when converting to PI or Sales Invoice.",
        });
      }
      doc.status = req.body.status;
    }
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines, doc));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelOA(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const reason = String(req.body?.cancellationReason ?? req.body?.cancelReason ?? req.body?.reason ?? "").trim();
    const dryRun = req.query.dryRun === "1" || req.body?.dryRun === true;
    if (!dryRun && !reason) {
      return res.status(400).json({ message: "cancellationReason is required" });
    }
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    if (!oa) return res.status(404).json({ message: "Not found" });
    if (String(oa.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Order acknowledgement is already cancelled" });
    }
    if (!isOACancelableStatus(oa.status)) {
      return res.status(400).json({ message: "Only approved or active order acknowledgements can be cancelled." });
    }
    const downstream = await findActiveDownstreamForOA(req, oa._id);
    if (downstream) {
      return res.status(400).json({ message: OA_DOWNSTREAM_BLOCK_MESSAGE });
    }
    if (dryRun) {
      return res.json({
        dryRun: true,
        stockImpact: [],
        message: "OA cancel: no stock movement (no active downstream documents).",
        releaseQuotation: Boolean(oa.linkedQuotationId),
      });
    }
    const prevStatus = String(oa.status || "");
    assertTransition(DOC_TYPES.QUOTATION, prevStatus, "CANCELLED", { documentNo: oa.oaNo });
    await withTransaction(async (session) => {
      oa.status = "CANCELLED";
      oa.cancelledAt = new Date();
      oa.cancelledBy = req.user?.email || "";
      oa.cancellationReason = reason;
      oa.cancelReason = reason;
      oa.releasedQuotationId = oa.linkedQuotationId || null;
      oa.updatedBy = req.user?.email || "";
      await oa.save({ session });
      await releaseQuotationFromCancelledOA(req, oa, session);
    });
    await writeStatusChange(req, {
      module: "SALES",
      entityType: "ORDER_ACKNOWLEDGEMENT",
      entityId: oa._id,
      documentNo: oa.oaNo || "",
      fromStatus: canonicalStatus(DOC_TYPES.QUOTATION, prevStatus),
      toStatus: "CANCELLED",
      description: `OA ${oa.oaNo || ""} cancelled`,
      metadata: { reason, releasedQuotationId: oa.releasedQuotationId },
    });
    const fresh = await OrderAcknowledgement.findOne(withCompany(req, { _id: id })).lean();
    const [enriched] = await enrichOAsWithCancelEligibility(req, [fresh || oa.toObject?.() || oa]);
    res.json(enriched || fresh || oa);
  } catch (err) {
    if (err?.code === "INVALID_TRANSITION") {
      return res.status(err.statusCode || 409).json({ message: err.message, code: err.code, details: err.details });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function listProformas(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ proformaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    const [itemsRaw, total] = await Promise.all([
      ProformaInvoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ProformaInvoice.countDocuments(filter),
    ]);
    const withPricing = await applyLinkedQuotationDiscountFallback(req, itemsRaw, { persistModel: ProformaInvoice });
    const items = await enrichProformasWithPaymentState(req, withPricing);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const docRaw = await ProformaInvoice.findOne(withCompany(req, { _id: id })).lean();
    if (!docRaw) return res.status(404).json({ message: "Not found" });
    const [withPricing] = await applyLinkedQuotationDiscountFallback(req, [docRaw], { persistModel: ProformaInvoice });
    const [enriched] = await enrichProformasWithPaymentState(req, [withPricing || docRaw]);
    res.json(enriched || withPricing || docRaw);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createProforma(req, res) {
  try {
    const body = { ...req.body };
    const lines = normalizeLines(body.lines || []);
    if (!lines.length) return res.status(400).json({ message: "Proforma requires at least one line" });
    const proformaNo =
      body.proformaNo ||
      (await nextUniqueSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "PROFORMA",
        model: ProformaInvoice,
        field: "proformaNo",
      }));
    const totals = computeTotals(lines, body);
    const doc = await ProformaInvoice.create({
      ...body,
      lines,
      ...totals,
      proformaNo,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!isProformaEditable(doc)) {
      return res.status(400).json({
        message: "Proforma can only be edited while in DRAFT (after SI/CIPL conversion it is approved and locked).",
      });
    }
    const allowed = [
      "proformaDate",
      "customerName",
      "paymentTerms",
      "bankDetails",
      "validity",
      "shipmentTerms",
      "remarks",
      "currency",
      "lines",
      "discountType",
      "discountValue",
      "packingCost",
      "clearanceCost",
      "vertical",
      "engine",
      "model",
      "config",
      "esn",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    if (req.body.status !== undefined) {
      const st = String(req.body.status || "").toUpperCase();
      if (["CONVERTED"].includes(st)) {
        return res.status(400).json({
          message: "Status CONVERTED is managed by the system.",
        });
      }
      doc.status = req.body.status;
    }
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines, doc));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const dryRun = req.query.dryRun === "1" || req.body?.dryRun === true;
    const reason = String(req.body?.cancellationReason ?? req.body?.reason ?? "").trim();
    if (!dryRun && !reason) return res.status(400).json({ message: "cancellationReason is required" });
    const doc = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (String(doc.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Proforma is already cancelled" });
    }
    const blockingAlloc = await OrderAllocation.findOne(
      withCompany(req, { linkedProformaId: doc._id, status: { $ne: "CANCELLED" } })
    ).lean();
    if (blockingAlloc) {
      return res.status(400).json({
        message: `Cannot cancel proforma while order allocation ${blockingAlloc.allocationNo || ""} exists.`,
      });
    }
    if (dryRun) {
      return res.json({ dryRun: true, stockImpact: [] });
    }
    await withTransaction(async (session) => {
      doc.status = "CANCELLED";
      doc.cancelledAt = new Date();
      doc.cancelledBy = req.user?.email || "";
      doc.cancellationReason = reason;
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      await tryReleaseOAAfterProformaCancel(req, doc, session);
    });
    const fresh = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    res.json(fresh || doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function markProformaPaid(req, res) {
  return res.status(400).json({
    message:
      "Direct mark-paid is disabled. Use payment receipts workflow: POST /api/payment-receipts with payment details.",
  });
}

export async function convertQuotationToOA(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid quotation id" });
    const quotation = await Quotation.findOne(withCompany(req, { _id: id }));
    validateConversionSource(quotation, "quotation");
    requireApprovedQuotationForConversion(quotation);
    if (!quotation.lines?.length) {
      return res.status(400).json({ message: "Quotation requires at least one line to convert" });
    }
    const already = await OrderAcknowledgement.findOne(
      withCompany(req, { linkedQuotationId: quotation._id, status: { $ne: "CANCELLED" } })
    );
    if (already) return res.status(409).json({ message: `OA already exists (${already.oaNo})` });

    const oaNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "ORDER_ACK",
      model: OrderAcknowledgement,
      field: "oaNo",
    });
    const lines = normalizeLines(quotation.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines, quotation);
    const doc = await OrderAcknowledgement.create({
      companyId: req.companyId,
      oaNo,
      oaDate: new Date(),
      linkedQuotationId: quotation._id,
      linkedQuotationNo: quotation.quotationNo,
      customerName: quotation.customerName,
      paymentTerms: quotation.paymentTerms || "",
      incoterm: quotation.incoterm || "",
      currency: quotation.currency || "USD",
      acknowledgementNotes: quotation.remarks || "",
      deliverySchedule: quotation.deliveryTerms || "",
      vertical: quotation.vertical || "",
      engine: quotation.engine || "",
      model: quotation.model || "",
      config: quotation.config || "",
      esn: quotation.esn || "",
      lines,
      ...totals,
      status: "ACTIVE",
      createdBy: req.user?.email || "",
    });
    if (!quotation.convertedTo?.includes("OA")) quotation.convertedTo = [...(quotation.convertedTo || []), "OA"];
    quotation.status = "CONVERTED";
    quotation.updatedBy = req.user?.email || "";
    await quotation.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertQuotationToProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid quotation id" });
    const quotation = await Quotation.findOne(withCompany(req, { _id: id }));
    validateConversionSource(quotation, "quotation");
    requireApprovedQuotationForConversion(quotation);
    if (!quotation.lines?.length) {
      return res.status(400).json({ message: "Quotation requires at least one line to convert" });
    }
    const already = await ProformaInvoice.findOne(
      withCompany(req, { linkedQuotationId: quotation._id, status: { $ne: "CANCELLED" } })
    );
    if (already) return res.status(409).json({ message: `Proforma already exists (${already.proformaNo})` });

    const proformaNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "PROFORMA",
      model: ProformaInvoice,
      field: "proformaNo",
    });
    const lines = normalizeLines(quotation.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines, quotation);
    const doc = await ProformaInvoice.create({
      companyId: req.companyId,
      proformaNo,
      proformaDate: new Date(),
      linkedQuotationId: quotation._id,
      linkedQuotationNo: quotation.quotationNo,
      customerName: quotation.customerName,
      paymentTerms: quotation.paymentTerms || "",
      validity: quotation.validityDate ? new Date(quotation.validityDate).toISOString().slice(0, 10) : "",
      shipmentTerms: quotation.deliveryTerms || "",
      currency: quotation.currency || "USD",
      remarks: quotation.remarks || "",
      vertical: quotation.vertical || "",
      engine: quotation.engine || "",
      model: quotation.model || "",
      config: quotation.config || "",
      esn: quotation.esn || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!quotation.convertedTo?.includes("PROFORMA")) quotation.convertedTo = [...(quotation.convertedTo || []), "PROFORMA"];
    quotation.updatedBy = req.user?.email || "";
    await quotation.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertOAToProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid OA id" });
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    validateConversionSource(oa, "order acknowledgement");
    if (!oa.lines?.length) return res.status(400).json({ message: "OA requires at least one line to convert" });
    const already = await ProformaInvoice.findOne(
      withCompany(req, { linkedOAId: oa._id, status: { $ne: "CANCELLED" } })
    );
    if (already) return res.status(409).json({ message: `Proforma already exists (${already.proformaNo})` });

    const proformaNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "PROFORMA",
      model: ProformaInvoice,
      field: "proformaNo",
    });
    const lines = normalizeLines(oa.lines.map((line) => line.toObject?.() || line));
    let discountType = "NONE";
    let discountValue = 0;
    if (oa.linkedQuotationId) {
      const linkedQuote = await Quotation.findOne(withCompany(req, { _id: oa.linkedQuotationId }))
        .select("discountType discountValue discountTotal")
        .lean();
      if (linkedQuote) {
        discountType = linkedQuote.discountType || "NONE";
        discountValue = Number(linkedQuote.discountValue) || 0;
      }
    }
    if (!["PERCENT", "FLAT"].includes(String(discountType).toUpperCase()) && Number(oa.discountTotal) > 0) {
      discountType = "FLAT";
      discountValue = Number(oa.discountTotal) || 0;
    }
    const totals = computeTotals(lines, { ...oa, discountType, discountValue });
    const doc = await ProformaInvoice.create({
      companyId: req.companyId,
      proformaNo,
      proformaDate: new Date(),
      linkedQuotationId: oa.linkedQuotationId || null,
      linkedQuotationNo: oa.linkedQuotationNo || "",
      linkedOAId: oa._id,
      linkedOANo: oa.oaNo,
      customerName: oa.customerName,
      paymentTerms: oa.paymentTerms || "",
      shipmentTerms: oa.deliverySchedule || "",
      currency: oa.currency || "USD",
      remarks: oa.acknowledgementNotes || "",
      vertical: oa.vertical || "",
      engine: oa.engine || "",
      model: oa.model || "",
      config: oa.config || "",
      esn: oa.esn || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!oa.convertedTo?.includes("PROFORMA")) oa.convertedTo = [...(oa.convertedTo || []), "PROFORMA"];
    oa.status = "APPROVED";
    oa.updatedBy = req.user?.email || "";
    await oa.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertOAToSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid OA id" });
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    validateConversionSource(oa, "order acknowledgement");
    const allocation = await OrderAllocation.findOne(
      withCompany(req, { linkedOAId: oa._id, status: { $ne: "CANCELLED" } })
    )
      .sort({ allocationDate: -1 })
      .lean();
    if (!allocation) {
      return res.status(400).json({
        message: "Packing must be completed before creating Sales Invoice",
      });
    }
    req.params.id = String(allocation._id);
    req.body = { ...(req.body || {}), sourceOAId: id };
    return convertOrderAllocationToSalesInvoice(req, res);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listSalesInvoices(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ invoiceNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    if (req.query.paymentStatus) {
      filter.paymentStatus = String(req.query.paymentStatus).trim().toUpperCase();
    }
    const [itemsRaw, total] = await Promise.all([
      SalesInvoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SalesInvoice.countDocuments(filter),
    ]);
    // Phase-8.2 — recompute live payment buckets for any rows that
    // pre-date the persisted fields (and refresh slightly stale ones)
    // so the UI reads consistent numbers without a separate roundtrip.
    const items = await enrichSalesInvoicesWithPaymentState(req, itemsRaw);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function enrichSalesInvoicesWithPaymentState(req, docs = []) {
  const rows = Array.isArray(docs) ? docs : [];
  if (!rows.length) return rows;
  const ids = [...new Set(rows.map((x) => String(x._id || "")).filter(Boolean))];
  if (!ids.length) return rows;
  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  // Sum allocations[].allocatedAmount per SI across all non-cancelled receipts.
  const sums = await PaymentReceipt.aggregate([
    {
      $match: withCompany(req, {
        status: { $ne: "CANCELLED" },
        "allocations.targetType": "SALES_INVOICE",
        "allocations.targetId": { $in: objectIds },
      }),
    },
    { $unwind: "$allocations" },
    {
      $match: {
        "allocations.targetType": "SALES_INVOICE",
        "allocations.targetId": { $in: objectIds },
      },
    },
    {
      $group: {
        _id: "$allocations.targetId",
        total: { $sum: "$allocations.allocatedAmount" },
      },
    },
  ]);
  const sumByInvoiceId = new Map(sums.map((s) => [String(s._id), Number(s.total) || 0]));
  return rows.map((r) => {
    const total = Math.max(0, Number(r.grandTotal) || 0);
    const received = Math.max(0, sumByInvoiceId.get(String(r._id)) || 0);
    const balance = Math.max(0, total - received);
    let paymentStatus = "UNPAID";
    if (received > 0 && received < total) paymentStatus = "PARTIAL";
    if (received >= total && total > 0) paymentStatus = "PAID";
    return {
      ...r,
      totalReceivedAmount: received,
      balanceAmount: balance,
      paymentStatus,
    };
  });
}

export async function getSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await SalesInvoice.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    const [enriched] = await enrichSalesInvoicesWithPaymentState(req, [doc]);
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createSalesInvoice(req, res) {
  try {
    const body = { ...req.body };
    if (body.linkedStorePackingId) {
      req.params.id = String(body.linkedStorePackingId);
      return convertPackingToSalesInvoice(req, res);
    }
    return res.status(400).json({ message: "Packing must be completed before creating Sales Invoice" });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listPackingsReadyForInvoice(req, res) {
  try {
    const q = String(req.query.search || "").trim();
    const filter = withCompany(req, {
      status: "FULLY_PACKED",
      invoiceStatus: { $ne: "FULLY_INVOICED" },
    });
    if (q) {
      const re = new RegExp(q, "i");
      filter.$or = [{ packingNo: re }, { customerName: re }, { allocationNo: re }, { linkedOANo: re }, { linkedProformaNo: re }];
    }
    const rows = await StorePacking.find(filter).sort({ packingDate: -1 }).limit(200).lean();
    const items = [];
    for (const packing of rows) {
      const invoicedByLine = await invoicedQtyByPackingLine(req.companyId, packing._id);
      let packedQty = 0;
      let invoicedQty = 0;
      for (const line of packing.lines || []) {
        packedQty += Number(line.packQty) || 0;
        invoicedQty += invoicedByLine.get(String(line._id)) || 0;
      }
      const pendingInvoiceQty = Math.max(0, packedQty - invoicedQty);
      if (pendingInvoiceQty <= 0) continue;
      items.push({
        _id: packing._id,
        allocationId: packing.allocationId,
        packingNo: packing.packingNo,
        customerName: packing.customerName,
        allocationNo: packing.allocationNo,
        linkedOANo: packing.linkedOANo || "",
        linkedProformaNo: packing.linkedProformaNo || "",
        warehouse: packing.warehouse || "MAIN",
        status: packing.status,
        invoiceStatus: packing.invoiceStatus || "NOT_INVOICED",
        packedQty,
        invoicedQty,
        pendingInvoiceQty,
        totalPackages: packing.totalPackages || (packing.packages || []).length,
      });
    }
    res.json({ items, total: items.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPackingInvoicePreview(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid packing id" });
    const packing = await StorePacking.findOne(withCompany(req, { _id: id })).lean();
    if (!packing) return res.status(404).json({ message: "Packing not found" });
    if (String(packing.invoiceStatus || "").toUpperCase() === "FULLY_INVOICED") {
      return res.status(400).json({ message: "Sales invoice already created for this packing" });
    }
    if (String(packing.status || "").toUpperCase() !== "FULLY_PACKED") {
      return res.status(400).json({ message: "Packing must be FULLY_PACKED before creating Sales Invoice" });
    }
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: packing.allocationId })).lean();
    const invoicedByLine = await invoicedQtyByPackingLine(req.companyId, packing._id);
    const lines = (packing.lines || []).map((line) => {
      const allocationLine = (allocation?.lines || []).find((x) => String(x._id) === String(line.allocationLineId));
      const packedQty = Number(line.packQty) || 0;
      const invoicedQty = invoicedByLine.get(String(line._id)) || 0;
      const pendingInvoiceQty = Math.max(0, packedQty - invoicedQty);
      return {
        ...packedInvoiceLineFromPackingLine(line, allocationLine, pendingInvoiceQty),
        packedQty,
        invoicedQty,
        pendingInvoiceQty,
      };
    });
    res.json({ packing, allocation, lines, packages: packing.packages || [] });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function convertPackingToSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid packing id" });
    const packingPre = await StorePacking.findOne(withCompany(req, { _id: id })).lean();
    if (!packingPre) return res.status(404).json({ message: "Packing not found" });
    if (String(packingPre.invoiceStatus || "").toUpperCase() === "FULLY_INVOICED") {
      return res.status(400).json({ message: "Sales invoice already created for this packing" });
    }
    if (String(packingPre.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Cannot invoice cancelled packing" });
    }
    if (String(packingPre.status || "").toUpperCase() !== "FULLY_PACKED") {
      return res.status(400).json({ message: "Packing must be FULLY_PACKED before creating Sales Invoice" });
    }
    const allocationPre = await OrderAllocation.findOne(withCompany(req, { _id: packingPre.allocationId })).lean();
    if (!allocationPre) return res.status(404).json({ message: "Linked allocation not found" });
    const invoicedByLinePre = await invoicedQtyByPackingLine(req.companyId, packingPre._id);
    const requestedQtyByLine = new Map(
      (req.body?.lines || [])
        .map((line) => [String(line.packingLineId || ""), Number(line.qty) || 0])
        .filter(([lineId, qty]) => lineId && qty > 0)
    );
    const rawLines = [];
    for (const packingLine of packingPre.lines || []) {
      const allocationLine = (allocationPre.lines || []).find((x) => String(x._id) === String(packingLine.allocationLineId));
      const packedQty = Number(packingLine.packQty) || 0;
      const invoicedQty = invoicedByLinePre.get(String(packingLine._id)) || 0;
      const pendingQty = Math.max(0, packedQty - invoicedQty);
      const requestedQty = requestedQtyByLine.size ? Math.min(requestedQtyByLine.get(String(packingLine._id)) || 0, pendingQty) : pendingQty;
      if (requestedQty > 0) rawLines.push(packedInvoiceLineFromPackingLine(packingLine, allocationLine, requestedQty));
    }
    const lines = normalizeLines(rawLines);
    if (!lines.length) return res.status(400).json({ message: "Packing has no pending invoice quantity" });
    const totals = computeTotals(lines, allocationPre);
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "SALES",
      actionKey: "invoice_post",
      documentType: "SALES_INVOICE",
      documentNo: "",
      customerName: packingPre.customerName || "",
      amount: totals.grandTotal || 0,
      currency: packingPre.currency || "USD",
      description: `Post sales invoice from packing ${packingPre.packingNo}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));
    const invoiceNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "SALES_INVOICE",
      model: SalesInvoice,
      field: "invoiceNo",
    });

    let createdId = null;
    await withTransaction(async (session) => {
      const packing = await StorePacking.findOne(withCompany(req, { _id: id })).session(session);
      if (!packing) throw new Error("Packing not found");
      if (String(packing.invoiceStatus || "").toUpperCase() === "FULLY_INVOICED") {
        throw new Error("Sales invoice already created for this packing");
      }
      if (String(packing.status || "").toUpperCase() === "CANCELLED") throw new Error("Cannot invoice cancelled packing");
      if (String(packing.status || "").toUpperCase() !== "FULLY_PACKED") {
        throw new Error("Packing must be FULLY_PACKED before creating Sales Invoice");
      }
      const allocation = await OrderAllocation.findOne(withCompany(req, { _id: packing.allocationId })).session(session);
      if (!allocation) throw new Error("Linked allocation not found");
      const invoicedByLine = await invoicedQtyByPackingLine(req.companyId, packing._id, session);
      for (const line of lines) {
        const packingLine = (packing.lines || []).find((x) => String(x._id) === String(line.packingLineId));
        const packedQty = Number(packingLine?.packQty) || 0;
        const invoicedQty = invoicedByLine.get(String(line.packingLineId)) || 0;
        if (invoicedQty + (Number(line.qty) || 0) > packedQty + 1e-6) {
          throw new Error(`Invoice qty exceeds packed pending invoice qty for ${line.article}`);
        }
      }
      const [doc] = await SalesInvoice.create(
        [
          {
            companyId: req.companyId,
            invoiceNo,
            invoiceNumber: invoiceNo,
            invoiceDate: req.body?.invoiceDate || new Date(),
            linkedQuotationId: allocation.linkedQuotationId || null,
            linkedQuotationNo: allocation.linkedQuotationNo || "",
            linkedOAId: allocation.linkedOAId || null,
            linkedOANo: allocation.linkedOANo || "",
            linkedProformaId: allocation.linkedProformaId || null,
            linkedProformaNo: allocation.linkedProformaNo || "",
            linkedOrderAllocationId: allocation._id,
            linkedOrderAllocationNo: allocation.allocationNo,
            linkedStorePackingId: packing._id,
            linkedStorePackingNo: packing.packingNo,
            customerName: packing.customerName,
            paymentTerms: req.body?.paymentTerms || "",
            dispatchDetails: "",
            shippingAddress: req.body?.shippingAddress || "",
            billingAddress: req.body?.billingAddress || "",
            currency: packing.currency || allocation.currency || "USD",
            vertical: allocation.vertical || "",
            engine: packing.engine || allocation.engine || "",
            model: packing.model || allocation.model || "",
            config: allocation.config || "",
            esn: packing.esn || allocation.esn || "",
            remarks: t(req.body?.remarks),
            lines,
            ...totals,
            status: "ISSUED",
            stockPostedAt: null,
            createdBy: req.user?.email || "",
          },
        ],
        { session }
      );
      createdId = doc._id;
      await postSalesInvoiceReceivable({ req, invoice: doc, session });
      const refreshedPacking = await recalcPackingInvoiceStatus({ companyId: req.companyId, packingId: packing._id, session });
      allocation.linkedSalesInvoiceId = doc._id;
      allocation.linkedSalesInvoiceNo = doc.invoiceNo;
      await persistAllocationFulfilment(req.companyId, allocation, session);
      if (refreshedPacking?.invoiceStatus === "FULLY_INVOICED") allocation.status = "CLOSED";
      allocation.updatedBy = req.user?.email || "";
      await allocation.save({ session });
    });
    const doc = await SalesInvoice.findOne(withCompany(req, { _id: createdId })).lean();
    await writeAudit(req, {
      action: "CREATE",
      module: "SALES",
      entityType: "SALES_INVOICE",
      entityId: doc._id,
      documentNo: doc.invoiceNo,
      toStatus: "ISSUED",
      description: `Sales Invoice ${doc.invoiceNo} created from packing ${doc.linkedStorePackingNo}`,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message || String(err) });
  }
}

export async function updateSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await SalesInvoice.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    // Phase-8: posted invoices are immutable except for status (which
    // goes through the lifecycle). Block free-form edits the moment
    // stock has been posted out so accounts and stock stay consistent.
    const canon = canonicalStatus(DOC_TYPES.SALES_INVOICE, doc.status);
    if (["POSTED", "PARTIAL_PAYMENT", "PAID", "CANCELLED"].includes(canon)) {
      const requestedStatus = req.body?.status;
      const otherEditedKey = Object.keys(req.body || {}).find((k) => k !== "status" && k !== "remarks");
      if (otherEditedKey) {
        blockTransition(
          DOC_TYPES.SALES_INVOICE,
          doc.status,
          doc.status,
          `Cannot edit field "${otherEditedKey}" on a ${canon} sales invoice (${doc.invoiceNo}). Cancel and re-issue if needed.`,
          { invoiceNo: doc.invoiceNo, attemptedField: otherEditedKey }
        );
      }
      if (requestedStatus && canonicalStatus(DOC_TYPES.SALES_INVOICE, requestedStatus) !== canon) {
        assertTransition(DOC_TYPES.SALES_INVOICE, doc.status, requestedStatus, { documentNo: doc.invoiceNo });
      }
    }
    const allowed = [
      "invoiceDate",
      "customerName",
      "paymentTerms",
      "dispatchDetails",
      "shippingAddress",
      "billingAddress",
      "customerReference",
      "loadingPort",
      "dischargePort",
      "consignee",
      "customerVatNo",
      "currency",
      "status",
      "remarks",
      "lines",
      "packingCost",
      "clearanceCost",
      "vertical",
      "engine",
      "model",
      "config",
      "esn",
    ];
    const beforeSnapshot = doc.toObject();
    const beforeCanon = canonicalStatus(DOC_TYPES.SALES_INVOICE, beforeSnapshot.status);
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines, doc));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    const afterCanon = canonicalStatus(DOC_TYPES.SALES_INVOICE, doc.status);
    if (beforeCanon === "DRAFT" && ["POSTED", "PARTIAL_PAYMENT", "PAID"].includes(afterCanon)) {
      await postSalesInvoiceReceivable({ req, invoice: doc });
    }
    await writeAudit(req, {
      action: "UPDATE",
      module: "SALES",
      entityType: "SALES_INVOICE",
      entityId: doc._id,
      documentNo: doc.invoiceNo,
      description: `Sales Invoice ${doc.invoiceNo} updated`,
      beforeData: { status: beforeSnapshot.status, grandTotal: beforeSnapshot.grandTotal },
      afterData: { status: doc.status, grandTotal: doc.grandTotal },
    });
    res.json(doc);
  } catch (err) {
    if (err?.code === "INVALID_TRANSITION") {
      return res.status(err.statusCode || 409).json({ message: err.message, code: err.code, details: err.details });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function cancelSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const dryRun = req.query.dryRun === "1" || req.body?.dryRun === true;
    const reason = String(req.body?.cancellationReason ?? req.body?.reason ?? "").trim();
    if (!dryRun && !reason) return res.status(400).json({ message: "cancellationReason is required" });
    const inv = await SalesInvoice.findOne(withCompany(req, { _id: id }));
    if (!inv) return res.status(404).json({ message: "Not found" });
    const prevInvStatus = String(inv.status || "");
    if (canonicalStatus(DOC_TYPES.SALES_INVOICE, prevInvStatus) === "CANCELLED") {
      return res.status(400).json({ message: "Sales invoice is already cancelled" });
    }
    // Phase-8: block cancel if any payment has been received against this
    // invoice. The frontend should remove receipts via the Payments tab
    // first; mirroring the proforma behaviour.
    const receivedAgg = await PaymentReceipt.aggregate([
      {
        $match: withCompany(req, {
          status: { $ne: "CANCELLED" },
          "allocations.targetType": "SALES_INVOICE",
          "allocations.targetId": new mongoose.Types.ObjectId(inv._id),
        }),
      },
      { $unwind: "$allocations" },
      {
        $match: {
          "allocations.targetType": "SALES_INVOICE",
          "allocations.targetId": new mongoose.Types.ObjectId(inv._id),
        },
      },
      { $group: { _id: null, total: { $sum: "$allocations.allocatedAmount" } } },
    ]);
    const receivedAmount = Number(receivedAgg[0]?.total || 0);
    if (receivedAmount > 0) {
      blockTransition(
        DOC_TYPES.SALES_INVOICE,
        prevInvStatus,
        "CANCELLED",
        `Cannot cancel sales invoice ${inv.invoiceNo}: ${receivedAmount.toFixed(2)} ${inv.currency || "USD"} already received. Reverse the payments first.`,
        { receivedAmount, invoiceNo: inv.invoiceNo }
      );
    }
    if (inv.linkedStorePackingId) {
      const postedDispatch = await StoreDispatch.findOne(
        withCompany(req, { salesInvoiceId: inv._id, status: { $in: POSTED_STORE_DISPATCH_STATUSES } })
      ).lean();
      if (postedDispatch) {
        return res.status(400).json({ message: "Cannot cancel invoice after dispatch. Cancel dispatch first." });
      }
    }
    assertTransition(DOC_TYPES.SALES_INVOICE, prevInvStatus, "CANCELLED", { documentNo: inv.invoiceNo });
    let warehouse = "MAIN";
    let allocation = null;
    if (inv.linkedOrderAllocationId) {
      allocation = await OrderAllocation.findOne(withCompany(req, { _id: inv.linkedOrderAllocationId }));
      if (allocation?.warehouse) warehouse = String(allocation.warehouse).trim().toUpperCase() || "MAIN";
    }
    const lines = (inv.lines || [])
      .map((l) => ({ article: l.article, qty: Number(l.qty) || 0 }))
      .filter((x) => x.article && x.qty > 0);
    const stockImpact = inv.linkedStorePackingId
      ? []
      : lines.map((l) => ({
          article: l.article,
          qty: l.qty,
          from: "INVOICED",
          to: "RTS",
        }));
    if (dryRun) {
      return res.json({ dryRun: true, stockImpact });
    }
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "SALES",
      actionKey: "invoice_cancel",
      documentType: "SALES_INVOICE",
      documentId: inv._id,
      documentNo: inv.invoiceNo,
      customerName: inv.customerName || "",
      amount: inv.grandTotal || 0,
      currency: inv.currency || "USD",
      description: `Cancel sales invoice ${inv.invoiceNo}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));
    await withTransaction(async (session) => {
      if (inv.stockPostedAt) {
        for (const [article, qty] of dedupeLines(lines)) {
          await stockService.cancelInvoice({
            session,
            companyId: req.companyId,
            article,
            warehouse,
            qty,
            customerName: inv.customerName || "",
            referenceType: "SALES_INVOICE_CANCEL",
            referenceNo: inv.invoiceNo,
            remarks: reason,
            createdBy: req.user?.email || "",
            sourceModule: "SALES",
          });
        }
      }
      inv.status = "CANCELLED";
      inv.cancelledAt = new Date();
      inv.cancelledBy = req.user?.email || "";
      inv.cancellationReason = reason;
      inv.updatedBy = req.user?.email || "";
      await inv.save({ session });
      await reverseSalesInvoiceReceivable({ req, invoice: inv, reason, session });
      if (inv.linkedRtsId) {
        await Rts.findOneAndUpdate(
          withCompany(req, { _id: inv.linkedRtsId }),
          {
            status: "APPROVED",
            linkedSalesInvoiceId: null,
            linkedSalesInvoiceNo: "",
            updatedBy: req.user?.email || "",
          },
          { session }
        );
      }
      if (inv.linkedStorePackingId) {
        const refreshedPacking = await recalcPackingInvoiceStatus({
          companyId: req.companyId,
          packingId: inv.linkedStorePackingId,
          session,
        });
        if (allocation) {
          const remainingInvoice = await SalesInvoice.findOne(
            withCompany(req, {
              linkedOrderAllocationId: allocation._id,
              _id: { $ne: inv._id },
              status: { $ne: "CANCELLED" },
            })
          )
            .sort({ invoiceDate: -1 })
            .session(session)
            .lean();
          allocation.linkedSalesInvoiceId = remainingInvoice?._id || null;
          allocation.linkedSalesInvoiceNo = remainingInvoice?.invoiceNo || "";
          allocation.status = refreshedPacking?.invoiceStatus === "FULLY_INVOICED" ? "CLOSED" : refreshedPacking?.status || allocation.status;
          allocation.updatedBy = req.user?.email || "";
          await allocation.save({ session });
        }
      }
      if (allocation && (inv.linkedRtsId || inv.stockPostedAt)) {
        allocation.linkedSalesInvoiceId = null;
        allocation.linkedSalesInvoiceNo = "";
        const postedDocs = await postedRtsByAllocation(req, allocation._id, session);
        const shipped = shippedQtyMapForAllocation(postedDocs);
        let complete = true;
        for (const line of allocation.lines || []) {
          const qty = Number(line.qty) || 0;
          const done = shipped.get(String(line._id || "")) || 0;
          if (done < qty) {
            complete = false;
            break;
          }
        }
        allocation.status = complete ? "RTS_COMPLETE" : "PARTIALLY_RTS";
        allocation.updatedBy = req.user?.email || "";
        await allocation.save({ session });
      }
    });
    await writeStatusChange(req, {
      module: "SALES",
      entityType: "SALES_INVOICE",
      entityId: inv._id,
      documentNo: inv.invoiceNo,
      fromStatus: canonicalStatus(DOC_TYPES.SALES_INVOICE, prevInvStatus),
      toStatus: "CANCELLED",
      description: `Sales Invoice ${inv.invoiceNo} cancelled`,
      metadata: { reason, restoredLines: stockImpact },
    });
    const fresh = await SalesInvoice.findOne(withCompany(req, { _id: id }));
    res.json(fresh);
  } catch (err) {
    if (err?.code === "INVALID_TRANSITION" || err?.code === "STOCK_INSUFFICIENT") {
      return res.status(err.statusCode || 409).json({ message: err.message, code: err.code, details: err.details });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function listSalesDispatches(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ dispatchNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedSalesInvoiceNo: new RegExp(q, "i") }];
    }
    const [rawItems, total] = await Promise.all([
      SalesDispatch.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SalesDispatch.countDocuments(filter),
    ]);
    const items = await enrichSalesDispatchesWithInvoiceStatus(req.companyId, rawItems);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSalesDispatch(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await SalesDispatch.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    const [enriched] = await enrichSalesDispatchesWithInvoiceStatus(req.companyId, [doc]);
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/**
 * PATCH /sales/sales-dispatches/:id
 * Body: { status?: "DISPATCHED" | "CLOSED", postCustomerLedgerCredit?: boolean, remarks?: string }
 * — DRAFT→DISPATCHED (shipped); DISPATCHED→CLOSED only if linked sales invoice is PAID.
 */
export async function patchSalesDispatch(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const dispatch = await SalesDispatch.findOne(withCompany(req, { _id: id }));
    if (!dispatch) return res.status(404).json({ message: "Not found" });

    if (req.body.remarks !== undefined) {
      dispatch.remarks = String(req.body.remarks || "");
    }

    const nextStatus = req.body.status != null ? String(req.body.status).toUpperCase().trim() : "";
    const cur = String(dispatch.status || "").toUpperCase();

    if (nextStatus) {
      if (nextStatus === "READY" && cur === "DRAFT") {
        dispatch.status = "READY";
        dispatch.updatedBy = req.user?.email || "";
        await dispatch.save();
        await writeStatusChange(req, {
          module: "LOGISTICS",
          entityType: "SALES_DISPATCH",
          entityId: dispatch._id,
          documentNo: dispatch.dispatchNo,
          fromStatus: cur,
          toStatus: "READY",
          description: `Dispatch ${dispatch.dispatchNo} marked ready`,
        });
        const lean = dispatch.toObject();
        const [enriched] = await enrichSalesDispatchesWithInvoiceStatus(req.companyId, [lean]);
        return res.json(enriched);
      }

      if (nextStatus === "DISPATCHED" && ["DRAFT", "READY"].includes(cur)) {
        dispatch.status = "DISPATCHED";
        dispatch.dispatchedQty = Number(dispatch.dispatchedQty || dispatch.totalQty || 0);
        dispatch.pendingQty = Math.max(0, Number(dispatch.totalQty || 0) - Number(dispatch.dispatchedQty || 0));
        dispatch.updatedBy = req.user?.email || "";
        await dispatch.save();
        await writeStatusChange(req, {
          module: "LOGISTICS",
          entityType: "SALES_DISPATCH",
          entityId: dispatch._id,
          documentNo: dispatch.dispatchNo,
          fromStatus: cur,
          toStatus: "DISPATCHED",
          description: `Dispatch ${dispatch.dispatchNo} posted`,
        });
        const lean = dispatch.toObject();
        const [enriched] = await enrichSalesDispatchesWithInvoiceStatus(req.companyId, [lean]);
        return res.json(enriched);
      }

      if (nextStatus === "IN_TRANSIT" && cur === "DISPATCHED") {
        dispatch.status = "IN_TRANSIT";
        dispatch.trackingStatus = "in_transit";
        dispatch.updatedBy = req.user?.email || "";
        await dispatch.save();
        await writeStatusChange(req, {
          module: "LOGISTICS",
          entityType: "SALES_DISPATCH",
          entityId: dispatch._id,
          documentNo: dispatch.dispatchNo,
          fromStatus: cur,
          toStatus: "IN_TRANSIT",
          description: `Dispatch ${dispatch.dispatchNo} marked in transit`,
        });
        const lean = dispatch.toObject();
        const [enriched] = await enrichSalesDispatchesWithInvoiceStatus(req.companyId, [lean]);
        return res.json(enriched);
      }

      if (nextStatus === "DELIVERED" && ["DISPATCHED", "IN_TRANSIT"].includes(cur)) {
        dispatch.status = "DELIVERED";
        dispatch.trackingStatus = "delivered";
        dispatch.deliveredAt = new Date();
        dispatch.deliveredBy = req.user?.email || "";
        dispatch.updatedBy = req.user?.email || "";
        await dispatch.save();
        await writeStatusChange(req, {
          module: "LOGISTICS",
          entityType: "SALES_DISPATCH",
          entityId: dispatch._id,
          documentNo: dispatch.dispatchNo,
          fromStatus: cur,
          toStatus: "DELIVERED",
          description: `Dispatch ${dispatch.dispatchNo} delivered`,
        });
        const lean = dispatch.toObject();
        const [enriched] = await enrichSalesDispatchesWithInvoiceStatus(req.companyId, [lean]);
        return res.json(enriched);
      }

      if (nextStatus === "CLOSED" && ["DISPATCHED", "IN_TRANSIT", "DELIVERED"].includes(cur)) {
        const inv = await SalesInvoice.findOne(withCompany(req, { _id: dispatch.linkedSalesInvoiceId }));
        if (!inv) return res.status(400).json({ message: "Linked sales invoice not found" });
        if (String(inv.status || "").toUpperCase() !== "PAID") {
          return res.status(400).json({
            message: "Sales invoice must be PAID before closing this dispatch (settle payment on the invoice first).",
          });
        }
        dispatch.status = "CLOSED";
        dispatch.closedAt = new Date();
        dispatch.closedBy = req.user?.email || "";
        const postCredit = req.body.postCustomerLedgerCredit === true;
        if (postCredit && !dispatch.ledgerCloseEntryId) {
          const credit = Number(dispatch.grandTotal) || 0;
          if (credit > 0) {
            const entry = await CustomerLedgerEntry.create({
              companyId: req.companyId,
              entryDate: new Date(),
              customerName: dispatch.customerName,
              referenceType: "SALES_DISPATCH_CLOSE",
              referenceNumber: dispatch.dispatchNo,
              debit: 0,
              credit,
              narrative: `Dispatch closed — payment received (${dispatch.dispatchNo})`,
              createdBy: req.user?.email || "",
            });
            dispatch.ledgerCloseEntryId = entry._id;
          }
        }
        dispatch.updatedBy = req.user?.email || "";
        await dispatch.save();
        await writeStatusChange(req, {
          module: "LOGISTICS",
          entityType: "SALES_DISPATCH",
          entityId: dispatch._id,
          documentNo: dispatch.dispatchNo,
          fromStatus: cur,
          toStatus: "CLOSED",
          description: `Dispatch ${dispatch.dispatchNo} closed`,
        });
        const lean = dispatch.toObject();
        const [enriched] = await enrichSalesDispatchesWithInvoiceStatus(req.companyId, [lean]);
        return res.json(enriched);
      }

      if (nextStatus === "CANCELLED" && !["DELIVERED", "CLOSED", "CANCELLED"].includes(cur)) {
        dispatch.status = "CANCELLED";
        dispatch.updatedBy = req.user?.email || "";
        await dispatch.save();
        await writeStatusChange(req, {
          module: "LOGISTICS",
          entityType: "SALES_DISPATCH",
          entityId: dispatch._id,
          documentNo: dispatch.dispatchNo,
          fromStatus: cur,
          toStatus: "CANCELLED",
          description: `Dispatch ${dispatch.dispatchNo} cancelled`,
          metadata: { reason: req.body.reason || req.body.remarks || "" },
        });
        const lean = dispatch.toObject();
        const [enriched] = await enrichSalesDispatchesWithInvoiceStatus(req.companyId, [lean]);
        return res.json(enriched);
      }

      return res.status(400).json({ message: `Invalid status transition (${cur} → ${nextStatus})` });
    }

    dispatch.updatedBy = req.user?.email || "";
    await dispatch.save();
    const lean = dispatch.toObject();
    const [enriched] = await enrichSalesDispatchesWithInvoiceStatus(req.companyId, [lean]);
    res.json(enriched);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertSalesInvoiceToSalesDispatch(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid sales invoice id" });
    const invoice = await SalesInvoice.findOne(withCompany(req, { _id: id }));
    validateConversionSource(invoice, "sales invoice");
    if (!invoice?.lines?.length) return res.status(400).json({ message: "Sales invoice requires at least one line to convert" });
    if (String(invoice.status || "").toUpperCase() !== "DISPATCHED") {
      return res.status(400).json({ message: "Sales invoice must be DISPATCHED before converting to Sales Dispatch" });
    }
    const existingDispatches = await SalesDispatch.find(
      withCompany(req, { linkedSalesInvoiceId: invoice._id, status: { $ne: "CANCELLED" } })
    ).lean();
    const dispatchNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "SALES_DISPATCH",
    });
    const invoiceLines = normalizeLines(invoice.lines.map((line) => line.toObject?.() || line));
    const requestedLines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    const alreadyDispatched = new Map();
    for (const dispatch of existingDispatches) {
      for (const line of dispatch.lines || []) {
        const key = String(line.sourceLineId || line.article || "");
        alreadyDispatched.set(key, (alreadyDispatched.get(key) || 0) + (Number(line.qty) || 0));
      }
    }
    const requestedByKey = new Map(
      requestedLines
        .map((l) => [String(l.sourceLineId || l._id || l.article || ""), Number(l.qty) || 0])
        .filter(([, qty]) => qty > 0)
    );
    const lines = invoiceLines
      .map((line) => {
        const key = String(line._id || line.article || "");
        const articleKey = String(line.article || "");
        const requestedQty = requestedByKey.size ? requestedByKey.get(key) ?? requestedByKey.get(articleKey) ?? 0 : Number(line.qty) || 0;
        const used = alreadyDispatched.get(key) || alreadyDispatched.get(articleKey) || 0;
        const pending = Math.max(0, (Number(line.qty) || 0) - used);
        const qty = Math.min(pending, Math.max(0, requestedQty));
        return {
          ...line,
          sourceLineId: line._id || null,
          qty,
          dispatchedQty: qty,
          pendingQty: Math.max(0, pending - qty),
          countryOfOrigin: line.coo || line.countryOfOrigin || "",
        };
      })
      .filter((line) => Number(line.qty) > 0);
    if (!lines.length) {
      return res.status(409).json({ message: "No pending dispatch quantity remains for this sales invoice." });
    }
    const totals = computeTotals(lines, invoice);
    const qtyTotal = lines.reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
    const doc = await SalesDispatch.create({
      companyId: req.companyId,
      dispatchNo,
      dispatchDate: new Date(),
      linkedSalesInvoiceId: invoice._id,
      linkedSalesInvoiceNo: invoice.invoiceNo,
      linkedRtsId: invoice.linkedRtsId || null,
      linkedRtsNo: invoice.linkedRtsNo || "",
      customerName: invoice.customerName,
      currency: invoice.currency || "USD",
      vertical: invoice.vertical || "",
      engine: invoice.engine || "",
      model: invoice.model || "",
      config: invoice.config || "",
      esn: invoice.esn || "",
      remarks: invoice.remarks || "",
      lines,
      ...totals,
      totalQty: qtyTotal,
      dispatchedQty: qtyTotal,
      pendingQty: 0,
      packingListNo: `${dispatchNo}-PL`,
      packingListGeneratedAt: new Date(),
      status: "READY",
      createdBy: req.user?.email || "",
    });
    invoice.linkedSalesDispatchId = doc._id;
    invoice.linkedSalesDispatchNo = doc.dispatchNo;
    invoice.updatedBy = req.user?.email || "";
    await invoice.save();
    await writeAudit(req, {
      action: "CREATE",
      module: "LOGISTICS",
      entityType: "SALES_DISPATCH",
      entityId: doc._id,
      documentNo: doc.dispatchNo,
      toStatus: doc.status,
      description: `Dispatch ${doc.dispatchNo} created from sales invoice ${invoice.invoiceNo}`,
      metadata: { invoiceNo: invoice.invoiceNo, rtsNo: doc.linkedRtsNo || "", partial: existingDispatches.length > 0 },
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertProformaToSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid proforma id" });
    const proforma = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    validateConversionSource(proforma, "proforma");
    const allocation = await OrderAllocation.findOne(
      withCompany(req, { linkedProformaId: proforma._id, status: { $ne: "CANCELLED" } })
    )
      .sort({ allocationDate: -1 })
      .lean();
    if (!allocation) {
      return res.status(400).json({
        message: "Packing must be completed before creating Sales Invoice",
      });
    }
    req.params.id = String(allocation._id);
    req.body = { ...(req.body || {}), sourceProformaId: id };
    return convertOrderAllocationToSalesInvoice(req, res);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertProformaToCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid proforma id" });
    const proforma = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    validateConversionSource(proforma, "proforma");
    if (!proforma.lines?.length) return res.status(400).json({ message: "Proforma requires at least one line to convert" });
    const si = await SalesInvoice.findOne(
      withCompany(req, { linkedProformaId: proforma._id, status: { $ne: "CANCELLED" } })
    );
    if (si) return res.status(409).json({ message: `Sales invoice already exists (${si.invoiceNo}) — cannot create CIPL from proforma` });
    const already = await Cipl.findOne(
      withCompany(req, { linkedProformaId: proforma._id, status: { $ne: "CANCELLED" } })
    );
    if (already) return res.status(409).json({ message: `CIPL already exists (${already.ciplNo})` });

    const ciplNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "CIPL",
    });
    const lines = normalizeLines(proforma.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines, proforma);
    const doc = await Cipl.create({
      companyId: req.companyId,
      ciplNo,
      ciplDate: new Date(),
      linkedQuotationId: proforma.linkedQuotationId || null,
      linkedQuotationNo: proforma.linkedQuotationNo || "",
      linkedOAId: proforma.linkedOAId || null,
      linkedOANo: proforma.linkedOANo || "",
      linkedProformaId: proforma._id,
      linkedProformaNo: proforma.proformaNo,
      customerName: proforma.customerName,
      incoterm: "",
      currency: proforma.currency || "USD",
      remarks: proforma.remarks || "",
      vertical: proforma.vertical || "",
      engine: proforma.engine || "",
      model: proforma.model || "",
      config: proforma.config || "",
      esn: proforma.esn || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    proforma.status = "APPROVED";
    proforma.updatedBy = req.user?.email || "";
    await proforma.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listOrderAllocations(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ allocationNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [itemsRaw, total] = await Promise.all([
      OrderAllocation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAllocation.countDocuments(filter),
    ]);
    const items = [];
    for (const allocation of itemsRaw) {
      const snapshot = await allocationFulfilmentSnapshot(req.companyId, allocation);
      items.push({ ...allocation, ...snapshot });
    }
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await OrderAllocation.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    const packings = await StorePacking.find(
      withCompany(req, {
        allocationId: doc._id,
        status: { $in: POSTED_STORE_PACKING_STATUSES },
      })
    ).lean();
    const packed = new Map();
    for (const packing of packings) {
      for (const line of packing.lines || []) {
        const key = String(line.allocationLineId || "");
        if (!key) continue;
        packed.set(key, (packed.get(key) || 0) + (Number(line.packQty) || 0));
      }
    }
    const lines = (doc.lines || []).map((l) => {
      const lineId = String(l._id || "");
      const packedQty = packed.get(lineId) || 0;
      const pendingPackQty = Math.max(0, (Number(l.qty) || 0) - packedQty);
      return { ...l, packedQty, pendingPackQty, pendingQty: pendingPackQty };
    });
    const snapshot = await allocationFulfilmentSnapshot(req.companyId, doc);
    res.json({ ...doc, ...snapshot, lines });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportOrderAllocation(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ allocationNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [rows, total] = await Promise.all([
      OrderAllocation.find(filter).sort({ allocationDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAllocation.countDocuments(filter),
    ]);
    const rowsOut = [];
    for (const r of rows) {
      const snapshot = await allocationFulfilmentSnapshot(req.companyId, r);
      rowsOut.push({
        _id: r._id,
        allocationNo: r.allocationNo,
        allocationDate: r.allocationDate,
        linkedOANo: r.linkedOANo || "",
        linkedProformaNo: r.linkedProformaNo || "",
        customerName: r.customerName || "",
        vertical: r.vertical || "",
        engine: r.engine || "",
        model: r.model || "",
        config: r.config || "",
        esn: r.esn || "",
        status: r.status || "OPEN",
        packingStatus: snapshot.packingStatus,
        invoiceStatus: snapshot.invoiceStatus,
        dispatchStatus: snapshot.dispatchStatus,
        allocatedQty: snapshot.allocatedQty,
        packedQty: snapshot.packedQty,
        pendingPackingQty: snapshot.pendingPackingQty,
        invoicedQty: snapshot.invoicedQty,
        pendingInvoiceQty: snapshot.pendingInvoiceQty,
        dispatchedQty: snapshot.dispatchedQty,
        pendingDispatchQty: snapshot.pendingDispatchQty,
        lineCount: Array.isArray(r.lines) ? r.lines.length : 0,
      });
    }
    res.json({ rows: rowsOut, total, page, limit, totals: { totalOrderAllocations: total } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportRts(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ rtsNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedOrderAllocationNo: new RegExp(q, "i") }];
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [rows, total] = await Promise.all([
      Rts.find(filter).sort({ rtsDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Rts.countDocuments(filter),
    ]);
    const rowsOut = rows.map((r) => ({
      _id: r._id,
      rtsNo: r.rtsNo,
      rtsDate: r.rtsDate,
      linkedOrderAllocationNo: r.linkedOrderAllocationNo || "",
      customerName: r.customerName || "",
      vertical: r.vertical || "",
      engine: r.engine || "",
      model: r.model || "",
      config: r.config || "",
      esn: r.esn || "",
      status: r.status || "DRAFT",
      boxCount: Number(r.packingDetails?.boxCount || 0),
      totalWeightKg: Number(r.packingDetails?.totalWeightKg || 0),
      lineCount: Array.isArray(r.lines) ? r.lines.length : 0,
    }));
    res.json({ rows: rowsOut, total, page, limit, totals: { totalRTS: total } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportBackorder(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const search = String(req.query.search || "").trim();
    const customer = String(req.query.customer || "").trim();
    const articleFilter = String(req.query.article || "").trim().toUpperCase();
    const referenceNo = String(req.query.referenceNo || "").trim();

    const filter = withCompany(req, { status: { $nin: ["CANCELLED", "CLOSED"] } });
    if (customer) filter.customerName = new RegExp(customer, "i");
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [{ allocationNo: re }, { customerName: re }, { linkedProformaNo: re }, { linkedOANo: re }];
    }
    if (articleFilter) filter["lines.article"] = articleFilter;

    const allocations = await OrderAllocation.find(filter)
      .sort({ allocationDate: -1, createdAt: -1 })
      .lean();
    const allocationIds = allocations.map((a) => a._id);
    const [rtsRows, invoiceRows] = allocationIds.length
      ? await Promise.all([
          Rts.find(withCompany(req, { linkedOrderAllocationId: { $in: allocationIds }, status: { $nin: ["CANCELLED"] } }))
            .select("linkedOrderAllocationId status lines")
            .lean(),
          SalesInvoice.find(withCompany(req, { linkedOrderAllocationId: { $in: allocationIds }, status: { $ne: "CANCELLED" } }))
            .select("linkedOrderAllocationId status lines")
            .lean(),
        ])
      : [[], []];

    const rtsByAllocationArticle = new Map();
    for (const rts of rtsRows) {
      if (String(rts.status || "").toUpperCase() !== "APPROVED") continue;
      const allocationId = String(rts.linkedOrderAllocationId || "");
      for (const line of rts.lines || []) {
        const article = String(line.article || "").trim().toUpperCase();
        const qty = Number(line.qty) || 0;
        if (!article || !(qty > 0)) continue;
        const key = `${allocationId}::${article}`;
        rtsByAllocationArticle.set(key, (rtsByAllocationArticle.get(key) || 0) + qty);
      }
    }
    const invoiceByAllocationArticle = new Map();
    for (const inv of invoiceRows) {
      const allocationId = String(inv.linkedOrderAllocationId || "");
      for (const line of inv.lines || []) {
        const article = String(line.article || "").trim().toUpperCase();
        const qty = Number(line.qty) || 0;
        if (!article || !(qty > 0)) continue;
        const key = `${allocationId}::${article}`;
        invoiceByAllocationArticle.set(key, (invoiceByAllocationArticle.get(key) || 0) + qty);
      }
    }

    const rows = [];
    for (const alloc of allocations) {
      const refNo = alloc.linkedProformaNo || alloc.linkedOANo || alloc.linkedQuotationNo || alloc.allocationNo || "";
      if (referenceNo && !new RegExp(referenceNo, "i").test(refNo)) continue;
      const warehouse = String(alloc.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
      for (const line of alloc.lines || []) {
        const article = String(line.article || "").trim().toUpperCase();
        if (!article || (articleFilter && article !== articleFilter)) continue;
        const orderedQty = Number(line.qty) || 0;
        const key = `${String(alloc._id)}::${article}`;
        const rtsQty = Number(rtsByAllocationArticle.get(key) || 0);
        const invoiceQty = Number(invoiceByAllocationArticle.get(key) || 0);
        const pendingQty = Math.max(0, orderedQty - rtsQty - invoiceQty);
        if (!(pendingQty > 0)) continue;
        rows.push({
          customer: alloc.customerName || "",
          customerName: alloc.customerName || "",
          article,
          description: line.description || "",
          refNo,
          referenceNo: refNo,
          referenceType: alloc.linkedProformaId ? "PROFORMA" : alloc.linkedOAId ? "ORDER_ACK" : "ORDER_ALLOCATION",
          orderedQty,
          allocatedQty: orderedQty,
          pendingQty,
          rtsQty,
          invoiceQty,
          warehouse,
          location: warehouse,
          allocationDate: alloc.allocationDate,
          status: alloc.status || "",
        });
      }
    }

    const articles = [...new Set(rows.map((r) => r.article))];
    const warehouses = [...new Set(rows.map((r) => r.warehouse))];
    const [balances, draftGrns] = await Promise.all([
      articles.length
        ? StockBalance.find(
            withCompany(req, {
              article: { $in: articles },
              location: { $in: warehouses },
            })
          ).lean()
        : [],
      articles.length
        ? GRN.find(
            withCompany(req, {
              status: "Draft",
              "items.article": { $in: articles },
            })
          )
            .select("grnNo grnDate items")
            .sort({ grnDate: 1, createdAt: 1 })
            .lean()
        : [],
    ]);
    const availableByArticleWarehouse = new Map();
    for (const bal of balances) {
      const article = String(bal.article || bal.itemCode || "").toUpperCase();
      const warehouse = String(bal.location || bal.warehouse || "MAIN").toUpperCase();
      const key = `${article}::${warehouse}`;
      const onHand = Number(bal.onHandQty ?? bal.quantity ?? 0) || 0;
      const allocated = Math.max(Number(bal.allocatedQty || 0), Number(bal.reservedQty || 0));
      const rts = Number(bal.rtsQty || 0);
      availableByArticleWarehouse.set(key, (availableByArticleWarehouse.get(key) || 0) + onHand - allocated - rts);
    }
    const expectedGrnByArticleWarehouse = new Map();
    for (const grn of draftGrns) {
      for (const line of grn.items || []) {
        const article = String(line.article || "").toUpperCase();
        const warehouse = String(line.location || "MAIN").toUpperCase();
        const qty = Number(line.acceptedQty || line.receivedQty || 0);
        if (!article || !(qty > 0)) continue;
        const key = `${article}::${warehouse}`;
        if (!expectedGrnByArticleWarehouse.has(key)) {
          expectedGrnByArticleWarehouse.set(key, `${grn.grnNo} (${qty})`);
        }
      }
    }

    const enriched = rows.map((row) => {
      const key = `${row.article}::${row.warehouse}`;
      return {
        ...row,
        available: Number(availableByArticleWarehouse.get(key) || 0),
        expectedGrn: expectedGrnByArticleWarehouse.get(key) || "",
      };
    });
    const total = enriched.length;
    res.json({
      rows: enriched.slice(skip, skip + limit),
      total,
      page,
      limit,
      totals: { totalBackorders: total },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listRts(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ rtsNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedOrderAllocationNo: new RegExp(q, "i") }];
    }
    if (req.query.allocationId && mongoose.Types.ObjectId.isValid(String(req.query.allocationId))) {
      filter.linkedOrderAllocationId = new mongoose.Types.ObjectId(String(req.query.allocationId));
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [items, total] = await Promise.all([
      Rts.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Rts.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getRts(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Rts.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json({ ...doc, editable: isRtsEditable(doc) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateRts(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Rts.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!isRtsEditable(doc)) {
      return res.status(400).json({ message: "RTS is locked after Sales Invoice reference is created." });
    }

    if (req.body.rtsDate !== undefined) doc.rtsDate = req.body.rtsDate;
    if (req.body.packingDetails !== undefined) {
      doc.packingDetails = normalizeRtsPackingDetails(req.body?.packingDetails || {});
    }
    if (req.body.lines !== undefined) {
      const incoming = Array.isArray(req.body.lines) ? req.body.lines : [];
      if (!incoming.length) return res.status(400).json({ message: "RTS requires at least one line" });
      doc.lines = incoming.map((line, idx) => {
        const qty = Number(line.qty) || 0;
        const unitWeightKg = normalizeWeight(line.unitWeightKg);
        return {
          serialNo: idx + 1,
          allocationLineId: line.allocationLineId,
          article: String(line.article || "").trim().toUpperCase(),
          partNumber: String(line.partNumber || ""),
          description: String(line.description || ""),
          qty,
          uom: String(line.uom || "PCS"),
          coo: String(line.coo || "").trim() || "Germany",
          remarks: String(line.remarks || ""),
          materialCode: String(line.materialCode || ""),
          availability: String(line.availability || ""),
          unitWeightKg,
          totalWeightKg: unitWeightKg == null ? null : qty * unitWeightKg,
        };
      });
    }
    if (req.body.status !== undefined) {
      const st = String(req.body.status || "").toUpperCase();
      if (!["DRAFT", "APPROVED", "CANCELLED"].includes(st)) {
        return res.status(400).json({ message: "Invalid RTS status" });
      }
      doc.status = st;
    }
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function approveRts(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Rts.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!isRtsEditable(doc)) return res.status(400).json({ message: "RTS is locked after Sales Invoice reference is created." });
    if (String(doc.status || "").toUpperCase() === "CONVERTED_TO_INVOICE") {
      return res.status(400).json({ message: "RTS is already converted to invoice; cancel the invoice first." });
    }
    if (String(doc.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Cannot approve a cancelled RTS" });
    }
    if (doc.status === "APPROVED") return res.json(doc);

    const rtsLines = (doc.lines || [])
      .map((l) => ({ article: l.article, qty: Number(l.qty) || 0 }))
      .filter((x) => x.article && x.qty > 0);

    await withTransaction(async (session) => {
      const allocation = await OrderAllocation.findOne(withCompany(req, { _id: doc.linkedOrderAllocationId })).session(session);
      if (!allocation) throw new Error("Linked order allocation not found");
      if (String(allocation.status || "").toUpperCase() === "CANCELLED") {
        throw new Error("Cannot approve RTS for a cancelled order allocation");
      }
      const warehouse = String(allocation.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
      /**
       * Legacy allocations (no stockReservedAt): reserve the full allocation once, then move this RTS slice
       * from reserved → RTS bucket. New allocations already carry SALES_RESERVE at creation.
       */
      if (!allocation.stockReservedAt) {
        const reserveLines = (allocation.lines || [])
          .map((l) => ({ article: l.article, qty: Number(l.qty) || 0 }))
          .filter((x) => x.article && x.qty > 0);
        // Legacy allocations did not record a SALES_RESERVE on creation —
        // backfill the reservation now so the RTS approval can move qty
        // from reserved → RTS. We allow negative since these allocations
        // were already accepted before the negative-stock policy existed.
        await reserveAllocationLines({
          session,
          companyId: req.companyId,
          warehouse,
          lines: reserveLines,
          referenceType: "ORDER_ALLOCATION_RESERVE_BACKFILL",
          referenceNo: allocation.allocationNo,
          customerName: allocation.customerName || "",
          remarks: "Backfill reservation for legacy allocation",
          createdBy: req.user?.email || "",
          allowNegative: true,
        });
        allocation.stockReservedAt = new Date();
      }
      for (const [article, qty] of dedupeLines(rtsLines)) {
        await stockService.moveAllocationToRTS({
          session,
          companyId: req.companyId,
          article,
          warehouse,
          qty,
          customerName: doc.customerName || allocation.customerName || "",
          referenceType: "RTS_APPROVED",
          referenceNo: doc.rtsNo,
          remarks: "RTS approved",
          createdBy: req.user?.email || "",
          sourceModule: "SALES",
        });
      }
      const prevRtsStatus = String(doc.status || "");
      assertTransition(DOC_TYPES.RTS, prevRtsStatus, "APPROVED", { documentNo: doc.rtsNo });
      doc.status = "APPROVED";
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      const postedDocs = await postedRtsByAllocation(req, allocation._id, session);
      const shipped = shippedQtyMapForAllocation(postedDocs);
      let complete = true;
      for (const line of allocation.lines || []) {
        const qty = Number(line.qty) || 0;
        const done = shipped.get(String(line._id || "")) || 0;
        if (done < qty) {
          complete = false;
          break;
        }
      }
      allocation.status = complete ? "RTS_COMPLETE" : "PARTIALLY_RTS";
      allocation.updatedBy = req.user?.email || "";
      await allocation.save({ session });
    });
    await writeStatusChange(req, {
      module: "SALES",
      entityType: "RTS",
      entityId: doc._id,
      documentNo: doc.rtsNo,
      fromStatus: "PENDING",
      toStatus: "APPROVED",
      description: `RTS ${doc.rtsNo} approved, qty moved Allocated → RTS`,
    });

    const out = await Rts.findOne(withCompany(req, { _id: id })).lean();
    res.json(out);
  } catch (err) {
    if (err?.code === "INVALID_TRANSITION" || err?.code === "STOCK_INSUFFICIENT") {
      return res.status(err.statusCode || 409).json({ message: err.message, code: err.code, details: err.details });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function convertOAToOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid OA id" });
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    validateConversionSource(oa, "order acknowledgement");
    if (!oa.lines?.length) return res.status(400).json({ message: "OA requires at least one line to convert" });
    const already = await OrderAllocation.findOne(withCompany(req, { linkedOAId: oa._id, status: { $ne: "CANCELLED" } }));
    if (already) return res.status(409).json({ message: `Order allocation already exists (${already.allocationNo})` });
    const allocationNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "ORDER_ALLOCATION",
      model: OrderAllocation,
      field: "allocationNo",
    });
    let lines = normalizeLines(oa.lines.map((line) => line.toObject?.() || line));
    lines = await attachUnitWeightFromItems(req, lines);
    const totals = computeTotals(lines, oa);
    const warehouse = "MAIN";
    const reserveLines = lines.map((l) => ({ article: l.article, qty: Number(l.qty) || 0 })).filter((x) => x.article && x.qty > 0);
    const allowNegative = req.body?.allowNegative === true;
    const negativeReason = String(req.body?.allowNegativeReason || "").trim();

    let createdId = null;
    await withTransaction(async (session) => {
      await assertOaReadyForStockAllocation(req, oa, session);
      const [doc] = await OrderAllocation.create(
        [
          {
            companyId: req.companyId,
            allocationNo,
            allocationDate: new Date(),
            linkedQuotationId: oa.linkedQuotationId || null,
            linkedQuotationNo: oa.linkedQuotationNo || "",
            linkedOAId: oa._id,
            linkedOANo: oa.oaNo,
            customerName: oa.customerName,
            currency: oa.currency || "USD",
            vertical: oa.vertical || "",
            engine: oa.engine || "",
            model: oa.model || "",
            config: oa.config || "",
            esn: oa.esn || "",
            warehouse,
            lines,
            ...totals,
            status: "OPEN",
            packingStatus: "NOT_PACKED",
            invoiceStatus: "NOT_INVOICED",
            dispatchStatus: "NOT_DISPATCHED",
            createdBy: req.user?.email || "",
          },
        ],
        { session }
      );
      createdId = doc._id;
      const { negativeArticles } = await reserveAllocationLines({
        session,
        companyId: req.companyId,
        warehouse,
        lines: reserveLines,
        referenceType: "ORDER_ALLOCATION",
        referenceNo: allocationNo,
        customerName: oa.customerName || "",
        remarks: allowNegative ? "Reserve on OA→allocation (allowNegative)" : "Reserve on OA→allocation",
        createdBy: req.user?.email || "",
        allowNegative,
      });
      if (negativeArticles.size) {
        for (const line of doc.lines || []) {
          if (negativeArticles.has(String(line.article || "").trim().toUpperCase())) {
            line.isNegativeAllocation = true;
          }
        }
        doc.hasNegativeAllocation = true;
        if (negativeReason) doc.negativeAllocationReason = negativeReason;
      }
      doc.stockReservedAt = new Date();
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      oa.status = "CONVERTED";
      if (!oa.convertedTo?.includes("ORDER_ALLOCATION")) {
        oa.convertedTo = [...(oa.convertedTo || []), "ORDER_ALLOCATION"];
      }
      oa.updatedBy = req.user?.email || "";
      await oa.save({ session });
    });
    const doc = await OrderAllocation.findOne(withCompany(req, { _id: createdId })).lean();
    await writeAudit(req, {
      action: "CREATE",
      module: "SALES",
      entityType: "ORDER_ALLOCATION",
      entityId: doc._id,
      documentNo: doc.allocationNo,
      toStatus: "ALLOCATED",
      description: `Order Allocation ${doc.allocationNo} created from OA ${oa.oaNo || ""}`,
      metadata: {
        sourceDoc: { type: "ORDER_ACKNOWLEDGEMENT", id: String(oa._id), no: oa.oaNo || "" },
        hasNegativeAllocation: doc.hasNegativeAllocation === true,
      },
    });
    res.status(201).json(doc);
  } catch (err) {
    if (err?.code === "STOCK_INSUFFICIENT" || err?.code === "INVALID_TRANSITION") {
      return res.status(err.statusCode || 409).json({
        message: err.message,
        code: err.code,
        details: err.details || null,
      });
    }
    res.status(400).json({ message: err.message });
  }
}

/**
 * Backfill: legacy receipts that were linked to a proforma but never got an
 * allocation row (because the old auto-allocation logic capped at the
 * persisted balanceAmount which defaulted to 0). For each such non-cancelled
 * receipt linked to this proforma, create the missing allocation entry,
 * recompute allocatedAmount/unallocatedAmount/status, and save.
 * Returns the number of receipts patched.
 */
async function backfillProformaReceiptAllocations(req, proforma) {
  if (!proforma?._id) return 0;
  const receipts = await PaymentReceipt.find(
    withCompany(req, {
      proformaInvoiceId: proforma._id,
      status: { $ne: "CANCELLED" },
    })
  );
  let patched = 0;
  // Run capacity from grand total minus what is already allocated to this proforma elsewhere.
  let allocatedSoFar = 0;
  for (const r of receipts) {
    for (const a of r.allocations || []) {
      if (
        String(a.targetType || "") === "PROFORMA_INVOICE" &&
        String(a.targetId || "") === String(proforma._id)
      ) {
        allocatedSoFar += Math.max(0, Number(a.allocatedAmount) || 0);
      }
    }
  }
  for (const r of receipts) {
    const hasMatch = (r.allocations || []).some(
      (a) =>
        String(a.targetType || "") === "PROFORMA_INVOICE" &&
        String(a.targetId || "") === String(proforma._id)
    );
    if (hasMatch) continue;
    const grandTotal = Math.max(0, Number(proforma.grandTotal) || 0);
    const remaining = Math.max(0, grandTotal - allocatedSoFar);
    if (remaining <= 0) continue;
    const amountReceived = Math.max(0, Number(r.amountReceived) || 0);
    const alreadyAllocatedOnReceipt = Math.max(0, Number(r.allocatedAmount) || 0);
    const unallocatedHeadroom = Math.max(0, amountReceived - alreadyAllocatedOnReceipt);
    const cap = Math.min(remaining, unallocatedHeadroom);
    if (cap <= 0) continue;
    r.allocations.push({
      paymentReceiptId: r._id,
      customerId: r.customerId || null,
      targetType: "PROFORMA_INVOICE",
      targetId: proforma._id,
      targetNo: proforma.proformaNo || "",
      invoiceTotal: grandTotal,
      allocatedAmount: cap,
      currency: r.currency || proforma.currency || "USD",
      allocatedAt: r.receiptDate || r.receivedDate || new Date(),
      allocatedBy: req.user?.email || r.createdBy || "",
    });
    const newAllocatedAmount = (r.allocations || []).reduce(
      (acc, a) => acc + (Math.max(0, Number(a.allocatedAmount) || 0)),
      0
    );
    r.allocatedAmount = newAllocatedAmount;
    r.unallocatedAmount = Math.max(0, amountReceived - newAllocatedAmount);
    r.status =
      newAllocatedAmount <= 0
        ? "POSTED"
        : r.unallocatedAmount > 0
        ? "PARTIALLY_ALLOCATED"
        : "FULLY_ALLOCATED";
    r.updatedBy = req.user?.email || r.updatedBy || "";
    await r.save();
    allocatedSoFar += cap;
    patched += 1;
  }
  return patched;
}

export async function recalcAllProformaPaymentStates(req, res) {
  try {
    const proformas = await ProformaInvoice.find(
      withCompany(req, { status: { $nin: ["CANCELLED"] } })
    );
    let updated = 0;
    let receiptsPatched = 0;
    for (const p of proformas) {
      const before = {
        total: Number(p.totalReceivedAmount || 0),
        paymentStatus: String(p.paymentStatus || "").toUpperCase(),
        status: String(p.status || "").toUpperCase(),
      };
      receiptsPatched += await backfillProformaReceiptAllocations(req, p);
      await syncProformaPaymentState(req, p);
      const after = {
        total: Number(p.totalReceivedAmount || 0),
        paymentStatus: String(p.paymentStatus || "").toUpperCase(),
        status: String(p.status || "").toUpperCase(),
      };
      if (
        Math.abs(before.total - after.total) > 0.0001 ||
        before.paymentStatus !== after.paymentStatus ||
        before.status !== after.status
      ) {
        updated += 1;
      }
    }
    res.json({ scanned: proformas.length, updated, receiptsPatched });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function convertProformaToOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid proforma id" });
    let proforma = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    validateConversionSource(proforma, "proforma");
    proforma = await syncProformaPaymentState(req, proforma);
    const pst = String(proforma?.status || "").toUpperCase();
    if (!["APPROVED", "PAID_PENDING_SHIPMENT"].includes(pst)) {
      return res.status(400).json({
        message: "Proforma must be APPROVED or PAID (PAID_PENDING_SHIPMENT) before converting to Order Allocation",
      });
    }
    if (!proforma.lines?.length) return res.status(400).json({ message: "Proforma requires at least one line to convert" });
    const already = await OrderAllocation.findOne(
      withCompany(req, { linkedProformaId: proforma._id, status: { $ne: "CANCELLED" } })
    );
    if (already) return res.status(409).json({ message: `Order allocation already exists (${already.allocationNo})` });
    const allocationNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "ORDER_ALLOCATION",
      model: OrderAllocation,
      field: "allocationNo",
    });
    let lines = normalizeLines(proforma.lines.map((line) => line.toObject?.() || line));
    lines = await attachUnitWeightFromItems(req, lines);
    const totals = computeTotals(lines, proforma);
    const warehouse = "MAIN";
    const reserveLines = lines.map((l) => ({ article: l.article, qty: Number(l.qty) || 0 })).filter((x) => x.article && x.qty > 0);
    const allowNegative = req.body?.allowNegative === true;
    const negativeReason = String(req.body?.allowNegativeReason || "").trim();

    let createdId = null;
    await withTransaction(async (session) => {
      const [doc] = await OrderAllocation.create(
        [
          {
            companyId: req.companyId,
            allocationNo,
            allocationDate: new Date(),
            linkedQuotationId: proforma.linkedQuotationId || null,
            linkedQuotationNo: proforma.linkedQuotationNo || "",
            linkedOAId: proforma.linkedOAId || null,
            linkedOANo: proforma.linkedOANo || "",
            linkedProformaId: proforma._id,
            linkedProformaNo: proforma.proformaNo,
            customerName: proforma.customerName,
            currency: proforma.currency || "USD",
            vertical: proforma.vertical || "",
            engine: proforma.engine || "",
            model: proforma.model || "",
            config: proforma.config || "",
            esn: proforma.esn || "",
            warehouse,
            lines,
            ...totals,
            status: "OPEN",
            packingStatus: "NOT_PACKED",
            invoiceStatus: "NOT_INVOICED",
            dispatchStatus: "NOT_DISPATCHED",
            createdBy: req.user?.email || "",
          },
        ],
        { session }
      );
      createdId = doc._id;
      const { negativeArticles } = await reserveAllocationLines({
        session,
        companyId: req.companyId,
        warehouse,
        lines: reserveLines,
        referenceType: "ORDER_ALLOCATION",
        referenceNo: allocationNo,
        customerName: proforma.customerName || "",
        remarks: allowNegative ? "Reserve on proforma→allocation (allowNegative)" : "Reserve on proforma→allocation",
        createdBy: req.user?.email || "",
        allowNegative,
      });
      if (negativeArticles.size) {
        for (const line of doc.lines || []) {
          if (negativeArticles.has(String(line.article || "").trim().toUpperCase())) {
            line.isNegativeAllocation = true;
          }
        }
        doc.hasNegativeAllocation = true;
        if (negativeReason) doc.negativeAllocationReason = negativeReason;
      }
      doc.stockReservedAt = new Date();
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
    });
    const doc = await OrderAllocation.findOne(withCompany(req, { _id: createdId })).lean();
    await writeAudit(req, {
      action: "CREATE",
      module: "SALES",
      entityType: "ORDER_ALLOCATION",
      entityId: doc._id,
      documentNo: doc.allocationNo,
      toStatus: "ALLOCATED",
      description: `Order Allocation ${doc.allocationNo} created from proforma ${proforma.proformaNo}`,
      metadata: {
        sourceDoc: { type: "PROFORMA", id: String(proforma._id), no: proforma.proformaNo },
        hasNegativeAllocation: doc.hasNegativeAllocation === true,
      },
    });
    res.status(201).json(doc);
  } catch (err) {
    if (err?.code === "STOCK_INSUFFICIENT" || err?.code === "INVALID_TRANSITION") {
      return res.status(err.statusCode || 409).json({
        message: err.message,
        code: err.code,
        details: err.details || null,
      });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function createRtsFromOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid order allocation id" });
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: id }));
    validateConversionSource(allocation, "order allocation");
    if (!allocation?.lines?.length) return res.status(400).json({ message: "Order allocation has no lines" });
    const postedDocs = await postedRtsByAllocation(req, allocation._id);
    const shipped = shippedQtyMapForAllocation(postedDocs);

    const selected = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!selected.length) return res.status(400).json({ message: "Select at least one article/line for RTS" });
    const byId = new Map((allocation.lines || []).map((line) => [String(line._id), line]));
    const rtsLines = [];
    for (const row of selected) {
      const line = byId.get(String(row.allocationLineId || ""));
      if (!line) continue;
      const pending = Math.max(0, (Number(line.qty) || 0) - (shipped.get(String(line._id)) || 0));
      const qty = Number(row.qty) || 0;
      if (!(qty > 0) || qty > pending) {
        return res.status(400).json({ message: `Invalid RTS qty for article ${line.article}. Pending: ${pending}` });
      }
      const unitWeightKg = normalizeWeight(row.unitWeightKg) ?? normalizeWeight(line.unitWeightKg);
      rtsLines.push({
        serialNo: rtsLines.length + 1,
        allocationLineId: line._id,
        article: line.article,
        partNumber: line.partNumber || "",
        description: line.description || "",
        qty,
        uom: line.uom || "PCS",
        coo: String(row.coo || "").trim(),
        remarks: line.remarks || "",
        materialCode: line.materialCode || "",
        availability: line.availability || "",
        unitWeightKg,
        totalWeightKg: unitWeightKg == null ? null : qty * unitWeightKg,
      });
    }
    if (!rtsLines.length) return res.status(400).json({ message: "No valid RTS lines selected" });
    const rtsLinesWithDefaults = await attachRtsDefaultsFromItems(req, rtsLines);
    const rtsNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "RTS",
    });
    const doc = await Rts.create({
      companyId: req.companyId,
      rtsNo,
      rtsDate: req.body?.rtsDate || new Date(),
      linkedOrderAllocationId: allocation._id,
      linkedOrderAllocationNo: allocation.allocationNo,
      customerName: allocation.customerName,
      vertical: allocation.vertical || "",
      engine: allocation.engine || "",
      model: allocation.model || "",
      config: allocation.config || "",
      esn: allocation.esn || "",
      lines: rtsLinesWithDefaults,
      packingDetails: normalizeRtsPackingDetails(req.body?.packingDetails || {}),
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertOrderAllocationToSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid order allocation id" });
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: id })).lean();
    validateConversionSource(allocation, "order allocation");
    const ready = await firstReadyPackingForAllocation(req, allocation._id);
    if (!ready) {
      return res.status(400).json({
        message: "Packing must be completed before creating Sales Invoice",
      });
    }
    req.params.id = String(ready.packing._id);
    req.body = { ...(req.body || {}), sourceAllocationId: id };
    return convertPackingToSalesInvoice(req, res);
  } catch (err) {
    const msg = err.message || String(err);
    if (err?.code === "INVALID_TRANSITION" || err?.code === "STOCK_INSUFFICIENT") {
      return res.status(err.statusCode || 409).json({ message: err.message, code: err.code, details: err.details });
    }
    if (String(msg).includes("already exists")) return res.status(409).json({ message: msg });
    res.status(400).json({ message: msg });
  }
}

/** Legacy RTS no longer gates Sales Invoice. Invoices must be created from posted Store Packing. */
export async function convertRtsToSalesInvoice(req, res) {
  return res.status(410).json({
    message: "RTS conversion is disabled. Complete Store Packing, then create Sales Invoice from the Order Allocation or Packing document.",
  });
}

export async function cancelOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const dryRun = req.query.dryRun === "1" || req.body?.dryRun === true;
    const reason = String(req.body?.cancellationReason ?? req.body?.reason ?? "").trim();
    if (!dryRun && !reason) return res.status(400).json({ message: "cancellationReason is required" });
    const alloc = await OrderAllocation.findOne(withCompany(req, { _id: id }));
    if (!alloc) return res.status(404).json({ message: "Not found" });
    if (String(alloc.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Order allocation is already cancelled" });
    }
    if (alloc.linkedSalesInvoiceId) {
      return res.status(400).json({
        message: "Cannot cancel allocation while a sales invoice exists. Cancel the sales invoice first.",
      });
    }
    const blockRts = await Rts.countDocuments(
      withCompany(req, { linkedOrderAllocationId: alloc._id, status: { $ne: "CANCELLED" } })
    );
    if (blockRts) {
      return res.status(400).json({ message: "Cancel all RTS documents for this allocation first." });
    }
    const warehouse = String(alloc.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const postedDocs = await postedRtsByAllocation(req, alloc._id);
    const shipped = shippedQtyMapForAllocation(postedDocs);
    const releaseLines = (alloc.lines || [])
      .map((line) => {
        const lid = String(line._id || "");
        const sq = shipped.get(lid) || 0;
        const rem = Math.max(0, (Number(line.qty) || 0) - sq);
        return { article: line.article, qty: rem };
      })
      .filter((x) => x.article && x.qty > 0);
    const stockImpact = releaseLines.map((l) => ({
      article: l.article,
      qty: l.qty,
      from: "RESERVED",
      to: "AVAILABLE",
    }));
    if (dryRun) return res.json({ dryRun: true, stockImpact });
    const prevStatus = String(alloc.status || "");
    assertTransition(DOC_TYPES.ORDER_ALLOCATION, prevStatus, "CANCELLED", { documentNo: alloc.allocationNo });
    await withTransaction(async (session) => {
      if (alloc.stockReservedAt && releaseLines.length) {
        for (const [article, qty] of dedupeLines(releaseLines)) {
          await stockService.cancelAllocation({
            session,
            companyId: req.companyId,
            article,
            warehouse,
            qty,
            customerName: alloc.customerName || "",
            referenceType: "ORDER_ALLOCATION_CANCEL",
            referenceNo: alloc.allocationNo,
            remarks: reason,
            createdBy: req.user?.email || "",
            sourceModule: "SALES",
          });
        }
      }
      alloc.status = "CANCELLED";
      alloc.cancelledAt = new Date();
      alloc.cancelledBy = req.user?.email || "";
      alloc.cancellationReason = reason;
      alloc.updatedBy = req.user?.email || "";
      await alloc.save({ session });
    });
    await writeStatusChange(req, {
      module: "SALES",
      entityType: "ORDER_ALLOCATION",
      entityId: alloc._id,
      documentNo: alloc.allocationNo,
      fromStatus: canonicalStatus(DOC_TYPES.ORDER_ALLOCATION, prevStatus),
      toStatus: "CANCELLED",
      description: `Order Allocation ${alloc.allocationNo} cancelled`,
      metadata: { reason, releasedLines: stockImpact },
    });
    const fresh = await OrderAllocation.findOne(withCompany(req, { _id: id }));
    res.json(fresh);
  } catch (err) {
    if (err?.code === "INVALID_TRANSITION" || err?.code === "STOCK_INSUFFICIENT") {
      return res.status(err.statusCode || 409).json({ message: err.message, code: err.code, details: err.details });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function cancelRtsDocument(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const dryRun = req.query.dryRun === "1" || req.body?.dryRun === true;
    const reason = String(req.body?.cancellationReason ?? req.body?.reason ?? "").trim();
    if (!dryRun && !reason) return res.status(400).json({ message: "cancellationReason is required" });
    const doc = await Rts.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    const st = String(doc.status || "").toUpperCase();
    if (st === "CANCELLED") return res.status(400).json({ message: "RTS is already cancelled" });
    if (st === "CONVERTED_TO_INVOICE") {
      return res.status(400).json({ message: "Cancel the sales invoice first before cancelling this RTS." });
    }
    if (doc.linkedSalesInvoiceId) {
      return res.status(400).json({ message: "RTS is linked to a sales invoice; cancel the invoice first." });
    }
    const rtsLines = (doc.lines || [])
      .map((l) => ({ article: l.article, qty: Number(l.qty) || 0 }))
      .filter((x) => x.article && x.qty > 0);
    const stockImpact = rtsLines.map((l) => ({
      article: l.article,
      qty: l.qty,
      from: st === "APPROVED" ? "RTS" : "DRAFT",
      to: "RESERVED",
    }));
    if (dryRun) return res.json({ dryRun: true, stockImpact });
    assertTransition(DOC_TYPES.RTS, st, "CANCELLED", { documentNo: doc.rtsNo });
    if (st === "DRAFT") {
      doc.status = "CANCELLED";
      doc.cancelledAt = new Date();
      doc.cancelledBy = req.user?.email || "";
      doc.cancellationReason = reason;
      doc.updatedBy = req.user?.email || "";
      await doc.save();
      await writeStatusChange(req, {
        module: "SALES",
        entityType: "RTS",
        entityId: doc._id,
        documentNo: doc.rtsNo,
        fromStatus: canonicalStatus(DOC_TYPES.RTS, st),
        toStatus: "CANCELLED",
        description: `RTS ${doc.rtsNo} cancelled (no stock impact, was DRAFT)`,
        metadata: { reason },
      });
      return res.json(doc);
    }
    if (st !== "APPROVED") {
      return res.status(400).json({ message: `Cannot cancel RTS in status ${st}` });
    }
    await withTransaction(async (session) => {
      const allocation = await OrderAllocation.findOne(withCompany(req, { _id: doc.linkedOrderAllocationId })).session(session);
      const warehouse = String(allocation?.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
      for (const [article, qty] of dedupeLines(rtsLines)) {
        await stockService.cancelRTS({
          session,
          companyId: req.companyId,
          article,
          warehouse,
          qty,
          customerName: doc.customerName || allocation?.customerName || "",
          referenceType: "RTS_CANCEL",
          referenceNo: doc.rtsNo,
          remarks: reason,
          createdBy: req.user?.email || "",
          sourceModule: "SALES",
        });
      }
      doc.status = "CANCELLED";
      doc.cancelledAt = new Date();
      doc.cancelledBy = req.user?.email || "";
      doc.cancellationReason = reason;
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      if (allocation) {
        const postedDocs = await postedRtsByAllocation(req, allocation._id, session);
        const shipped = shippedQtyMapForAllocation(postedDocs);
        let complete = true;
        for (const line of allocation.lines || []) {
          const qty = Number(line.qty) || 0;
          const done = shipped.get(String(line._id || "")) || 0;
          if (done < qty) {
            complete = false;
            break;
          }
        }
        const anyPosted = postedDocs.length > 0;
        allocation.status = !anyPosted ? "OPEN" : complete ? "RTS_COMPLETE" : "PARTIALLY_RTS";
        allocation.updatedBy = req.user?.email || "";
        await allocation.save({ session });
      }
    });
    await writeStatusChange(req, {
      module: "SALES",
      entityType: "RTS",
      entityId: doc._id,
      documentNo: doc.rtsNo,
      fromStatus: canonicalStatus(DOC_TYPES.RTS, st),
      toStatus: "CANCELLED",
      description: `RTS ${doc.rtsNo} cancelled, qty restored to allocation`,
      metadata: { reason, restoredLines: stockImpact },
    });
    const out = await Rts.findOne(withCompany(req, { _id: id }));
    res.json(out);
  } catch (err) {
    if (err?.code === "INVALID_TRANSITION") {
      return res.status(err.statusCode || 409).json({ message: err.message, code: err.code, details: err.details });
    }
    res.status(400).json({ message: err.message });
  }
}

export async function listCipls(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ ciplNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    const [items, total] = await Promise.all([
      Cipl.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Cipl.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Cipl.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createCipl(req, res) {
  try {
    const body = { ...req.body };
    const lines = normalizeLines(body.lines || []);
    if (!lines.length) return res.status(400).json({ message: "CIPL requires at least one line" });
    const ciplNo =
      body.ciplNo ||
      (await nextSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "CIPL",
      }));
    const totals = computeTotals(lines, body);
    const doc = await Cipl.create({
      ...body,
      lines,
      ...totals,
      ciplNo,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Cipl.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    const allowed = [
      "ciplDate",
      "customerName",
      "consigneeName",
      "shipmentMode",
      "incoterm",
      "currency",
      "status",
      "remarks",
      "lines",
      "packingCost",
      "clearanceCost",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines, doc));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Cipl.findOneAndUpdate(
      withCompany(req, { _id: id }),
      { status: "CANCELLED", updatedBy: req.user?.email || "" },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertQuotationToCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid quotation id" });
    const quotation = await Quotation.findOne(withCompany(req, { _id: id }));
    validateConversionSource(quotation, "quotation");
    requireApprovedQuotationForConversion(quotation);
    if (!quotation.lines?.length) return res.status(400).json({ message: "Quotation requires at least one line to convert" });
    const already = await Cipl.findOne(
      withCompany(req, { linkedQuotationId: quotation._id, status: { $ne: "CANCELLED" } })
    );
    if (already) return res.status(409).json({ message: `CIPL already exists (${already.ciplNo})` });

    const ciplNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "CIPL",
    });
    const lines = normalizeLines(quotation.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines, quotation);
    const doc = await Cipl.create({
      companyId: req.companyId,
      ciplNo,
      ciplDate: new Date(),
      linkedQuotationId: quotation._id,
      linkedQuotationNo: quotation.quotationNo,
      customerName: quotation.customerName,
      incoterm: quotation.incoterm || "",
      currency: quotation.currency || "USD",
      remarks: quotation.remarks || "",
      vertical: quotation.vertical || "",
      engine: quotation.engine || "",
      model: quotation.model || "",
      config: quotation.config || "",
      esn: quotation.esn || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!quotation.convertedTo?.includes("CIPL")) quotation.convertedTo = [...(quotation.convertedTo || []), "CIPL"];
    quotation.updatedBy = req.user?.email || "";
    await quotation.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertOAToCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid OA id" });
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    validateConversionSource(oa, "order acknowledgement");
    if (!oa.lines?.length) return res.status(400).json({ message: "OA requires at least one line to convert" });
    const already = await Cipl.findOne(withCompany(req, { linkedOAId: oa._id, status: { $ne: "CANCELLED" } }));
    if (already) return res.status(409).json({ message: `CIPL already exists (${already.ciplNo})` });

    const ciplNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "CIPL",
    });
    const lines = normalizeLines(oa.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines, oa);
    const doc = await Cipl.create({
      companyId: req.companyId,
      ciplNo,
      ciplDate: new Date(),
      linkedQuotationId: oa.linkedQuotationId || null,
      linkedQuotationNo: oa.linkedQuotationNo || "",
      linkedOAId: oa._id,
      linkedOANo: oa.oaNo,
      customerName: oa.customerName,
      incoterm: oa.incoterm || "",
      currency: oa.currency || "USD",
      remarks: oa.acknowledgementNotes || "",
      vertical: oa.vertical || "",
      engine: oa.engine || "",
      model: oa.model || "",
      config: oa.config || "",
      esn: oa.esn || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!oa.convertedTo?.includes("CIPL")) oa.convertedTo = [...(oa.convertedTo || []), "CIPL"];
    oa.updatedBy = req.user?.email || "";
    await oa.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertSalesInvoiceToCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid sales invoice id" });
    const invoice = await SalesInvoice.findOne(withCompany(req, { _id: id }));
    validateConversionSource(invoice, "sales invoice");
    if (!invoice.lines?.length) return res.status(400).json({ message: "Sales invoice requires at least one line to convert" });
    const already = await Cipl.findOne(
      withCompany(req, { linkedSalesInvoiceId: invoice._id, status: { $ne: "CANCELLED" } })
    );
    if (already) return res.status(409).json({ message: `CIPL already exists (${already.ciplNo})` });

    const ciplNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "CIPL",
    });
    const lines = normalizeLines(invoice.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines, invoice);
    const doc = await Cipl.create({
      companyId: req.companyId,
      ciplNo,
      ciplDate: new Date(),
      linkedQuotationId: invoice.linkedQuotationId || null,
      linkedQuotationNo: invoice.linkedQuotationNo || "",
      linkedOAId: invoice.linkedOAId || null,
      linkedOANo: invoice.linkedOANo || "",
      linkedSalesInvoiceId: invoice._id,
      linkedSalesInvoiceNo: invoice.invoiceNo,
      customerName: invoice.customerName,
      incoterm: "",
      currency: invoice.currency || "USD",
      remarks: invoice.remarks || "",
      vertical: invoice.vertical || "",
      engine: invoice.engine || "",
      model: invoice.model || "",
      config: invoice.config || "",
      esn: invoice.esn || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    invoice.updatedBy = req.user?.email || "";
    await invoice.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
