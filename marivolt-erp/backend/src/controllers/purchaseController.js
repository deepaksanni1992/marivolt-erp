import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import Supplier from "../models/Supplier.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import * as stockService from "../services/stockService.js";
import { applyPurchaseOrderDefaults } from "../constants/purchaseOrderDefaults.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";
import { writeAudit, writeStatusChange } from "../services/auditService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function normalizePoLines(lines = []) {
  return lines
    .map((l) => {
      const itemCode = String(l.itemCode || l.articleNo || l.partNo || "").trim().toUpperCase();
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
        uom: l.uom || "PCS",
        qty: Number(l.orderedQty ?? l.qty) || 0,
        orderedQty: Number(l.orderedQty ?? l.qty) || 0,
        receivedQty: Number(l.receivedQty) || 0,
        cancelledQty: Number(l.cancelledQty) || 0,
        unitPrice: Number(l.unitPrice) || 0,
        description: l.description ?? "",
        remarks: l.remarks ?? "",
        leadTime: l.leadTime != null ? String(l.leadTime).trim() : "",
      };
    })
    .filter((l) => l.itemCode && l.qty > 0);
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
  doc.grandTotal = sub;
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
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createPurchaseOrder(req, res) {
  try {
    let body = { ...req.body };
    body.lines = normalizePoLines(body.lines);
    if (!body.lines.length) {
      return res.status(400).json({
        message: "At least one line with Article Nr. (or item / part code) and quantity is required",
      });
    }
    body = applyPurchaseOrderDefaults(body);
    if (!body.poNo && !body.poNumber) {
      body.poNo = await nextSequentialNumber(PurchaseOrder, "poNo", "PO", {
        companyId: req.companyId,
        branchId: body.branchId || null,
        docKey: "PURCHASE_ORDER",
        companyCode: req.companyCode || "",
      });
    }
    body.poNumber = body.poNumber || body.poNo;
    body.poNo = body.poNo || body.poNumber;
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
    res.status(201).json(doc);
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

    const allowed = [
      "buyerLegalName",
      "buyerAddressLine",
      "buyerPhone",
      "buyerEmail",
      "buyerWeb",
      "supplierName",
      "supplierAddress",
      "supplierPhone",
      "supplierEmail",
      "supplierReference",
      "ref",
      "intRef",
      "contactPerson",
      "supplierId",
      "branchId",
      "warehouseId",
      "expectedDeliveryDate",
      "exchangeRate",
      "paymentTerms",
      "linkedPRs",
      "offerDate",
      "currency",
      "lines",
      "status",
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
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    if (req.body.lines) {
      doc.lines = normalizePoLines(doc.lines);
      if (!doc.lines.length) {
        return res.status(400).json({ message: "At least one valid line is required" });
      }
    }
    if (req.body.supplierId !== undefined || req.body.supplierName !== undefined) {
      const supplierSnapshot = await resolveSupplierSnapshot(req, doc);
      doc.supplierId = supplierSnapshot.supplierId;
      doc.supplierName = supplierSnapshot.supplierName;
      doc.supplierAddress = supplierSnapshot.supplierAddress;
      doc.supplierPhone = supplierSnapshot.supplierPhone;
      doc.supplierEmail = supplierSnapshot.supplierEmail;
      doc.paymentTerms = supplierSnapshot.paymentTerms || doc.paymentTerms;
      doc.currency = supplierSnapshot.currency || doc.currency;
    }
    if (doc.poNo && !doc.poNumber) doc.poNumber = doc.poNo;
    if (doc.poNumber && !doc.poNo) doc.poNo = doc.poNumber;
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

    const { warehouse = "MAIN", lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "lines array required" });
    }

    const userEmail = req.user?.email || "";

    await stockService.withTransaction(async (session) => {
      for (const row of lines) {
        const lineId = row.lineId;
        const q = Number(row.qty);
        if (!lineId) throw new Error("Each line needs lineId");
        if (!Number.isFinite(q) || q <= 0) throw new Error("Invalid qty");

        const line = po.lines.id(lineId);
        if (!line) throw new Error(`Invalid lineId ${lineId}`);

        const remaining = (Number(line.qty) || 0) - (Number(line.receivedQty) || 0);
        const take = Math.min(q, remaining);
        if (take <= 0) continue;

        await stockService.grnReceive({
          session,
          companyId: req.companyId,
          article: line.itemCode,
          warehouse,
          qty: take,
          referenceType: "PURCHASE_ORDER",
          referenceNo: po.poNo || po.poNumber,
          supplierName: po.supplierName || "",
          unitCost: line.unitPrice,
          remarks: row.remarks || "",
          createdBy: userEmail,
          sourceModule: "PURCHASE",
        });

        line.receivedQty = (Number(line.receivedQty) || 0) + take;
      }

      const allReceived =
        po.lines.length > 0 && po.lines.every((l) => (l.receivedQty || 0) >= (l.qty || 0));
      const anyReceived = po.lines.some((l) => (l.receivedQty || 0) > 0);
      if (allReceived) po.status = "RECEIVED";
      else if (anyReceived) po.status = "PARTIAL_RECEIVED";

      await po.save({ session });
    });
    res.json(po);
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
  const q = Number(line.qty) || 0;
  const r = Number(line.receivedQty) || 0;
  return Math.max(0, q - r);
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
          ordered += Number(l.qty) || 0;
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

    for (let i = 0; i < orders.length; i++) {
      const row = orders[i];
      try {
        if (!row.supplierName) throw new Error("supplierName required");
        if (!Array.isArray(row.lines) || row.lines.length === 0) {
          throw new Error("lines required");
        }
        const poNumber =
          row.poNumber ||
          (await nextSequentialNumber(
            PurchaseOrder,
            "poNumber",
            `${req.companyCode || "CMP"}-PO`,
            { companyId: req.companyId }
          ));
        let payload = applyPurchaseOrderDefaults({
          ...row,
          companyId: req.companyId,
          poNumber,
          createdBy: userEmail,
          status: row.status || "DRAFT",
          lines: normalizePoLines(row.lines),
        });
        if (!payload.lines.length) throw new Error("no valid lines after normalize");
        const doc = new PurchaseOrder(payload);
        recalcPoTotals(doc);
        await doc.save();
        created.push(doc);
      } catch (e) {
        errors.push({ index: i, message: e.message });
      }
    }
    res.json({ createdCount: created.length, errors, errorCount: errors.length });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
