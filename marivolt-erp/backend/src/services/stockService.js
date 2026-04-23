import StockBalance from "../models/StockBalance.js";
import InventoryLedger from "../models/InventoryLedger.js";

function normCode(itemCode) {
  return String(itemCode || "").trim().toUpperCase();
}

function normWh(warehouse) {
  return String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
}

export async function applyStockIn({
  companyId,
  itemCode,
  warehouse,
  qty,
  movementType = "IN_PURCHASE",
  referenceType = "",
  referenceId = "",
  referenceNumber = "",
  unitCost = 0,
  remarks = "",
  createdBy = "",
}) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) throw new Error("Quantity must be a positive number");
  const code = normCode(itemCode);
  const w = normWh(warehouse);
  const u = Number(unitCost) || 0;
  const cid = String(companyId || "");
  if (!cid) throw new Error("companyId is required");

  await InventoryLedger.create({
    companyId: cid,
    itemCode: code,
    warehouse: w,
    movementType,
    qtyDelta: q,
    referenceType,
    referenceId: referenceId ? String(referenceId) : "",
    referenceNumber,
    unitCost: u,
    remarks,
    createdBy,
  });

  const update = { $inc: { quantity: q } };
  if (u > 0) update.$set = { unitCost: u };

  await StockBalance.findOneAndUpdate({ companyId: cid, itemCode: code, warehouse: w }, update, {
    upsert: true,
    new: true,
  });
}

export async function applyStockOut({
  companyId,
  itemCode,
  warehouse,
  qty,
  movementType = "OUT_SALE",
  referenceType = "",
  referenceId = "",
  referenceNumber = "",
  remarks = "",
  createdBy = "",
}) {
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) throw new Error("Quantity must be a positive number");
  const code = normCode(itemCode);
  const w = normWh(warehouse);
  const cid = String(companyId || "");
  if (!cid) throw new Error("companyId is required");

  const updated = await StockBalance.findOneAndUpdate(
    { companyId: cid, itemCode: code, warehouse: w, quantity: { $gte: q } },
    { $inc: { quantity: -q } },
    { new: true }
  );
  if (!updated) throw new Error("Insufficient stock");

  await InventoryLedger.create({
    companyId: cid,
    itemCode: code,
    warehouse: w,
    movementType,
    qtyDelta: -q,
    referenceType,
    referenceId: referenceId ? String(referenceId) : "",
    referenceNumber,
    unitCost: 0,
    remarks,
    createdBy,
  });
  return updated;
}

export async function applyAdjustment({
  companyId,
  itemCode,
  warehouse,
  qtyDelta,
  remarks = "",
  createdBy = "",
}) {
  const d = Number(qtyDelta);
  if (!Number.isFinite(d) || d === 0) throw new Error("qtyDelta must be a non-zero number");
  const code = normCode(itemCode);
  const w = normWh(warehouse);
  const cid = String(companyId || "");
  if (!cid) throw new Error("companyId is required");

  if (d < 0) {
    const out = -d;
    const updated = await StockBalance.findOneAndUpdate(
      { companyId: cid, itemCode: code, warehouse: w, quantity: { $gte: out } },
      { $inc: { quantity: d } },
      { new: true }
    );
    if (!updated) throw new Error("Insufficient stock for adjustment");
  } else {
    await StockBalance.findOneAndUpdate(
      { companyId: cid, itemCode: code, warehouse: w },
      { $inc: { quantity: d } },
      { upsert: true, new: true }
    );
  }

  await InventoryLedger.create({
    companyId: cid,
    itemCode: code,
    warehouse: w,
    movementType: "ADJUSTMENT",
    qtyDelta: d,
    referenceType: "ADJUSTMENT",
    remarks,
    createdBy,
  });
}
