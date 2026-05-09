import mongoose from "mongoose";
import BOM from "../models/BOM.js";
import KittingOrder from "../models/KittingOrder.js";
import StockBalance from "../models/StockBalance.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { runKitAssembly } from "../services/kittingExecution.js";

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

async function buildShortageAnalysis({ companyId, parentItemCode, warehouse, quantity }) {
  const bom = await BOM.findOne({ companyId, parentItemCode, isActive: true }).lean();
  if (!bom) throw new Error("No active BOM for this parent item");
  const wh = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
  const kitQty = Number(quantity) || 0;
  const lines = [];
  for (const ln of bom.lines || []) {
    const article = String(ln.article || ln.componentItemCode || "").trim().toUpperCase();
    if (!article) continue;
    const requiredQty = (Number(ln.qty) || 0) * kitQty;
    const bal = await StockBalance.findOne({ companyId, article, warehouse: wh }).lean();
    const availableQty = Number(bal?.availableQty ?? bal?.quantity ?? 0) || 0;
    const missingQty = Math.max(0, requiredQty - availableQty);
    const alternatives = [];
    const candidates = Array.isArray(ln.alternativeArticles) ? ln.alternativeArticles : [];
    for (const altArticle of candidates) {
      const alt = await StockBalance.findOne({ companyId, article: altArticle, warehouse: wh }).lean();
      const altAvailable = Number(alt?.availableQty ?? alt?.quantity ?? 0) || 0;
      if (altAvailable > 0) alternatives.push({ article: altArticle, availableQty: altAvailable });
    }
    lines.push({
      article,
      qtyPerKit: Number(ln.qty) || 0,
      requiredQty,
      availableQty,
      missingQty,
      optionalFlag: Boolean(ln.optionalFlag),
      interchangeableGroup: ln.interchangeableGroup || "",
      substituteAvailability: alternatives,
      remarks: ln.remarks || "",
      short: missingQty > 0 && !ln.optionalFlag && alternatives.length === 0,
    });
  }
  return {
    parentItemCode,
    warehouse: wh,
    quantity: kitQty,
    bomId: bom._id,
    bomCode: bom.bomCode || "",
    bomRevision: bom.revisionNo || "",
    lines,
    hasBlockingShortage: lines.some((x) => x.short),
  };
}

export async function listKittingOrders(req, res) {
  try {
    const { page, limit, skip } = pagination(req);
    const filter = withCompany(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.parentItemCode) {
      filter.parentItemCode = String(req.query.parentItemCode).trim().toUpperCase();
    }
    if (req.query.kitType) {
      filter.kitType = String(req.query.kitType).trim().toUpperCase();
    }
    const [items, total] = await Promise.all([
      KittingOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      KittingOrder.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await KittingOrder.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createKittingOrder(req, res) {
  try {
    const parentItemCode = String(req.body.parentItemCode || "").trim().toUpperCase();
    if (!parentItemCode) return res.status(400).json({ message: "parentItemCode required" });

    const bom = await BOM.findOne(withCompany(req, { parentItemCode, isActive: true }));
    if (!bom) {
      return res.status(400).json({ message: "No active BOM for this parent item" });
    }

    const quantity = Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ message: "quantity must be a positive number" });
    }

    const kitNumber = await nextSequentialNumber(
      KittingOrder,
      "kitNumber",
      `${req.companyCode || "CMP"}-KIT`,
      { companyId: req.companyId }
    );
    const warehouse = String(req.body.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const kitType = String(req.body.kitType || bom.kitType || "CUSTOM_KIT").trim().toUpperCase();
    const assemblyMode = String(req.body.assemblyMode || "STANDARD_ASSEMBLY").trim().toUpperCase();
    const kitBatch = String(req.body.kitBatch || `${kitNumber}-B1`).trim().toUpperCase();
    const analysis = await buildShortageAnalysis({
      companyId: req.companyId,
      parentItemCode,
      warehouse,
      quantity,
    });

    const doc = await KittingOrder.create({
      companyId: req.companyId,
      kitNumber,
      parentItemCode,
      kitType,
      assemblyMode,
      linkedEngineModel: String(req.body.linkedEngineModel || "").trim(),
      linkedEngineESN: String(req.body.linkedEngineESN || "").trim(),
      sourceReference: String(req.body.sourceReference || "").trim(),
      kitBatch,
      linkedBomRevision: bom.revisionNo || "",
      warehouse,
      quantity,
      bomId: bom._id,
      status: "DRAFT",
      remarks: req.body.remarks || "",
      createdBy: req.user?.email || "",
      shortageSnapshot: analysis.lines,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function executeKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const order = await KittingOrder.findOne(withCompany(req, { _id: id }));
    if (!order) return res.status(404).json({ message: "Not found" });
    if (order.status !== "DRAFT") {
      return res.status(400).json({ message: "Only DRAFT orders can be executed" });
    }

    const userEmail = req.user?.email || "";
    await runKitAssembly(order, userEmail, req.companyId);
    order.status = "COMPLETED";
    order.assemblyDate = new Date();
    order.assembledBy = userEmail;
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getKittingShortage(req, res) {
  try {
    const parentItemCode = String(req.query.parentItemCode || "").trim().toUpperCase();
    const warehouse = String(req.query.warehouse || "MAIN").trim().toUpperCase();
    const quantity = Number(req.query.quantity || 0);
    if (!parentItemCode) return res.status(400).json({ message: "parentItemCode required" });
    if (!(quantity > 0)) return res.status(400).json({ message: "quantity must be > 0" });
    const data = await buildShortageAnalysis({
      companyId: req.companyId,
      parentItemCode,
      warehouse,
      quantity,
    });
    res.json(data);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function kittingAssemblyHistoryReport(req, res) {
  try {
    const rows = await KittingOrder.find(
      withCompany(req, { status: { $in: ["COMPLETED", "CANCELLED"] } })
    )
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function componentConsumptionReport(req, res) {
  try {
    const rows = await KittingOrder.find(withCompany(req, { status: "COMPLETED" }))
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean();
    const items = [];
    for (const row of rows) {
      for (const ln of row.linesSnapshot || []) {
        items.push({
          kitNumber: row.kitNumber,
          parentItemCode: row.parentItemCode,
          kitBatch: row.kitBatch || "",
          linkedBomRevision: row.linkedBomRevision || "",
          article: ln.componentItemCode,
          qtyPerKit: Number(ln.qtyPerKit) || 0,
          consumedQty: (Number(ln.qtyPerKit) || 0) * (Number(row.quantity) || 0),
          warehouse: row.warehouse,
          assemblyDate: row.assemblyDate || row.updatedAt || row.createdAt,
          assembledBy: row.assembledBy || row.createdBy || "",
        });
      }
    }
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function cancelKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const order = await KittingOrder.findOne(withCompany(req, { _id: id }));
    if (!order) return res.status(404).json({ message: "Not found" });
    if (order.status !== "DRAFT") {
      return res.status(400).json({ message: "Only DRAFT orders can be cancelled" });
    }
    order.status = "CANCELLED";
    await order.save();
    res.json(order);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
