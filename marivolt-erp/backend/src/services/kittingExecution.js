import crypto from "crypto";
import * as stockService from "./stockService.js";
import {
  buildKittingEffectKey,
  buildKittingReversalEffectKey,
  DEKIT_REVERSAL_BLOCKED,
  DEKIT_STOCK_SHORTAGE,
  KIT_REVERSAL_BLOCKED,
  KIT_SNAPSHOT_REQUIRED,
  KIT_STOCK_SHORTAGE,
  kittingConflictError,
} from "../utils/kittingIdempotency.js";
import {
  assertDeKitParentQtyInteger,
  assertPackConversionParentQtyInteger,
  BOM_KIND,
  childQtyForParent,
} from "../utils/kittingPackConversion.js";
import StockLedger from "../models/StockLedger.js";

function lineKey(line) {
  return String(line?.lineId || line?.componentItemCode || "");
}

function packConversionUsesStrictGuards(order) {
  return String(order?.bomKind || "").toUpperCase() === BOM_KIND.PACK_CONVERSION;
}

function assertSnapshot(order) {
  const snap = order?.linesSnapshot;
  if (!Array.isArray(snap) || snap.length === 0) {
    throw kittingConflictError(
      KIT_SNAPSHOT_REQUIRED,
      "Order has no frozen BOM snapshot. Re-create the draft order against the current BOM.",
      null,
      400
    );
  }
  return snap;
}

async function postDecrease({
  session,
  companyId,
  article,
  warehouse,
  qty,
  referenceType,
  referenceNo,
  remarks,
  createdBy,
  movementType,
  lineId,
  allowNegative,
  effectKey = "",
  reversedFromLedgerId = null,
  originalEffectKey = "",
  cancellationOperationId = "",
}) {
  try {
    return await stockService.stockAdjustment({
      session,
      companyId,
      article,
      warehouse,
      qty,
      direction: "Decrease",
      referenceType,
      referenceNo,
      remarks,
      createdBy,
      sourceModule: "KITTING",
      allowNegative,
      movementType,
      lineId,
      effectKey,
      reversedFromLedgerId,
      originalEffectKey,
      cancellationOperationId,
    });
  } catch (err) {
    if (String(err?.message || "").includes("insufficient available")) {
      const bal = await stockService.getStockBalance({ companyId, article, warehouse, session });
      const shortageCode =
        movementType.includes("DEKIT") || movementType.includes("REVERSAL")
          ? movementType.startsWith("DEKIT")
            ? DEKIT_STOCK_SHORTAGE
            : KIT_STOCK_SHORTAGE
          : KIT_STOCK_SHORTAGE;
      throw kittingConflictError(shortageCode, `Insufficient available stock for ${article}`, {
        article,
        required: qty,
        available: bal.availableQty,
        warehouse,
      });
    }
    throw err;
  }
}

async function postIncrease({
  session,
  companyId,
  article,
  warehouse,
  qty,
  referenceType,
  referenceNo,
  remarks,
  createdBy,
  movementType,
  lineId,
  effectKey = "",
  reversedFromLedgerId = null,
  originalEffectKey = "",
  cancellationOperationId = "",
}) {
  return stockService.stockAdjustment({
    session,
    companyId,
    article,
    warehouse,
    qty,
    direction: "Increase",
    referenceType,
    referenceNo,
    remarks,
    createdBy,
    sourceModule: "KITTING",
    movementType,
    lineId,
    effectKey,
    reversedFromLedgerId,
    originalEffectKey,
    cancellationOperationId,
  });
}

/**
 * Kit assembly from frozen order snapshot (never live BOM lines).
 */
export async function runKitAssembly(order, createdBy, companyId, session) {
  const snapshot = assertSnapshot(order);
  const strict = packConversionUsesStrictGuards(order);
  const refNum = order.kitNumber;
  const wh = order.warehouse;
  const kitQty = Number(order.quantity);
  const orderLineId = String(order._id || refNum);
  const effectKeys = [];

  if (strict) {
    if (snapshot.length !== 1) {
      throw kittingConflictError(
        "BOM_PACK_CONVERSION_INVALID",
        "PACK_CONVERSION kitting requires exactly one component in the frozen snapshot",
        null,
        400
      );
    }
    assertPackConversionParentQtyInteger(kitQty, order.parentUom);
  }

  let componentCostTotal = 0;
  let idx = 0;
  for (const line of snapshot) {
    const optional = Boolean(line.optionalFlag);
    if (optional && strict) continue;
    const componentArticle = line.componentItemCode;
    const need = (Number(line.qtyPerKit) || 0) * kitQty;
    const lineKeyId = lineKey(line) || `bom:${idx}`;
    idx += 1;
    if (need <= 0) continue;
    const bal = await stockService.getStockBalance({
      companyId,
      article: componentArticle,
      warehouse: wh,
      session,
    });
    const componentUnitCost = Number(bal.raw?.avgCost ?? bal.raw?.unitCost ?? 0) || 0;
    componentCostTotal += componentUnitCost * need;
    const ek = buildKittingEffectKey({
      movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_OUT,
      companyId,
      referenceNo: refNum,
      article: componentArticle,
      warehouse: wh,
      lineId: lineKeyId,
    });
    effectKeys.push(ek);
    await postDecrease({
      session,
      companyId,
      article: componentArticle,
      warehouse: wh,
      qty: need,
      referenceType: "KITTING",
      referenceNo: refNum,
      remarks: `Kit assembly (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode} × ${kitQty}`,
      createdBy,
      movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_OUT,
      lineId: lineKeyId,
      allowNegative: strict ? false : true,
      effectKey: ek,
    });
  }

  const parentEk = buildKittingEffectKey({
    movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_IN,
    companyId,
    referenceNo: refNum,
    article: order.parentItemCode,
    warehouse: wh,
    lineId: `PARENT:${orderLineId}`,
  });
  effectKeys.push(parentEk);
  await postIncrease({
    session,
    companyId,
    article: order.parentItemCode,
    warehouse: wh,
    qty: kitQty,
    referenceType: "KITTING",
    referenceNo: refNum,
    remarks: `Assembled kit (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode}`,
    createdBy,
    movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_IN,
    lineId: `PARENT:${orderLineId}`,
    effectKey: parentEk,
  });

  order.componentCostTotal = componentCostTotal;
  order.assembledCost = kitQty > 0 ? componentCostTotal / kitQty : 0;
  order.ledgerEffectKeys = effectKeys;
}

/**
 * De-kit from frozen order snapshot.
 */
export async function runDeKit(order, createdBy, companyId, session) {
  const snapshot = assertSnapshot(order);
  const strict = packConversionUsesStrictGuards(order);
  const refNum = order.dekitNumber;
  const wh = order.warehouse;
  const kitQty = Number(order.quantity);
  const orderLineId = String(order._id || refNum);
  const effectKeys = [];

  if (strict) {
    if (snapshot.length !== 1) {
      throw kittingConflictError(
        "BOM_PACK_CONVERSION_INVALID",
        "PACK_CONVERSION de-kitting requires exactly one component in the frozen snapshot",
        null,
        400
      );
    }
    assertDeKitParentQtyInteger(kitQty, order.parentUom);
  }

  const parentEk = buildKittingEffectKey({
    movementType: stockService.MOVEMENT_TYPES.DEKIT_OUT,
    companyId,
    referenceNo: refNum,
    article: order.parentItemCode,
    warehouse: wh,
    lineId: `PARENT:${orderLineId}`,
  });
  effectKeys.push(parentEk);
  await postDecrease({
    session,
    companyId,
    article: order.parentItemCode,
    warehouse: wh,
    qty: kitQty,
    referenceType: "DEKITTING",
    referenceNo: refNum,
    remarks: `De-kit (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode} × ${kitQty}${order.disassemblyReason ? ` | ${order.disassemblyReason}` : ""}`,
    createdBy,
    movementType: stockService.MOVEMENT_TYPES.DEKIT_OUT,
    lineId: `PARENT:${orderLineId}`,
    allowNegative: strict ? false : true,
    effectKey: parentEk,
  });

  let componentCostTotal = 0;
  let idx = 0;
  for (const line of snapshot) {
    const componentArticle = line.componentItemCode;
    const qtyIn = (Number(line.qtyPerKit) || 0) * kitQty;
    const lineKeyId = lineKey(line) || `bom:${idx}`;
    idx += 1;
    if (qtyIn <= 0) continue;
    const bal = await stockService.getStockBalance({
      companyId,
      article: componentArticle,
      warehouse: wh,
      session,
    });
    const componentUnitCost = Number(bal.raw?.avgCost ?? bal.raw?.unitCost ?? 0) || 0;
    componentCostTotal += componentUnitCost * qtyIn;
    const ek = buildKittingEffectKey({
      movementType: stockService.MOVEMENT_TYPES.DEKIT_IN,
      companyId,
      referenceNo: refNum,
      article: componentArticle,
      warehouse: wh,
      lineId: lineKeyId,
    });
    effectKeys.push(ek);
    await postIncrease({
      session,
      companyId,
      article: componentArticle,
      warehouse: wh,
      qty: qtyIn,
      referenceType: "DEKITTING",
      referenceNo: refNum,
      remarks: `De-kit component from (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode}`,
      createdBy,
      movementType: stockService.MOVEMENT_TYPES.DEKIT_IN,
      lineId: lineKeyId,
      effectKey: ek,
    });
  }

  order.componentCostTotal = componentCostTotal;
  order.assembledCost = kitQty > 0 ? componentCostTotal / kitQty : 0;
  order.ledgerEffectKeys = effectKeys;
}

async function findOriginalLedger(effectKey, session) {
  if (!effectKey) return null;
  return StockLedger.findOne({ effectKey }).session(session);
}

function requireOriginalLedger(original, effectKey, label) {
  if (!original?._id) {
    throw kittingConflictError(
      KIT_REVERSAL_BLOCKED,
      `Cannot reverse ${label}: original ledger row not found for effectKey ${effectKey}`,
      { effectKey },
      409
    );
  }
  return original;
}

export async function runReverseKitAssembly(order, createdBy, companyId, session, reversalReason = "") {
  const snapshot = assertSnapshot(order);
  const refNum = order.kitNumber;
  const wh = order.warehouse;
  const kitQty = Number(order.quantity);
  const orderLineId = String(order._id || refNum);
  const reversalOpId = crypto.randomUUID();
  const reversalKeys = [];

  const parentOrigKey = buildKittingEffectKey({
    movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_IN,
    companyId,
    referenceNo: refNum,
    article: order.parentItemCode,
    warehouse: wh,
    lineId: `PARENT:${orderLineId}`,
  });
  const parentOrigLedger = requireOriginalLedger(
    await findOriginalLedger(parentOrigKey, session),
    parentOrigKey,
    "kit parent IN"
  );
  const parentRevKey = buildKittingReversalEffectKey(parentOrigKey);
  reversalKeys.push(parentRevKey);
  await postDecrease({
    session,
    companyId,
    article: order.parentItemCode,
    warehouse: wh,
    qty: kitQty,
    referenceType: "KITTING",
    referenceNo: refNum,
    remarks: `Reverse kit assembly ${order.parentItemCode} × ${kitQty}${reversalReason ? ` | ${reversalReason}` : ""}`,
    createdBy,
    movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_REVERSAL_OUT,
    lineId: `PARENT:${orderLineId}`,
    allowNegative: false,
    effectKey: parentRevKey,
    reversedFromLedgerId: parentOrigLedger._id,
    originalEffectKey: parentOrigKey,
    cancellationOperationId: reversalOpId,
  });

  let idx = 0;
  for (const line of snapshot) {
    const componentArticle = line.componentItemCode;
    const qtyBack = (Number(line.qtyPerKit) || 0) * kitQty;
    const lineKeyId = lineKey(line) || `bom:${idx}`;
    idx += 1;
    if (qtyBack <= 0) continue;
    const origKey = buildKittingEffectKey({
      movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_OUT,
      companyId,
      referenceNo: refNum,
      article: componentArticle,
      warehouse: wh,
      lineId: lineKeyId,
    });
    const origLedger = requireOriginalLedger(
      await findOriginalLedger(origKey, session),
      origKey,
      `kit component OUT ${componentArticle}`
    );
    const revKey = buildKittingReversalEffectKey(origKey);
    reversalKeys.push(revKey);
    await postIncrease({
      session,
      companyId,
      article: componentArticle,
      warehouse: wh,
      qty: qtyBack,
      referenceType: "KITTING",
      referenceNo: refNum,
      remarks: `Reverse kit component ${componentArticle} for ${order.parentItemCode}`,
      createdBy,
      movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_REVERSAL_IN,
      lineId: lineKeyId,
      effectKey: revKey,
      reversedFromLedgerId: origLedger._id,
      originalEffectKey: origKey,
      cancellationOperationId: reversalOpId,
    });
  }

  order.reversalOperationId = reversalOpId;
  order.reversalReason = reversalReason;
  order.ledgerEffectKeys = [...(order.ledgerEffectKeys || []), ...reversalKeys];
}

export async function runReverseDeKit(order, createdBy, companyId, session, reversalReason = "") {
  const snapshot = assertSnapshot(order);
  const refNum = order.dekitNumber;
  const wh = order.warehouse;
  const kitQty = Number(order.quantity);
  const orderLineId = String(order._id || refNum);
  const reversalOpId = crypto.randomUUID();
  const reversalKeys = [];

  const totalChildQty = childQtyForParent(kitQty, snapshot);
  if (totalChildQty <= 0) {
    throw kittingConflictError(KIT_REVERSAL_BLOCKED, "Cannot reverse de-kit with zero component quantity", null, 400);
  }

  // Child OUT first (reverse DEKIT_IN)
  let idx = 0;
  for (const line of snapshot) {
    const componentArticle = line.componentItemCode;
    const qtyOut = (Number(line.qtyPerKit) || 0) * kitQty;
    const lineKeyId = lineKey(line) || `bom:${idx}`;
    idx += 1;
    if (qtyOut <= 0) continue;
    const origKey = buildKittingEffectKey({
      movementType: stockService.MOVEMENT_TYPES.DEKIT_IN,
      companyId,
      referenceNo: refNum,
      article: componentArticle,
      warehouse: wh,
      lineId: lineKeyId,
    });
    const origLedger = requireOriginalLedger(
      await findOriginalLedger(origKey, session),
      origKey,
      `de-kit component IN ${componentArticle}`
    );
    const revKey = buildKittingReversalEffectKey(origKey);
    reversalKeys.push(revKey);
    try {
      await postDecrease({
        session,
        companyId,
        article: componentArticle,
        warehouse: wh,
        qty: qtyOut,
        referenceType: "DEKITTING",
        referenceNo: refNum,
        remarks: `Reverse de-kit component ${componentArticle}`,
        createdBy,
        movementType: stockService.MOVEMENT_TYPES.DEKIT_REVERSAL_OUT,
        lineId: lineKeyId,
        allowNegative: false,
        effectKey: revKey,
        reversedFromLedgerId: origLedger._id,
        originalEffectKey: origKey,
        cancellationOperationId: reversalOpId,
      });
    } catch (err) {
      if (err.code === KIT_STOCK_SHORTAGE || err.code === DEKIT_STOCK_SHORTAGE) {
        throw kittingConflictError(
          DEKIT_REVERSAL_BLOCKED,
          `De-kit reversal blocked: insufficient ${componentArticle} stock to reverse full quantity`,
          err.details || { article: componentArticle, required: qtyOut }
        );
      }
      throw err;
    }
  }

  const parentOrigKey = buildKittingEffectKey({
    movementType: stockService.MOVEMENT_TYPES.DEKIT_OUT,
    companyId,
    referenceNo: refNum,
    article: order.parentItemCode,
    warehouse: wh,
    lineId: `PARENT:${orderLineId}`,
  });
  const parentOrigLedger = requireOriginalLedger(
    await findOriginalLedger(parentOrigKey, session),
    parentOrigKey,
    "de-kit parent OUT"
  );
  const parentRevKey = buildKittingReversalEffectKey(parentOrigKey);
  reversalKeys.push(parentRevKey);
  await postIncrease({
    session,
    companyId,
    article: order.parentItemCode,
    warehouse: wh,
    qty: kitQty,
    referenceType: "DEKITTING",
    referenceNo: refNum,
    remarks: `Reverse de-kit parent ${order.parentItemCode}`,
    createdBy,
    movementType: stockService.MOVEMENT_TYPES.DEKIT_REVERSAL_IN,
    lineId: `PARENT:${orderLineId}`,
    effectKey: parentRevKey,
    reversedFromLedgerId: parentOrigLedger._id,
    originalEffectKey: parentOrigKey,
    cancellationOperationId: reversalOpId,
  });

  order.reversalOperationId = reversalOpId;
  order.reversalReason = reversalReason;
  order.ledgerEffectKeys = [...(order.ledgerEffectKeys || []), ...reversalKeys];
}
