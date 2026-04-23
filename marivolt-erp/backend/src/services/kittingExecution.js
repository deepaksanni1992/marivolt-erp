import BOM from "../models/BOM.js";
import { applyStockIn, applyStockOut } from "./stockService.js";

function snapshotFromBom(bom) {
  return (bom.lines || []).map((l) => ({
    componentItemCode: l.componentItemCode,
    qtyPerKit: Number(l.qty) || 0,
    description: l.description || "",
  }));
}

/**
 * Consumes components per BOM, receives parent (assembled kit) qty.
 */
export async function runKitAssembly(order, createdBy, companyId) {
  const bom = await BOM.findOne({ _id: order.bomId, companyId });
  if (!bom) throw new Error("BOM not found");
  if (!bom.isActive) throw new Error("BOM is inactive");
  if (String(bom.parentItemCode).toUpperCase() !== String(order.parentItemCode).toUpperCase()) {
    throw new Error("BOM parent does not match order");
  }
  if (!bom.lines?.length) throw new Error("BOM has no component lines");

  const refId = String(order._id);
  const refNum = order.kitNumber;
  const wh = order.warehouse;
  const kitQty = Number(order.quantity);

  for (const line of bom.lines) {
    const need = (Number(line.qty) || 0) * kitQty;
    if (need <= 0) continue;
    await applyStockOut({
      companyId,
      itemCode: line.componentItemCode,
      warehouse: wh,
      qty: need,
      movementType: "KIT_COMPONENT_OUT",
      referenceType: "KITTING",
      referenceId: refId,
      referenceNumber: refNum,
      remarks: `Kit assembly ${order.parentItemCode} × ${kitQty}`,
      createdBy,
    });
  }

  await applyStockIn({
    companyId,
    itemCode: order.parentItemCode,
    warehouse: wh,
    qty: kitQty,
    movementType: "KIT_PARENT_IN",
    referenceType: "KITTING",
    referenceId: refId,
    referenceNumber: refNum,
    remarks: `Assembled kit ${order.parentItemCode}`,
    createdBy,
    unitCost: 0,
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

  const refId = String(order._id);
  const refNum = order.dekitNumber;
  const wh = order.warehouse;
  const kitQty = Number(order.quantity);

  await applyStockOut({
    companyId,
    itemCode: order.parentItemCode,
    warehouse: wh,
    qty: kitQty,
    movementType: "DEKIT_PARENT_OUT",
    referenceType: "DEKITTING",
    referenceId: refId,
    referenceNumber: refNum,
    remarks: `De-kit ${order.parentItemCode} × ${kitQty}`,
    createdBy,
  });

  for (const line of bom.lines) {
    const qtyIn = (Number(line.qty) || 0) * kitQty;
    if (qtyIn <= 0) continue;
    await applyStockIn({
      companyId,
      itemCode: line.componentItemCode,
      warehouse: wh,
      qty: qtyIn,
      movementType: "DEKIT_COMPONENT_IN",
      referenceType: "DEKITTING",
      referenceId: refId,
      referenceNumber: refNum,
      remarks: `De-kit component from ${order.parentItemCode}`,
      createdBy,
      unitCost: 0,
    });
  }

  order.linesSnapshot = snapshotFromBom(bom);
}
