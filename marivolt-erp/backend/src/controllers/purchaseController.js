import mongoose from "mongoose";
import PurchaseOrder from "../models/PurchaseOrder.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { applyStockIn } from "../services/stockService.js";
import { applyPurchaseOrderDefaults } from "../constants/purchaseOrderDefaults.js";

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
        articleNo,
        partNo: l.partNo != null ? String(l.partNo).trim() : "",
        uom: l.uom || "PCS",
        qty: Number(l.qty) || 0,
        unitPrice: Number(l.unitPrice) || 0,
        description: l.description ?? "",
        remarks: l.remarks ?? "",
      };
    })
    .filter((l) => l.itemCode && l.qty > 0);
}

function recalcPoTotals(doc) {
  let sub = 0;
  const cur = doc.currency || "USD";
  for (const line of doc.lines) {
    line.currency = line.currency || cur;
    line.lineTotal = (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
    sub += line.lineTotal;
  }
  doc.subTotal = sub;
  doc.grandTotal = sub;
}

export async function listPurchaseOrders(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
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
    const row = await PurchaseOrder.findById(id).lean();
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
    if (!body.poNumber) {
      body.poNumber = await nextSequentialNumber(PurchaseOrder, "poNumber", "PO");
    }
    body.createdBy = req.user?.email || "";
    const doc = new PurchaseOrder(body);
    recalcPoTotals(doc);
    await doc.save();
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
    const doc = await PurchaseOrder.findById(id);
    if (!doc) return res.status(404).json({ message: "Not found" });

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
    recalcPoTotals(doc);
    await doc.save();
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
    const doc = await PurchaseOrder.findByIdAndUpdate(
      id,
      { status },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
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
    const po = await PurchaseOrder.findById(id);
    if (!po) return res.status(404).json({ message: "Not found" });

    const { warehouse = "MAIN", lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "lines array required" });
    }

    const userEmail = req.user?.email || "";

    for (const row of lines) {
      const lineId = row.lineId;
      const q = Number(row.qty);
      if (!lineId) return res.status(400).json({ message: "Each line needs lineId" });
      if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ message: "Invalid qty" });

      const line = po.lines.id(lineId);
      if (!line) return res.status(400).json({ message: `Invalid lineId ${lineId}` });

      const remaining = (Number(line.qty) || 0) - (Number(line.receivedQty) || 0);
      const take = Math.min(q, remaining);
      if (take <= 0) continue;

      await applyStockIn({
        itemCode: line.itemCode,
        warehouse,
        qty: take,
        movementType: "IN_PURCHASE",
        referenceType: "PURCHASE_ORDER",
        referenceId: po._id,
        referenceNumber: po.poNumber,
        unitCost: line.unitPrice,
        remarks: row.remarks || "",
        createdBy: userEmail,
      });

      line.receivedQty = (Number(line.receivedQty) || 0) + take;
    }

    const allReceived = po.lines.length > 0 && po.lines.every((l) => (l.receivedQty || 0) >= (l.qty || 0));
    const anyReceived = po.lines.some((l) => (l.receivedQty || 0) > 0);
    if (allReceived) po.status = "RECEIVED";
    else if (anyReceived) po.status = "PARTIAL_RECEIVED";

    await po.save();
    res.json(po);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deletePurchaseOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseOrder.findByIdAndDelete(id);
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/** Dashboard-style aggregates for purchase module. */
export async function purchaseSummaryReport(req, res) {
  try {
    const pos = await PurchaseOrder.find({}).lean();
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

    const filter = {
      status: { $nin: ["RECEIVED", "CANCELLED"] },
    };
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
          (await nextSequentialNumber(PurchaseOrder, "poNumber", "PO"));
        let payload = applyPurchaseOrderDefaults({
          ...row,
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
