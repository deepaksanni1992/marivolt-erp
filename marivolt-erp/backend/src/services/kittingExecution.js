import BOM from "../models/BOM.js";
import * as stockService from "./stockService.js";

function snapshotFromBom(bom) {
  return (bom.lines || []).map((l) => ({
    componentItemCode: l.componentItemCode,
    qtyPerKit: Number(l.qty) || 0,
    description: l.description || "",
  }));
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

  await stockService.withTransaction(async (session) => {
    for (const line of bom.lines) {
      const need = (Number(line.qty) || 0) * kitQty;
      if (need <= 0) continue;
      await stockService.stockAdjustment({
        session,
        companyId,
        article: line.componentItemCode,
        warehouse: wh,
        qty: need,
        direction: "Decrease",
        referenceType: "KITTING",
        referenceNo: refNum,
        remarks: `Kit assembly ${order.parentItemCode} × ${kitQty}`,
        createdBy,
        sourceModule: "KITTING",
        allowNegative: true,
      });
    }

    await stockService.grnReceive({
      session,
      companyId,
      article: order.parentItemCode,
      warehouse: wh,
      qty: kitQty,
      referenceType: "KITTING",
      referenceNo: refNum,
      remarks: `Assembled kit ${order.parentItemCode}`,
      createdBy,
      sourceModule: "KITTING",
      unitCost: 0,
    });
  });

  order.linesSnapshot = snapshotFromBom(bom);
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
      remarks: `De-kit ${order.parentItemCode} × ${kitQty}`,
      createdBy,
      sourceModule: "KITTING",
      allowNegative: true,
    });

    for (const line of bom.lines) {
      const qtyIn = (Number(line.qty) || 0) * kitQty;
      if (qtyIn <= 0) continue;
      await stockService.grnReceive({
        session,
        companyId,
        article: line.componentItemCode,
        warehouse: wh,
        qty: qtyIn,
        referenceType: "DEKITTING",
        referenceNo: refNum,
        remarks: `De-kit component from ${order.parentItemCode}`,
        createdBy,
        sourceModule: "KITTING",
        unitCost: 0,
      });
    }
  });

  order.linesSnapshot = snapshotFromBom(bom);
}
