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
import StockBalance from "../models/StockBalance.js";
import GRN from "../models/GRN.js";
import PaymentReceipt from "../models/PaymentReceipt.js";
import Customer from "../models/Customer.js";
import Company from "../models/Company.js";
import Item from "../models/Item.js";
import CustomerLedgerEntry from "../models/CustomerLedgerEntry.js";
import {
  applyManualSalesDocumentNumber,
  mapSalesDocNumberDuplicateError,
  nextSalesDocNumber,
  nextUniqueSalesDocNumber,
  validateManualSalesDocumentNumber,
} from "../utils/salesDocNumber.js";
import { assertSalesDocumentNumberChangeAllowed } from "../utils/salesDocumentNumberChangeGuard.js";
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
import {
  isOaWorkingCopyPayload,
  normalizeOALinesFromWorkingCopy,
  validateOaWorkingCopyBeforeSave,
  buildOaSourceMetadataForPersist,
} from "../services/documentSnapshot/documentSnapshotService.js";
import { validateOaLineFields } from "../services/documentSnapshot/oaCreateValidation.js";
import { resolveBankDetailsTextForCurrency } from "../services/bankDetailResolveService.js";
import {
  copyCustomerTransactionFields,
  CUSTOMER_FIELD_LIMITS,
  customerDetailSearchOr,
  customerTransactionAuditFieldSlice,
  diffCustomerTransactionFields,
  firstNonEmpty,
  pickCustomerTransactionFieldsFromBody,
  resolveDocumentCustomerFields,
  clampText,
} from "../utils/customerTransactionFields.js";
import {
  buildValidatedPiPaymentRequest,
  defaultFullPiPaymentRequest,
  piPayableTotal,
  resolvePiPaymentRequest,
  roundMoney,
} from "../utils/piPaymentRequest.js";
import {
  buildOaPiProgressSummary,
  buildOaCommercialRevision,
  isOaEditLockedByLifecycle,
  recalculatePiAdvancePercentage,
  suggestOaStatusAfterPiIssuance,
} from "../utils/oaLifecycle.js";
import {
  ACTIVE_ALLOCATION_ALREADY_EXISTS,
  activeAllocationConflictError,
  activeAllocationStatusFilter,
  isActiveAllocationDuplicateKeyError,
} from "../utils/allocationUniqueness.js";
import {
  computePaymentStatus,
  isInvoiceDispatchEligible,
  legacyStatusFromDimensions,
  normalizeDocumentStatus,
  normalizePaymentStatus,
  rejectProtectedSiStateFields,
} from "../utils/salesInvoiceState.js";

const { withTransaction } = stockService;

async function findActiveAllocationByOA(req, oaId, session = null) {
  const q = OrderAllocation.findOne(
    withCompany(req, { linkedOAId: oaId, ...activeAllocationStatusFilter() })
  ).select("_id allocationNo status");
  if (session) q.session(session);
  return q.lean();
}

async function findActiveAllocationByProforma(req, proformaId, session = null) {
  const q = OrderAllocation.findOne(
    withCompany(req, { linkedProformaId: proformaId, ...activeAllocationStatusFilter() })
  ).select("_id allocationNo status");
  if (session) q.session(session);
  return q.lean();
}

/** Resolve Packing → OA → PI → Quotation only (never Customer Master during conversion). */
async function resolveCustomerFieldsForPackingInvoice(req, allocation, body = {}, packing = null) {
  const fromBody = pickCustomerTransactionFieldsFromBody(body);
  const [oa, pi, quotation] = await Promise.all([
    allocation?.linkedOAId
      ? OrderAcknowledgement.findOne(withCompany(req, { _id: allocation.linkedOAId })).lean()
      : null,
    allocation?.linkedProformaId
      ? ProformaInvoice.findOne(withCompany(req, { _id: allocation.linkedProformaId })).lean()
      : null,
    allocation?.linkedQuotationId
      ? Quotation.findOne(withCompany(req, { _id: allocation.linkedQuotationId })).lean()
      : null,
  ]);
  const fromPacking = packing ? resolveDocumentCustomerFields(packing) : {};
  const fromOa = oa ? resolveDocumentCustomerFields(oa) : {};
  const fromPi = pi ? resolveDocumentCustomerFields(pi) : {};
  const fromQtn = quotation ? resolveDocumentCustomerFields(quotation) : {};
  const pick = (key) =>
    fromBody[key] !== undefined
      ? fromBody[key]
      : firstNonEmpty(fromPacking[key], fromOa[key], fromPi[key], fromQtn[key]);
  return {
    contactPerson: pick("contactPerson"),
    attention: pick("attention"),
    billingAddress: pick("billingAddress"),
    shippingAddress: pick("shippingAddress"),
    paymentTerms: pick("paymentTerms"),
  };
}

function t(v) {
  return String(v ?? "").trim();
}

async function resolveTermsForSalesInvoice(req, { proformaId, oaId, quotationId } = {}) {
  if (proformaId && mongoose.Types.ObjectId.isValid(String(proformaId))) {
    const pi = await ProformaInvoice.findOne(withCompany(req, { _id: proformaId }))
      .select("termsAndConditions")
      .lean();
    const text = t(pi?.termsAndConditions);
    if (text) return text;
  }
  if (oaId && mongoose.Types.ObjectId.isValid(String(oaId))) {
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: oaId }))
      .select("termsAndConditions")
      .lean();
    const text = t(oa?.termsAndConditions);
    if (text) return text;
  }
  if (quotationId && mongoose.Types.ObjectId.isValid(String(quotationId))) {
    const q = await Quotation.findOne(withCompany(req, { _id: quotationId }))
      .select("termsAndConditions")
      .lean();
    const text = t(q?.termsAndConditions);
    if (text) return text;
  }
  return "";
}

async function resolveTermsFromQuotation(req, quotationId) {
  if (!quotationId || !mongoose.Types.ObjectId.isValid(String(quotationId))) return "";
  const q = await Quotation.findOne(withCompany(req, { _id: quotationId })).select("termsAndConditions").lean();
  return t(q?.termsAndConditions);
}

async function resolveEffectiveTermsAndConditions(req, doc, docKind) {
  const stored = t(doc?.termsAndConditions);
  if (stored) return stored;

  if (docKind === "OA") {
    return resolveTermsFromQuotation(req, doc?.linkedQuotationId);
  }
  if (docKind === "PROFORMA") {
    if (doc?.linkedOAId && mongoose.Types.ObjectId.isValid(String(doc.linkedOAId))) {
      const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: doc.linkedOAId }))
        .select("termsAndConditions linkedQuotationId")
        .lean();
      const fromOa = t(oa?.termsAndConditions);
      if (fromOa) return fromOa;
      const fromQuoteViaOa = await resolveTermsFromQuotation(req, oa?.linkedQuotationId);
      if (fromQuoteViaOa) return fromQuoteViaOa;
    }
    return resolveTermsFromQuotation(req, doc?.linkedQuotationId);
  }
  if (docKind === "SALES_INVOICE") {
    return resolveTermsForSalesInvoice(req, {
      proformaId: doc?.linkedProformaId,
      oaId: doc?.linkedOAId,
      quotationId: doc?.linkedQuotationId,
    });
  }
  return "";
}

async function withResolvedTermsForPrint(req, doc, docKind) {
  if (!doc) return doc;
  const termsAndConditions = await resolveEffectiveTermsAndConditions(req, doc, docKind);
  return { ...doc, termsAndConditions };
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
    const effectKey = `alloc:reserve:${String(companyId)}:${String(referenceNo || "").trim()}:${article}`;
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
      effectKey,
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
    return items.map((d) => ({
      ...d,
      linkedInvoiceStatus: null,
      linkedInvoiceDocumentStatus: null,
      linkedInvoicePaymentStatus: null,
      linkedInvoiceDispatchStatus: null,
    }));
  }
  const invoices = await SalesInvoice.find({
    companyId,
    _id: { $in: ids },
  })
    .select("status documentStatus paymentStatus dispatchStatus paymentTerms")
    .lean();
  const map = Object.fromEntries(invoices.map((i) => [String(i._id), i]));
  return items.map((d) => {
    const inv = map[String(d.linkedSalesInvoiceId)];
    const documentStatus = inv
      ? normalizeDocumentStatus(
          inv.documentStatus ||
            (["DRAFT", "CANCELLED"].includes(String(inv.status || "").toUpperCase()) ? inv.status : "ISSUED")
        )
      : null;
    return {
      ...d,
      linkedInvoiceStatus: documentStatus ?? inv?.status ?? null,
      linkedInvoiceDocumentStatus: documentStatus,
      linkedInvoicePaymentStatus: inv ? normalizePaymentStatus(inv.paymentStatus) : null,
      linkedInvoiceDispatchStatus: inv?.dispatchStatus || null,
    };
  });
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
  const payableTotal = piPayableTotal(proforma);
  const balanceAmount = Math.max(0, roundMoney(payableTotal - totalReceived));
  let paymentStatus = "UNPAID";
  if (totalReceived > 0 && totalReceived < payableTotal - 0.0001) paymentStatus = "PARTIALLY_PAID";
  if (totalReceived >= payableTotal - 0.0001 && payableTotal > 0) paymentStatus = "PAID";

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
    const paymentReq = resolvePiPaymentRequest(doc);
    const payableTotal = piPayableTotal({ ...doc, ...paymentReq });
    const totalReceivedAmount = byId.get(String(doc._id)) ?? Math.max(0, Number(doc.totalReceivedAmount) || 0);
    const balanceAmount = Math.max(0, roundMoney(payableTotal - totalReceivedAmount));
    const paymentStatus =
      totalReceivedAmount >= payableTotal - 0.0001 && payableTotal > 0
        ? "PAID"
        : totalReceivedAmount > 0
          ? "PARTIALLY_PAID"
          : "UNPAID";
    return {
      ...doc,
      ...paymentReq,
      payableTotal,
      totalReceivedAmount,
      balanceAmount,
      paymentStatus,
    };
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

const OA_CANCELABLE_STATUSES = new Set([
  "ACTIVE",
  "APPROVED",
  "CONFIRMED",
  "CONVERTED",
  "PARTIALLY_PI_ISSUED",
  "FULLY_PI_ISSUED",
  "PACKING",
]);
const OA_DOWNSTREAM_BLOCK_MESSAGE = "Cannot cancel OA because active downstream document exists.";

/** Edit lock — active PI alone must not lock; packing / SI / completed do. */
function isOAEditLocked(doc, ctx = {}) {
  return isOaEditLockedByLifecycle(doc, ctx);
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

/** Sum requested (payable) amounts of non-cancelled PIs linked to an OA. */
async function summarizeOaProformaIssuance(req, oaId, { excludePiId = null } = {}) {
  if (!oaId || !mongoose.Types.ObjectId.isValid(String(oaId))) {
    return { issuedRequestedTotal: 0, activePiCount: 0, items: [] };
  }
  const filter = withCompany(req, { linkedOAId: oaId, status: { $ne: "CANCELLED" } });
  if (excludePiId && mongoose.Types.ObjectId.isValid(String(excludePiId))) {
    filter._id = { $ne: excludePiId };
  }
  const rows = await ProformaInvoice.find(filter)
    .select(
      "proformaNo proformaDate requestedAmount grandTotal commercialGrandTotal piValueType advancePercentage status paymentStatus balanceAmount totalReceivedAmount"
    )
    .lean();
  let issuedRequestedTotal = 0;
  for (const row of rows) {
    issuedRequestedTotal += piPayableTotal(resolvePiPaymentRequest(row));
  }
  return {
    issuedRequestedTotal: roundMoney(issuedRequestedTotal),
    activePiCount: rows.length,
    items: rows,
  };
}

async function resolveOaPiCapacity(req, oaDoc, { excludePiId = null } = {}) {
  const commercial = roundMoney(Math.max(0, Number(oaDoc?.grandTotal) || 0));
  const { issuedRequestedTotal, activePiCount } = await summarizeOaProformaIssuance(req, oaDoc?._id, {
    excludePiId,
  });
  const remainingEligible = roundMoney(Math.max(0, commercial - issuedRequestedTotal));
  return {
    oaCommercialGrandTotal: commercial,
    piIssuedRequestedTotal: issuedRequestedTotal,
    piRemainingEligibleAmount: remainingEligible,
    activePiCount,
    canCreateAdditionalProforma: remainingEligible > 0.005,
  };
}

/** Full PI history for OA detail (includes cancelled — capacity release is visible). */
async function loadOaProformaHistory(req, oaId, { oaCommercial = null } = {}) {
  if (!oaId || !mongoose.Types.ObjectId.isValid(String(oaId))) return [];
  const rows = await ProformaInvoice.find(withCompany(req, { linkedOAId: oaId }))
    .select(
      "proformaNo proformaDate requestedAmount grandTotal commercialGrandTotal piValueType advancePercentage status paymentStatus balanceAmount totalReceivedAmount"
    )
    .sort({ proformaDate: 1, createdAt: 1 })
    .lean();
  const commercial =
    oaCommercial != null ? roundMoney(Math.max(0, Number(oaCommercial) || 0)) : null;
  return rows.map((row) => {
    const pay = resolvePiPaymentRequest(row);
    const advancePercentage =
      commercial != null && commercial > 0.005 && String(row.status || "").toUpperCase() !== "CANCELLED"
        ? recalculatePiAdvancePercentage(pay.requestedAmount, commercial)
        : pay.advancePercentage;
    return {
      _id: row._id,
      proformaNo: row.proformaNo || "",
      proformaDate: row.proformaDate || null,
      requestedAmount: pay.requestedAmount,
      advancePercentage,
      commercialGrandTotal: pay.commercialGrandTotal,
      piValueType: pay.piValueType,
      paymentStatus: row.paymentStatus || "UNPAID",
      status: row.status || "DRAFT",
      totalReceivedAmount: Math.max(0, Number(row.totalReceivedAmount) || 0),
      balanceAmount: Math.max(0, Number(row.balanceAmount) || 0),
    };
  });
}

/** Persist advanced % of OA commercial on active PIs without changing requested amounts. */
async function recalculateActivePiPercentagesForOa(req, oa) {
  if (!oa?._id) return;
  const commercial = roundMoney(Math.max(0, Number(oa.grandTotal) || 0));
  const rows = await ProformaInvoice.find(
    withCompany(req, { linkedOAId: oa._id, status: { $ne: "CANCELLED" } })
  );
  for (const pi of rows) {
    const pay = resolvePiPaymentRequest(pi.toObject?.() || pi);
    const pct = recalculatePiAdvancePercentage(pay.requestedAmount, commercial);
    pi.advancePercentage = pct;
    pi.updatedBy = req.user?.email || pi.updatedBy || "";
    await pi.save();
  }
}

async function hasActiveOrderAllocationForOA(req, oaId) {
  if (!oaId) return false;
  const row = await OrderAllocation.findOne(
    withCompany(req, { linkedOAId: oaId, status: { $ne: "CANCELLED" } })
  )
    .select("_id")
    .lean();
  return Boolean(row);
}

async function hasActiveSalesInvoiceForOA(req, oaId) {
  if (!oaId) return false;
  const row = await SalesInvoice.findOne(
    withCompany(req, { linkedOAId: oaId, status: { $ne: "CANCELLED" } })
  )
    .select("_id")
    .lean();
  return Boolean(row);
}

/**
 * Keep OA.status aligned with PI issuance without forcing packing/SI rows.
 * Does not lock editing; does not overwrite COMPLETED/PACKING/CANCELLED.
 */
async function syncOaStatusFromPiCapacity(req, oa, session = null) {
  if (!oa || String(oa.status || "").toUpperCase() === "CANCELLED") return false;
  const st = String(oa.status || "").toUpperCase();
  if (["CLOSED", "COMPLETED", "PACKING", "CONVERTED"].includes(st)) return false;
  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map(String) : [];
  if (conv.includes("ORDER_ALLOCATION") || conv.includes("SALES_INVOICE")) return false;

  const capacity = await resolveOaPiCapacity(req, oa);
  const next = suggestOaStatusAfterPiIssuance(capacity);
  const hadProforma = conv.includes("PROFORMA");

  if (capacity.activePiCount === 0) {
    if (hadProforma) {
      oa.convertedTo = conv.filter((x) => x.toUpperCase() !== "PROFORMA");
    }
  } else if (!hadProforma) {
    oa.convertedTo = [...conv, "PROFORMA"];
  }

  if (String(oa.status || "").toUpperCase() !== next) {
    oa.status = next;
  }
  oa.updatedBy = req.user?.email || oa.updatedBy || "";
  await oa.save({ session });
  return true;
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
  return syncOaStatusFromPiCapacity(req, oa, session);
}

async function enrichOAsWithCancelEligibility(req, oas = [], { includeProformaHistory = false } = {}) {
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
      const capacity = await resolveOaPiCapacity(req, oa);
      const [hasOrderAllocation, hasSalesInvoice] = await Promise.all([
        hasActiveOrderAllocationForOA(req, oa._id),
        hasActiveSalesInvoiceForOA(req, oa._id),
      ]);
      const progress = buildOaPiProgressSummary(oa, {
        ...capacity,
        hasOrderAllocation,
        hasSalesInvoice,
      });
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

      const proformaHistory = includeProformaHistory
        ? await loadOaProformaHistory(req, oa._id, { oaCommercial: oa.grandTotal })
        : undefined;

      return {
        ...oa,
        hasActiveProforma,
        canCancelOA,
        cancelOABlockReason,
        ...capacity,
        ...progress,
        hasOrderAllocation,
        hasSalesInvoice,
        commercialRevisions: Array.isArray(oa.commercialRevisions) ? oa.commercialRevisions : [],
        originalCommercialValue:
          oa.originalCommercialValue != null
            ? oa.originalCommercialValue
            : Array.isArray(oa.commercialRevisions) && oa.commercialRevisions[0]
              ? oa.commercialRevisions[0].originalCommercialValue
              : null,
        ...(proformaHistory ? { proformaHistory } : {}),
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
      SalesInvoice.countDocuments(
        withCompany(req, {
          documentStatus: { $ne: "CANCELLED" },
          paymentStatus: { $in: ["UNPAID", "PARTIAL", "PARTIALLY_PAID"] },
        })
      ),
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
        ...customerDetailSearchOr(q),
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
      contactPerson: doc.contactPerson || "",
      attention: doc.attention || "",
      paymentTerms: doc.paymentTerms || "",
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
      filter.$or = [
        { oaNo: new RegExp(q, "i") },
        { linkedQuotationNo: new RegExp(q, "i") },
        ...customerDetailSearchOr(q),
      ];
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
      contactPerson: doc.contactPerson || "",
      attention: doc.attention || "",
      paymentTerms: doc.paymentTerms || "",
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
    const rows = rowsRaw.map((doc) => {
      const pay = resolvePiPaymentRequest(doc);
      return {
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
        commercialTotal: toNumber(pay.commercialGrandTotal),
        requestedAmount: toNumber(pay.requestedAmount),
        advancePercentage: pay.advancePercentage,
        commercialBalanceAmount: toNumber(pay.commercialBalanceAmount),
        piValueType: pay.piValueType,
        status: doc.status || "DRAFT",
        validity: doc.validity || "",
        paymentTerms: doc.paymentTerms || "",
      };
    });
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
      OrderAcknowledgement.find(
        withCompany(req, {
          status: { $nin: ["CANCELLED", "CONVERTED", "CLOSED", "PACKING", "COMPLETED"] },
        })
      ).lean(),
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
    if (req.query.paymentStatus) {
      const ps = normalizePaymentStatus(req.query.paymentStatus);
      filter.paymentStatus = ps === "PARTIALLY_PAID" ? { $in: ["PARTIALLY_PAID", "PARTIAL"] } : ps;
    }
    if (req.query.documentStatus) {
      filter.documentStatus = normalizeDocumentStatus(req.query.documentStatus);
    }
    if (req.query.status) {
      const st = String(req.query.status).toUpperCase();
      if (["DRAFT", "CANCELLED", "ISSUED"].includes(st)) filter.documentStatus = st;
      else if (st === "PAID") filter.paymentStatus = "PAID";
      else if (st === "PARTIALLY_PAID") filter.paymentStatus = { $in: ["PARTIALLY_PAID", "PARTIAL"] };
      else if (st === "DISPATCHED") filter.dispatchStatus = "FULLY_DISPATCHED";
    }
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [
        { invoiceNo: new RegExp(q, "i") },
        { linkedProformaNo: new RegExp(q, "i") },
        ...customerDetailSearchOr(q),
      ];
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
            paidValue: {
              $sum: {
                $cond: [{ $eq: ["$paymentStatus", "PAID"] }, { $ifNull: ["$grandTotal", 0] }, 0],
              },
            },
            unpaidValue: {
              $sum: {
                $cond: [{ $ne: ["$paymentStatus", "PAID"] }, { $ifNull: ["$grandTotal", 0] }, 0],
              },
            },
            overdueInvoicesCount: { $sum: 0 },
          },
        },
      ]),
    ]);
    const rows = rowsRaw.map((doc) => {
      const invoiceValue = toNumber(doc.grandTotal);
      const paidAmount = toNumber(doc.totalReceivedAmount);
      const balanceAmount = Math.max(0, toNumber(doc.balanceAmount ?? invoiceValue - paidAmount));
      return {
        _id: doc._id,
        invoiceNo: doc.invoiceNo,
        invoiceDate: doc.invoiceDate,
        customerName: doc.customerName,
        customerReference: doc.customerReference || "",
        contactPerson: doc.contactPerson || "",
        attention: doc.attention || "",
        paymentTerms: doc.paymentTerms || "",
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
        documentStatus: normalizeDocumentStatus(
          doc.documentStatus || (doc.status === "DRAFT" || doc.status === "CANCELLED" ? doc.status : "ISSUED")
        ),
        paymentStatus: normalizePaymentStatus(doc.paymentStatus || "UNPAID"),
        dispatchStatus: doc.dispatchStatus || "NOT_DISPATCHED",
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
          paidAmount: { $sum: { $cond: [{ $eq: ["$paymentStatus", "PAID"] }, "$grandTotal", 0] } },
          unpaidAmount: { $sum: { $cond: [{ $ne: ["$paymentStatus", "PAID"] }, "$grandTotal", 0] } },
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
    if (body.contactName !== undefined) {
      body.contactName = clampText(body.contactName, CUSTOMER_FIELD_LIMITS.contactPerson);
    }
    if (body.attention !== undefined) {
      body.attention = clampText(body.attention, CUSTOMER_FIELD_LIMITS.attention);
    }
    if (body.billingAddress !== undefined) {
      body.billingAddress = clampText(body.billingAddress, CUSTOMER_FIELD_LIMITS.billingAddress);
    }
    if (body.shippingAddress !== undefined) {
      body.shippingAddress = clampText(body.shippingAddress, CUSTOMER_FIELD_LIMITS.shippingAddress);
    }
    if (body.documentPaymentTerms !== undefined) {
      body.documentPaymentTerms = clampText(body.documentPaymentTerms, CUSTOMER_FIELD_LIMITS.paymentTerms);
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
    const allowed = [
      "name",
      "contactName",
      "attention",
      "phone",
      "email",
      "address",
      "billingAddress",
      "shippingAddress",
      "paymentTerms",
      "documentPaymentTerms",
      "notes",
    ];
    const payload = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) payload[key] = req.body[key];
    }
    if (payload.contactName !== undefined) {
      payload.contactName = clampText(payload.contactName, CUSTOMER_FIELD_LIMITS.contactPerson);
    }
    if (payload.attention !== undefined) {
      payload.attention = clampText(payload.attention, CUSTOMER_FIELD_LIMITS.attention);
    }
    if (payload.billingAddress !== undefined) {
      payload.billingAddress = clampText(payload.billingAddress, CUSTOMER_FIELD_LIMITS.billingAddress);
    }
    if (payload.shippingAddress !== undefined) {
      payload.shippingAddress = clampText(payload.shippingAddress, CUSTOMER_FIELD_LIMITS.shippingAddress);
    }
    if (payload.documentPaymentTerms !== undefined) {
      payload.documentPaymentTerms = clampText(
        payload.documentPaymentTerms,
        CUSTOMER_FIELD_LIMITS.paymentTerms
      );
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
      filter.$or = [{ oaNo: new RegExp(q, "i") }, ...customerDetailSearchOr(q)];
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
    const [enriched] = await enrichOAsWithCancelEligibility(req, [patched || doc], {
      includeProformaHistory: true,
    });
    const base = enriched || patched || doc;
    const resolvedTermsAndConditions = await resolveEffectiveTermsAndConditions(req, base, "OA");
    res.json({ ...base, resolvedTermsAndConditions });
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
    const orderAcknowledgement = await withResolvedTermsForPrint(req, doc, "OA");
    res.json({
      orderAcknowledgement,
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

export async function getProformaPrintData(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const docRaw = await ProformaInvoice.findOne(withCompany(req, { _id: id })).lean();
    if (!docRaw) return res.status(404).json({ message: "Not found" });
    const [withPricing] = await applyLinkedQuotationDiscountFallback(req, [docRaw], { persistModel: ProformaInvoice });
    const [enriched] = await enrichProformasWithPaymentState(req, [withPricing || docRaw]);
    const proforma = await withResolvedTermsForPrint(req, enriched || withPricing || docRaw, "PROFORMA");
    res.json({ proforma });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSalesInvoicePrintData(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const docRaw = await SalesInvoice.findOne(withCompany(req, { _id: id })).lean();
    if (!docRaw) return res.status(404).json({ message: "Not found" });
    const [enriched] = await enrichSalesInvoicesWithPaymentState(req, [docRaw]);
    const salesInvoice = await withResolvedTermsForPrint(req, enriched || docRaw, "SALES_INVOICE");
    res.json({ salesInvoice });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createOA(req, res) {
  try {
    const body = { ...req.body };
    const fromWorkingCopy = isOaWorkingCopyPayload(body);

    if (!String(body.customerName || "").trim()) {
      return res.status(400).json({ message: "Customer name is required", code: "VALIDATION" });
    }

    const lineErrors = validateOaLineFields(body.lines || [], { fromWorkingCopy });
    if (lineErrors.length) {
      return res.status(400).json({
        message: lineErrors[0],
        code: "VALIDATION",
        errors: lineErrors,
      });
    }

    if (fromWorkingCopy) {
      const validation = await validateOaWorkingCopyBeforeSave({
        companyId: req.companyId,
        body,
      });
      if (!validation.ok) {
        return res.status(validation.code === "STALE_CONSUMPTION" ? 409 : 400).json({
          message: validation.message,
          code: validation.code,
          violations: validation.violations,
          reasons: validation.reasons,
          errors: validation.errors,
        });
      }
    }

    const lines = fromWorkingCopy
      ? normalizeOALinesFromWorkingCopy(body.lines || [])
      : normalizeLines(body.lines || []);
    if (!lines.length) {
      return res.status(400).json({
        message: fromWorkingCopy
          ? "OA requires at least one included line with ordered quantity > 0"
          : "OA requires at least one line",
        code: "VALIDATION",
      });
    }
    let oaNo;
    if (String(body.oaNo || "").trim()) {
      const prepared = await applyManualSalesDocumentNumber({
        companyId: req.companyId,
        documentType: "OA",
        value: body.oaNo,
        model: OrderAcknowledgement,
        field: "oaNo",
      });
      oaNo = prepared.number;
    } else {
      oaNo = await nextUniqueSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "ORDER_ACK",
        model: OrderAcknowledgement,
        field: "oaNo",
      });
    }
    const totals = computeTotals(lines, body);
    const linkedQtnId = body.linkedQuotationId || body.sourceQuotationId;
    let termsAndConditions = t(body.termsAndConditions);
    if (!termsAndConditions && linkedQtnId && mongoose.Types.ObjectId.isValid(String(linkedQtnId))) {
      termsAndConditions = await resolveTermsFromQuotation(req, linkedQtnId);
    }
    const sourceMeta = fromWorkingCopy ? buildOaSourceMetadataForPersist(body, req.user) : {};
    const doc = await OrderAcknowledgement.create({
      companyId: req.companyId,
      oaNo,
      oaDate: body.oaDate ? new Date(body.oaDate) : new Date(),
      oaSourceType: String(body.oaSourceType || "").toUpperCase() === "FROM_QUOTATION" ? "FROM_QUOTATION" : "BLANK",
      linkedQuotationId: mongoose.Types.ObjectId.isValid(String(linkedQtnId || ""))
        ? new mongoose.Types.ObjectId(String(linkedQtnId))
        : null,
      linkedQuotationNo: String(body.linkedQuotationNo || body.sourceQuotationNo || sourceMeta.sourceDocumentNumber || "").trim(),
      ...sourceMeta,
      customerName: String(body.customerName || "").trim(),
      customerPORef: String(body.customerPORef || body.customerReference || "").trim(),
      ...pickCustomerTransactionFieldsFromBody({
        contactPerson: body.contactPerson || "",
        attention: body.attention || "",
        billingAddress: body.billingAddress || "",
        shippingAddress: body.shippingAddress || "",
        paymentTerms: body.paymentTerms || "",
      }),
      acknowledgementNotes: String(body.acknowledgementNotes || "").trim(),
      termsAndConditions,
      deliverySchedule: String(body.deliverySchedule || "").trim(),
      incoterm: String(body.incoterm || "").trim(),
      dispatchTerms: String(body.dispatchTerms || "").trim(),
      currency: String(body.currency || "USD").toUpperCase(),
      vertical: String(body.vertical || "").trim(),
      engine: String(body.engine || "").trim(),
      model: String(body.model || "").trim(),
      config: String(body.config || "").trim(),
      esn: String(body.esn || "").trim(),
      discountType: body.discountType || "NONE",
      discountValue: Number(body.discountValue) || 0,
      packingCost: Math.max(0, Number(body.packingCost) || 0),
      clearanceCost: Math.max(0, Number(body.clearanceCost) || 0),
      taxTotal: Math.max(0, Number(body.taxTotal) || 0),
      lines,
      ...totals,
      status: "ACTIVE",
      createdBy: req.user?.email || "",
    });
    // Snapshot OA creation never mutates the source quotation.
    res.status(201).json(doc);
  } catch (err) {
    const dup = mapSalesDocNumberDuplicateError(err, {
      documentLabel: "Order Acknowledgement",
      number: req.body?.oaNo,
    });
    if (dup) return res.status(dup.statusCode).json({ message: dup.message });
    res.status(err.statusCode || 400).json({ message: err.message });
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
    const [hasOrderAllocation, hasSalesInvoice, capacity] = await Promise.all([
      hasActiveOrderAllocationForOA(req, doc._id),
      hasActiveSalesInvoiceForOA(req, doc._id),
      resolveOaPiCapacity(req, doc),
    ]);
    if (
      isOAEditLocked(doc, {
        hasActiveProforma,
        hasOrderAllocation,
        hasSalesInvoice,
        ...capacity,
      })
    ) {
      return res.status(400).json({
        message:
          "This order acknowledgement is locked after packing / sales invoice / completion; it cannot be edited.",
      });
    }
    const beforeSnapshot = doc.toObject();
    let numberChange = null;
    if (req.body.oaNo !== undefined) {
      try {
        const previousNo = String(doc.oaNo || "").trim();
        const validated = validateManualSalesDocumentNumber({
          value: req.body.oaNo,
          expectedDocumentType: "OA",
        });
        if (validated.number !== previousNo) {
          await assertSalesDocumentNumberChangeAllowed({
            companyId: req.companyId,
            documentType: "OA",
            documentId: doc._id,
          });
          const prepared = await applyManualSalesDocumentNumber({
            companyId: req.companyId,
            documentType: "OA",
            value: req.body.oaNo,
            model: OrderAcknowledgement,
            field: "oaNo",
            excludeId: doc._id,
            previousNumber: previousNo,
          });
          numberChange = { oldNumber: previousNo, newNumber: prepared.number };
          doc.oaNo = prepared.number;
        } else {
          doc.oaNo = validated.number;
        }
      } catch (numErr) {
        return res.status(numErr.statusCode || 400).json({ message: numErr.message });
      }
    }
    const allowed = [
      "oaDate",
      "customerName",
      "customerPORef",
      "customerPODate",
      "contactPerson",
      "attention",
      "billingAddress",
      "shippingAddress",
      "acknowledgementNotes",
      "termsAndConditions",
      "deliverySchedule",
      "paymentTerms",
      "incoterm",
      "dispatchTerms",
      "currency",
      "lines",
      "packingCost",
      "clearanceCost",
      "discountType",
      "discountValue",
      "taxTotal",
      "vertical",
      "engine",
      "model",
      "config",
      "esn",
      "linkedQuotationNo",
      "sourceDocumentNumber",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    Object.assign(doc, pickCustomerTransactionFieldsFromBody(req.body));
    if (req.body.customerPODate !== undefined) {
      const raw = req.body.customerPODate;
      doc.customerPODate = raw === "" || raw === null || raw === undefined ? null : new Date(raw);
    }
    if (req.body.status !== undefined) {
      const st = String(req.body.status || "").toUpperCase();
      if (["APPROVED", "CONVERTED", "PACKING", "COMPLETED", "PARTIALLY_PI_ISSUED", "FULLY_PI_ISSUED"].includes(st)) {
        return res.status(400).json({
          message: "This OA status is managed automatically from PI issuance, packing, and sales invoice progress.",
        });
      }
      doc.status = req.body.status;
    }
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines, doc));
    const previousCommercial = roundMoney(Math.max(0, Number(beforeSnapshot.grandTotal) || 0));
    const revisedCommercial = roundMoney(Math.max(0, Number(doc.grandTotal) || 0));
    const commercialChanged = Math.abs(revisedCommercial - previousCommercial) > 0.005;
    let commercialRevision = null;

    if (hasActiveProforma && commercialChanged) {
      try {
        commercialRevision = buildOaCommercialRevision({
          previousCommercial,
          revisedCommercial,
          issuedRequestedTotal: capacity.piIssuedRequestedTotal,
          existingRevisions: doc.commercialRevisions || [],
          reason:
            req.body.commercialRevisionReason ??
            req.body.revisionReason ??
            req.body.reason ??
            "",
          revisedBy: req.user?.email || "",
          revisionDate: new Date(),
        });
      } catch (revErr) {
        return res.status(400).json({ message: revErr.message });
      }
      if (commercialRevision) {
        if (doc.originalCommercialValue == null) {
          doc.originalCommercialValue = commercialRevision.originalCommercialValue;
        }
        doc.commercialRevisions = [...(doc.commercialRevisions || []), commercialRevision];
      }
    } else if (hasActiveProforma) {
      const issued = Number(capacity.piIssuedRequestedTotal) || 0;
      if (revisedCommercial + 0.005 < issued) {
        return res.status(400).json({
          message: `Commercial total cannot be below PI amount already issued (${issued.toFixed(2)})`,
        });
      }
    }

    doc.updatedBy = req.user?.email || "";
    await doc.save();
    if (commercialRevision) {
      await recalculateActivePiPercentagesForOa(req, doc);
    }
    if (hasActiveProforma || String(doc.status || "").toUpperCase().includes("PI_ISSUED")) {
      await syncOaStatusFromPiCapacity(req, doc);
    }
    const customerFieldChanges = diffCustomerTransactionFields(beforeSnapshot, doc);
    const auditMetadata = {
      ...(commercialRevision
        ? {
            commercialRevision: true,
            revisionNumber: commercialRevision.revisionNumber,
            reason: commercialRevision.reason,
          }
        : {}),
      ...(numberChange
        ? {
            documentNumberChanged: true,
            documentType: "OA",
            oldNumber: numberChange.oldNumber,
            newNumber: numberChange.newNumber,
          }
        : {}),
    };
    await writeAudit(req, {
      action: "UPDATE",
      module: "SALES",
      entityType: "ORDER_ACKNOWLEDGEMENT",
      entityId: doc._id,
      documentNo: doc.oaNo || "",
      description: numberChange
        ? `Order Acknowledgement number changed from ${numberChange.oldNumber || "—"} to ${numberChange.newNumber}`
        : commercialRevision
          ? `Order Acknowledgement ${doc.oaNo || ""} commercial revision #${commercialRevision.revisionNumber}`
          : `Order Acknowledgement ${doc.oaNo || ""} updated`,
      beforeData: {
        ...customerTransactionAuditFieldSlice(beforeSnapshot),
        grandTotal: previousCommercial,
        ...(numberChange ? { oaNo: numberChange.oldNumber } : {}),
      },
      afterData: {
        ...customerTransactionAuditFieldSlice(doc),
        grandTotal: revisedCommercial,
        ...(customerFieldChanges ? { customerFieldChanges } : {}),
        ...(numberChange ? { oaNo: numberChange.newNumber } : {}),
        ...(commercialRevision
          ? {
              commercialRevision: {
                revisionNumber: commercialRevision.revisionNumber,
                originalCommercialValue: commercialRevision.originalCommercialValue,
                revisedCommercialValue: commercialRevision.revisedCommercialValue,
                difference: commercialRevision.difference,
                reason: commercialRevision.reason,
                revisedBy: commercialRevision.revisedBy,
                revisionDate: commercialRevision.revisionDate,
              },
            }
          : {}),
      },
      metadata: Object.keys(auditMetadata).length ? auditMetadata : null,
    });
    const [enriched] = await enrichOAsWithCancelEligibility(req, [doc.toObject()], {
      includeProformaHistory: true,
    });
    res.json(enriched || doc);
  } catch (err) {
    const dup = mapSalesDocNumberDuplicateError(err, {
      documentLabel: "Order Acknowledgement",
      number: req.body?.oaNo,
    });
    if (dup) return res.status(dup.statusCode).json({ message: dup.message });
    res.status(err.statusCode || 400).json({ message: err.message });
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
      filter.$or = [{ proformaNo: new RegExp(q, "i") }, ...customerDetailSearchOr(q)];
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
    const base = enriched || withPricing || docRaw;
    const resolvedTermsAndConditions = await resolveEffectiveTermsAndConditions(req, base, "PROFORMA");
    res.json({ ...base, resolvedTermsAndConditions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createProforma(req, res) {
  try {
    const body = { ...req.body };
    const lines = normalizeLines(body.lines || []);
    if (!lines.length) return res.status(400).json({ message: "Proforma requires at least one line" });
    let proformaNo;
    if (String(body.proformaNo || "").trim()) {
      const prepared = await applyManualSalesDocumentNumber({
        companyId: req.companyId,
        documentType: "PI",
        value: body.proformaNo,
        model: ProformaInvoice,
        field: "proformaNo",
      });
      proformaNo = prepared.number;
    } else {
      proformaNo = await nextUniqueSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "PROFORMA",
        model: ProformaInvoice,
        field: "proformaNo",
      });
    }
    const totals = computeTotals(lines, body);
    const currency = body.currency || "USD";
    let bankDetails = String(body.bankDetails || "").trim();
    if (!bankDetails) {
      bankDetails = (await resolveBankDetailsTextForCurrency(withCompany(req), currency)) || "";
    }
    const customerFields = pickCustomerTransactionFieldsFromBody(body);
    let maxRequestedAmount = null;
    if (body.linkedOAId && mongoose.Types.ObjectId.isValid(String(body.linkedOAId))) {
      const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: body.linkedOAId })).lean();
      if (oa) {
        const capacity = await resolveOaPiCapacity(req, oa);
        maxRequestedAmount = capacity.piRemainingEligibleAmount;
        if (maxRequestedAmount <= 0.005) {
          return res.status(409).json({
            message: "PI-eligible amount for this Order Acknowledgement is fully issued",
          });
        }
      }
    }
    const paymentRequest = buildValidatedPiPaymentRequest(totals.grandTotal, body, { maxRequestedAmount });
    const doc = await ProformaInvoice.create({
      ...body,
      ...customerFields,
      customerReference: String(body.customerReference || "").trim(),
      bankDetails,
      lines,
      ...totals,
      ...paymentRequest,
      proformaNo,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    });
    if (doc.linkedOAId) {
      const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: doc.linkedOAId }));
      if (oa) await syncOaStatusFromPiCapacity(req, oa);
    }
    res.status(201).json(doc);
  } catch (err) {
    const dup = mapSalesDocNumberDuplicateError(err, {
      documentLabel: "Proforma Invoice",
      number: req.body?.proformaNo,
    });
    if (dup) return res.status(dup.statusCode).json({ message: dup.message });
    res.status(err.statusCode || 400).json({ message: err.message });
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
    const beforeSnapshot = doc.toObject();
    let numberChange = null;
    if (req.body.proformaNo !== undefined) {
      try {
        const previousNo = String(doc.proformaNo || "").trim();
        const validated = validateManualSalesDocumentNumber({
          value: req.body.proformaNo,
          expectedDocumentType: "PI",
        });
        if (validated.number !== previousNo) {
          await assertSalesDocumentNumberChangeAllowed({
            companyId: req.companyId,
            documentType: "PI",
            documentId: doc._id,
          });
          const prepared = await applyManualSalesDocumentNumber({
            companyId: req.companyId,
            documentType: "PI",
            value: req.body.proformaNo,
            model: ProformaInvoice,
            field: "proformaNo",
            excludeId: doc._id,
            previousNumber: previousNo,
          });
          numberChange = { oldNumber: previousNo, newNumber: prepared.number };
          doc.proformaNo = prepared.number;
        } else {
          doc.proformaNo = validated.number;
        }
      } catch (numErr) {
        return res.status(numErr.statusCode || 400).json({ message: numErr.message });
      }
    }
    const previousCurrency = String(doc.currency || "USD").trim().toUpperCase();
    const allowed = [
      "proformaDate",
      "customerName",
      "contactPerson",
      "attention",
      "billingAddress",
      "shippingAddress",
      "customerReference",
      "paymentTerms",
      "bankDetails",
      "validity",
      "shipmentTerms",
      "remarks",
      "termsAndConditions",
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
      "linkedQuotationNo",
      "linkedOANo",
      "piValueType",
      "advancePercentage",
      "requestedAmount",
      "advanceRemarks",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    Object.assign(doc, pickCustomerTransactionFieldsFromBody(req.body));
    const newCurrency = String(doc.currency || "USD").trim().toUpperCase();
    if (newCurrency !== previousCurrency) {
      const bankText = await resolveBankDetailsTextForCurrency(withCompany(req), doc.currency);
      if (bankText) doc.bankDetails = bankText;
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
    const totals = computeTotals(doc.lines, doc);
    Object.assign(doc, totals);
    let maxRequestedAmount = null;
    if (doc.linkedOAId) {
      const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: doc.linkedOAId })).lean();
      if (oa) {
        const capacity = await resolveOaPiCapacity(req, oa, { excludePiId: doc._id });
        maxRequestedAmount = capacity.piRemainingEligibleAmount;
      }
    }
    const paymentRequest = buildValidatedPiPaymentRequest(totals.grandTotal, {
      piValueType: req.body.piValueType !== undefined ? req.body.piValueType : doc.piValueType,
      advancePercentage:
        req.body.advancePercentage !== undefined ? req.body.advancePercentage : doc.advancePercentage,
      requestedAmount: req.body.requestedAmount !== undefined ? req.body.requestedAmount : doc.requestedAmount,
      advanceRemarks: req.body.advanceRemarks !== undefined ? req.body.advanceRemarks : doc.advanceRemarks,
    }, { maxRequestedAmount });
    Object.assign(doc, paymentRequest);
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    const customerFieldChanges = diffCustomerTransactionFields(beforeSnapshot, doc);
    await writeAudit(req, {
      action: "UPDATE",
      module: "SALES",
      entityType: "PROFORMA_INVOICE",
      entityId: doc._id,
      documentNo: doc.proformaNo || "",
      description: numberChange
        ? `Proforma Invoice number changed from ${numberChange.oldNumber || "—"} to ${numberChange.newNumber}`
        : `Proforma Invoice ${doc.proformaNo || ""} updated`,
      beforeData: {
        ...customerTransactionAuditFieldSlice(beforeSnapshot),
        piValueType: beforeSnapshot.piValueType || "FULL",
        requestedAmount: beforeSnapshot.requestedAmount,
        advancePercentage: beforeSnapshot.advancePercentage,
        ...(numberChange ? { proformaNo: numberChange.oldNumber } : {}),
      },
      afterData: {
        ...customerTransactionAuditFieldSlice(doc),
        piValueType: doc.piValueType,
        requestedAmount: doc.requestedAmount,
        advancePercentage: doc.advancePercentage,
        ...(customerFieldChanges ? { customerFieldChanges } : {}),
        ...(numberChange ? { proformaNo: numberChange.newNumber } : {}),
      },
      metadata: numberChange
        ? {
            documentNumberChanged: true,
            documentType: "PI",
            oldNumber: numberChange.oldNumber,
            newNumber: numberChange.newNumber,
          }
        : null,
    });
    if (doc.linkedOAId) {
      const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: doc.linkedOAId }));
      if (oa) await syncOaStatusFromPiCapacity(req, oa);
    }
    res.json(doc);
  } catch (err) {
    const dup = mapSalesDocNumberDuplicateError(err, {
      documentLabel: "Proforma Invoice",
      number: req.body?.proformaNo,
    });
    if (dup) return res.status(dup.statusCode).json({ message: dup.message });
    res.status(err.statusCode || 400).json({ message: err.message });
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
    const customerFields = copyCustomerTransactionFields(quotation);
    const doc = await OrderAcknowledgement.create({
      companyId: req.companyId,
      oaNo,
      oaDate: new Date(),
      linkedQuotationId: quotation._id,
      linkedQuotationNo: quotation.quotationNo,
      customerName: quotation.customerName,
      customerPORef: quotation.customerReference || "",
      ...customerFields,
      incoterm: quotation.incoterm || "",
      currency: quotation.currency || "USD",
      acknowledgementNotes: quotation.remarks || "",
      termsAndConditions: quotation.termsAndConditions || "",
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
    const currency = quotation.currency || "USD";
    const bankDetails = (await resolveBankDetailsTextForCurrency(withCompany(req), currency)) || "";
    const customerFields = copyCustomerTransactionFields(quotation);
    const paymentRequest = defaultFullPiPaymentRequest(totals.grandTotal);
    const doc = await ProformaInvoice.create({
      companyId: req.companyId,
      proformaNo,
      proformaDate: new Date(),
      linkedQuotationId: quotation._id,
      linkedQuotationNo: quotation.quotationNo,
      customerName: quotation.customerName,
      customerReference: quotation.customerReference || "",
      ...customerFields,
      validity: quotation.validityDate ? new Date(quotation.validityDate).toISOString().slice(0, 10) : "",
      shipmentTerms: quotation.deliveryTerms || "",
      currency,
      bankDetails,
      remarks: quotation.remarks || "",
      termsAndConditions: quotation.termsAndConditions || "",
      vertical: quotation.vertical || "",
      engine: quotation.engine || "",
      model: quotation.model || "",
      config: quotation.config || "",
      esn: quotation.esn || "",
      lines,
      ...totals,
      ...paymentRequest,
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
    const capacity = await resolveOaPiCapacity(req, oa);
    if (["CANCELLED", "COMPLETED", "CLOSED"].includes(String(oa.status || "").toUpperCase())) {
      return res.status(400).json({ message: "Cannot create Proforma from a cancelled or completed OA" });
    }
    if (!capacity.canCreateAdditionalProforma) {
      return res.status(409).json({
        message: `PI-eligible amount fully issued for this OA (${capacity.piIssuedRequestedTotal.toFixed(2)} of ${capacity.oaCommercialGrandTotal.toFixed(2)})`,
      });
    }

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
    const currency = oa.currency || "USD";
    const bankDetails = (await resolveBankDetailsTextForCurrency(withCompany(req), currency)) || "";
    let termsAndConditions = t(oa.termsAndConditions);
    if (!termsAndConditions && oa.linkedQuotationId) {
      termsAndConditions = await resolveTermsFromQuotation(req, oa.linkedQuotationId);
    }
    let precedingQuotation = null;
    if (oa.linkedQuotationId) {
      precedingQuotation = await Quotation.findOne(withCompany(req, { _id: oa.linkedQuotationId })).lean();
    }
    const customerFields = copyCustomerTransactionFields(oa, { preceding: precedingQuotation });
    const paymentRequest = defaultFullPiPaymentRequest(totals.grandTotal);
    const doc = await ProformaInvoice.create({
      companyId: req.companyId,
      proformaNo,
      proformaDate: new Date(),
      linkedQuotationId: oa.linkedQuotationId || null,
      linkedQuotationNo: oa.linkedQuotationNo || "",
      linkedOAId: oa._id,
      linkedOANo: oa.oaNo,
      customerName: oa.customerName,
      customerReference: oa.customerPORef || precedingQuotation?.customerReference || "",
      ...customerFields,
      shipmentTerms: oa.deliverySchedule || "",
      currency,
      bankDetails,
      remarks: oa.acknowledgementNotes || "",
      termsAndConditions,
      vertical: oa.vertical || "",
      engine: oa.engine || "",
      model: oa.model || "",
      config: oa.config || "",
      esn: oa.esn || "",
      lines,
      ...totals,
      ...paymentRequest,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!oa.convertedTo?.includes("PROFORMA")) oa.convertedTo = [...(oa.convertedTo || []), "PROFORMA"];
    oa.updatedBy = req.user?.email || "";
    await oa.save();
    await syncOaStatusFromPiCapacity(req, oa);
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
      filter.$or = [{ invoiceNo: new RegExp(q, "i") }, ...customerDetailSearchOr(q)];
    }
    if (req.query.paymentStatus) {
      const ps = normalizePaymentStatus(req.query.paymentStatus);
      filter.paymentStatus = ps === "PARTIALLY_PAID" ? { $in: ["PARTIALLY_PAID", "PARTIAL"] } : ps;
    }
    if (req.query.documentStatus) {
      filter.documentStatus = normalizeDocumentStatus(req.query.documentStatus);
    }
    if (req.query.dispatchStatus) {
      filter.dispatchStatus = String(req.query.dispatchStatus).trim().toUpperCase();
    }
    // Legacy status filter: map only document-like values; payment/dispatch filters use dedicated params.
    if (req.query.status) {
      const st = String(req.query.status).trim().toUpperCase();
      if (["DRAFT", "CANCELLED"].includes(st)) filter.documentStatus = st;
      else if (st === "ISSUED") filter.documentStatus = "ISSUED";
      else if (st === "PAID") filter.paymentStatus = "PAID";
      else if (st === "PARTIALLY_PAID") filter.paymentStatus = { $in: ["PARTIALLY_PAID", "PARTIAL"] };
      else if (st === "DISPATCHED") filter.dispatchStatus = "FULLY_DISPATCHED";
      else filter.status = st;
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
    const paymentStatus = computePaymentStatus({ grandTotal: total, receivedAmount: received });
    return {
      ...r,
      totalReceivedAmount: received,
      balanceAmount: balance,
      paymentStatus,
      documentStatus: normalizeDocumentStatus(r.documentStatus || (r.status === "DRAFT" || r.status === "CANCELLED" ? r.status : "ISSUED")),
      dispatchStatus: r.dispatchStatus || "NOT_DISPATCHED",
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
    const base = enriched || doc;
    const resolvedTermsAndConditions = await resolveEffectiveTermsAndConditions(req, base, "SALES_INVOICE");
    res.json({ ...base, resolvedTermsAndConditions });
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
    const termsAndConditions =
      t(req.body?.termsAndConditions) ||
      (await resolveTermsForSalesInvoice(req, {
        proformaId: allocationPre.linkedProformaId,
        oaId: allocationPre.linkedOAId,
        quotationId: allocationPre.linkedQuotationId,
      }));
    const invoiceNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "SALES_INVOICE",
      model: SalesInvoice,
      field: "invoiceNo",
    });
    const customerFields = await resolveCustomerFieldsForPackingInvoice(
      req,
      allocationPre,
      req.body || {},
      packingPre
    );

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
            contactPerson: customerFields.contactPerson || "",
            attention: customerFields.attention || "",
            paymentTerms: customerFields.paymentTerms || "",
            dispatchDetails: "",
            shippingAddress: customerFields.shippingAddress || "",
            billingAddress: customerFields.billingAddress || "",
            customerReference:
              t(req.body?.customerReference) ||
              t(packing.customerReference) ||
              "",
            currency: packing.currency || allocation.currency || "USD",
            vertical: allocation.vertical || "",
            engine: packing.engine || allocation.engine || "",
            model: packing.model || allocation.model || "",
            config: allocation.config || "",
            esn: packing.esn || allocation.esn || "",
            remarks: t(req.body?.remarks),
            termsAndConditions,
            lines,
            ...totals,
            documentStatus: "ISSUED",
            paymentStatus: "UNPAID",
            dispatchStatus: "NOT_DISPATCHED",
            status: "ISSUED", // deprecated compat projection
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
      if (allocation.linkedOAId) {
        const oaDoc = await OrderAcknowledgement.findOne(
          withCompany(req, { _id: allocation.linkedOAId })
        ).session(session);
        if (oaDoc && String(oaDoc.status || "").toUpperCase() !== "CANCELLED") {
          oaDoc.status = "COMPLETED";
          const conv = Array.isArray(oaDoc.convertedTo) ? oaDoc.convertedTo.map(String) : [];
          if (!conv.includes("SALES_INVOICE")) oaDoc.convertedTo = [...conv, "SALES_INVOICE"];
          oaDoc.updatedBy = req.user?.email || "";
          await oaDoc.save({ session });
        }
      }
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
    const protectedErr = rejectProtectedSiStateFields(req.body || {});
    if (protectedErr) {
      return res.status(protectedErr.statusCode).json({
        message: protectedErr.message,
        code: protectedErr.code,
        fields: protectedErr.fields,
      });
    }
    // S1 — issued/cancelled documents are immutable except remarks + dedicated lifecycle actions.
    const docStatus = normalizeDocumentStatus(
      doc.documentStatus ||
        (["DRAFT", "CANCELLED"].includes(String(doc.status || "").toUpperCase()) ? doc.status : "ISSUED")
    );
    if (docStatus === "ISSUED" || docStatus === "CANCELLED") {
      const otherEditedKey = Object.keys(req.body || {}).find((k) => k !== "remarks");
      if (otherEditedKey) {
        blockTransition(
          DOC_TYPES.SALES_INVOICE,
          docStatus,
          docStatus,
          `Cannot edit field "${otherEditedKey}" on a ${docStatus} sales invoice (${doc.invoiceNo}). Cancel and re-issue if needed.`,
          { invoiceNo: doc.invoiceNo, attemptedField: otherEditedKey }
        );
      }
    }
    const allowed = [
      "invoiceDate",
      "customerName",
      "contactPerson",
      "attention",
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
      "remarks",
      "termsAndConditions",
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
    Object.assign(doc, pickCustomerTransactionFieldsFromBody(req.body));
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines, doc));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    const afterCanon = canonicalStatus(DOC_TYPES.SALES_INVOICE, doc.status);
    if (beforeCanon === "DRAFT" && ["POSTED", "PARTIAL_PAYMENT", "PAID"].includes(afterCanon)) {
      await postSalesInvoiceReceivable({ req, invoice: doc });
    }
    const customerFieldChanges = diffCustomerTransactionFields(beforeSnapshot, doc);
    await writeAudit(req, {
      action: "UPDATE",
      module: "SALES",
      entityType: "SALES_INVOICE",
      entityId: doc._id,
      documentNo: doc.invoiceNo,
      description: `Sales Invoice ${doc.invoiceNo} updated`,
      beforeData: {
        status: beforeSnapshot.status,
        grandTotal: beforeSnapshot.grandTotal,
        ...customerTransactionAuditFieldSlice(beforeSnapshot),
      },
      afterData: {
        status: doc.status,
        grandTotal: doc.grandTotal,
        ...customerTransactionAuditFieldSlice(doc),
        ...(customerFieldChanges ? { customerFieldChanges } : {}),
      },
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
          to: "AVAILABLE",
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
      inv.documentStatus = "CANCELLED";
      inv.status = "CANCELLED"; // deprecated compat
      inv.cancelledAt = new Date();
      inv.cancelledBy = req.user?.email || "";
      inv.cancellationReason = reason;
      inv.updatedBy = req.user?.email || "";
      await inv.save({ session });
      await reverseSalesInvoiceReceivable({ req, invoice: inv, reason, session });
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
      if (allocation && inv.stockPostedAt && !inv.linkedStorePackingId) {
        allocation.linkedSalesInvoiceId = null;
        allocation.linkedSalesInvoiceNo = "";
        const snapshot = await allocationFulfilmentSnapshot(req.companyId, allocation, session);
        allocation.packingStatus = snapshot.packingStatus;
        allocation.invoiceStatus = snapshot.invoiceStatus;
        allocation.dispatchStatus = snapshot.dispatchStatus;
        allocation.status =
          snapshot.packingStatus === "FULLY_PACKED"
            ? "FULLY_PACKED"
            : snapshot.packingStatus === "PARTIALLY_PACKED"
            ? "PARTIALLY_PACKED"
            : "OPEN";
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
        if (normalizePaymentStatus(inv.paymentStatus) !== "PAID") {
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
    // S2 — canonical Sales Dispatch draft (stock posts via POST /sales-dispatches/:id/post).
    const { createCanonicalSalesDispatch } = await import("../services/canonicalSalesDispatchService.js");
    const { id } = req.params;
    const doc = await createCanonicalSalesDispatch(req, {
      ...(req.body || {}),
      salesInvoiceId: id,
      lines: req.body?.lines,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message, code: err.code || undefined });
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
    const [packingRows, invoiceRows] = allocationIds.length
      ? await Promise.all([
          StorePacking.find(
            withCompany(req, { allocationId: { $in: allocationIds }, status: { $in: POSTED_STORE_PACKING_STATUSES } })
          )
            .select("allocationId status lines")
            .lean(),
          SalesInvoice.find(withCompany(req, { linkedOrderAllocationId: { $in: allocationIds }, status: { $ne: "CANCELLED" } }))
            .select("linkedOrderAllocationId status lines")
            .lean(),
        ])
      : [[], []];

    /** Packed-but-not-yet-invoiced qty from posted Store Packing. */
    const packedByAllocationArticle = new Map();
    for (const packing of packingRows) {
      const allocationId = String(packing.allocationId || "");
      for (const line of packing.lines || []) {
        const article = String(line.article || "").trim().toUpperCase();
        const qty = Number(line.packQty) || 0;
        if (!article || !(qty > 0)) continue;
        const key = `${allocationId}::${article}`;
        packedByAllocationArticle.set(key, (packedByAllocationArticle.get(key) || 0) + qty);
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
        const packedQty = Number(packedByAllocationArticle.get(key) || 0);
        const invoiceQty = Number(invoiceByAllocationArticle.get(key) || 0);
        const pendingQty = Math.max(0, orderedQty - packedQty - invoiceQty);
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
          packedQty,
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
      const packed = Number(bal.packedQty || 0);
      availableByArticleWarehouse.set(key, (availableByArticleWarehouse.get(key) || 0) + onHand - allocated - packed);
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

export async function convertOAToOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid OA id" });
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    validateConversionSource(oa, "order acknowledgement");
    if (!oa.lines?.length) return res.status(400).json({ message: "OA requires at least one line to convert" });
    const already = await findActiveAllocationByOA(req, oa._id);
    if (already) {
      return res.status(409).json({
        message: `An active order allocation already exists (${already.allocationNo})`,
        code: ACTIVE_ALLOCATION_ALREADY_EXISTS,
        details: {
          allocationId: String(already._id),
          allocationNo: already.allocationNo || "",
          status: already.status || "",
        },
      });
    }
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
      const oaFresh = await OrderAcknowledgement.findOne(withCompany(req, { _id: oa._id })).session(session);
      validateConversionSource(oaFresh, "order acknowledgement");
      if (!oaFresh.lines?.length) throw new Error("OA requires at least one line to convert");
      await assertOaReadyForStockAllocation(req, oaFresh, session);

      // Create-first under unique partial index so a concurrent loser fails before stock reserve.
      const existing = await findActiveAllocationByOA(req, oaFresh._id, session);
      if (existing) throw activeAllocationConflictError(existing);

      let doc;
      try {
        [doc] = await OrderAllocation.create(
          [
            {
              companyId: req.companyId,
              allocationNo,
              allocationDate: new Date(),
              linkedQuotationId: oaFresh.linkedQuotationId || null,
              linkedQuotationNo: oaFresh.linkedQuotationNo || "",
              linkedOAId: oaFresh._id,
              linkedOANo: oaFresh.oaNo,
              customerName: oaFresh.customerName,
              currency: oaFresh.currency || "USD",
              vertical: oaFresh.vertical || "",
              engine: oaFresh.engine || "",
              model: oaFresh.model || "",
              config: oaFresh.config || "",
              esn: oaFresh.esn || "",
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
      } catch (createErr) {
        if (isActiveAllocationDuplicateKeyError(createErr)) {
          const winner = await findActiveAllocationByOA(req, oaFresh._id, session);
          throw activeAllocationConflictError(winner);
        }
        throw createErr;
      }
      createdId = doc._id;

      const { negativeArticles } = await reserveAllocationLines({
        session,
        companyId: req.companyId,
        warehouse,
        lines: reserveLines,
        referenceType: "ORDER_ALLOCATION",
        referenceNo: allocationNo,
        customerName: oaFresh.customerName || "",
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
      oaFresh.status = "PACKING";
      if (!oaFresh.convertedTo?.includes("ORDER_ALLOCATION")) {
        oaFresh.convertedTo = [...(oaFresh.convertedTo || []), "ORDER_ALLOCATION"];
      }
      oaFresh.updatedBy = req.user?.email || "";
      await oaFresh.save({ session });
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
    if (err?.code === ACTIVE_ALLOCATION_ALREADY_EXISTS) {
      return res.status(409).json({
        message: err.message,
        code: err.code,
        details: err.details || null,
      });
    }
    if (isActiveAllocationDuplicateKeyError(err)) {
      const winner = await findActiveAllocationByOA(req, req.params.id).catch(() => null);
      const conflict = activeAllocationConflictError(winner);
      return res.status(409).json({
        message: conflict.message,
        code: conflict.code,
        details: conflict.details,
      });
    }
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
    const grandTotal = piPayableTotal(proforma);
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
    const alreadyByPi = await findActiveAllocationByProforma(req, proforma._id);
    if (alreadyByPi) {
      return res.status(409).json({
        message: `An active order allocation already exists (${alreadyByPi.allocationNo})`,
        code: ACTIVE_ALLOCATION_ALREADY_EXISTS,
        details: {
          allocationId: String(alreadyByPi._id),
          allocationNo: alreadyByPi.allocationNo || "",
          status: alreadyByPi.status || "",
        },
      });
    }
    if (proforma.linkedOAId) {
      const alreadyByOa = await findActiveAllocationByOA(req, proforma.linkedOAId);
      if (alreadyByOa) {
        return res.status(409).json({
          message: `An active order allocation already exists for the linked OA (${alreadyByOa.allocationNo})`,
          code: ACTIVE_ALLOCATION_ALREADY_EXISTS,
          details: {
            allocationId: String(alreadyByOa._id),
            allocationNo: alreadyByOa.allocationNo || "",
            status: alreadyByOa.status || "",
          },
        });
      }
    }
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
      const proformaFresh = await ProformaInvoice.findOne(withCompany(req, { _id: proforma._id })).session(session);
      validateConversionSource(proformaFresh, "proforma");
      // Revalidate payment eligibility on a session-scoped read (sync already ran before the txn).
      const freshStatus = String(proformaFresh?.status || "").toUpperCase();
      if (!["APPROVED", "PAID_PENDING_SHIPMENT"].includes(freshStatus)) {
        throw new Error(
          "Proforma must be APPROVED or PAID (PAID_PENDING_SHIPMENT) before converting to Order Allocation"
        );
      }
      if (!proformaFresh.lines?.length) throw new Error("Proforma requires at least one line to convert");

      const existingPi = await findActiveAllocationByProforma(req, proformaFresh._id, session);
      if (existingPi) throw activeAllocationConflictError(existingPi);
      if (proformaFresh.linkedOAId) {
        const existingOa = await findActiveAllocationByOA(req, proformaFresh.linkedOAId, session);
        if (existingOa) throw activeAllocationConflictError(existingOa);
      }

      let doc;
      try {
        [doc] = await OrderAllocation.create(
          [
            {
              companyId: req.companyId,
              allocationNo,
              allocationDate: new Date(),
              linkedQuotationId: proformaFresh.linkedQuotationId || null,
              linkedQuotationNo: proformaFresh.linkedQuotationNo || "",
              linkedOAId: proformaFresh.linkedOAId || null,
              linkedOANo: proformaFresh.linkedOANo || "",
              linkedProformaId: proformaFresh._id,
              linkedProformaNo: proformaFresh.proformaNo,
              customerName: proformaFresh.customerName,
              currency: proformaFresh.currency || "USD",
              vertical: proformaFresh.vertical || "",
              engine: proformaFresh.engine || "",
              model: proformaFresh.model || "",
              config: proformaFresh.config || "",
              esn: proformaFresh.esn || "",
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
      } catch (createErr) {
        if (isActiveAllocationDuplicateKeyError(createErr)) {
          const winner =
            (await findActiveAllocationByProforma(req, proformaFresh._id, session)) ||
            (proformaFresh.linkedOAId
              ? await findActiveAllocationByOA(req, proformaFresh.linkedOAId, session)
              : null);
          throw activeAllocationConflictError(winner);
        }
        throw createErr;
      }
      createdId = doc._id;

      const { negativeArticles } = await reserveAllocationLines({
        session,
        companyId: req.companyId,
        warehouse,
        lines: reserveLines,
        referenceType: "ORDER_ALLOCATION",
        referenceNo: allocationNo,
        customerName: proformaFresh.customerName || "",
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
    if (err?.code === ACTIVE_ALLOCATION_ALREADY_EXISTS) {
      return res.status(409).json({
        message: err.message,
        code: err.code,
        details: err.details || null,
      });
    }
    if (isActiveAllocationDuplicateKeyError(err)) {
      const winner = await findActiveAllocationByProforma(req, req.params.id).catch(() => null);
      const conflict = activeAllocationConflictError(winner);
      return res.status(409).json({
        message: conflict.message,
        code: conflict.code,
        details: conflict.details,
      });
    }
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
    const blockPacking = await StorePacking.countDocuments(
      withCompany(req, { allocationId: alloc._id, status: { $ne: "CANCELLED" } })
    );
    if (blockPacking) {
      return res.status(400).json({ message: "Cancel or complete Store Packing for this allocation first." });
    }
    const warehouse = String(alloc.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    // Release remaining reservation only (qty − already packed moved to packed bucket).
    const releaseLines = (alloc.lines || [])
      .map((line) => ({
        article: line.article,
        qty: Math.max(0, (Number(line.qty) || 0) - (Number(line.packedQty) || 0)),
      }))
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
      // Always release remaining reserved qty when cancelling — do not gate on stockReservedAt
      // alone (legacy rows / deleted-doc orphans left reserved without that stamp).
      if (releaseLines.length) {
        for (const [article, qty] of dedupeLines(releaseLines)) {
          const effectKey = `alloc:release:${String(req.companyId)}:${String(alloc.allocationNo)}:${article}`;
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
            effectKey,
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
