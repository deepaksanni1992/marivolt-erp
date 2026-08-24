import crypto from "crypto";
import mongoose from "mongoose";
import BOM from "../models/BOM.js";
import DeKittingOrder from "../models/DeKittingOrder.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { runDeKit, runReverseDeKit } from "../services/kittingExecution.js";
import {
  assertDeKitParentQtyInteger,
  assertWorkflowAllowsDeKitting,
  buildConversionPreview,
  buildLinesSnapshotFromBom,
  resolveBomKind,
} from "../utils/kittingPackConversion.js";
import {
  DEKIT_ALREADY_POSTED,
  DEKIT_ALREADY_REVERSED,
  DEKIT_POSTING_CONFLICT,
  DEKIT_POST_IN_PROGRESS,
  DEKIT_REVERSAL_IN_PROGRESS,
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
    code: err.code || DEKIT_POSTING_CONFLICT,
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

export async function listDeKittingOrders(req, res) {
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
      DeKittingOrder.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      DeKittingOrder.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getDeKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await DeKittingOrder.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createDeKittingOrder(req, res) {
  try {
    const parentItemCode = String(req.body.parentItemCode || "").trim().toUpperCase();
    if (!parentItemCode) return res.status(400).json({ message: "parentItemCode required" });

    const bom = await loadActiveBom(req.companyId, parentItemCode);
    assertWorkflowAllowsDeKitting(bom.workflowMode);

    const quantity = Number(req.body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ message: "quantity must be a positive number" });
    }

    const bomKind = resolveBomKind(bom.kitType);
    if (bomKind === "PACK_CONVERSION") {
      assertDeKitParentQtyInteger(quantity, bom.parentUom);
    }

    const dekitNumber = await nextSequentialNumber(
      DeKittingOrder,
      "dekitNumber",
      `${req.companyCode || "CMP"}-DK`,
      { companyId: req.companyId }
    );
    const warehouse = String(req.body.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const kitType = String(req.body.kitType || bom.kitType || "CUSTOM_KIT").trim().toUpperCase();
    const disassemblyMode = String(req.body.disassemblyMode || "STANDARD_DISASSEMBLY").trim().toUpperCase();
    const kitBatch =
      bomKind === "PACK_CONVERSION"
        ? String(req.body.kitBatch || "").trim().toUpperCase()
        : String(req.body.kitBatch || `${dekitNumber}-B1`).trim().toUpperCase();

    const linesSnapshot = buildLinesSnapshotFromBom(bom);
    const preview = buildConversionPreview({
      direction: "DEKIT",
      parentItemCode: bom.parentItemCode,
      parentUom: bom.parentUom,
      parentQty: quantity,
      linesSnapshot,
    });

    const doc = await DeKittingOrder.create({
      companyId: req.companyId,
      dekitNumber,
      parentItemCode,
      parentUom: bom.parentUom || "",
      parentItemName: bom.parentItemName || "",
      kitType,
      bomKind,
      disassemblyMode,
      disassemblyReason: String(req.body.disassemblyReason || "").trim(),
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
      linesSnapshot,
      previewConsume: preview.consume,
      previewProduce: preview.produce,
    });
    res.status(201).json(doc);
  } catch (err) {
    if (err.code) return respondConflict(res, err);
    res.status(400).json({ message: err.message, code: err.code || null });
  }
}

export async function executeDeKittingOrder(req, res) {
  const session = await mongoose.startSession();
  try {
    let idempotent = false;
    let completedDoc = null;
    await session.withTransaction(async () => {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw kittingConflictError(DEKIT_POSTING_CONFLICT, "Invalid id", null, 400);
      }
      const postingOperationId = crypto.randomUUID();
      const claimed = await DeKittingOrder.findOneAndUpdate(
        withCompany(req, { _id: id, status: "DRAFT" }),
        { $set: { status: "POSTING", postingOperationId } },
        { new: true, session }
      );
      if (!claimed) {
        const existing = await DeKittingOrder.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) {
          throw kittingConflictError(DEKIT_POSTING_CONFLICT, "Not found", null, 404);
        }
        const st = String(existing.status || "").toUpperCase();
        if (st === "POSTING") {
          throw kittingConflictError(DEKIT_POST_IN_PROGRESS, "De-kitting execution already in progress");
        }
        if (st === "COMPLETED" && existing.reversalStatus !== "REVERSED") {
          idempotent = true;
          completedDoc = existing;
          return;
        }
        throw kittingConflictError(DEKIT_POSTING_CONFLICT, `Only DRAFT orders can be executed (status ${st})`);
      }

      const userEmail = req.user?.email || "";
      await runDeKit(claimed, userEmail, req.companyId, session);
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
        code: DEKIT_ALREADY_POSTED,
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

export async function reverseDeKittingOrder(req, res) {
  const session = await mongoose.startSession();
  try {
    const reason = String(req.body?.reason || req.body?.reversalReason || "").trim();
    if (!reason) return res.status(400).json({ message: "Reversal reason is mandatory" });
    let idempotent = false;
    let docOut = null;
    await session.withTransaction(async () => {
      const { id } = req.params;
      const claimed = await DeKittingOrder.findOneAndUpdate(
        withCompany(req, { _id: id, status: "COMPLETED", reversalStatus: "NONE" }),
        { $set: { reversalStatus: "REVERSING", reversalReason: reason } },
        { new: true, session }
      );
      if (!claimed) {
        const existing = await DeKittingOrder.findOne(withCompany(req, { _id: id })).session(session);
        if (!existing) {
          throw kittingConflictError(DEKIT_POSTING_CONFLICT, "Not found", null, 404);
        }
        if (existing.reversalStatus === "REVERSING") {
          throw kittingConflictError(DEKIT_REVERSAL_IN_PROGRESS, "Reversal already in progress");
        }
        if (existing.reversalStatus === "REVERSED" || existing.status === "REVERSED") {
          idempotent = true;
          docOut = existing;
          return;
        }
        throw kittingConflictError(DEKIT_POSTING_CONFLICT, "Only COMPLETED de-kitting orders can be reversed");
      }

      await runReverseDeKit(claimed, req.user?.email || "", req.companyId, session, reason);
      claimed.reversalStatus = "REVERSED";
      claimed.reversedAt = new Date();
      claimed.reversedBy = req.user?.email || "";
      await claimed.save({ session });
      docOut = claimed;
    });

    if (idempotent) {
      return res.status(200).json({
        success: true,
        code: DEKIT_ALREADY_REVERSED,
        alreadyReversed: true,
        order: docOut,
      });
    }
    res.json(docOut);
  } catch (err) {
    if (err.code) return respondConflict(res, err);
    res.status(400).json({ message: err.message, code: err.code || null });
  } finally {
    session.endSession();
  }
}

export async function dekittingReport(req, res) {
  try {
    const rows = await DeKittingOrder.find(
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

export async function cancelDeKittingOrder(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const order = await DeKittingOrder.findOne(withCompany(req, { _id: id }));
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
