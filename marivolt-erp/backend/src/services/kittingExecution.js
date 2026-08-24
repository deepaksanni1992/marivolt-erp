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
  PACK_CONVERSION_CUSTOMS_SHORTAGE,
  kittingConflictError,
} from "../utils/kittingIdempotency.js";
import {
  assertDeKitParentQtyInteger,
  assertPackConversionParentQtyInteger,
  BOM_KIND,
  childQtyForParent,
} from "../utils/kittingPackConversion.js";
import {
  computeConservedTargetUnitCost,
  resolveBalanceUnitCost,
  roundMoney,
} from "../utils/packConversionCost.js";
import {
  retargetCustomsLotsForPackDeKit,
  retargetCustomsLotsForPackKit,
  reverseCustomsLotsForPackConversion,
  selectPackConversionCustomsLayers,
} from "./packConversionCustomsService.js";
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
  unitCost = null,
  currency = "",
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
      unitCost,
      currency,
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
  unitCost = null,
  currency = "",
  updateAvgCostOnIncrease = false,
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
    unitCost,
    currency,
    updateAvgCostOnIncrease,
  });
}

function mapCustomsShortage(err) {
  if (err?.code === "ARTICLE_CONVERSION_CUSTOMS_SHORTAGE") {
    return kittingConflictError(
      PACK_CONVERSION_CUSTOMS_SHORTAGE,
      err.message || "Insufficient customs stock for pack conversion",
      err.details || { remaining: err.remaining }
    );
  }
  return err;
}

async function transferPackDeKitCustoms(order, companyId, session, createdBy) {
  const snapshot = order.linesSnapshot;
  const line = snapshot[0];
  const qtyPerParent = Number(line.qtyPerKit) || 0;
  let layers = [];
  try {
    layers = await selectPackConversionCustomsLayers({
      companyId,
      sourceArticle: order.parentItemCode,
      sourceQty: Number(order.quantity),
      session,
    });
  } catch (err) {
    throw mapCustomsShortage(err);
  }
  if (!layers.length) return [];
  return retargetCustomsLotsForPackDeKit({
    session,
    companyId,
    parentArticle: order.parentItemCode,
    childArticle: line.componentItemCode,
    childDescription: line.componentItemName || line.description || "",
    qtyPerParent,
    conversionNo: order.dekitNumber,
    conversionDocumentId: order._id,
    layers,
    createdBy,
  });
}

async function transferPackKitCustoms(order, companyId, session, createdBy) {
  const snapshot = order.linesSnapshot;
  const line = snapshot[0];
  const qtyPerParent = Number(line.qtyPerKit) || 0;
  const childNeed = qtyPerParent * Number(order.quantity);
  let layers = [];
  try {
    layers = await selectPackConversionCustomsLayers({
      companyId,
      sourceArticle: line.componentItemCode,
      sourceQty: childNeed,
      session,
    });
  } catch (err) {
    throw mapCustomsShortage(err);
  }
  if (!layers.length) return [];
  return retargetCustomsLotsForPackKit({
    session,
    companyId,
    parentArticle: order.parentItemCode,
    childArticle: line.componentItemCode,
    parentDescription: order.parentItemName || "",
    qtyPerParent,
    conversionNo: order.kitNumber,
    conversionDocumentId: order._id,
    layers,
    createdBy,
  });
}

function setPackCostSnapshot(order, {
  sourceUnitCost,
  sourceTotalCost,
  producedUnitCost,
  producedTotalCost,
  currency,
}) {
  order.costSnapshot = {
    sourceUnitCost: roundMoney(sourceUnitCost),
    sourceTotalCost: roundMoney(sourceTotalCost),
    producedUnitCost: roundMoney(producedUnitCost),
    producedTotalCost: roundMoney(producedTotalCost),
    currency: String(currency || "USD").trim().toUpperCase(),
    capturedAt: new Date(),
  };
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

  const line = snapshot[0];
  const componentArticle = line.componentItemCode;
  const need = (Number(line.qtyPerKit) || 0) * kitQty;
  const lineKeyId = lineKey(line) || "bom:0";

  let componentUnitCost = 0;
  let parentIncomingUnitCost = 0;
  let currency = "USD";

  if (strict) {
    order.customsLotLayers = await transferPackKitCustoms(order, companyId, session, createdBy);
    const childBal = await stockService.getStockBalance({
      companyId,
      article: componentArticle,
      warehouse: wh,
      session,
    });
    componentUnitCost = resolveBalanceUnitCost(childBal);
    currency = childBal.raw?.currency || "USD";
    const childTotalCost = componentUnitCost * need;
    parentIncomingUnitCost = computeConservedTargetUnitCost(need, componentUnitCost, kitQty);
    setPackCostSnapshot(order, {
      sourceUnitCost: componentUnitCost,
      sourceTotalCost: childTotalCost,
      producedUnitCost: parentIncomingUnitCost,
      producedTotalCost: childTotalCost,
      currency,
    });
  }

  let componentCostTotal = 0;
  let idx = 0;
  for (const snapLine of snapshot) {
    const optional = Boolean(snapLine.optionalFlag);
    if (optional && strict) continue;
    const compArticle = snapLine.componentItemCode;
    const compNeed = (Number(snapLine.qtyPerKit) || 0) * kitQty;
    const compLineKeyId = lineKey(snapLine) || `bom:${idx}`;
    idx += 1;
    if (compNeed <= 0) continue;
    const bal = await stockService.getStockBalance({
      companyId,
      article: compArticle,
      warehouse: wh,
      session,
    });
    const compUnitCost = strict
      ? componentUnitCost
      : resolveBalanceUnitCost(bal);
    componentCostTotal += compUnitCost * compNeed;
    const ek = buildKittingEffectKey({
      movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_OUT,
      companyId,
      referenceNo: refNum,
      article: compArticle,
      warehouse: wh,
      lineId: compLineKeyId,
    });
    effectKeys.push(ek);
    await postDecrease({
      session,
      companyId,
      article: compArticle,
      warehouse: wh,
      qty: compNeed,
      referenceType: "KITTING",
      referenceNo: refNum,
      remarks: `Kit assembly (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode} × ${kitQty}`,
      createdBy,
      movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_OUT,
      lineId: compLineKeyId,
      allowNegative: strict ? false : true,
      effectKey: ek,
      unitCost: strict ? compUnitCost : null,
      currency: strict ? currency : "",
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
    unitCost: strict ? parentIncomingUnitCost : null,
    currency: strict ? currency : "",
    updateAvgCostOnIncrease: strict,
  });

  order.componentCostTotal = strict ? order.costSnapshot.producedTotalCost : componentCostTotal;
  order.assembledCost = kitQty > 0 ? order.componentCostTotal / kitQty : 0;
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

  const line = snapshot[0];
  const componentArticle = line.componentItemCode;
  const qtyIn = (Number(line.qtyPerKit) || 0) * kitQty;
  const lineKeyId = lineKey(line) || "bom:0";

  let parentUnitCost = 0;
  let childIncomingUnitCost = 0;
  let currency = "USD";

  if (strict) {
    order.customsLotLayers = await transferPackDeKitCustoms(order, companyId, session, createdBy);
    const parentBal = await stockService.getStockBalance({
      companyId,
      article: order.parentItemCode,
      warehouse: wh,
      session,
    });
    parentUnitCost = resolveBalanceUnitCost(parentBal);
    currency = parentBal.raw?.currency || "USD";
    const parentTotalCost = parentUnitCost * kitQty;
    childIncomingUnitCost = computeConservedTargetUnitCost(kitQty, parentUnitCost, qtyIn);
    setPackCostSnapshot(order, {
      sourceUnitCost: parentUnitCost,
      sourceTotalCost: parentTotalCost,
      producedUnitCost: childIncomingUnitCost,
      producedTotalCost: parentTotalCost,
      currency,
    });
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
    unitCost: strict ? parentUnitCost : null,
    currency: strict ? currency : "",
  });

  let componentCostTotal = 0;
  let idx = 0;
  for (const snapLine of snapshot) {
    const compArticle = snapLine.componentItemCode;
    const compQtyIn = (Number(snapLine.qtyPerKit) || 0) * kitQty;
    const compLineKeyId = lineKey(snapLine) || `bom:${idx}`;
    idx += 1;
    if (compQtyIn <= 0) continue;
    if (!strict) {
      const bal = await stockService.getStockBalance({
        companyId,
        article: compArticle,
        warehouse: wh,
        session,
      });
      componentCostTotal += resolveBalanceUnitCost(bal) * compQtyIn;
    }
    const ek = buildKittingEffectKey({
      movementType: stockService.MOVEMENT_TYPES.DEKIT_IN,
      companyId,
      referenceNo: refNum,
      article: compArticle,
      warehouse: wh,
      lineId: compLineKeyId,
    });
    effectKeys.push(ek);
    await postIncrease({
      session,
      companyId,
      article: compArticle,
      warehouse: wh,
      qty: compQtyIn,
      referenceType: "DEKITTING",
      referenceNo: refNum,
      remarks: `De-kit component from (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode}`,
      createdBy,
      movementType: stockService.MOVEMENT_TYPES.DEKIT_IN,
      lineId: compLineKeyId,
      effectKey: ek,
      unitCost: strict ? childIncomingUnitCost : null,
      currency: strict ? currency : "",
      updateAvgCostOnIncrease: strict,
    });
  }

  order.componentCostTotal = strict ? order.costSnapshot.producedTotalCost : componentCostTotal;
  order.assembledCost = kitQty > 0 ? order.componentCostTotal / kitQty : 0;
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

function ledgerUnitCost(ledger) {
  return Math.max(0, Number(ledger?.unitCost ?? 0) || 0);
}

export async function runReverseKitAssembly(order, createdBy, companyId, session, reversalReason = "") {
  const snapshot = assertSnapshot(order);
  const strict = packConversionUsesStrictGuards(order);
  const refNum = order.kitNumber;
  const wh = order.warehouse;
  const kitQty = Number(order.quantity);
  const orderLineId = String(order._id || refNum);
  const reversalOpId = crypto.randomUUID();
  const reversalKeys = [];

  if (strict && Array.isArray(order.customsLotLayers) && order.customsLotLayers.length) {
    await reverseCustomsLotsForPackConversion({
      session,
      companyId,
      conversionNo: refNum,
      conversionDocumentId: order._id,
      lotLayers: order.customsLotLayers,
      createdBy,
    });
  }

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
    unitCost: strict ? ledgerUnitCost(parentOrigLedger) : null,
    currency: strict ? order.costSnapshot?.currency || "" : "",
  });

  let idx = 0;
  for (const snapLine of snapshot) {
    const componentArticle = snapLine.componentItemCode;
    const qtyBack = (Number(snapLine.qtyPerKit) || 0) * kitQty;
    const compLineKeyId = lineKey(snapLine) || `bom:${idx}`;
    idx += 1;
    if (qtyBack <= 0) continue;
    const origKey = buildKittingEffectKey({
      movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_OUT,
      companyId,
      referenceNo: refNum,
      article: componentArticle,
      warehouse: wh,
      lineId: compLineKeyId,
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
      lineId: compLineKeyId,
      effectKey: revKey,
      reversedFromLedgerId: origLedger._id,
      originalEffectKey: origKey,
      cancellationOperationId: reversalOpId,
      unitCost: strict ? ledgerUnitCost(origLedger) : null,
      currency: strict ? order.costSnapshot?.currency || "" : "",
      updateAvgCostOnIncrease: strict,
    });
  }

  order.reversalOperationId = reversalOpId;
  order.reversalReason = reversalReason;
  order.ledgerEffectKeys = [...(order.ledgerEffectKeys || []), ...reversalKeys];
}

export async function runReverseDeKit(order, createdBy, companyId, session, reversalReason = "") {
  const snapshot = assertSnapshot(order);
  const strict = packConversionUsesStrictGuards(order);
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

  if (strict && Array.isArray(order.customsLotLayers) && order.customsLotLayers.length) {
    await reverseCustomsLotsForPackConversion({
      session,
      companyId,
      conversionNo: refNum,
      conversionDocumentId: order._id,
      lotLayers: order.customsLotLayers,
      createdBy,
    });
  }

  let idx = 0;
  for (const snapLine of snapshot) {
    const componentArticle = snapLine.componentItemCode;
    const qtyOut = (Number(snapLine.qtyPerKit) || 0) * kitQty;
    const compLineKeyId = lineKey(snapLine) || `bom:${idx}`;
    idx += 1;
    if (qtyOut <= 0) continue;
    const origKey = buildKittingEffectKey({
      movementType: stockService.MOVEMENT_TYPES.DEKIT_IN,
      companyId,
      referenceNo: refNum,
      article: componentArticle,
      warehouse: wh,
      lineId: compLineKeyId,
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
        lineId: compLineKeyId,
        allowNegative: false,
        effectKey: revKey,
        reversedFromLedgerId: origLedger._id,
        originalEffectKey: origKey,
        cancellationOperationId: reversalOpId,
        unitCost: strict ? ledgerUnitCost(origLedger) : null,
        currency: strict ? order.costSnapshot?.currency || "" : "",
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
    unitCost: strict ? ledgerUnitCost(parentOrigLedger) : null,
    currency: strict ? order.costSnapshot?.currency || "" : "",
    updateAvgCostOnIncrease: strict,
  });

  order.reversalOperationId = reversalOpId;
  order.reversalReason = reversalReason;
  order.ledgerEffectKeys = [...(order.ledgerEffectKeys || []), ...reversalKeys];
}
