import mongoose from "mongoose";
import GRN from "../models/GRN.js";
import ItemMaster from "../models/itemMasterModel.js";
import StockLocation from "../models/StockLocation.js";
import * as stockService from "../services/stockService.js";
import { writeAudit } from "../services/auditService.js";

function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}
function t(v) {
  return String(v ?? "").trim();
}

async function nextGrnNo(companyId) {
  const y = new Date().getFullYear();
  const prefix = `GRN-${y}-`;
  const latest = await GRN.findOne({ companyId, grnNo: new RegExp(`^${prefix}`) }).sort({ createdAt: -1 }).lean();
  const n = latest ? Number(String(latest.grnNo).split("-").pop()) + 1 : 1;
  return `${prefix}${String(n).padStart(5, "0")}`;
}

function normalizeItems(items = []) {
  return (items || []).map((r) => {
    const received = Number(r.receivedQty) || 0;
    const accepted = Number(r.acceptedQty) || 0;
    if (accepted > received) throw new Error("Accepted Qty cannot exceed Received Qty");
    return {
      article: t(r.article).toUpperCase(),
      receivedQty: received,
      acceptedQty: accepted,
      rejectedQty: received - accepted,
      unitCost: Number(r.unitCost) || 0,
      currency: t(r.currency || "USD").toUpperCase() || "USD",
      location: t(r.location).toUpperCase(),
      batchNo: t(r.batchNo),
      serialNo: t(r.serialNo),
      remarks: t(r.remarks),
      poNo: t(r.poNo),
    };
  });
}

export async function createGrn(req, res) {
  try {
    const items = normalizeItems(req.body.items || []);
    const grnNo = t(req.body.grnNo) || (await nextGrnNo(req.companyId));
    const doc = await GRN.create({
      companyId: req.companyId,
      grnNo,
      grnDate: req.body.grnDate || new Date(),
      supplierName: t(req.body.supplierName),
      supplierInvoiceNo: t(req.body.supplierInvoiceNo),
      poNo: t(req.body.poNo),
      remarks: t(req.body.remarks),
      status: req.body.status === "Posted" ? "Posted" : "Draft",
      items,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listGrn(req, res) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const re = new RegExp(t(req.query.search), "i");
      filter.$or = [{ grnNo: re }, { supplierName: re }, { supplierInvoiceNo: re }, { poNo: re }];
    }
    const [items, total] = await Promise.all([
      GRN.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      GRN.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getGrn(req, res) {
  try {
    const row = await GRN.findOne(withCompany(req, { grnNo: t(req.params.grnNo).toUpperCase() })).lean();
    if (!row) return res.status(404).json({ message: "GRN not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateGrn(req, res) {
  try {
    const grnNo = t(req.params.grnNo).toUpperCase();
    const grn = await GRN.findOne(withCompany(req, { grnNo }));
    if (!grn) return res.status(404).json({ message: "GRN not found" });
    if (grn.status !== "Draft") return res.status(400).json({ message: "Only Draft GRN can be edited" });
    grn.grnDate = req.body.grnDate || grn.grnDate;
    grn.supplierName = t(req.body.supplierName);
    grn.supplierInvoiceNo = t(req.body.supplierInvoiceNo);
    grn.poNo = t(req.body.poNo);
    grn.remarks = t(req.body.remarks);
    grn.items = normalizeItems(req.body.items || []);
    await grn.save();
    res.json(grn);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function postGrn(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const grnNo = t(req.params.grnNo).toUpperCase();
      const grn = await GRN.findOne(withCompany(req, { grnNo })).session(session);
      if (!grn) throw new Error("GRN not found");
      if (grn.status !== "Draft") throw new Error("Only Draft GRN can be posted");

      for (const line of grn.items) {
        const article = t(line.article).toUpperCase();
        const item = await ItemMaster.findOne(withCompany(req, { article })).select("_id").session(session);
        if (!item) throw new Error(`Article not found: ${article}`);
        const loc = await StockLocation.findOne(withCompany(req, { locationCode: t(line.location).toUpperCase(), status: "Active" })).session(session);
        if (!loc) throw new Error(`Invalid location: ${line.location}`);
        if (Number(line.acceptedQty) > 0) {
          await stockService.grnReceive({
            session,
            companyId: req.companyId,
            article,
            warehouse: line.location,
            qty: Number(line.acceptedQty),
            referenceType: "GRN",
            referenceNo: grn.grnNo,
            supplierName: grn.supplierName || "",
            unitCost: Number(line.unitCost) || 0,
            currency: line.currency || "USD",
            batchNo: line.batchNo || "",
            serialNo: line.serialNo || "",
            remarks: line.remarks || "",
            createdBy: req.user?.email || "",
            sourceModule: "STORE",
            transactionDate: grn.grnDate,
          });
        }
      }
      grn.status = "Posted";
      grn.postedAt = new Date();
      await grn.save({ session });
      await writeAudit(req, {
        action: "POST",
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "Draft",
        toStatus: "Posted",
        description: `GRN ${grn.grnNo} posted (${grn.items?.length || 0} lines)`,
        metadata: { supplierName: grn.supplierName || "" },
      });
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}

export async function cancelGrn(req, res) {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const grnNo = t(req.params.grnNo).toUpperCase();
      const grn = await GRN.findOne(withCompany(req, { grnNo })).session(session);
      if (!grn) throw new Error("GRN not found");
      if (grn.status !== "Posted") throw new Error("Only Posted GRN can be cancelled");

      for (const line of grn.items) {
        if (!(Number(line.acceptedQty) > 0)) continue;
        await stockService.cancelGrn({
          session,
          companyId: req.companyId,
          article: t(line.article).toUpperCase(),
          warehouse: t(line.location).toUpperCase(),
          qty: Number(line.acceptedQty),
          referenceNo: grn.grnNo,
          supplierName: grn.supplierName || "",
          unitCost: Number(line.unitCost) || 0,
          currency: line.currency || "USD",
          batchNo: line.batchNo || "",
          serialNo: line.serialNo || "",
          remarks: `GRN cancelled: ${grn.grnNo}`,
          createdBy: req.user?.email || "",
          sourceModule: "STORE",
        });
      }
      grn.status = "Cancelled";
      grn.cancelledAt = new Date();
      await grn.save({ session });
      await writeAudit(req, {
        action: "CANCEL",
        module: "STORE",
        entityType: "GRN",
        entityId: grn._id,
        documentNo: grn.grnNo,
        fromStatus: "Posted",
        toStatus: "Cancelled",
        description: `GRN ${grn.grnNo} cancelled — stock reversed`,
        metadata: { supplierName: grn.supplierName || "" },
      });
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}
