/**
 * Article Stock Conversion — customs lot retarget + posting orchestration helpers.
 * Physical ERP stock moves through stockService.articleConversion / reverseArticleConversion.
 * Customs qty is conserved by splitting lot items under the same customsLotId (no new GRN inbound).
 */
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsMovement from "../models/CustomsMovement.js";
import { sortCustomsLotsForFifo } from "../utils/customsFifo.js";

function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

function deriveItemStatus(qtyAvailable, qtyImported) {
  if (qtyAvailable <= 1e-6) return "CONSUMED";
  if (qtyAvailable + 1e-6 < qtyImported) return "PARTIAL";
  return "IN_STOCK";
}

/**
 * Select FIFO source customs layers for conversion qty.
 * @returns {Promise<Array>} layers with take qty
 */
export async function selectCustomsLayersForConversion({
  companyId,
  sourceArticle,
  qty,
  selectedCustomsLotItemId = null,
  session = null,
}) {
  const need = Number(qty) || 0;
  if (!(need > 0)) return [];
  const article = up(sourceArticle);
  const q = {
    companyId,
    articleNumber: article,
    qtyAvailable: { $gt: 0 },
    status: { $nin: ["CANCELLED"] },
  };
  if (selectedCustomsLotItemId) {
    q._id = selectedCustomsLotItemId;
  }
  let items = await CustomsLotItem.find(q).session(session || null).lean();
  if (!items.length) return [];

  // Enrich with lot header for FIFO keys / PO refs
  const lotIds = [...new Set(items.map((i) => String(i.customsLotId)))];
  const lots = await CustomsLot.find({ companyId, _id: { $in: lotIds } })
    .session(session || null)
    .lean();
  const lotById = new Map(lots.map((l) => [String(l._id), l]));
  const enriched = items.map((it) => {
    const lot = lotById.get(String(it.customsLotId)) || {};
    return {
      ...it,
      boeDate: it.boeDate || lot.boeDate,
      supplierInvoiceDate: it.supplierInvoiceDate || lot.supplierInvoiceDate,
      receivedDate: it.receivedDate,
      grnCreatedAt: lot.createdAt,
      customsLotId: it.customsLotId,
      customsLotItemId: it._id,
      poNo: lot.poNo || "",
    };
  });
  const ordered = selectedCustomsLotItemId ? enriched : sortCustomsLotsForFifo(enriched);

  let remaining = need;
  const layers = [];
  for (const row of ordered) {
    if (remaining <= 1e-9) break;
    const avail = Number(row.qtyAvailable) || 0;
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);
    layers.push({ ...row, take });
    remaining -= take;
  }
  if (remaining > 1e-6) {
    const err = new Error(
      `Insufficient customs stock for article ${article} (short by ${remaining}).`
    );
    err.code = "ARTICLE_CONVERSION_CUSTOMS_SHORTAGE";
    err.remaining = remaining;
    throw err;
  }
  return layers;
}

/**
 * Move customs availability from source article layers to target article layers
 * under the same customsLotId. Conserves Σ qtyImported and Σ qtyAvailable on the lot.
 */
export async function retargetCustomsLotsForConversion({
  session,
  companyId,
  companyCode = "",
  sourceArticle,
  targetArticle,
  targetDescription = "",
  conversionNo,
  conversionDocumentId,
  layers,
  createdBy = "",
}) {
  const srcArt = up(sourceArticle);
  const tgtArt = up(targetArticle);
  const results = [];

  for (const layer of layers || []) {
    const take = Number(layer.take) || 0;
    if (!(take > 0)) continue;
    const sourceItem = await CustomsLotItem.findOne({
      _id: layer._id || layer.customsLotItemId,
      companyId,
    }).session(session);
    if (!sourceItem) throw new Error("Customs lot item not found for conversion");
    if (up(sourceItem.articleNumber) !== srcArt) {
      throw new Error("Customs lot item article mismatch");
    }
    if (String(sourceItem.status).toUpperCase() === "CANCELLED") {
      throw new Error("Cannot convert from a cancelled customs lot item");
    }
    const avail = Number(sourceItem.qtyAvailable) || 0;
    if (take > avail + 1e-6) {
      throw new Error(`Customs layer available ${avail} < conversion take ${take}`);
    }

    const imported = Number(sourceItem.qtyImported) || 0;
    const consumed = Number(sourceItem.qtyConsumed) || 0;
    const nextAvail = Math.max(0, avail - take);
    const nextImported = Math.max(consumed + nextAvail, imported - take);
    sourceItem.qtyAvailable = nextAvail;
    sourceItem.qtyImported = nextImported;
    sourceItem.customStock = nextAvail;
    sourceItem.customStockBalance = nextAvail;
    sourceItem.status = deriveItemStatus(nextAvail, nextImported);
    await sourceItem.save({ session });

    const unitPrice = Number(sourceItem.unitPrice) || 0;
    const fx = Number(sourceItem.exchangeRateToAED) || 0;
    const unitWeight = Number(sourceItem.unitWeightKg || sourceItem.weightKg) || 0;
    const [targetItem] = await CustomsLotItem.create(
      [
        {
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
          unitPrice,
          qtyImported: take,
          qtyAvailable: take,
          qtyConsumed: 0,
          weightKg: unitWeight,
          unitWeightKg: unitWeight,
          totalWeightKg: unitWeight * take,
          totalValue: unitPrice * take,
          exchangeRateToAED: fx,
          customsValueAED: unitPrice * take * fx,
          customStock: take,
          customStockBalance: take,
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
          customsRemarks: `Converted from ${srcArt} under ${up(conversionNo)}`,
        },
      ],
      { session }
    );

    await CustomsMovement.create(
      [
        {
          companyId,
          companyCode: companyCode || sourceItem.companyCode || "",
          movementType: "ADJUSTMENT",
          customsLotId: sourceItem.customsLotId,
          customsLotItemId: sourceItem._id,
          articleNumber: srcArt,
          partNumber: sourceItem.partNumber || "",
          qty: take,
          referenceType: "ARTICLE_STOCK_CONVERSION",
          referenceId: conversionDocumentId || null,
          referenceNumber: up(conversionNo),
          movementDate: new Date(),
          remarks: `Conversion OUT ${srcArt} → ${tgtArt}`,
          createdBy,
        },
        {
          companyId,
          companyCode: companyCode || sourceItem.companyCode || "",
          movementType: "ADJUSTMENT",
          customsLotId: sourceItem.customsLotId,
          customsLotItemId: targetItem._id,
          articleNumber: tgtArt,
          partNumber: sourceItem.partNumber || "",
          qty: take,
          referenceType: "ARTICLE_STOCK_CONVERSION",
          referenceId: conversionDocumentId || null,
          referenceNumber: up(conversionNo),
          movementDate: new Date(),
          remarks: `Conversion IN ${srcArt} → ${tgtArt}`,
          createdBy,
        },
      ],
      { session }
    );

    results.push({
      customsLotId: sourceItem.customsLotId,
      customsLotItemId: sourceItem._id,
      targetCustomsLotItemId: targetItem._id,
      customsLotRef: sourceItem.customsLotRef,
      grnId: sourceItem.grnId,
      grnNo: sourceItem.grnNo,
      poNo: layer.poNo || "",
      boeNumber: sourceItem.boeNumber,
      blNumber: sourceItem.blNumber,
      awbNumber: sourceItem.awbNumber,
      supplierInvoiceNumber: sourceItem.supplierInvoiceNumber,
      sourceQty: take,
      targetQty: take,
      unitCost: unitPrice,
      currency: sourceItem.currency || "USD",
      exchangeRateToAED: fx,
      sourceStockValue: unitPrice * take,
      targetStockValue: unitPrice * take,
    });
  }
  return results;
}

/**
 * Reverse customs conversion layers: reduce target conversion layers, restore source.
 */
export async function reverseCustomsLotsForConversion({
  session,
  companyId,
  companyCode = "",
  conversionNo,
  conversionDocumentId,
  lotLayers,
  createdBy = "",
}) {
  for (const layer of lotLayers || []) {
    const take = Number(layer.sourceQty || layer.targetQty) || 0;
    if (!(take > 0)) continue;
    const targetItem = await CustomsLotItem.findOne({
      _id: layer.targetCustomsLotItemId,
      companyId,
    }).session(session);
    const sourceItem = await CustomsLotItem.findOne({
      _id: layer.customsLotItemId,
      companyId,
    }).session(session);
    if (!targetItem || !sourceItem) {
      throw new Error("Cannot reverse: customs conversion layers missing");
    }
    if ((Number(targetItem.qtyConsumed) || 0) > 1e-6) {
      const err = new Error(
        "Cannot reverse conversion: target customs stock has been consumed on a customs invoice."
      );
      err.code = "ARTICLE_CONVERSION_REVERSAL_BLOCKED";
      throw err;
    }
    const tgtAvail = Number(targetItem.qtyAvailable) || 0;
    if (take > tgtAvail + 1e-6) {
      const err = new Error(
        `Cannot reverse conversion: target customs available ${tgtAvail} < ${take}`
      );
      err.code = "ARTICLE_CONVERSION_REVERSAL_BLOCKED";
      throw err;
    }

    targetItem.qtyAvailable = Math.max(0, tgtAvail - take);
    targetItem.qtyImported = Math.max(0, (Number(targetItem.qtyImported) || 0) - take);
    targetItem.customStock = targetItem.qtyAvailable;
    targetItem.customStockBalance = targetItem.qtyAvailable;
    targetItem.status = deriveItemStatus(targetItem.qtyAvailable, targetItem.qtyImported);
    await targetItem.save({ session });

    const srcAvail = Number(sourceItem.qtyAvailable) || 0;
    const srcImported = Number(sourceItem.qtyImported) || 0;
    sourceItem.qtyAvailable = srcAvail + take;
    sourceItem.qtyImported = srcImported + take;
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
          qty: take,
          referenceType: "ARTICLE_STOCK_CONVERSION",
          referenceId: conversionDocumentId || null,
          referenceNumber: up(conversionNo),
          movementDate: new Date(),
          remarks: `Conversion reversal OUT ${targetItem.articleNumber}`,
          createdBy,
        },
        {
          companyId,
          companyCode: companyCode || sourceItem.companyCode || "",
          movementType: "REVERSAL",
          customsLotId: sourceItem.customsLotId,
          customsLotItemId: sourceItem._id,
          articleNumber: sourceItem.articleNumber,
          qty: take,
          referenceType: "ARTICLE_STOCK_CONVERSION",
          referenceId: conversionDocumentId || null,
          referenceNumber: up(conversionNo),
          movementDate: new Date(),
          remarks: `Conversion reversal IN ${sourceItem.articleNumber}`,
          createdBy,
        },
      ],
      { session }
    );
  }
}
