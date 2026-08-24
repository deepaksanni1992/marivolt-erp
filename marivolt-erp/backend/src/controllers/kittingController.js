import crypto from "crypto";
import mongoose from "mongoose";
import BOM from "../models/BOM.js";
import KittingOrder from "../models/KittingOrder.js";
import StockBalance from "../models/StockBalance.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { runKitAssembly, runReverseKitAssembly } from "../services/kittingExecution.js";
import { deriveStockBuckets } from "../services/stockExpectedBuckets.js";
import {
  assertPackConversionParentQtyInteger,
  assertWorkflowAllowsKitting,
  buildConversionPreview,
  buildLinesSnapshotFromBom,
  deriveAvailabilityFromBalance,
  maxKittableSets,
  resolveBomKind,
} from "../utils/kittingPackConversion.js";
import {
  KIT_ALREADY_POSTED,
  KIT_ALREADY_REVERSED,
  KIT_POSTING_CONFLICT,
  KIT_POST_IN_PROGRESS,
  KIT_REVERSAL_IN_PROGRESS,
  kittingConflictError,
} from "../utils/kittingIdempotency.js";

function pagination(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function respondConflict(res, err) {
  return res.status(err.statusCode || 409).json({
    message: err.message,
    code: err.code || KIT_POSTING_CONFLICT,
    details: err.details || null,
    article: err.article || err.details?.article || null,
    required: err.details?.required ?? null,
    available: err.details?.available ?? null,
  });
}

async function loadActiveBom(companyId, parentItemCode) {
  const bom = await BOM.findOne({ companyId, parentItemCode, isActive: true }).lean();
  if (!bom) throw new Error("No active BOM for this parent item");
  return bom;
}

function freezeOrderFromBom(bom, quantity, warehouse, direction = "KIT") {
  assertWorkflowAllowsKitting(bom.workflowMode);
  const linesSnapshot = buildLinesSnapshotFromBom(bom);
  const preview = buildConversionPreview({
    direction,
    parentItemCode: bom.parentItemCode,
    parentUom: bom.parentUom,
    parentQty: quantity,
    linesSnapshot,
  });
  return { linesSnapshot, preview };
}

async function buildShortageAnalysis({ companyId, parentItemCode, warehouse, quantity, bom }) {
  const activeBom = bom || (await loadActiveBom(companyId, parentItemCode));
  const wh = String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
  const kitQty = Number(quantity) || 0;
  const lines = [];
  for (const ln of activeBom.lines || []) {
    const article = String(ln.article || ln.componentItemCode || "").trim().toUpperCase();
    if (!article) continue;
    const requiredQty = (Number(ln.qty) || 0) * kitQty;
    const bal = await StockBalance.findOne({ companyId, article, warehouse: wh }).lean();
    const { availableQty } = deriveStockBuckets(bal || {});
    const missingQty = Math.max(0, requiredQty - availableQty);
    const alternatives = [];
    const candidates = Array.isArray(ln.alternativeArticles) ? ln.alternativeArticles : [];
    for (const altArticle of candidates) {
      const alt = await StockBalance.findOne({ companyId, article: altArticle, warehouse: wh }).lean();
      const altAvailable = deriveStockBuckets(alt || {}).availableQty;
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
  const ratio = activeBom.lines?.[0]?.qty;
  const childArticle = activeBom.lines?.[0]?.componentItemCode || activeBom.lines?.[0]?.article;
  let maxKittable = null;
  if (resolveBomKind(activeBom.kitType) === "PACK_CONVERSION" && childArticle) {
    const childBal = await StockBalance.findOne({
      companyId,
      article: String(childArticle).toUpperCase(),
      warehouse: wh,
    }).lean();
    maxKittable = maxKittableSets(deriveAvailabilityFromBalance(childBal), ratio);
  }
  return {
    parentItemCode,
    parentUom: activeBom.parentUom || "",
    warehouse: wh,
    quantity: kitQty,
    bomId: activeBom._id,
    bomCode: activeBom.bomCode || "",
    bomRevision: activeBom.revisionNo || "",
    bomKind: resolveBomKind(activeBom.kitType),
    maxKittable,
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

    const bom = await loadActiveBom(req.companyId, parentItemCode);
    assertWorkflowAllowsKitting(bom.workflowMode);

    const quantity = Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ message: "quantity must be a positive number" });
    }

    const bomKind = resolveBomKind(bom.kitType);
    if (bomKind === "PACK_CONVERSION") {
      assertPackConversionParentQtyInteger(quantity, bom.parentUom);
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
    const kitBatch =
      bomKind === "PACK_CONVERSION"
        ? String(req.body.kitBatch || "").trim().toUpperCase()
        : String(req.body.kitBatch || `${kitNumber}-B1`).trim().toUpperCase();

    const { linesSnapshot, preview } = freezeOrderFromBom(bom, quantity, warehouse, "KIT");
    const analysis = await buildShortageAnalysis({
      companyId: req.companyId,
      parentItemCode,
      warehouse,
      quantity,
      bom,
    });

    const doc = await KittingOrder.create({
      companyId: req.companyId,
      kitNumber,
      parentItemCode,
      parentUom: bom.parentUom || "",
      parentItemName: bom.parentItemName || "",
      kitType,
      bomKind,
      assemblyMode,
      linkedEngineModel: String(req.body.linkedEngineModel || "").trim(),
      linkedEngineESN: String(req.body.linkedEngineESN || "").trim(),
      sourceReference: String(req.body.sourceReference || "").trim(),
      kitBatch,
      linkedBomRevision: bom.revisionNo || "",
      bomSnapshotAt: new Date(),
      workflowMode: bom.workflowMode || "BOTH",
      warehouse,
      quantity,
      bomId: bom._id,
      status: "DRAFT",
      remarks: req.body.remarks || "",
      createdBy: req.user?.email || "",
      shortageSnapshot: analysis.lines,
      linesSnapshot,
      previewConsume: preview.consume,
      previewProduce: preview.produce,
      maxKittable: analysis.maxKittable,
    });
    res.status(201).json(doc);
  } catch (err) {
    if (err.code) return respondConflict(res, err);
    res.status(400).json({ message: err.message, code: err.code || null });
  }
}

export async function executeKittingOrder(req, res) {
  const session = await mongoose.startSession();
  try {
    let idempotent = false;
    let completedDoc = null;
    await session.withTransaction(async () => {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw kittingConflictError(KIT_POSTING_CONFLICT, "Invalid id", null, 400);
      }
      const postingOperationId = crypto.randomUUID();
      const claimed = await KittingOrder.findOneAndUpdate(
        withCompany(req, { _id: id, status: "DRAFT" }),
        { $set: { status: "POSTING", postingOperationId } },
        { new: true, session }
      );
      if (!claimed) {
        const existing = await KittingOrder.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) {
          throw kittingConflictError(KIT_POSTING_CONFLICT, "Not found", null, 404);
        }
        const st = String(existing.status || "").toUpperCase();
        if (st === "POSTING") {
          throw kittingConflictError(KIT_POST_IN_PROGRESS, "Kitting execution already in progress");
        }
        if (st === "COMPLETED" && existing.reversalStatus !== "REVERSED") {
          idempotent = true;
          completedDoc = existing;
          return;
        }
        throw kittingConflictError(KIT_POSTING_CONFLICT, `Only DRAFT orders can be executed (status ${st})`);
      }

      const userEmail = req.user?.email || "";
      await runKitAssembly(claimed, userEmail, req.companyId, session);
      claimed.status = "COMPLETED";
      claimed.assemblyDate = new Date();
      claimed.assembledBy = userEmail;
      claimed.postedAt = new Date();
      claimed.postedBy = userEmail;
      await claimed.save({ session });
      completedDoc = claimed;
    });

    if (idempotent) {
      return res.status(200).json({
        success: true,
        code: KIT_ALREADY_POSTED,
        alreadyPosted: true,
        order: completedDoc,
      });
    }
    res.json(completedDoc);
  } catch (err) {
    if (err.code) return respondConflict(res, err);
    res.status(400).json({ message: err.message, code: err.code || null });
  } finally {
    session.endSession();
  }
}

export async function reverseKittingOrder(req, res) {
  const session = await mongoose.startSession();
  try {
    const reason = String(req.body?.reason || req.body?.reversalReason || "").trim();
    if (!reason) return res.status(400).json({ message: "Reversal reason is mandatory" });
    let idempotent = false;
    let docOut = null;
    await session.withTransaction(async () => {
      const { id } = req.params;
      const claimed = await KittingOrder.findOneAndUpdate(
        withCompany(req, { _id: id, status: "COMPLETED", reversalStatus: "NONE" }),
        { $set: { reversalStatus: "REVERSING", reversalReason: reason } },
        { new: true, session }
      );
      if (!claimed) {
        const existing = await KittingOrder.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) {
          throw kittingConflictError(KIT_POSTING_CONFLICT, "Not found", null, 404);
        }
        if (existing.reversalStatus === "REVERSING") {
          throw kittingConflictError(KIT_REVERSAL_IN_PROGRESS, "Reversal already in progress");
        }
        if (existing.reversalStatus === "REVERSED" || existing.status === "REVERSED") {
          idempotent = true;
          docOut = existing;
          return;
        }
        throw kittingConflictError(KIT_POSTING_CONFLICT, "Only COMPLETED kitting orders can be reversed");
      }

      await runReverseKitAssembly(claimed, req.user?.email || "", req.companyId, session, reason);
      claimed.reversalStatus = "REVERSED";
      claimed.reversedAt = new Date();
      claimed.reversedBy = req.user?.email || "";
      await claimed.save({ session });
      docOut = claimed;
    });

    if (idempotent) {
      return res.status(200).json({ success: true, code: KIT_ALREADY_REVERSED, alreadyReversed: true, order: docOut });
    }
    res.json(docOut);
  } catch (err) {
    if (err.code) return respondConflict(res, err);
    res.status(400).json({ message: err.message, code: err.code || null });
  } finally {
    session.endSession();
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
      withCompany(req, { status: { $in: ["COMPLETED", "CANCELLED", "REVERSED"] } })
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
          parentUom: row.parentUom || "",
          kitBatch: row.kitBatch || "",
          linkedBomRevision: row.linkedBomRevision || "",
          article: ln.componentItemCode,
          componentUom: ln.componentUom || "",
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
