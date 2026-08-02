/**
 * A1 — Supplier Proforma helpers (normalization, validation, advance dependency interface).
 * No stock / AP posting.
 */
import mongoose from "mongoose";
import SupplierPayment from "../models/SupplierPayment.js";
import SupplierProforma from "../models/SupplierProforma.js";

export const SUPPLIER_PROFORMA_DUPLICATE = "SUPPLIER_PROFORMA_DUPLICATE";
export const SUPPLIER_PROFORMA_PO_SUPPLIER_MISMATCH = "SUPPLIER_PROFORMA_PO_SUPPLIER_MISMATCH";
export const SUPPLIER_PROFORMA_ADVANCE_EXCEEDS_TOTAL = "SUPPLIER_PROFORMA_ADVANCE_EXCEEDS_TOTAL";
export const SUPPLIER_PROFORMA_NOT_EDITABLE = "SUPPLIER_PROFORMA_NOT_EDITABLE";
export const SUPPLIER_PROFORMA_APPROVAL_CONFLICT = "SUPPLIER_PROFORMA_APPROVAL_CONFLICT";
export const SUPPLIER_PROFORMA_HAS_ADVANCE_DEPENDENCY = "SUPPLIER_PROFORMA_HAS_ADVANCE_DEPENDENCY";
export const SUPPLIER_PROFORMA_INVALID_TRANSITION = "SUPPLIER_PROFORMA_INVALID_TRANSITION";
export const SUPPLIER_PROFORMA_CURRENCY_MISMATCH = "SUPPLIER_PROFORMA_CURRENCY_MISMATCH";
export const SUPPLIER_PROFORMA_PROTECTED_FIELD = "SUPPLIER_PROFORMA_PROTECTED_FIELD";

export const EDITABLE_DOCUMENT_STATUSES = new Set(["DRAFT", "RECEIVED"]);
export const ACTIVE_DOCUMENT_STATUSES = new Set(["DRAFT", "RECEIVED", "APPROVED"]);

export function supplierProformaError(code, message, details = null, statusCode = 400) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  err.details = details;
  return err;
}

/** Trim, uppercase, collapse repeated spaces. Keeps digits/letters/separators. */
export function normalizeSupplierProformaNo(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

export function resolveAdvanceAmounts({ totalValue, requestedAdvanceAmount, requestedAdvancePercent }) {
  const total = Math.max(0, Number(totalValue) || 0);
  let amount = Math.max(0, Number(requestedAdvanceAmount) || 0);
  let percent = Math.max(0, Number(requestedAdvancePercent) || 0);
  if (percent > 100) percent = 100;
  if (!(amount > 0) && percent > 0 && total > 0) {
    amount = Math.round(((total * percent) / 100) * 1e6) / 1e6;
  } else if (!(percent > 0) && amount > 0 && total > 0) {
    percent = Math.min(100, Math.round(((amount / total) * 100) * 1e4) / 1e4);
  }
  return { totalValue: total, requestedAdvanceAmount: amount, requestedAdvancePercent: percent };
}

export function assertAdvanceWithinTotal({ totalValue, requestedAdvanceAmount }, { allowException = false } = {}) {
  const total = Math.max(0, Number(totalValue) || 0);
  const adv = Math.max(0, Number(requestedAdvanceAmount) || 0);
  if (adv > total + 1e-6 && !allowException) {
    throw supplierProformaError(
      SUPPLIER_PROFORMA_ADVANCE_EXCEEDS_TOTAL,
      "Requested advance amount cannot exceed proforma total value",
      { totalValue: total, requestedAdvanceAmount: adv }
    );
  }
}

export function assertEditableStatus(documentStatus) {
  const st = String(documentStatus || "").toUpperCase();
  if (!EDITABLE_DOCUMENT_STATUSES.has(st)) {
    throw supplierProformaError(
      SUPPLIER_PROFORMA_NOT_EDITABLE,
      `Supplier Proforma in status ${st} cannot be edited`,
      { documentStatus: st },
      409
    );
  }
}

/**
 * A1 limitation: one active (non-cancelled) APPROVED Supplier Proforma per PO.
 * Multiple DRAFT/RECEIVED allowed until approve.
 */
export async function assertOneApprovedPerPo({ companyId, purchaseOrderId, excludeId = null }) {
  const filter = {
    companyId,
    purchaseOrderId,
    documentStatus: "APPROVED",
  };
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = await SupplierProforma.findOne(filter).select("_id internalProformaRef").lean();
  if (existing) {
    throw supplierProformaError(
      SUPPLIER_PROFORMA_APPROVAL_CONFLICT,
      "Only one approved Supplier Proforma is allowed per Purchase Order in A1",
      { existingId: String(existing._id), existingRef: existing.internalProformaRef },
      409
    );
  }
}

/**
 * Dependency check interface for A2.
 * A1: block cancel when non-cancelled SupplierPayment exists on the PO (advance evidence).
 */
export async function supplierProformaHasAdvanceDependency({
  companyId,
  purchaseOrderNo,
  purchaseOrderNos = [],
}) {
  const nos = [
    ...new Set(
      [purchaseOrderNo, ...(purchaseOrderNos || [])]
        .map((s) => String(s || "").trim())
        .filter(Boolean)
    ),
  ];
  if (!nos.length) return { hasDependency: false, reason: null, paymentCount: 0 };

  const s = String(companyId ?? "").trim();
  const scope = mongoose.Types.ObjectId.isValid(s)
    ? { $or: [{ companyId: new mongoose.Types.ObjectId(s) }, { companyId: s }] }
    : { companyId: s };

  const paymentCount = await SupplierPayment.countDocuments({
    ...scope,
    linkedPoNo: { $in: nos },
    status: { $ne: "CANCELLED" },
  });
  if (paymentCount > 0) {
    return {
      hasDependency: true,
      reason: "Non-cancelled supplier payment(s) exist on this PO (advance evidence). Stronger application guards arrive in A2.",
      paymentCount,
    };
  }
  return { hasDependency: false, reason: null, paymentCount: 0 };
}

export async function findActiveDuplicateProforma({
  companyId,
  supplierId,
  normalizedSupplierProformaNo,
  excludeId = null,
}) {
  const filter = {
    companyId,
    supplierId,
    normalizedSupplierProformaNo,
    documentStatus: { $in: [...ACTIVE_DOCUMENT_STATUSES] },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  return SupplierProforma.findOne(filter)
    .select("_id internalProformaRef documentStatus purchaseDocumentId")
    .lean();
}

export const SUPPLIER_PROFORMA_CREATE_FIELDS = [
  "purchaseOrderId",
  "supplierProformaNo",
  "supplierProformaDate",
  "currency",
  "exchangeRate",
  "exchangeRateReason",
  "totalValue",
  "requestedAdvanceAmount",
  "requestedAdvancePercent",
  "paymentDueDate",
  "paymentTerms",
  "remarks",
  "primaryAttachment",
  "supportingAttachments",
  "purchaseDocumentId",
  "branchId",
];

export const SUPPLIER_PROFORMA_UPDATE_FIELDS = [
  "supplierProformaNo",
  "supplierProformaDate",
  "currency",
  "exchangeRate",
  "exchangeRateReason",
  "totalValue",
  "requestedAdvanceAmount",
  "requestedAdvancePercent",
  "paymentDueDate",
  "paymentTerms",
  "remarks",
  "primaryAttachment",
  "supportingAttachments",
];

export const SUPPLIER_PROFORMA_PROTECTED_FIELDS = [
  "companyId",
  "internalProformaRef",
  "normalizedSupplierProformaNo",
  "supplierId",
  "purchaseOrderId",
  "purchaseOrderNo",
  "documentStatus",
  "paymentStatus",
  "approvedBy",
  "approvedAt",
  "cancelledBy",
  "cancelledAt",
  "cancellationReason",
  "createdBy",
  "createdAt",
  "updatedAt",
];

export function pickWhitelisted(body, allowed) {
  const out = {};
  for (const key of allowed) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  return out;
}

export function rejectProtectedFields(body) {
  const hits = SUPPLIER_PROFORMA_PROTECTED_FIELDS.filter(
    (k) => body && Object.prototype.hasOwnProperty.call(body, k)
  );
  if (hits.length) {
    throw supplierProformaError(
      SUPPLIER_PROFORMA_PROTECTED_FIELD,
      `Protected fields cannot be set: ${hits.join(", ")}`,
      { fields: hits }
    );
  }
}

/** Index spec for controlled migration (not applied at app startup). */
export const SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX = {
  name: "uniq_active_supplier_proforma_per_supplier_no",
  key: { companyId: 1, supplierId: 1, normalizedSupplierProformaNo: 1 },
  unique: true,
  partialFilterExpression: {
    documentStatus: { $in: ["DRAFT", "RECEIVED", "APPROVED"] },
    normalizedSupplierProformaNo: { $type: "string" },
  },
};
