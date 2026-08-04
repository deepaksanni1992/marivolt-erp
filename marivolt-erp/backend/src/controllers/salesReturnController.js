import mongoose from "mongoose";
import SalesReturn from "../models/SalesReturn.js";
import SalesDispatch from "../models/SalesDispatch.js";
import SalesInvoice from "../models/SalesInvoice.js";
import { nextSalesDocNumber } from "../utils/salesDocNumber.js";
import * as stockService from "../services/stockService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function recalcTotals(doc) {
  let sub = 0;
  for (const line of doc.lines || []) {
    const qty = Number(line.qty) || 0;
    const rate = Number(line.unitPrice) || 0;
    line.lineTotal = qty * rate;
    sub += line.lineTotal;
  }
  doc.subTotal = sub;
  doc.grandTotal = sub;
}

export async function listSalesReturns(req, res) {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [
        { returnNo: new RegExp(q, "i") },
        { customerName: new RegExp(q, "i") },
        { linkedSalesDispatchNo: new RegExp(q, "i") },
      ];
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [items, total] = await Promise.all([
      SalesReturn.find(filter).sort({ returnDate: -1 }).skip(skip).limit(limit).lean(),
      SalesReturn.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSalesReturn(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await SalesReturn.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createSalesReturn(req, res) {
  try {
    const body = { ...req.body };
    body.returnNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "SALES_RETURN",
    });
    body.createdBy = req.user?.email || "";
    body.companyId = req.companyId;
    if (body.warehouse) body.warehouse = String(body.warehouse).trim().toUpperCase() || "MAIN";
    if (body.linkedSalesDispatchId && !mongoose.Types.ObjectId.isValid(String(body.linkedSalesDispatchId))) {
      return res.status(400).json({ message: "Invalid linkedSalesDispatchId" });
    }
    const doc = new SalesReturn(body);
    recalcTotals(doc);
    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateSalesReturn(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await SalesReturn.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (doc.status === "POSTED") return res.status(400).json({ message: "Posted returns cannot be edited" });
    const allowed = [
      "customerName",
      "linkedSalesDispatchId",
      "linkedSalesDispatchNo",
      "linkedSalesInvoiceId",
      "linkedSalesInvoiceNo",
      "warehouse",
      "currency",
      "lines",
      "remarks",
      "returnDate",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    if (doc.warehouse) doc.warehouse = String(doc.warehouse).trim().toUpperCase() || "MAIN";
    doc.updatedBy = req.user?.email || "";
    recalcTotals(doc);
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postSalesReturn(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const sr = await SalesReturn.findOne(withCompany(req, { _id: id }));
    if (!sr) return res.status(404).json({ message: "Not found" });
    if (sr.status === "POSTED") return res.status(400).json({ message: "Already posted" });
    if (sr.status === "CANCELLED") return res.status(400).json({ message: "Cancelled return cannot be posted" });
    if (!sr.lines?.length) return res.status(400).json({ message: "No lines to post" });

    const userEmail = req.user?.email || "";
    const wh = String(sr.warehouse || "MAIN").trim().toUpperCase() || "MAIN";

    await stockService.withTransaction(async (session) => {
      for (const line of sr.lines) {
        const q = Number(line.qty) || 0;
        if (q <= 0) continue;
        await stockService.stockAdjustment({
          session,
          companyId: req.companyId,
          article: line.article,
          warehouse: wh,
          qty: q,
          direction: "Increase",
          referenceType: "SALES_RETURN",
          referenceNo: sr.returnNo,
          remarks: line.reason || sr.remarks || "",
          createdBy: userEmail,
          sourceModule: "SALES",
          lineId: String(line._id || `${line.article}:${q}`),
        });
      }

      sr.status = "POSTED";
      sr.updatedBy = userEmail;
      await sr.save({ session });
    });
    res.json(sr);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteSalesReturn(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await SalesReturn.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.status === "POSTED") return res.status(400).json({ message: "Cannot delete posted return" });
    await SalesReturn.findOneAndDelete(withCompany(req, { _id: id }));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/** Prefill lines from a sales dispatch (for UI). */
export async function getSalesReturnPrefillFromDispatch(req, res) {
  try {
    const { dispatchId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(dispatchId)) {
      return res.status(400).json({ message: "Invalid dispatch id" });
    }
    const d = await SalesDispatch.findOne(withCompany(req, { _id: dispatchId })).lean();
    if (!d) return res.status(404).json({ message: "Dispatch not found" });
    const inv = d.linkedSalesInvoiceId
      ? await SalesInvoice.findOne(withCompany(req, { _id: d.linkedSalesInvoiceId })).select("invoiceNo").lean()
      : null;
    const lines = (d.lines || []).map((line) => ({
      article: line.article,
      partNumber: line.partNumber || "",
      description: line.description || "",
      qty: line.qty,
      uom: line.uom || "PCS",
      unitPrice: Number(line.price) || 0,
      lineTotal: Number(line.totalPrice) || 0,
      reason: "",
    }));
    res.json({
      customerName: d.customerName,
      linkedSalesDispatchId: d._id,
      linkedSalesDispatchNo: d.dispatchNo,
      linkedSalesInvoiceId: d.linkedSalesInvoiceId || null,
      linkedSalesInvoiceNo: inv?.invoiceNo || d.linkedSalesInvoiceNo || "",
      currency: d.currency || "USD",
      lines,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
