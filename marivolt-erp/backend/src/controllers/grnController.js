import mongoose from "mongoose";
import GRN from "../models/GRN.js";
import ItemMaster from "../models/itemMasterModel.js";
import StockBalance from "../models/StockBalance.js";
import StockLocation from "../models/StockLocation.js";
import { postLedgerMovement } from "../services/stockLedgerService.js";

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
          await postLedgerMovement({
            session,
            companyId: req.companyId,
            transactionDate: grn.grnDate,
            transactionType: "GRN",
            referenceType: "GRN",
            referenceNo: grn.grnNo,
            article,
            location: line.location,
            batchNo: line.batchNo,
            serialNo: line.serialNo,
            qtyIn: Number(line.acceptedQty),
            qtyOut: 0,
            unitCost: Number(line.unitCost) || 0,
            currency: line.currency || "USD",
            remarks: line.remarks || "",
            createdBy: req.user?.email || "",
          });
        }
      }
      grn.status = "Posted";
      grn.postedAt = new Date();
      await grn.save({ session });
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
        const bal = await StockBalance.findOne(
          withCompany(req, {
            article: t(line.article).toUpperCase(),
            location: t(line.location).toUpperCase(),
            batchNo: t(line.batchNo),
            serialNo: t(line.serialNo),
          })
        ).session(session);
        const reqQty = Number(line.acceptedQty);
        if (!bal || Number(bal.onHandQty || 0) < reqQty || Number(bal.availableQty || 0) < reqQty) {
          throw new Error(`Cannot cancel GRN. Stock already allocated/sold for article ${line.article}`);
        }
      }

      for (const line of grn.items) {
        if (!(Number(line.acceptedQty) > 0)) continue;
        await postLedgerMovement({
          session,
          companyId: req.companyId,
          transactionDate: new Date(),
          transactionType: "STOCK_ADJUSTMENT",
          referenceType: "GRN_CANCEL",
          referenceNo: grn.grnNo,
          article: line.article,
          location: line.location,
          batchNo: line.batchNo,
          serialNo: line.serialNo,
          qtyIn: 0,
          qtyOut: Number(line.acceptedQty),
          unitCost: Number(line.unitCost) || 0,
          currency: line.currency || "USD",
          remarks: `GRN cancelled: ${grn.grnNo}`,
          createdBy: req.user?.email || "",
        });
      }
      grn.status = "Cancelled";
      grn.cancelledAt = new Date();
      await grn.save({ session });
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  } finally {
    await session.endSession();
  }
}
