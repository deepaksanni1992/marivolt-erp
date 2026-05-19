import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import GRN from "../models/GRN.js";
import Supplier from "../models/Supplier.js";
import Company from "../models/Company.js";
import {
  allocatePurchaseOrderNumber,
  isDuplicatePoNumberError,
  stripClientPoNumbers,
} from "../services/poNumberService.js";
import { applyPurchaseOrderDefaults } from "../constants/purchaseOrderDefaults.js";
import { buyerSnapshotFromCompany } from "../utils/companyBuyer.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";
import { writeAudit, writeStatusChange } from "../services/auditService.js";
import { syncPurchaseOrderApExtensionFields } from "./purchasePoDocumentController.js";
import { nextGrnNo } from "../services/grnNumberService.js";
import { syncPoLinesToItemMaster } from "../services/poItemMasterSyncService.js";
import { calcPoGrandTotal, poHeaderCost } from "../utils/poTotals.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

const MAX_GRN_NUMBER_RETRIES = 2;

function isDuplicateGrnNoError(err) {
  const msg = String(err?.message || "");
  return (
    err?.code === 11000 &&
    (err?.keyPattern?.grnNo || err?.keyValue?.grnNo || msg.includes("grnNo_1") || msg.includes("grnNo"))
  );
}

function normalizePoLines(lines = []) {
  return lines
    .map((l) => {
      const itemCode = String(l.itemCode || l.article || l.articleNo || l.materialCode || l.partNumber || l.partNo || "")
        .trim()
        .toUpperCase();
      const articleNo =
        l.articleNo != null && String(l.articleNo).trim() !== ""
          ? String(l.articleNo).trim()
          : itemCode;
      return {
        ...l,
        itemCode,
        article: String(l.article || itemCode).trim().toUpperCase(),
        articleNo,
        partNo: l.partNo != null ? String(l.partNo).trim() : "",
        partNumber: String(l.partNumber || l.partNo || "").trim().toUpperCase(),
        materialCode: String(l.materialCode || l.itemCode || "").trim().toUpperCase(),
        spn: String(l.spn || l.SPN || l.partNo || "").trim().toUpperCase(),
        drawingNo: l.drawingNo != null ? String(l.drawingNo).trim() : String(l.drawingNumber || "").trim(),
        vertical: l.vertical != null ? String(l.vertical).trim() : "",
        brand: l.brand != null ? String(l.brand).trim() : String(l.engine || "").trim(),
        engine: l.engine != null ? String(l.engine).trim() : String(l.brand || "").trim(),
        model: l.model != null ? String(l.model).trim() : "",
        config: l.config != null ? String(l.config).trim() : "",
        esn: l.esn != null ? String(l.esn).trim() : "",
        uom: l.uom || "PCS",
        qty: Number(l.orderedQty ?? l.qty) || 0,
        orderedQty: Number(l.orderedQty ?? l.qty) || 0,
        receivedQty: Number(l.receivedQty) || 0,
        cancelledQty: Number(l.cancelledQty) || 0,
        unitPrice: Number(l.unitPrice) || 0,
        description: l.description ?? "",
        remarks: l.remarks ?? "",
        leadTime: l.leadTime != null ? String(l.leadTime).trim() : "",
        supplierPartNumber: String(l.supplierPartNumber || "").trim(),
      };
    })
    .filter((l) => l.itemCode && l.qty > 0);
}

function poLineToPlain(line) {
  if (!line) return {};
  if (typeof line.toObject === "function") return line.toObject();
  return { ...line };
}

function mergeLinePatch(baseLine, patchLine) {
  const base = poLineToPlain(baseLine);
  const patch = poLineToPlain(patchLine);
  return {
    ...base,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    _id: patch._id || base._id,
  };
}

function mergePoLinesForUpdate(existingLines = [], incomingLines = []) {
  const existing = Array.from(existingLines || []);
  const byId = new Map(existing.map((line) => [String(line._id || ""), line]).filter(([id]) => id));
  const usedIds = new Set();
  const merged = [];

  for (let i = 0; i < incomingLines.length; i += 1) {
    const incoming = incomingLines[i] || {};
    const id = String(incoming._id || incoming.id || "");
    const base = (id && byId.get(id)) || existing[i] || null;
    if (id) usedIds.add(id);
    merged.push(mergeLinePatch(base, incoming));
  }

  for (const line of existing) {
    const id = String(line._id || "");
    if (id && usedIds.has(id)) continue;
    if (!incomingLines.length) merged.push(poLineToPlain(line));
  }

  return normalizePoLines(merged);
}

function fillBlankBuyerSnapshot(doc, company) {
  const snapshot = buyerSnapshotFromCompany(company);
  for (const [key, value] of Object.entries(snapshot)) {
    if (doc[key] == null || String(doc[key]).trim() === "") {
      doc[key] = value;
    }
  }
}

function recalcPoTotals(doc) {
  let sub = 0;
  const cur = doc.currency || "USD";
  for (const line of doc.lines) {
    line.currency = line.currency || cur;
    line.qty = Number(line.orderedQty ?? line.qty) || 0;
    line.orderedQty = Number(line.orderedQty ?? line.qty) || 0;
    line.receivedQty = Number(line.receivedQty) || 0;
    line.cancelledQty = Number(line.cancelledQty) || 0;
    line.pendingQty = Math.max(0, line.orderedQty - line.receivedQty - line.cancelledQty);
    line.lineAmount = line.orderedQty * (Number(line.unitPrice) || 0);
    line.lineTotal = line.lineAmount;
    sub += line.lineTotal;
  }
  doc.subTotal = sub;
  doc.packingCost = poHeaderCost(doc.packingCost);
  doc.handlingCost = poHeaderCost(doc.handlingCost);
  doc.miscellaneousCost = poHeaderCost(doc.miscellaneousCost);
  doc.grandTotal = calcPoGrandTotal(sub, doc.packingCost, doc.handlingCost, doc.miscellaneousCost);
}

async function resolveSupplierSnapshot(req, body = {}) {
  const supplierId = body.supplierId && mongoose.Types.ObjectId.isValid(String(body.supplierId))
    ? new mongoose.Types.ObjectId(String(body.supplierId))
    : null;
  let supplierDoc = null;
  if (supplierId) {
    supplierDoc = await Supplier.findOne(withCompany(req, { _id: supplierId })).lean();
  } else if (body.supplierName) {
    supplierDoc = await Supplier.findOne(withCompany(req, { supplierName: String(body.supplierName).trim() })).lean();
  }
  if (!supplierDoc) {
    return {
      supplierId: null,
      supplierName: String(body.supplierName || "").trim(),
      supplierAddress: String(body.supplierAddress || "").trim(),
      supplierPhone: String(body.supplierPhone || "").trim(),
      supplierEmail: String(body.supplierEmail || "").trim(),
      paymentTerms: String(body.paymentTerms || body.payment || "").trim(),
      currency: String(body.currency || "USD").trim().toUpperCase(),
    };
  }
  return {
    supplierId: supplierDoc._id,
    supplierName: supplierDoc.supplierName || supplierDoc.name || "",
    supplierAddress: supplierDoc.address || "",
    supplierPhone: supplierDoc.phone || "",
    supplierEmail: supplierDoc.email || "",
    paymentTerms: String(body.paymentTerms || supplierDoc.paymentTerms || body.payment || "").trim(),
    currency: String(body.currency || supplierDoc.currency || "USD").trim().toUpperCase(),
  };
}

export async function listPurchaseOrders(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.approvalStatus) filter.approvalStatus = String(req.query.approvalStatus).trim().toUpperCase();
    if (req.query.supplierName) {
      filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    }
    const [rows, total] = await Promise.all([
      PurchaseOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PurchaseOrder.countDocuments(filter),
    ]);
    res.json({ items: rows, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseOrder.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    const grns = await GRN.find(withCompany(req, { poId: row._id }))
      .select("grnNo grnDate status items")
      .sort({ createdAt: -1 })
      .lean();
    const lineHistory = {};
    for (const g of grns) {
      for (const ln of g.items || []) {
        const key = String(ln.poLineId || "");
        if (!key) continue;
        if (!lineHistory[key]) lineHistory[key] = [];
        lineHistory[key].push({
          grnNo: g.grnNo,
          grnDate: g.grnDate,
          status: g.status,
          receivedQty: Number(ln.receivedQty) || 0,
          rejectedQty: Number(ln.rejectedQty) || 0,
          cancelledQty: Number(ln.cancelledQty) || 0,
        });
      }
    }
    row._grnLineHistory = lineHistory;
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

const MAX_PO_NUMBER_SAVE_RETRIES = 4;

async function assignNewPurchaseOrderNumbers(body, req, company) {
  const allocated = await allocatePurchaseOrderNumber({
    companyId: req.companyId,
    companyCode: req.companyCode || company?.code || "",
    companyName: company?.name || company?.companyName || "",
  });
  body.poNo = allocated.poNo;
  body.poNumber = allocated.poNumber;
  return allocated;
}

export async function createPurchaseOrder(req, res) {
  try {
    let body = stripClientPoNumbers(req.body);
    body.lines = normalizePoLines(body.lines);
    if (!body.lines.length) {
      return res.status(400).json({
        message: "At least one line with Article Nr. (or item / part code) and quantity is required",
      });
    }
    const company = await Company.findById(req.companyId).lean();
    Object.assign(body, buyerSnapshotFromCompany(company));
    body = applyPurchaseOrderDefaults(body);
    const supplierSnapshot = await resolveSupplierSnapshot(req, body);
    body.supplierId = supplierSnapshot.supplierId;
    body.supplierName = supplierSnapshot.supplierName;
    body.supplierAddress = supplierSnapshot.supplierAddress;
    body.supplierPhone = supplierSnapshot.supplierPhone;
    body.supplierEmail = supplierSnapshot.supplierEmail;
    body.paymentTerms = supplierSnapshot.paymentTerms;
    body.currency = supplierSnapshot.currency;
    body.exchangeRate = Number(body.exchangeRate) || 1;
    body.approvalStatus = "NOT_REQUIRED";
    body.expectedDeliveryDate = body.expectedDeliveryDate ? new Date(body.expectedDeliveryDate) : null;
    body.linkedPRs = Array.isArray(body.linkedPRs) ? body.linkedPRs.filter((x) => mongoose.Types.ObjectId.isValid(String(x))) : [];
    body.createdBy = req.user?.email || "";
    body.companyId = req.companyId;

    let lastErr = null;
    for (let attempt = 0; attempt < MAX_PO_NUMBER_SAVE_RETRIES; attempt += 1) {
      try {
        await assignNewPurchaseOrderNumbers(body, req, company);
        await syncPoLinesToItemMaster({
          companyId: req.companyId,
          companyCode: req.companyCode || company?.code || "",
          poNo: body.poNo,
          supplierName: body.supplierName,
          header: body,
          lines: body.lines,
        });
        const doc = new PurchaseOrder(body);
        recalcPoTotals(doc);
        await doc.save();
        await writeAudit(req, {
          action: "CREATE",
          module: "PURCHASE",
          entityType: "PURCHASE_ORDER",
          entityId: doc._id,
          documentNo: doc.poNo,
          description: `PO ${doc.poNo} created`,
          metadata: { supplierName: doc.supplierName, lineCount: doc.lines.length },
        });
        return res.status(201).json(doc);
      } catch (err) {
        lastErr = err;
        if (isDuplicatePoNumberError(err) && attempt < MAX_PO_NUMBER_SAVE_RETRIES - 1) {
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error("Could not create purchase order");
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updatePurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await PurchaseOrder.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!["DRAFT", "SAVED", "REJECTED"].includes(doc.status)) {
      return res.status(400).json({ message: "Only draft or saved purchase orders can be modified." });
    }
    const company = await Company.findById(req.companyId).lean();
    const previousSupplierId = String(doc.supplierId || "");
    const previousSupplierName = String(doc.supplierName || "").trim();

    const allowed = [
      "buyerLegalName",
      "buyerAddressLine",
      "buyerPhone",
      "buyerEmail",
      "buyerWeb",
      "buyerTrnNo",
      "supplierName",
      "supplierAddress",
      "supplierPhone",
      "supplierEmail",
      "supplierReference",
      "ref",
      "intRef",
      "contactPerson",
      "vertical",
      "brand",
      "engine",
      "model",
      "config",
      "esn",
      "supplierId",
      "branchId",
      "warehouseId",
      "expectedDeliveryDate",
      "exchangeRate",
      "paymentTerms",
      "linkedPRs",
      "offerDate",
      "currency",
      "remarks",
      "orderDate",
      "delivery",
      "insurance",
      "packing",
      "freight",
      "taxes",
      "payment",
      "specialRemarks",
      "termsAndConditions",
      "closingNote",
      "packingCost",
      "handlingCost",
      "miscellaneousCost",
    ];
    const patch = stripClientPoNumbers(req.body);
    for (const k of allowed) {
      if (patch[k] !== undefined) doc[k] = patch[k];
    }
    if (Array.isArray(patch.lines)) {
      doc.lines = mergePoLinesForUpdate(doc.lines, patch.lines);
      if (!doc.lines.length) {
        return res.status(400).json({ message: "At least one valid line is required" });
      }
    } else {
      doc.lines = normalizePoLines(doc.lines);
      if (!doc.lines.length) {
        return res.status(400).json({ message: "Purchase order must retain at least one valid line." });
      }
    }
    const supplierChanged =
      (patch.supplierId !== undefined && String(patch.supplierId || "") !== previousSupplierId) ||
      (patch.supplierName !== undefined && String(patch.supplierName || "").trim() !== previousSupplierName);
    if (supplierChanged) {
      const supplierSnapshot = await resolveSupplierSnapshot(req, doc);
      doc.supplierId = supplierSnapshot.supplierId;
      doc.supplierName = supplierSnapshot.supplierName;
      doc.supplierAddress = supplierSnapshot.supplierAddress;
      doc.supplierPhone = supplierSnapshot.supplierPhone;
      doc.supplierEmail = supplierSnapshot.supplierEmail;
      doc.paymentTerms = supplierSnapshot.paymentTerms || doc.paymentTerms;
      doc.currency = supplierSnapshot.currency || doc.currency;
    }
    fillBlankBuyerSnapshot(doc, company);
    if (doc.poNo && !doc.poNumber) doc.poNumber = doc.poNo;
    if (doc.poNumber && !doc.poNo) doc.poNo = doc.poNumber;
    await syncPoLinesToItemMaster({
      companyId: req.companyId,
      companyCode: req.companyCode || "",
      poNo: doc.poNo,
      supplierName: doc.supplierName,
      header: doc,
      lines: doc.lines,
    });
    recalcPoTotals(doc);
    await doc.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "PURCHASE",
      entityType: "PURCHASE_ORDER",
      entityId: doc._id,
      documentNo: doc.poNo,
      description: `PO ${doc.poNo} updated`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function patchPurchaseStatus(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: "status required" });
    const nextStatus = String(status || "").trim().toUpperCase();
    if (nextStatus === "SENT") {
      const gate = await ensureApproval(req, {
        companyId: req.companyId,
        module: "PURCHASE",
        actionKey: "po_submit",
        documentType: "PURCHASE_ORDER",
        documentId: id,
        description: `Submit PO ${id}`,
      });
      if (!gate.approved) {
        const pending = await PurchaseOrder.findOneAndUpdate(
          withCompany(req, { _id: id }),
          { status: "SENT", approvalStatus: "PENDING" },
          { new: true, runValidators: true }
        );
        if (!pending) return res.status(404).json({ message: "Not found" });
        await writeStatusChange(req, {
          module: "PURCHASE",
          entityType: "PURCHASE_ORDER",
          entityId: pending._id,
          documentNo: pending.poNo || pending.poNumber,
          fromStatus: pending.status,
          toStatus: "SENT",
          description: `PO ${pending.poNo || pending.poNumber} submitted and pending approval`,
        });
        return res.status(202).json(approvalRequiredPayload(gate.request));
      }
    }
    const doc = await PurchaseOrder.findOneAndUpdate(
      withCompany(req, { _id: id }),
      {
        status: nextStatus,
        approvalStatus: nextStatus === "SENT" ? "APPROVED" : undefined,
      },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
    await writeStatusChange(req, {
      module: "PURCHASE",
      entityType: "PURCHASE_ORDER",
      entityId: doc._id,
      documentNo: doc.poNo || doc.poNumber,
      fromStatus: "UNKNOWN",
      toStatus: nextStatus,
      description: `PO ${doc.poNo || doc.poNumber} moved to ${nextStatus}`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function receivePurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: id }));
    if (!po) return res.status(404).json({ message: "Not found" });

    const { warehouse = "MAIN", warehouseId = null, branchId = null, lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "lines array required" });
    }

    const receiveLines = [];
    for (const row of lines) {
      const lineId = row.lineId;
      const q = Number(row.qty);
      if (!lineId) throw new Error("Each line needs lineId");
      if (!Number.isFinite(q) || q <= 0) throw new Error("Invalid qty");
      const line = po.lines.id(lineId);
      if (!line) throw new Error(`Invalid lineId ${lineId}`);
      const ordered = Number(line.orderedQty ?? line.qty) || 0;
      const received = Number(line.receivedQty) || 0;
      const cancelled = Number(line.cancelledQty) || 0;
      const remaining = Math.max(0, ordered - received - cancelled);
      if (q > remaining) {
        return res.status(400).json({
          message: `Receive qty exceeds pending for ${line.itemCode || line.article || line.articleNo || "line"}`,
        });
      }
      receiveLines.push({
        article: line.itemCode || line.article,
        description: line.description || "",
        orderedQty: ordered,
        receivedQty: q,
        pendingQty: Math.max(0, remaining - q),
        acceptedQty: q,
        rejectedQty: 0,
        cancelledQty: 0,
        unitCost: Number(line.unitPrice) || 0,
        lineAmount: q * (Number(line.unitPrice) || 0),
        currency: po.currency || "USD",
        exchangeRate: Number(po.exchangeRate) || 1,
        freight: Number(row.freight) || 0,
        customs: Number(row.customs) || 0,
        landedAdjustment: Number(row.landedAdjustment) || 0,
        location: String(row.location || warehouse || "").trim().toUpperCase(),
        warehouse: String(row.location || warehouse || "").trim().toUpperCase(),
        warehouseId: row.warehouseId || warehouseId || po.warehouseId || null,
        batchNo: String(row.batchNo || "").trim(),
        serialNo: String(row.serialNo || "").trim(),
        manufacturingDate: row.manufacturingDate || null,
        expiryDate: row.expiryDate || null,
        poId: po._id,
        poLineId: line._id,
        poNo: po.poNo || po.poNumber,
        remarks: String(row.remarks || "").trim(),
      });
    }

    let grn = null;
    for (let attempt = 1; attempt <= MAX_GRN_NUMBER_RETRIES; attempt++) {
      const grnNo = await nextGrnNo({ companyId: req.companyId, companyCode: req.companyCode });
      try {
        grn = await GRN.create({
          companyId: req.companyId,
          branchId: branchId || po.branchId || null,
          warehouseId: warehouseId || po.warehouseId || null,
          grnNo,
          grnDate: req.body.grnDate || new Date(),
          poId: po._id,
          poNo: po.poNo || po.poNumber,
          supplierId: po.supplierId || null,
          supplierName: po.supplierName || "",
          supplierInvoiceNo: String(req.body.supplierInvoiceNo || "").trim(),
          packingListNo: String(req.body.packingListNo || "").trim(),
          blAwbNo: String(req.body.blAwbNo || "").trim(),
          customsDocRef: String(req.body.customsDocRef || "").trim(),
          currency: po.currency || "USD",
          exchangeRate: Number(po.exchangeRate) || 1,
          freight: Number(req.body.freight) || 0,
          customs: Number(req.body.customs) || 0,
          landedAdjustment: Number(req.body.landedAdjustment) || 0,
          remarks: String(req.body.remarks || "").trim(),
          status: "DRAFT",
          approvalStatus: "NOT_REQUIRED",
          items: receiveLines,
          attachments: Array.isArray(req.body.attachments) ? req.body.attachments : [],
          createdBy: req.user?.email || "",
          updatedBy: req.user?.email || "",
        });
        break;
      } catch (err) {
        if (isDuplicateGrnNoError(err) && attempt < MAX_GRN_NUMBER_RETRIES) continue;
        throw err;
      }
    }
    if (!grn) throw new Error("Unable to allocate a unique GRN number. Please retry.");
    await writeAudit(req, {
      action: "CREATE",
      module: "PURCHASE",
      entityType: "GRN",
      entityId: grn._id,
      documentNo: grn.grnNo,
      description: `Draft GRN ${grn.grnNo} created from PO ${po.poNo || po.poNumber}`,
    });
    await syncPurchaseOrderApExtensionFields(req.companyId, po._id);
    res.status(201).json(grn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deletePurchaseOrder(req, res) {
  try {
    const role = String(req.user?.role || "")
      .toLowerCase()
      .trim();
    if (!["super_admin", "company_admin", "admin"].includes(role)) {
      return res.status(403).json({ message: "Only administrators can delete purchase orders." });
    }
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseOrder.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (!["DRAFT", "SAVED", "REJECTED"].includes(row.status)) {
      return res.status(400).json({ message: "Only draft or saved purchase orders can be deleted." });
    }
    await PurchaseOrder.deleteOne(withCompany(req, { _id: id }));
    await writeAudit(req, {
      action: "DELETE",
      module: "PURCHASE",
      entityType: "PURCHASE_ORDER",
      entityId: row._id,
      documentNo: row.poNo || row.poNumber,
      description: `PO ${row.poNo || row.poNumber} deleted`,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function submitPurchaseOrder(req, res) {
  req.body = { ...(req.body || {}), status: "SENT" };
  return patchPurchaseStatus(req, res);
}

export async function approvePurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PurchaseOrder.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!["SENT", "REJECTED"].includes(doc.status)) return res.status(409).json({ message: "Only sent/rejected PO can be approved." });
    const prev = doc.status;
    doc.status = "SENT";
    doc.approvalStatus = "APPROVED";
    await doc.save();
    await writeStatusChange(req, {
      module: "PURCHASE",
      entityType: "PURCHASE_ORDER",
      entityId: doc._id,
      documentNo: doc.poNo || doc.poNumber,
      fromStatus: prev,
      toStatus: "SENT",
      description: `PO ${doc.poNo || doc.poNumber} approved`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function rejectPurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PurchaseOrder.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (doc.status !== "SENT") return res.status(409).json({ message: "Only sent PO can be rejected." });
    doc.status = "REJECTED";
    doc.approvalStatus = "REJECTED";
    await doc.save();
    await writeStatusChange(req, {
      module: "PURCHASE",
      entityType: "PURCHASE_ORDER",
      entityId: doc._id,
      documentNo: doc.poNo || doc.poNumber,
      fromStatus: "SENT",
      toStatus: "REJECTED",
      description: `PO ${doc.poNo || doc.poNumber} rejected`,
      metadata: { reason: String(req.body?.reason || "").trim() },
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelPurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await PurchaseOrder.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (["RECEIVED", "PARTIAL_RECEIVED", "CLOSED", "CANCELLED"].includes(doc.status)) {
      return res.status(409).json({ message: "PO cannot be cancelled in current status." });
    }
    const prev = doc.status;
    doc.status = "CANCELLED";
    await doc.save();
    await writeStatusChange(req, {
      module: "PURCHASE",
      entityType: "PURCHASE_ORDER",
      entityId: doc._id,
      documentNo: doc.poNo || doc.poNumber,
      fromStatus: prev,
      toStatus: "CANCELLED",
      description: `PO ${doc.poNo || doc.poNumber} cancelled`,
    });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/** Dashboard-style aggregates for purchase module. */
export async function purchaseSummaryReport(req, res) {
  try {
    const pos = await PurchaseOrder.find(withCompany(req)).lean();
    const byStatus = {};
    let totalGrand = 0;
    let pendingCount = 0;
    const supplierTotals = {};

    for (const po of pos) {
      const st = po.status || "DRAFT";
      byStatus[st] = (byStatus[st] || 0) + 1;
      const gt = Number(po.grandTotal) || 0;
      totalGrand += gt;
      const sup = (po.supplierName || "").trim() || "—";
      supplierTotals[sup] = (supplierTotals[sup] || 0) + gt;

      if (!["RECEIVED", "CANCELLED"].includes(st)) pendingCount += 1;
    }

    const supplierRanking = Object.entries(supplierTotals)
      .map(([supplierName, value]) => ({ supplierName, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 15);

    res.json({
      totalPurchaseOrders: pos.length,
      totalOrderValue: totalGrand,
      pendingOrderCount: pendingCount,
      byStatus,
      topSuppliersByValue: supplierRanking,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

function linePendingQty(line) {
  const q = Number(line.orderedQty ?? line.qty) || 0;
  const r = Number(line.receivedQty) || 0;
  const c = Number(line.cancelledQty) || 0;
  return Math.max(0, q - r - c);
}

function poHasPendingLines(po) {
  if (po.status === "CANCELLED") return false;
  if (po.status === "RECEIVED") return false;
  if (!po.lines?.length) return true;
  return po.lines.some((l) => linePendingQty(l) > 0);
}

/** POs awaiting full receipt (excludes cancelled and fully received). */
export async function pendingPurchaseReport(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;

    const filter = withCompany(req, {
      status: { $nin: ["RECEIVED", "CANCELLED"] },
    });
    if (req.query.supplierName) {
      filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    }

    const raw = await PurchaseOrder.find(filter).sort({ orderDate: -1 }).lean();
    const enriched = raw
      .filter(poHasPendingLines)
      .map((po) => {
        let pendingLines = 0;
        let ordered = 0;
        let received = 0;
        for (const l of po.lines || []) {
          ordered += Number(l.orderedQty ?? l.qty) || 0;
          received += Number(l.receivedQty) || 0;
          if (linePendingQty(l) > 0) pendingLines += 1;
        }
        const pendingQty = ordered - received;
        const pct =
          ordered > 0 ? Math.round((received / ordered) * 1000) / 10 : 0;
        return {
          ...po,
          _report: {
            pendingLineCount: pendingLines,
            totalOrderedQty: ordered,
            totalReceivedQty: received,
            pendingQty,
            receiptPercent: pct,
            eta: po.expectedDeliveryDate || null,
            warehouse: po.warehouse || po.warehouseName || "",
          },
        };
      });

    const total = enriched.length;
    const items = enriched.slice(skip, skip + limit);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function openPurchaseReport(req, res) {
  try {
    const filter = withCompany(req, { status: { $nin: ["CANCELLED", "CLOSED"] } });
    if (req.query.supplierName) filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    const rows = await PurchaseOrder.find(filter).sort({ createdAt: -1 }).lean();
    const items = rows.map((po) => {
      const ordered = (po.lines || []).reduce((n, l) => n + (Number(l.orderedQty ?? l.qty) || 0), 0);
      const received = (po.lines || []).reduce((n, l) => n + (Number(l.receivedQty) || 0), 0);
      const pending = Math.max(0, ordered - received);
      return {
        _id: po._id,
        poNo: po.poNo || po.poNumber,
        supplier: po.supplierName || "",
        ordered,
        received,
        pending,
        eta: po.expectedDeliveryDate || null,
        status: po.status || "DRAFT",
        warehouse: po.warehouse || po.warehouseName || "",
      };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function procurementDashboard(req, res) {
  try {
    const [poRows, grnRows] = await Promise.all([
      PurchaseOrder.find(withCompany(req)).lean(),
      GRN.find(withCompany(req)).lean(),
    ]);
    const today = new Date();
    const openPos = poRows.filter((x) => !["RECEIVED", "CANCELLED", "CLOSED"].includes(String(x.status || ""))).length;
    const pendingReceipts = poRows.filter((x) => ["SENT", "PARTIAL_RECEIVED"].includes(String(x.status || ""))).length;
    const delayedSuppliers = poRows.filter((x) => x.expectedDeliveryDate && new Date(x.expectedDeliveryDate) < today && !["RECEIVED", "CANCELLED", "CLOSED"].includes(String(x.status || ""))).length;
    const partialGrns = grnRows.filter((x) => String(x.status || "") === "PARTIAL_RECEIVED").length;
    const outstandingBySupplier = {};
    for (const po of poRows) {
      const supplierName = po.supplierName || "—";
      const ordered = (po.lines || []).reduce((n, l) => n + (Number(l.orderedQty ?? l.qty) || 0), 0);
      const received = (po.lines || []).reduce((n, l) => n + (Number(l.receivedQty) || 0), 0);
      const pending = Math.max(0, ordered - received);
      if (!(pending > 0)) continue;
      outstandingBySupplier[supplierName] = (outstandingBySupplier[supplierName] || 0) + pending;
    }
    const supplierOutstanding = Object.entries(outstandingBySupplier)
      .map(([supplierName, pendingQty]) => ({ supplierName, pendingQty }))
      .sort((a, b) => b.pendingQty - a.pendingQty)
      .slice(0, 10);
    res.json({
      widgets: { openPos, pendingReceipts, delayedSuppliers, partialGrns },
      supplierOutstanding,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** Bulk create POs from array of documents (minimal validation). */
export async function importPurchaseOrders(req, res) {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ message: "orders array required" });
    }
    if (orders.length > 100) {
      return res.status(400).json({ message: "Maximum 100 purchase orders per import" });
    }
    const created = [];
    const errors = [];
    const userEmail = req.user?.email || "";
    const company = await Company.findById(req.companyId).lean();
    const buyerSnap = buyerSnapshotFromCompany(company);

    for (let i = 0; i < orders.length; i++) {
      const row = orders[i];
      try {
        if (!row.supplierName) throw new Error("supplierName required");
        if (!Array.isArray(row.lines) || row.lines.length === 0) {
          throw new Error("lines required");
        }
        let payload = applyPurchaseOrderDefaults({
          ...buyerSnap,
          ...stripClientPoNumbers(row),
          companyId: req.companyId,
          createdBy: userEmail,
          status: row.status || "DRAFT",
          lines: normalizePoLines(row.lines),
        });
        if (!payload.lines.length) throw new Error("no valid lines after normalize");
        let saved = null;
        for (let attempt = 0; attempt < MAX_PO_NUMBER_SAVE_RETRIES; attempt += 1) {
          try {
            await assignNewPurchaseOrderNumbers(payload, req, company);
            const doc = new PurchaseOrder(payload);
            recalcPoTotals(doc);
            await doc.save();
            saved = doc;
            break;
          } catch (saveErr) {
            if (isDuplicatePoNumberError(saveErr) && attempt < MAX_PO_NUMBER_SAVE_RETRIES - 1) {
              continue;
            }
            throw saveErr;
          }
        }
        if (!saved) throw new Error("could not allocate PO number");
        created.push(saved);
      } catch (e) {
        errors.push({ index: i, message: e.message });
      }
    }
    res.json({ createdCount: created.length, errors, errorCount: errors.length });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
