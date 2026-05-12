import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import PurchaseDocument, { PURCHASE_DOCUMENT_TYPES } from "../models/PurchaseDocument.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import SupplierPayment from "../models/SupplierPayment.js";
import GRN from "../models/GRN.js";
import { writeAudit } from "../services/auditService.js";

function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}

export async function syncPurchaseOrderApExtensionFields(companyId, poId) {
  if (!mongoose.Types.ObjectId.isValid(String(poId))) return;
  const po = await PurchaseOrder.findOne({ companyId, _id: poId });
  if (!po) return;

  const docs = await PurchaseDocument.find({ companyId, linkedPoId: poId, status: "ACTIVE" }).lean();
  let supplierDocumentStatus = "NONE";
  const hasPi = docs.some((d) => d.documentType === "SUPPLIER_PROFORMA");
  const hasInvDoc = docs.some((d) =>
    ["SUPPLIER_TAX_INVOICE", "COMMERCIAL_INVOICE"].includes(String(d.documentType || ""))
  );
  if (hasInvDoc) supplierDocumentStatus = "INVOICE_RECEIVED";
  else if (hasPi) supplierDocumentStatus = "PI_RECEIVED";

  const postedInvoices = await PurchaseInvoice.find({
    companyId,
    linkedPoId: poId,
    status: "POSTED",
  }).lean();
  if (postedInvoices.length && supplierDocumentStatus !== "INVOICE_RECEIVED") {
    supplierDocumentStatus = "INVOICE_BOOKED";
  }

  let apPaymentStatus = "NOT_PAID";
  if (postedInvoices.length) {
    const anyBalance = postedInvoices.some((i) => Number(i.balanceAmount) > 0.001);
    const anyPaid = postedInvoices.some((i) => Number(i.totalPaidAmount) > 0.001);
    if (anyBalance && anyPaid) apPaymentStatus = "PARTIALLY_PAID";
    else if (anyBalance) apPaymentStatus = "PAYMENT_PENDING";
    else apPaymentStatus = "FULLY_PAID";
  } else {
    const poNoSet = [...new Set([po.poNo, po.poNumber].map((s) => String(s || "").trim()).filter(Boolean))];
    if (poNoSet.length) {
      const payAgg = await SupplierPayment.aggregate([
        {
          $match: {
            companyId,
            status: { $ne: "CANCELLED" },
            linkedPoNo: { $in: poNoSet },
          },
        },
        { $group: { _id: null, total: { $sum: "$amountPaid" } } },
      ]);
      const totalPaidOnPo = Number(payAgg[0]?.total || 0);
      if (totalPaidOnPo > 0.001) apPaymentStatus = "ADVANCE_PAID";
    }
  }

  const grnCount = await GRN.countDocuments({ companyId, poId });
  let grnProgressStatus = "NONE";
  if (String(po.status) === "PARTIAL_RECEIVED") grnProgressStatus = "PARTIAL";
  else if (String(po.status) === "RECEIVED" || String(po.status) === "CLOSED") grnProgressStatus = "COMPLETE";
  else if (grnCount > 0) grnProgressStatus = "IN_PROGRESS";

  let grnReceiptStatus = "NOT_RECEIVED";
  const lines = po.lines || [];
  let anyReceived = false;
  let anyPending = false;
  for (const l of lines) {
    const ordered = Number(l.orderedQty ?? l.qty) || 0;
    const received = Number(l.receivedQty) || 0;
    const pending = Number(l.pendingQty ?? Math.max(0, ordered - received)) || 0;
    if (received > 0.001) anyReceived = true;
    if (pending > 0.001) anyPending = true;
  }
  if (lines.length) {
    if (anyReceived && !anyPending) grnReceiptStatus = "FULLY_RECEIVED";
    else if (anyReceived) grnReceiptStatus = "PARTIALLY_RECEIVED";
    else grnReceiptStatus = "NOT_RECEIVED";
  }

  let receivedQtySummary = po.receivedQtySummary || "";
  if (Array.isArray(po.lines) && po.lines.length) {
    const parts = po.lines.map((l) => {
      const o = Number(l.orderedQty ?? l.qty) || 0;
      const r = Number(l.receivedQty) || 0;
      return `${l.itemCode || ""}:${r}/${o}`;
    });
    receivedQtySummary = parts.join("; ").slice(0, 500);
  }

  po.supplierDocumentStatus = supplierDocumentStatus;
  po.apPaymentStatus = apPaymentStatus;
  po.grnProgressStatus = grnProgressStatus;
  po.grnReceiptStatus = grnReceiptStatus;
  po.receivedQtySummary = receivedQtySummary;
  await po.save();
}

export async function listPoDocuments(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid PO id" });
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: id })).select("_id").lean();
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    const items = await PurchaseDocument.find(withCompany(req, { linkedPoId: id, status: "ACTIVE" }))
      .sort({ uploadedAt: -1 })
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createPoDocument(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid PO id" });
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: id }));
    if (!po) return res.status(404).json({ message: "Purchase order not found" });

    const documentType = String(req.body?.documentType || "").trim().toUpperCase();
    if (!PURCHASE_DOCUMENT_TYPES.includes(documentType)) {
      return res.status(400).json({ message: `Invalid documentType. Allowed: ${PURCHASE_DOCUMENT_TYPES.join(", ")}` });
    }

    const doc = await PurchaseDocument.create({
      companyId: req.companyId,
      branchId: req.body.branchId || po.branchId || null,
      linkedPoId: po._id,
      supplierId: po.supplierId || req.body.supplierId || null,
      documentType,
      documentNo: String(req.body?.documentNo || "").trim(),
      documentDate: req.body?.documentDate ? new Date(req.body.documentDate) : null,
      amount: Number(req.body?.amount) || 0,
      currency: String(req.body?.currency || po.currency || "USD")
        .trim()
        .toUpperCase(),
      dueDate: req.body?.dueDate ? new Date(req.body.dueDate) : null,
      fileUrl: String(req.body?.fileUrl || "").trim(),
      documentId: mongoose.Types.ObjectId.isValid(String(req.body?.documentId || ""))
        ? new mongoose.Types.ObjectId(String(req.body.documentId))
        : null,
      remarks: String(req.body?.remarks || "").trim(),
      uploadedBy: req.user?.email || "",
      uploadedAt: new Date(),
      status: "ACTIVE",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });

    await syncPurchaseOrderApExtensionFields(req.companyId, po._id);

    await writeAudit(req, {
      action: "CREATE",
      module: "PURCHASE",
      entityType: "PURCHASE_DOCUMENT",
      entityId: doc._id,
      documentNo: po.poNo,
      description: `PO document ${documentType} for ${po.poNo}`,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deletePoDocument(req, res) {
  try {
    const { id, documentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(documentId)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseDocument.findOne(withCompany(req, { _id: documentId, linkedPoId: id }));
    if (!row) return res.status(404).json({ message: "Document not found" });
    row.status = "VOID";
    row.updatedBy = req.user?.email || "";
    await row.save();
    await syncPurchaseOrderApExtensionFields(req.companyId, id);
    await writeAudit(req, {
      action: "DELETE",
      module: "PURCHASE",
      entityType: "PURCHASE_DOCUMENT",
      entityId: row._id,
      documentNo: id,
      description: `PO document voided (${row.documentType})`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/**
 * AP summary for PO detail / GRN warning (does not change core PO payload shape when fetched separately).
 */
export async function getPoApSummary(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid PO id" });
    await syncPurchaseOrderApExtensionFields(req.companyId, id);
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: id }))
      .select(
        "poNo poNumber supplierName supplierId status apPaymentStatus supplierDocumentStatus grnProgressStatus grnReceiptStatus receivedQtySummary currency grandTotal branchId"
      )
      .lean();
    if (!po) return res.status(404).json({ message: "Purchase order not found" });

    const docs = await PurchaseDocument.find(withCompany(req, { linkedPoId: id, status: "ACTIVE" }))
      .select("documentType documentNo amount currency uploadedAt")
      .lean();
    const hasPi = docs.some((d) => d.documentType === "SUPPLIER_PROFORMA");
    const hasSupplierInvoiceDoc = docs.some((d) =>
      ["SUPPLIER_TAX_INVOICE", "COMMERCIAL_INVOICE"].includes(d.documentType)
    );
    const invoices = await PurchaseInvoice.find(withCompany(req, { linkedPoId: id }))
      .select("invoiceNumber status balanceAmount totalPaidAmount totalAmount supplierInvoiceNo")
      .lean();

    const paymentPendingForGrn =
      ["PAYMENT_PENDING", "PARTIALLY_PAID"].includes(String(po.apPaymentStatus || "")) ||
      invoices.some((i) => String(i.status) === "POSTED" && Number(i.balanceAmount) > 0.001);

    res.json({
      po,
      documents: docs,
      purchaseInvoices: invoices,
      flags: {
        hasSupplierPi: hasPi,
        hasSupplierInvoiceDocument: hasSupplierInvoiceDoc,
        /** True when a booked supplier invoice still has balance (informational). */
        paymentPending: paymentPendingForGrn,
      },
      /** Non-blocking soft warning for GRN — never used to forbid receiving. */
      grnPaymentWarning: paymentPendingForGrn
        ? "Supplier payment is pending or partially paid. Continue GRN?"
        : null,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
