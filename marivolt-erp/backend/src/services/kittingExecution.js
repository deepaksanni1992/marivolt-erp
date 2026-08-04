import BOM from "../models/BOM.js";
import * as stockService from "./stockService.js";

function snapshotFromBom(bom) {
  return (bom.lines || []).map((l) => ({
    componentItemCode: l.componentItemCode || l.article,
    qtyPerKit: Number(l.qty) || 0,
    description: l.description || "",
  }));
}

function bomLineKey(line, index) {
  return String(line?._id || line?.componentItemCode || line?.article || `bom:${index}`);
}

/**
 * Consumes components per BOM, receives parent (assembled kit) qty.
 * Routed through `stockService` so balances + ledger stay consistent
 * with the rest of the ERP. Wrapped in a single Mongo transaction to
 * keep the component out / parent in pair atomic.
 */
export async function runKitAssembly(order, createdBy, companyId) {
  const bom = await BOM.findOne({ _id: order.bomId, companyId });
  if (!bom) throw new Error("BOM not found");
  if (!bom.isActive) throw new Error("BOM is inactive");
  if (String(bom.parentItemCode).toUpperCase() !== String(order.parentItemCode).toUpperCase()) {
    throw new Error("BOM parent does not match order");
  }
  if (!bom.lines?.length) throw new Error("BOM has no component lines");

  const refNum = order.kitNumber;
  const wh = order.warehouse;
  const kitQty = Number(order.quantity);
  let componentCostTotal = 0;
  const orderLineId = String(order._id || refNum);

  await stockService.withTransaction(async (session) => {
    let idx = 0;
    for (const line of bom.lines) {
      const componentArticle = line.componentItemCode || line.article;
      const need = (Number(line.qty) || 0) * kitQty;
      const lineKey = bomLineKey(line, idx++);
      if (need <= 0) continue;
      const bal = await stockService.getStockBalance({
        companyId,
        article: componentArticle,
        warehouse: wh,
        session,
      });
      const componentUnitCost = Number(bal.raw?.avgCost ?? bal.raw?.unitCost ?? 0) || 0;
      componentCostTotal += componentUnitCost * need;
      await stockService.stockAdjustment({
        session,
        companyId,
        article: componentArticle,
        warehouse: wh,
        qty: need,
        direction: "Decrease",
        referenceType: "KITTING",
        referenceNo: refNum,
        remarks: `Kit assembly (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode} × ${kitQty}`,
        createdBy,
        sourceModule: "KITTING",
        allowNegative: true,
        movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_OUT,
        lineId: lineKey,
      });
    }

    const assembledCostPerKit = kitQty > 0 ? componentCostTotal / kitQty : 0;
    await stockService.stockAdjustment({
      session,
      companyId,
      article: order.parentItemCode,
      warehouse: wh,
      qty: kitQty,
      direction: "Increase",
      referenceType: "KITTING",
      referenceNo: refNum,
      remarks: `Assembled kit (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode}`,
      createdBy,
      sourceModule: "KITTING",
      movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_IN,
      lineId: `PARENT:${orderLineId}`,
    });
    order.componentCostTotal = componentCostTotal;
    order.assembledCost = assembledCostPerKit;
  });

  order.linesSnapshot = snapshotFromBom(bom);
  order.linkedBomRevision = bom.revisionNo || "";
}

/**
 * Consumes parent kit qty, returns components per BOM.
 */
export async function runDeKit(order, createdBy, companyId) {
  const bom = await BOM.findOne({ _id: order.bomId, companyId });
  if (!bom) throw new Error("BOM not found");
  if (!bom.isActive) throw new Error("BOM is inactive");
  if (String(bom.parentItemCode).toUpperCase() !== String(order.parentItemCode).toUpperCase()) {
    throw new Error("BOM parent does not match order");
  }
  if (!bom.lines?.length) throw new Error("BOM has no component lines");

  const refNum = order.dekitNumber;
  const wh = order.warehouse;
  const kitQty = Number(order.quantity);
  let componentCostTotal = 0;
  const orderLineId = String(order._id || refNum);

  await stockService.withTransaction(async (session) => {
    await stockService.stockAdjustment({
      session,
      companyId,
      article: order.parentItemCode,
      warehouse: wh,
      qty: kitQty,
      direction: "Decrease",
      referenceType: "DEKITTING",
      referenceNo: refNum,
      remarks: `De-kit (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode} × ${kitQty}${order.disassemblyReason ? ` | ${order.disassemblyReason}` : ""}`,
      createdBy,
      sourceModule: "KITTING",
      allowNegative: true,
      movementType: stockService.MOVEMENT_TYPES.DEKIT_OUT,
      lineId: `PARENT:${orderLineId}`,
    });

    let idx = 0;
    for (const line of bom.lines) {
      const componentArticle = line.componentItemCode || line.article;
      const qtyIn = (Number(line.qty) || 0) * kitQty;
      const lineKey = bomLineKey(line, idx++);
      if (qtyIn <= 0) continue;
      const bal = await stockService.getStockBalance({
        companyId,
        article: componentArticle,
        warehouse: wh,
        session,
      });
      const componentUnitCost = Number(bal.raw?.avgCost ?? bal.raw?.unitCost ?? 0) || 0;
      componentCostTotal += componentUnitCost * qtyIn;
      await stockService.stockAdjustment({
        session,
        companyId,
        article: componentArticle,
        warehouse: wh,
        qty: qtyIn,
        direction: "Increase",
        referenceType: "DEKITTING",
        referenceNo: refNum,
        remarks: `De-kit component from (${order.kitType || "CUSTOM_KIT"}) ${order.parentItemCode}`,
        createdBy,
        sourceModule: "KITTING",
        movementType: stockService.MOVEMENT_TYPES.DEKIT_IN,
        lineId: lineKey,
      });
    }
    order.componentCostTotal = componentCostTotal;
    order.assembledCost = kitQty > 0 ? componentCostTotal / kitQty : 0;
  });

  order.linesSnapshot = snapshotFromBom(bom);
  order.linkedBomRevision = bom.revisionNo || "";
}
