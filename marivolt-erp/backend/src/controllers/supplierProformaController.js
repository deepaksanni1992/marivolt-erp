import mongoose from "mongoose";
import SupplierProforma from "../models/SupplierProforma.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import PurchaseDocument from "../models/PurchaseDocument.js";
import { writeAudit } from "../services/auditService.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import {
  SUPPLIER_PROFORMA_CREATE_FIELDS,
  SUPPLIER_PROFORMA_UPDATE_FIELDS,
  SUPPLIER_PROFORMA_DUPLICATE,
  SUPPLIER_PROFORMA_PO_SUPPLIER_MISMATCH,
  SUPPLIER_PROFORMA_HAS_ADVANCE_DEPENDENCY,
  SUPPLIER_PROFORMA_INVALID_TRANSITION,
  SUPPLIER_PROFORMA_CURRENCY_MISMATCH,
  assertAdvanceWithinTotal,
  assertEditableStatus,
  assertOneApprovedPerPo,
  findActiveDuplicateProforma,
  normalizeSupplierProformaNo,
  pickWhitelisted,
  rejectProtectedFields,
  resolveAdvanceAmounts,
  supplierProformaError,
  supplierProformaHasAdvanceDependency,
} from "../utils/supplierProforma.js";

function withCompany(req, filter = {}) {
  const cid = req.companyId;
  if (cid == null || cid === "") return { ...filter };
  const s = String(cid).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    if (!Object.keys(filter).length) {
      return { $or: [{ companyId: oid }, { companyId: s }] };
    }
    return { $and: [{ ...filter }, { $or: [{ companyId: oid }, { companyId: s }] }] };
  }
  return { ...filter, companyId: cid };
}

function companyOid(req) {
  const s = String(req.companyId || "").trim();
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : req.companyId;
}

function parseAttachment(raw) {
  if (!raw || typeof raw !== "object") return null;
  const documentId = mongoose.Types.ObjectId.isValid(String(raw.documentId || ""))
    ? new mongoose.Types.ObjectId(String(raw.documentId))
    : null;
  return {
    documentId,
    fileName: String(raw.fileName || "").trim(),
    fileUrl: String(raw.fileUrl || "").trim(),
    uploadedAt: raw.uploadedAt ? new Date(raw.uploadedAt) : new Date(),
    remarks: String(raw.remarks || "").trim(),
  };
}

async function nextInternalRef(req) {
  const code = String(req.companyCode || "CMP").trim().toUpperCase() || "CMP";
  return nextSequentialNumber(SupplierProforma, "internalProformaRef", `${code}-SPF`, {
    companyId: req.companyId,
    companyCode: code,
    docKey: "SUPPLIER_PROFORMA",
  });
}

function sendErr(res, err) {
  if (err?.code) {
    return res.status(err.statusCode || 400).json({
      message: err.message,
      code: err.code,
      details: err.details || null,
    });
  }
  return res.status(400).json({ message: err.message || String(err) });
}

/**
 * Create or link SupplierProforma from an uploaded PurchaseDocument (SUPPLIER_PROFORMA).
 * Idempotent on purchaseDocumentId.
 */
export async function ensureSupplierProformaFromPurchaseDocument({ req, po, purchaseDocument }) {
  if (!purchaseDocument?._id) return null;
  const existing = await SupplierProforma.findOne(
    withCompany(req, { purchaseDocumentId: purchaseDocument._id })
  );
  if (existing) return { created: false, supplierProforma: existing };

  const supplierProformaNo =
    String(purchaseDocument.documentNo || "").trim() || `DOC-${String(purchaseDocument._id).slice(-6)}`;
  const normalized = normalizeSupplierProformaNo(supplierProformaNo);
  const supplierId = po.supplierId || purchaseDocument.supplierId;
  if (!supplierId) {
    throw supplierProformaError(
      SUPPLIER_PROFORMA_PO_SUPPLIER_MISMATCH,
      "Purchase Order has no supplier; cannot record Supplier Proforma"
    );
  }

  const dup = await findActiveDuplicateProforma({
    companyId: companyOid(req),
    supplierId,
    normalizedSupplierProformaNo: normalized,
  });
  if (dup) {
    if (!dup.purchaseDocumentId) {
      await SupplierProforma.updateOne(
        { _id: dup._id },
        {
          $set: {
            purchaseDocumentId: purchaseDocument._id,
            primaryAttachment: {
              documentId: purchaseDocument.documentId || null,
              fileName: supplierProformaNo,
              fileUrl: purchaseDocument.fileUrl || "",
              uploadedAt: purchaseDocument.uploadedAt || new Date(),
              remarks: "",
            },
            updatedBy: req.user?.email || "",
          },
        }
      );
    }
    const linked = await SupplierProforma.findById(dup._id);
    return { created: false, supplierProforma: linked, duplicateLinked: true };
  }

  const amounts = resolveAdvanceAmounts({
    totalValue: Number(purchaseDocument.amount) || 0,
    requestedAdvanceAmount: Number(purchaseDocument.amount) || 0,
    requestedAdvancePercent: 0,
  });

  const internalProformaRef = await nextInternalRef(req);
  const doc = await SupplierProforma.create({
    companyId: companyOid(req),
    branchId: purchaseDocument.branchId || po.branchId || null,
    internalProformaRef,
    supplierProformaNo,
    normalizedSupplierProformaNo: normalized,
    supplierProformaDate: purchaseDocument.documentDate || purchaseDocument.uploadedAt || new Date(),
    supplierId,
    supplierName: po.supplierName || "",
    purchaseOrderId: po._id,
    purchaseOrderNo: String(po.poNo || po.poNumber || "").trim(),
    purchaseDocumentId: purchaseDocument._id,
    currency: String(purchaseDocument.currency || po.currency || "USD").trim().toUpperCase(),
    exchangeRate: 1,
    totalValue: amounts.totalValue,
    requestedAdvanceAmount: amounts.requestedAdvanceAmount,
    requestedAdvancePercent: amounts.requestedAdvancePercent,
    paymentDueDate: purchaseDocument.dueDate || null,
    paymentTerms: String(po.paymentTerms || "").trim(),
    remarks: String(purchaseDocument.remarks || "").trim(),
    primaryAttachment: {
      documentId: purchaseDocument.documentId || null,
      fileName: supplierProformaNo,
      fileUrl: purchaseDocument.fileUrl || "",
      uploadedAt: purchaseDocument.uploadedAt || new Date(),
      remarks: "",
    },
    documentStatus: "RECEIVED",
    paymentStatus: "UNPAID",
    createdBy: req.user?.email || "",
    updatedBy: req.user?.email || "",
  });

  await writeAudit(req, {
    action: "CREATE",
    module: "PURCHASE",
    entityType: "SUPPLIER_PROFORMA",
    entityId: doc._id,
    documentNo: doc.internalProformaRef,
    description: `Supplier Proforma ${doc.internalProformaRef} from PO document upload`,
  });

  return { created: true, supplierProforma: doc };
}

export async function listSupplierProformas(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req, {});
    if (req.query.documentStatus) filter.documentStatus = String(req.query.documentStatus).toUpperCase();
    if (req.query.paymentStatus) filter.paymentStatus = String(req.query.paymentStatus).toUpperCase();
    if (req.query.purchaseOrderId && mongoose.Types.ObjectId.isValid(req.query.purchaseOrderId)) {
      filter.purchaseOrderId = req.query.purchaseOrderId;
    }
    if (req.query.supplierId && mongoose.Types.ObjectId.isValid(req.query.supplierId)) {
      filter.supplierId = req.query.supplierId;
    }
    if (req.query.search) {
      const re = new RegExp(String(req.query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { internalProformaRef: re },
        { supplierProformaNo: re },
        { purchaseOrderNo: re },
        { supplierName: re },
      ];
    }
    const [items, total] = await Promise.all([
      SupplierProforma.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SupplierProforma.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listSupplierProformasForPo(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid PO id" });
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: id })).select("_id").lean();
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    const items = await SupplierProforma.find(withCompany(req, { purchaseOrderId: id }))
      .sort({ createdAt: -1 })
      .lean();
    res.json({
      items,
      notice: "Supplier Proforma does not create AP liability or stock.",
      a1Rule: "One approved Supplier Proforma per PO.",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSupplierProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await SupplierProforma.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Supplier Proforma not found" });
    res.json({
      ...doc,
      notice: "This document does not create AP liability.",
      advancePaymentSummary: {
        placeholder: true,
        message: "Supplier advance application arrives in Phase A2.",
        paymentStatus: doc.paymentStatus,
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createSupplierProforma(req, res) {
  try {
    rejectProtectedFields(req.body || {});
    const body = pickWhitelisted(req.body || {}, SUPPLIER_PROFORMA_CREATE_FIELDS);
    const purchaseOrderId = body.purchaseOrderId;
    if (!mongoose.Types.ObjectId.isValid(String(purchaseOrderId || ""))) {
      return res.status(400).json({ message: "purchaseOrderId is required" });
    }
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: purchaseOrderId }));
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    if (!po.supplierId) {
      throw supplierProformaError(SUPPLIER_PROFORMA_PO_SUPPLIER_MISMATCH, "Purchase Order has no supplier");
    }

    const supplierProformaNo = String(body.supplierProformaNo || "").trim();
    if (!supplierProformaNo) return res.status(400).json({ message: "supplierProformaNo is required" });
    const normalized = normalizeSupplierProformaNo(supplierProformaNo);

    const dup = await findActiveDuplicateProforma({
      companyId: companyOid(req),
      supplierId: po.supplierId,
      normalizedSupplierProformaNo: normalized,
    });
    if (dup) {
      throw supplierProformaError(
        SUPPLIER_PROFORMA_DUPLICATE,
        "An active Supplier Proforma with this number already exists for the supplier",
        { existingId: String(dup._id) },
        409
      );
    }

    const currency = String(body.currency || po.currency || "USD").trim().toUpperCase();
    const poCur = String(po.currency || "USD").trim().toUpperCase();
    const exchangeRate = Math.max(0, Number(body.exchangeRate) || 1);
    const exchangeRateReason = String(body.exchangeRateReason || "").trim();
    if (currency !== poCur && !exchangeRateReason) {
      throw supplierProformaError(
        SUPPLIER_PROFORMA_CURRENCY_MISMATCH,
        "Currency differs from PO; provide exchangeRateReason"
      );
    }

    const amounts = resolveAdvanceAmounts({
      totalValue: body.totalValue,
      requestedAdvanceAmount: body.requestedAdvanceAmount,
      requestedAdvancePercent: body.requestedAdvancePercent,
    });
    assertAdvanceWithinTotal(amounts);

    let purchaseDocumentId = null;
    if (mongoose.Types.ObjectId.isValid(String(body.purchaseDocumentId || ""))) {
      purchaseDocumentId = new mongoose.Types.ObjectId(String(body.purchaseDocumentId));
      const pd = await PurchaseDocument.findOne(
        withCompany(req, { _id: purchaseDocumentId, linkedPoId: po._id })
      ).lean();
      if (!pd) return res.status(400).json({ message: "purchaseDocumentId not found on this PO" });
      const already = await SupplierProforma.findOne(withCompany(req, { purchaseDocumentId })).lean();
      if (already) {
        return res.status(200).json({
          ...already,
          created: false,
          message: "Supplier Proforma already linked to this PurchaseDocument.",
          notice: "This document does not create AP liability.",
        });
      }
    }

    const internalProformaRef = await nextInternalRef(req);
    const doc = await SupplierProforma.create({
      companyId: companyOid(req),
      branchId: body.branchId || po.branchId || null,
      internalProformaRef,
      supplierProformaNo,
      normalizedSupplierProformaNo: normalized,
      supplierProformaDate: body.supplierProformaDate ? new Date(body.supplierProformaDate) : new Date(),
      supplierId: po.supplierId,
      supplierName: po.supplierName || "",
      purchaseOrderId: po._id,
      purchaseOrderNo: String(po.poNo || po.poNumber || "").trim(),
      purchaseDocumentId,
      currency,
      exchangeRate,
      exchangeRateReason,
      totalValue: amounts.totalValue,
      requestedAdvanceAmount: amounts.requestedAdvanceAmount,
      requestedAdvancePercent: amounts.requestedAdvancePercent,
      paymentDueDate: body.paymentDueDate ? new Date(body.paymentDueDate) : null,
      paymentTerms: String(body.paymentTerms || po.paymentTerms || "").trim(),
      remarks: String(body.remarks || "").trim(),
      primaryAttachment: parseAttachment(body.primaryAttachment),
      supportingAttachments: Array.isArray(body.supportingAttachments)
        ? body.supportingAttachments.map(parseAttachment).filter(Boolean)
        : [],
      documentStatus: "DRAFT",
      paymentStatus: "UNPAID",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });

    await writeAudit(req, {
      action: "CREATE",
      module: "PURCHASE",
      entityType: "SUPPLIER_PROFORMA",
      entityId: doc._id,
      documentNo: doc.internalProformaRef,
      description: `Supplier Proforma ${doc.internalProformaRef} created`,
    });

    res.status(201).json({
      ...doc.toObject(),
      created: true,
      message: "Supplier Proforma recorded. No Purchase Invoice or AP liability has been created.",
      notice: "This document does not create AP liability.",
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function updateSupplierProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    rejectProtectedFields(req.body || {});
    const row = await SupplierProforma.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Supplier Proforma not found" });
    assertEditableStatus(row.documentStatus);

    const body = pickWhitelisted(req.body || {}, SUPPLIER_PROFORMA_UPDATE_FIELDS);
    if (body.supplierProformaNo !== undefined) {
      const supplierProformaNo = String(body.supplierProformaNo || "").trim();
      if (!supplierProformaNo) return res.status(400).json({ message: "supplierProformaNo is required" });
      const normalized = normalizeSupplierProformaNo(supplierProformaNo);
      const dup = await findActiveDuplicateProforma({
        companyId: companyOid(req),
        supplierId: row.supplierId,
        normalizedSupplierProformaNo: normalized,
        excludeId: row._id,
      });
      if (dup) {
        throw supplierProformaError(
          SUPPLIER_PROFORMA_DUPLICATE,
          "An active Supplier Proforma with this number already exists for the supplier",
          { existingId: String(dup._id) },
          409
        );
      }
      row.supplierProformaNo = supplierProformaNo;
      row.normalizedSupplierProformaNo = normalized;
    }
    if (body.supplierProformaDate !== undefined) {
      row.supplierProformaDate = body.supplierProformaDate
        ? new Date(body.supplierProformaDate)
        : row.supplierProformaDate;
    }
    if (body.currency !== undefined) {
      const currency = String(body.currency || "").trim().toUpperCase();
      const po = await PurchaseOrder.findOne(withCompany(req, { _id: row.purchaseOrderId }))
        .select("currency")
        .lean();
      const poCur = String(po?.currency || row.currency || "USD").trim().toUpperCase();
      const exchangeRateReason =
        body.exchangeRateReason !== undefined
          ? String(body.exchangeRateReason || "").trim()
          : String(row.exchangeRateReason || "").trim();
      if (currency !== poCur && !exchangeRateReason) {
        throw supplierProformaError(
          SUPPLIER_PROFORMA_CURRENCY_MISMATCH,
          "Currency differs from PO; provide exchangeRateReason"
        );
      }
      row.currency = currency;
    }
    if (body.exchangeRate !== undefined) row.exchangeRate = Math.max(0, Number(body.exchangeRate) || 1);
    if (body.exchangeRateReason !== undefined) {
      row.exchangeRateReason = String(body.exchangeRateReason || "").trim();
    }
    if (body.paymentDueDate !== undefined) {
      row.paymentDueDate = body.paymentDueDate ? new Date(body.paymentDueDate) : null;
    }
    if (body.paymentTerms !== undefined) row.paymentTerms = String(body.paymentTerms || "").trim();
    if (body.remarks !== undefined) row.remarks = String(body.remarks || "").trim();
    if (body.primaryAttachment !== undefined) row.primaryAttachment = parseAttachment(body.primaryAttachment);
    if (body.supportingAttachments !== undefined) {
      row.supportingAttachments = Array.isArray(body.supportingAttachments)
        ? body.supportingAttachments.map(parseAttachment).filter(Boolean)
        : [];
    }

    const amounts = resolveAdvanceAmounts({
      totalValue: body.totalValue !== undefined ? body.totalValue : row.totalValue,
      requestedAdvanceAmount:
        body.requestedAdvanceAmount !== undefined ? body.requestedAdvanceAmount : row.requestedAdvanceAmount,
      requestedAdvancePercent:
        body.requestedAdvancePercent !== undefined ? body.requestedAdvancePercent : row.requestedAdvancePercent,
    });
    assertAdvanceWithinTotal(amounts);
    row.totalValue = amounts.totalValue;
    row.requestedAdvanceAmount = amounts.requestedAdvanceAmount;
    row.requestedAdvancePercent = amounts.requestedAdvancePercent;
    row.updatedBy = req.user?.email || "";
    await row.save();

    await writeAudit(req, {
      action: "UPDATE",
      module: "PURCHASE",
      entityType: "SUPPLIER_PROFORMA",
      entityId: row._id,
      documentNo: row.internalProformaRef,
      description: `Supplier Proforma ${row.internalProformaRef} updated`,
    });

    res.json({ ...row.toObject(), notice: "This document does not create AP liability." });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function receiveSupplierProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await SupplierProforma.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Supplier Proforma not found" });
    if (String(row.documentStatus) !== "DRAFT") {
      throw supplierProformaError(
        SUPPLIER_PROFORMA_INVALID_TRANSITION,
        `Cannot receive from status ${row.documentStatus}`,
        null,
        409
      );
    }
    row.documentStatus = "RECEIVED";
    row.updatedBy = req.user?.email || "";
    await row.save();
    await writeAudit(req, {
      action: "STATUS_CHANGE",
      module: "PURCHASE",
      entityType: "SUPPLIER_PROFORMA",
      entityId: row._id,
      documentNo: row.internalProformaRef,
      description: `Supplier Proforma ${row.internalProformaRef} received`,
      metadata: { from: "DRAFT", to: "RECEIVED" },
    });
    res.json(row);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function approveSupplierProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await SupplierProforma.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Supplier Proforma not found" });
    if (String(row.documentStatus) !== "RECEIVED") {
      throw supplierProformaError(
        SUPPLIER_PROFORMA_INVALID_TRANSITION,
        `Cannot approve from status ${row.documentStatus}`,
        null,
        409
      );
    }
    await assertOneApprovedPerPo({
      companyId: companyOid(req),
      purchaseOrderId: row.purchaseOrderId,
      excludeId: row._id,
    });
    row.documentStatus = "APPROVED";
    row.approvedBy = req.user?.email || "";
    row.approvedAt = new Date();
    row.updatedBy = req.user?.email || "";
    await row.save();
    await writeAudit(req, {
      action: "APPROVE",
      module: "PURCHASE",
      entityType: "SUPPLIER_PROFORMA",
      entityId: row._id,
      documentNo: row.internalProformaRef,
      description: `Supplier Proforma ${row.internalProformaRef} approved`,
    });
    res.json({
      ...row.toObject(),
      message: "Approved for advance authorization only. No AP liability created.",
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function cancelSupplierProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const reason = String(req.body?.reason || req.body?.cancellationReason || "").trim();
    if (!reason) return res.status(400).json({ message: "cancellation reason is required" });

    const row = await SupplierProforma.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Supplier Proforma not found" });
    if (String(row.documentStatus) === "CANCELLED") {
      return res.status(200).json({ ...row.toObject(), alreadyCancelled: true });
    }
    if (!["DRAFT", "RECEIVED", "APPROVED"].includes(String(row.documentStatus))) {
      throw supplierProformaError(
        SUPPLIER_PROFORMA_INVALID_TRANSITION,
        `Cannot cancel from status ${row.documentStatus}`,
        null,
        409
      );
    }

    if (String(row.documentStatus) === "APPROVED") {
      const dep = await supplierProformaHasAdvanceDependency({
        companyId: req.companyId,
        purchaseOrderNo: row.purchaseOrderNo,
      });
      if (dep.hasDependency) {
        throw supplierProformaError(
          SUPPLIER_PROFORMA_HAS_ADVANCE_DEPENDENCY,
          dep.reason || "Cannot cancel: supplier advance payment evidence exists on this PO",
          { paymentCount: dep.paymentCount },
          409
        );
      }
    }

    row.documentStatus = "CANCELLED";
    row.cancelledBy = req.user?.email || "";
    row.cancelledAt = new Date();
    row.cancellationReason = reason;
    row.updatedBy = req.user?.email || "";
    await row.save();
    await writeAudit(req, {
      action: "CANCEL",
      module: "PURCHASE",
      entityType: "SUPPLIER_PROFORMA",
      entityId: row._id,
      documentNo: row.internalProformaRef,
      description: `Supplier Proforma ${row.internalProformaRef} cancelled`,
      metadata: { reason },
    });
    res.json(row);
  } catch (err) {
    sendErr(res, err);
  }
}
