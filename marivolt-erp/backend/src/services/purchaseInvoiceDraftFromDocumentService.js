import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";

/** PO document types that should auto-create a draft purchase invoice when a document number is present. */
export const AUTO_DRAFT_PI_PURCHASE_DOC_TYPES = new Set([
  "SUPPLIER_TAX_INVOICE",
  "COMMERCIAL_INVOICE",
  "SUPPLIER_PROFORMA",
]);

function companyFilter(companyId) {
  const s = String(companyId ?? "").trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    return { $or: [{ companyId: oid }, { companyId: s }] };
  }
  return { companyId: s };
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sumInvoiceLines(lines, rateField) {
  let sub = 0;
  for (const line of lines || []) {
    const amt = (Number(line.qty) || 0) * (Number(line[rateField]) || 0);
    line.amount = amt;
    sub += amt;
  }
  return sub;
}

function dueDateForPurchaseInvoice(inv) {
  const base = new Date(inv.invoiceDate || inv.createdAt || Date.now());
  const terms = String(inv.paymentTerms || "");
  const match = terms.match(/(\d+)\s*(day|days|net)?/i);
  const days = match ? Number(match[1]) || 0 : 0;
  const due = new Date(base);
  due.setDate(due.getDate() + days);
  return due;
}

function purchaseDocTypeToUploadLabel(documentType) {
  const m = {
    SUPPLIER_PROFORMA: "Supplier Proforma Invoice",
    SUPPLIER_TAX_INVOICE: "Supplier Tax Invoice",
    COMMERCIAL_INVOICE: "Commercial Invoice",
  };
  return m[String(documentType || "").toUpperCase()] || "Supplier Invoice";
}

/**
 * Creates a DRAFT PurchaseInvoice from a PurchaseOrder + PurchaseDocument row.
 * @returns {{ created: boolean, invoice?: object, skippedReason?: string, message?: string }}
 */
export async function createDraftPurchaseInvoiceFromPurchaseDocument(opts) {
  const {
    companyId,
    companyCode,
    userEmail,
    purchaseDocument,
    skipIfDraftExists = true,
    restrictAutoTypes = false,
  } = opts;

  const poId = purchaseDocument?.linkedPoId;
  if (!mongoose.Types.ObjectId.isValid(String(poId || ""))) {
    return { created: false, skippedReason: "INVALID_PO", message: "Invalid linked PO" };
  }

  const docType = String(purchaseDocument.documentType || "").toUpperCase();
  if (restrictAutoTypes && !AUTO_DRAFT_PI_PURCHASE_DOC_TYPES.has(docType)) {
    return { created: false, skippedReason: "TYPE", message: "Document type is not auto-mapped to a purchase invoice" };
  }

  const supplierInvoiceNo = String(purchaseDocument.documentNo || "").trim();
  if (!supplierInvoiceNo) {
    return { created: false, skippedReason: "NO_DOC_NO", message: "Supplier document / invoice number is required" };
  }

  const po = await PurchaseOrder.findOne({ _id: poId, ...companyFilter(companyId) });
  if (!po) return { created: false, skippedReason: "PO_NOT_FOUND", message: "Purchase order not found" };

  const existingDraft = await PurchaseInvoice.findOne({
    ...companyFilter(companyId),
    linkedPoId: po._id,
    status: "DRAFT",
    supplierInvoiceNo: new RegExp(`^${escapeRegex(supplierInvoiceNo)}$`, "i"),
  })
    .select("_id invoiceNumber")
    .lean();

  if (existingDraft && skipIfDraftExists) {
    return {
      created: false,
      skippedReason: "DRAFT_EXISTS",
      message: "A draft purchase invoice already exists for this supplier document number on the PO",
      invoice: existingDraft,
    };
  }

  const cur = String(purchaseDocument.currency || po.currency || "USD")
    .trim()
    .toUpperCase();
  const lines = (po.lines || []).map((l) => ({
    itemCode: String(l.itemCode || "").trim().toUpperCase(),
    description: String(l.description || "").trim(),
    qty: Number(l.qty) || 0,
    rate: Number(l.unitPrice) || 0,
  }));
  const filtered = lines.filter((l) => l.itemCode && l.qty > 0);
  if (!filtered.length) {
    return { created: false, skippedReason: "NO_LINES", message: "PO has no billable lines for a purchase invoice" };
  }

  const invoiceNumber = await nextSequentialNumber(PurchaseInvoice, "invoiceNumber", `${companyCode || "CMP"}-PI`, {
    companyId,
  });

  const invDate = purchaseDocument.documentDate
    ? new Date(purchaseDocument.documentDate)
    : purchaseDocument.uploadedAt
      ? new Date(purchaseDocument.uploadedAt)
      : new Date();

  const attachments = [];
  if (mongoose.Types.ObjectId.isValid(String(purchaseDocument.documentId || ""))) {
    attachments.push({
      documentId: new mongoose.Types.ObjectId(String(purchaseDocument.documentId)),
      documentType: purchaseDocTypeToUploadLabel(docType),
      fileName: String(purchaseDocument.documentNo || purchaseDocument.originalFileName || "supplier-document").trim(),
      uploadedAt: new Date(),
    });
  }

  const doc = new PurchaseInvoice({
    companyId,
    branchId: po.branchId || null,
    linkedPoId: po._id,
    supplierId: po.supplierId || null,
    invoiceNumber,
    invoiceDate: invDate,
    dueDate: null,
    supplierName: po.supplierName,
    supplierInvoiceNo,
    supplierInvoiceDate: purchaseDocument.documentDate ? new Date(purchaseDocument.documentDate) : null,
    linkedPoNumber: String(po.poNo || po.poNumber || "").trim(),
    currency: cur,
    paymentTerms: String(po.paymentTerms || "").trim(),
    grnNo: "",
    lines: filtered,
    taxAmount: 0,
    otherCharges: 0,
    remarks: String(purchaseDocument.remarks || "").trim(),
    attachments,
    status: "DRAFT",
    paymentStatus: "UNPAID",
    createdBy: userEmail || "",
    updatedBy: userEmail || "",
  });

  doc.subTotal = sumInvoiceLines(doc.lines, "rate");
  const docAmt = Math.max(0, Number(purchaseDocument.amount) || 0);
  const lineSub = Number(doc.subTotal) || 0;
  if (docAmt > 0.001 && docAmt + 0.001 < lineSub) {
    return {
      created: false,
      skippedReason: "AMOUNT_LT_LINES",
      message: "Document amount is below PO line total; adjust PO lines or document amount before creating a PI",
    };
  }
  doc.otherCharges = docAmt > 0.001 ? Math.max(0, docAmt - lineSub) : 0;
  doc.totalAmount = (doc.subTotal || 0) + (Number(doc.taxAmount) || 0) + (Number(doc.otherCharges) || 0);
  doc.totalPaidAmount = 0;
  doc.balanceAmount = doc.totalAmount;
  doc.dueDate = dueDateForPurchaseInvoice(doc);
  await doc.save();

  return { created: true, invoice: doc.toObject() };
}
