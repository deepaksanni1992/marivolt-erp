/**
 * PACK_CONVERSION customs provenance — adapts Article Stock Conversion retarget
 * for parent↔child ratio (e.g. 1 SET → 25 PCS) while conserving customs value.
 */
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsMovement from "../models/CustomsMovement.js";
import {
  computeConversionCustomsTransfer,
  roundCustomsMoney,
  roundCustomsQty,
} from "../utils/customsBoeAverage.js";
import { selectCustomsLayersForConversion } from "./articleConversionCustomsService.js";

export { selectCustomsLayersForConversion };

function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

function deriveItemStatus(qtyAvailable, qtyImported) {
  if (qtyAvailable <= 1e-6) return "CONSUMED";
  if (qtyAvailable + 1e-6 < qtyImported) return "PARTIAL";
  return "IN_STOCK";
}

async function sumCustomsAvailable({ companyId, article, session }) {
  const rows = await CustomsLotItem.find({
    companyId,
    articleNumber: up(article),
    qtyAvailable: { $gt: 0 },
    status: { $nin: ["CANCELLED"] },
  })
    .session(session || null)
    .lean();
  return rows.reduce((s, r) => s + (Number(r.qtyAvailable) || 0), 0);
}

/**
 * When customs stock exists for an article, PACK_CONVERSION requires full customs coverage.
 * Returns [] when no customs stock exists (non-customs path).
 */
export async function selectPackConversionCustomsLayers({
  companyId,
  sourceArticle,
  sourceQty,
  session = null,
}) {
  const avail = await sumCustomsAvailable({ companyId, article: sourceArticle, session });
  if (avail <= 1e-9) return [];
  return selectCustomsLayersForConversion({
    companyId,
    sourceArticle,
    qty: sourceQty,
    session,
  });
}

async function findExistingPackConversionTarget({
  companyId,
  conversionNo,
  convertedFromLotItemId,
  targetArticle,
  session,
}) {
  return CustomsLotItem.findOne({
    companyId,
    articleNumber: up(targetArticle),
    conversionNo: up(conversionNo),
    convertedFromLotItemId,
    isConversionLayer: true,
    status: { $nin: ["CANCELLED"] },
  }).session(session || null);
}

/**
 * De-kit / kit customs transfer with ratio.
 * @param parentTake physical qty consumed from parent-side layer (parent inventory UOM)
 * @param childQty physical qty produced on child (child inventory UOM)
 */
async function retargetOnePackConversionLayer({
  session,
  companyId,
  companyCode = "",
  sourceItem,
  targetArticle,
  targetDescription = "",
  parentTake,
  childQty,
  conversionNo,
  conversionDocumentId,
  direction = "DEKIT",
  createdBy = "",
}) {
  const take = Number(parentTake) || 0;
  const childPhysical = Number(childQty) || 0;
  if (!(take > 0) || !(childPhysical > 0)) return null;

  const existing = await findExistingPackConversionTarget({
    companyId,
    conversionNo,
    convertedFromLotItemId: sourceItem._id,
    targetArticle,
    session,
  });
  if (existing) {
    return {
      customsLotId: existing.customsLotId,
      customsLotItemId: sourceItem._id,
      targetCustomsLotItemId: existing._id,
      sourceQty: take,
      targetQty: childPhysical,
      idempotent: true,
    };
  }

  const avail = Number(sourceItem.qtyAvailable) || 0;
  if (take > avail + 1e-6) {
    throw new Error(`Customs layer available ${avail} < pack conversion take ${take}`);
  }

  const transfer = computeConversionCustomsTransfer({
    take,
    qtyAvailable: avail,
    qtyImported: Number(sourceItem.qtyImported) || 0,
    qtyConsumed: Number(sourceItem.qtyConsumed) || 0,
    unitPrice: Number(sourceItem.unitPrice) || 0,
    customsUnitValue: sourceItem.customsUnitValue,
    totalValue: sourceItem.totalValue,
    customsQtyImported: sourceItem.customsQtyImported,
    customsValueAED: sourceItem.customsValueAED,
    exchangeRateToAED: sourceItem.exchangeRateToAED,
  });
  if (!transfer.ok) {
    throw new Error(transfer.message || "Pack conversion customs transfer failed");
  }

  const childUnitValue =
    childPhysical > 1e-9 ? roundCustomsMoney(transfer.transferValue / childPhysical) : transfer.unit;
  const fx = Number(sourceItem.exchangeRateToAED) || 0;
  const unitWeight = Number(sourceItem.unitWeightKg || sourceItem.weightKg) || 0;
  const valuationMethod = sourceItem.valuationMethod || "";
  const srcArt = up(sourceItem.articleNumber);
  const tgtArt = up(targetArticle);

  sourceItem.qtyAvailable = transfer.nextQtyAvailable;
  sourceItem.qtyImported = transfer.nextQtyImported;
  sourceItem.totalValue = transfer.nextTotalValue;
  sourceItem.customsQtyImported = transfer.nextCustomsQtyImported;
  sourceItem.customsValueAED = transfer.nextCustomsValueAED;
  sourceItem.totalWeightKg = unitWeight * transfer.nextQtyAvailable;
  sourceItem.customStock = transfer.nextQtyAvailable;
  sourceItem.customStockBalance = transfer.nextQtyAvailable;
  sourceItem.status = deriveItemStatus(transfer.nextQtyAvailable, transfer.nextQtyImported);
  await sourceItem.save({ session });

  const targetItem = new CustomsLotItem({
    companyId,
    companyCode: companyCode || sourceItem.companyCode || "",
    customsLotId: sourceItem.customsLotId,
    customsLotRef: sourceItem.customsLotRef,
    grnId: sourceItem.grnId,
    grnNo: sourceItem.grnNo,
    grnLineId: sourceItem.grnLineId,
    articleNumber: tgtArt,
    partNumber: sourceItem.partNumber || "",
    partName: targetDescription || sourceItem.partName || "",
    description: targetDescription || sourceItem.description || "",
    hsCode: sourceItem.hsCode,
    currency: sourceItem.currency,
    unitPrice: childUnitValue,
    customsUnitValue: childUnitValue,
    ...(valuationMethod ? { valuationMethod } : {}),
    customsQtyImported: roundCustomsQty(transfer.transferCustomsQty * (childPhysical / take)),
    qtyImported: childPhysical,
    qtyAvailable: childPhysical,
    qtyConsumed: 0,
    weightKg: unitWeight,
    unitWeightKg: unitWeight,
    totalWeightKg: unitWeight * childPhysical,
    totalValue: transfer.transferValue,
    exchangeRateToAED: fx,
    customsValueAED: transfer.transferValueAED,
    customStock: childPhysical,
    customStockBalance: childPhysical,
    supplierInvoiceNumber: sourceItem.supplierInvoiceNumber,
    supplierInvoiceDate: sourceItem.supplierInvoiceDate,
    receivedDate: sourceItem.receivedDate,
    boeNumber: sourceItem.boeNumber,
    boeDate: sourceItem.boeDate,
    blNumber: sourceItem.blNumber,
    awbNumber: sourceItem.awbNumber,
    countryOfOrigin: sourceItem.countryOfOrigin,
    status: "IN_STOCK",
    originalReceivedArticle: srcArt,
    conversionNo: up(conversionNo),
    conversionDocumentId: conversionDocumentId || null,
    convertedFromLotItemId: sourceItem._id,
    isConversionLayer: true,
    customsRemarks: `Pack conversion ${direction} ${srcArt} → ${tgtArt} under ${up(conversionNo)}`,
  });
  await targetItem.save({ session });

  await CustomsMovement.create(
    [
      {
        companyId,
        companyCode: companyCode || sourceItem.companyCode || "",
        movementType: "ADJUSTMENT",
        customsLotId: sourceItem.customsLotId,
        customsLotItemId: sourceItem._id,
        articleNumber: srcArt,
        qty: take,
        customsUnitValue: transfer.unit || null,
        customsValue: transfer.transferValue,
        currency: sourceItem.currency || "",
        valuationMethod: valuationMethod || "",
        referenceType: "PACK_CONVERSION",
        referenceId: conversionDocumentId || null,
        referenceNumber: up(conversionNo),
        movementDate: new Date(),
        remarks: `Pack conversion OUT ${srcArt} → ${tgtArt}`,
        createdBy,
      },
      {
        companyId,
        companyCode: companyCode || sourceItem.companyCode || "",
        movementType: "ADJUSTMENT",
        customsLotId: sourceItem.customsLotId,
        customsLotItemId: targetItem._id,
        articleNumber: tgtArt,
        qty: childPhysical,
        customsUnitValue: childUnitValue || null,
        customsValue: transfer.transferValue,
        currency: sourceItem.currency || "",
        valuationMethod: valuationMethod || "",
        referenceType: "PACK_CONVERSION",
        referenceId: conversionDocumentId || null,
        referenceNumber: up(conversionNo),
        movementDate: new Date(),
        remarks: `Pack conversion IN ${srcArt} → ${tgtArt}`,
        createdBy,
      },
    ],
    { session, ordered: true }
  );

  return {
    customsLotId: sourceItem.customsLotId,
    customsLotItemId: sourceItem._id,
    targetCustomsLotItemId: targetItem._id,
    customsLotRef: sourceItem.customsLotRef,
    grnId: sourceItem.grnId,
    grnNo: sourceItem.grnNo,
    boeNumber: sourceItem.boeNumber,
    sourceQty: take,
    targetQty: childPhysical,
    unitCost: childUnitValue,
    currency: sourceItem.currency || "USD",
    sourceStockValue: transfer.transferValue,
    targetStockValue: transfer.transferValue,
    transferCustomsQty: transfer.transferCustomsQty,
    idempotent: false,
  };
}

/** De-kit: parent article customs → child article customs (ratio applied). */
export async function retargetCustomsLotsForPackDeKit({
  session,
  companyId,
  companyCode = "",
  parentArticle,
  childArticle,
  childDescription = "",
  qtyPerParent,
  conversionNo,
  conversionDocumentId,
  layers,
  createdBy = "",
}) {
  const ratio = Number(qtyPerParent) || 0;
  if (!(ratio > 0)) throw new Error("qtyPerParent required for pack conversion customs");
  const results = [];
  for (const layer of layers || []) {
    const parentTake = Number(layer.take) || 0;
    if (!(parentTake > 0)) continue;
    const sourceItem = await CustomsLotItem.findOne({
      _id: layer._id || layer.customsLotItemId,
      companyId,
    }).session(session);
    if (!sourceItem) throw new Error("Customs lot item not found for pack de-kit");
    const row = await retargetOnePackConversionLayer({
      session,
      companyId,
      companyCode,
      sourceItem,
      targetArticle: childArticle,
      targetDescription: childDescription,
      parentTake,
      childQty: parentTake * ratio,
      conversionNo,
      conversionDocumentId,
      direction: "DEKIT",
      createdBy,
    });
    if (row) results.push(row);
  }
  return results;
}

/** Kit: child article customs → parent article customs (ratio applied). */
export async function retargetCustomsLotsForPackKit({
  session,
  companyId,
  companyCode = "",
  parentArticle,
  childArticle,
  parentDescription = "",
  qtyPerParent,
  conversionNo,
  conversionDocumentId,
  layers,
  createdBy = "",
}) {
  const ratio = Number(qtyPerParent) || 0;
  if (!(ratio > 0)) throw new Error("qtyPerParent required for pack conversion customs");
  const results = [];
  for (const layer of layers || []) {
    const childTake = Number(layer.take) || 0;
    if (!(childTake > 0)) continue;
    const parentQty = childTake / ratio;
    const sourceItem = await CustomsLotItem.findOne({
      _id: layer._id || layer.customsLotItemId,
      companyId,
    }).session(session);
    if (!sourceItem) throw new Error("Customs lot item not found for pack kit");
    const row = await retargetOnePackConversionLayer({
      session,
      companyId,
      companyCode,
      sourceItem,
      targetArticle: parentArticle,
      targetDescription: parentDescription,
      parentTake: childTake,
      childQty: parentQty,
      conversionNo,
      conversionDocumentId,
      direction: "KIT",
      createdBy,
    });
    if (row) results.push(row);
  }
  return results;
}

/** Reverse pack conversion customs layers (mirror of article conversion reversal). */
export async function reverseCustomsLotsForPackConversion({
  session,
  companyId,
  companyCode = "",
  conversionNo,
  conversionDocumentId,
  lotLayers,
  createdBy = "",
}) {
  for (const layer of lotLayers || []) {
    const sourceTake = Number(layer.sourceQty) || 0;
    const targetTake = Number(layer.targetQty) || 0;
    if (!(sourceTake > 0) || !(targetTake > 0)) continue;

    const targetItem = await CustomsLotItem.findOne({
      _id: layer.targetCustomsLotItemId,
      companyId,
    }).session(session);
    const sourceItem = await CustomsLotItem.findOne({
      _id: layer.customsLotItemId,
      companyId,
    }).session(session);
    if (!targetItem || !sourceItem) {
      throw new Error("Cannot reverse: pack conversion customs layers missing");
    }
    if ((Number(targetItem.qtyConsumed) || 0) > 1e-6) {
      const err = new Error(
        "Cannot reverse pack conversion: target customs stock has been consumed on a customs invoice."
      );
      err.code = "PACK_CONVERSION_CUSTOMS_REVERSAL_BLOCKED";
      throw err;
    }
    const tgtAvail = Number(targetItem.qtyAvailable) || 0;
    if (targetTake > tgtAvail + 1e-6) {
      const err = new Error(
        `Cannot reverse pack conversion: target customs available ${tgtAvail} < ${targetTake}`
      );
      err.code = "PACK_CONVERSION_CUSTOMS_REVERSAL_BLOCKED";
      throw err;
    }

    const tgtImported = Number(targetItem.qtyImported) || 0;
    const tgtTotal = Number(targetItem.totalValue) || 0;
    const tgtCqi = Number(targetItem.customsQtyImported) || tgtImported;
    const tgtAed = Number(targetItem.customsValueAED) || 0;
    const unit = Number(targetItem.customsUnitValue ?? targetItem.unitPrice ?? sourceItem.unitPrice) || 0;
    const valuationMethod = targetItem.valuationMethod || sourceItem.valuationMethod || "";

    const restoreValue =
      tgtImported > 1e-9 && Math.abs(targetTake - tgtAvail) < 1e-9
        ? roundCustomsMoney(tgtTotal)
        : tgtImported > 1e-9
          ? roundCustomsMoney(tgtTotal * (targetTake / tgtImported))
          : roundCustomsMoney(unit * targetTake);
    const restoreCqi =
      tgtImported > 1e-9 && Math.abs(targetTake - tgtAvail) < 1e-9
        ? roundCustomsQty(tgtCqi)
        : tgtImported > 1e-9
          ? roundCustomsQty(tgtCqi * (targetTake / tgtImported))
          : roundCustomsQty(targetTake);
    const restoreAed =
      tgtImported > 1e-9 && Math.abs(targetTake - tgtAvail) < 1e-9
        ? roundCustomsMoney(tgtAed)
        : tgtImported > 1e-9
          ? roundCustomsMoney(tgtAed * (targetTake / tgtImported))
          : 0;

    targetItem.qtyAvailable = Math.max(0, tgtAvail - targetTake);
    targetItem.qtyImported = Math.max(0, tgtImported - targetTake);
    targetItem.totalValue = Math.max(0, roundCustomsMoney(tgtTotal - restoreValue));
    targetItem.customsQtyImported = Math.max(0, roundCustomsQty(tgtCqi - restoreCqi));
    targetItem.customsValueAED = Math.max(0, roundCustomsMoney(tgtAed - restoreAed));
    targetItem.customStock = targetItem.qtyAvailable;
    targetItem.customStockBalance = targetItem.qtyAvailable;
    targetItem.status = deriveItemStatus(targetItem.qtyAvailable, targetItem.qtyImported);
    await targetItem.save({ session });

    sourceItem.qtyAvailable = (Number(sourceItem.qtyAvailable) || 0) + sourceTake;
    sourceItem.qtyImported = (Number(sourceItem.qtyImported) || 0) + sourceTake;
    sourceItem.totalValue = roundCustomsMoney((Number(sourceItem.totalValue) || 0) + restoreValue);
    sourceItem.customsQtyImported = roundCustomsQty(
      (Number(sourceItem.customsQtyImported) || Number(sourceItem.qtyImported) || 0) + restoreCqi
    );
    sourceItem.customsValueAED = roundCustomsMoney(
      (Number(sourceItem.customsValueAED) || 0) + restoreAed
    );
    sourceItem.customStock = sourceItem.qtyAvailable;
    sourceItem.customStockBalance = sourceItem.qtyAvailable;
    sourceItem.status = deriveItemStatus(sourceItem.qtyAvailable, sourceItem.qtyImported);
    await sourceItem.save({ session });

    await CustomsMovement.create(
      [
        {
          companyId,
          companyCode: companyCode || targetItem.companyCode || "",
          movementType: "REVERSAL",
          customsLotId: targetItem.customsLotId,
          customsLotItemId: targetItem._id,
          articleNumber: targetItem.articleNumber,
          qty: targetTake,
          customsUnitValue: unit || null,
          customsValue: restoreValue,
          currency: targetItem.currency || "",
          valuationMethod: valuationMethod || "",
          referenceType: "PACK_CONVERSION",
          referenceId: conversionDocumentId || null,
          referenceNumber: up(conversionNo),
          movementDate: new Date(),
          remarks: `Pack conversion reversal OUT ${targetItem.articleNumber}`,
          createdBy,
        },
        {
          companyId,
          companyCode: companyCode || sourceItem.companyCode || "",
          movementType: "REVERSAL",
          customsLotId: sourceItem.customsLotId,
          customsLotItemId: sourceItem._id,
          articleNumber: sourceItem.articleNumber,
          qty: sourceTake,
          customsUnitValue: unit || null,
          customsValue: restoreValue,
          currency: sourceItem.currency || "",
          valuationMethod: valuationMethod || "",
          referenceType: "PACK_CONVERSION",
          referenceId: conversionDocumentId || null,
          referenceNumber: up(conversionNo),
          movementDate: new Date(),
          remarks: `Pack conversion reversal IN ${sourceItem.articleNumber}`,
          createdBy,
        },
      ],
      { session, ordered: true }
    );
  }
}
