import mongoose from "mongoose";
import StockBalance from "../models/StockBalance.js";
import InventoryLedger from "../models/InventoryLedger.js";

function normCode(itemCode) {
  return String(itemCode || "").trim().toUpperCase();
}

function normWh(warehouse) {
  return String(warehouse || "MAIN").trim().toUpperCase() || "MAIN";
}

/** Free pool = physical quantity − reserved − staged RTS (must stay ≥ 0). */
function availableStockFilter(qty) {
  const q = Number(qty);
  return {
    $expr: {
      $gte: [
        {
          $subtract: [
            "$quantity",
            {
              $add: [{ $ifNull: ["$reservedQty", 0] }, { $ifNull: ["$rtsQty", 0] }],
            },
          ],
        },
        q,
      ],
    },
  };
}

async function writeLedger(session, row) {
  const [doc] = await InventoryLedger.create([row], { session });
  return doc;
}

/**
 * Reserve stock for an order allocation (physical unchanged; reservedQty increases).
 * Critical: only increases reserved when free pool (quantity − reserved − rts) ≥ qty.
 */
export async function applySalesReserve({
  session,
  companyId,
  warehouse,
  lines,
  referenceType,
  referenceId,
  referenceNumber,
  remarks = "",
  createdBy = "",
}) {
  const w = normWh(warehouse);
  const cid = String(companyId || "");
  if (!cid) throw new Error("companyId is required");
  const byArticle = new Map();
  for (const ln of lines || []) {
    const code = normCode(ln.article);
    const q = Number(ln.qty) || 0;
    if (!code || !(q > 0)) continue;
    byArticle.set(code, (byArticle.get(code) || 0) + q);
  }
  const ledgerIds = [];
  for (const [code, q] of byArticle) {
    const updated = await StockBalance.findOneAndUpdate(
      { companyId: cid, itemCode: code, warehouse: w, ...availableStockFilter(q) },
      { $inc: { reservedQty: q } },
      { session, new: true }
    );
    if (!updated) {
      throw new Error(
        `Insufficient available stock to reserve for ${code} (need ${q} in ${w}). Check physical quantity and existing reservations/RTS.`
      );
    }
    const led = await writeLedger(
      session,
      {
        companyId: cid,
        itemCode: code,
        warehouse: w,
        movementType: "SALES_RESERVE",
        qtyDelta: q,
        referenceType: referenceType || "",
        referenceId: referenceId ? String(referenceId) : "",
        referenceNumber: referenceNumber || "",
        remarks: remarks || "",
        createdBy,
      }
    );
    ledgerIds.push(led._id);
  }
  return { ledgerIds };
}

/** Release reservation back to free pool (allocation cancelled / OA unwind path). */
export async function applySalesReleaseReserve({
  session,
  companyId,
  warehouse,
  lines,
  referenceType,
  referenceId,
  referenceNumber,
  remarks = "",
  createdBy = "",
}) {
  const w = normWh(warehouse);
  const cid = String(companyId || "");
  if (!cid) throw new Error("companyId is required");
  const byArticle = new Map();
  for (const ln of lines || []) {
    const code = normCode(ln.article);
    const q = Number(ln.qty) || 0;
    if (!code || !(q > 0)) continue;
    byArticle.set(code, (byArticle.get(code) || 0) + q);
  }
  const ledgerIds = [];
  for (const [code, q] of byArticle) {
    const updated = await StockBalance.findOneAndUpdate(
      {
        companyId: cid,
        itemCode: code,
        warehouse: w,
        $expr: { $gte: [{ $ifNull: ["$reservedQty", 0] }, q] },
      },
      { $inc: { reservedQty: -q } },
      { session, new: true }
    );
    if (!updated) {
      throw new Error(
        `Cannot release reservation for ${code}: reserved quantity is lower than ${q}. Stock may be out of sync — check ledger.`
      );
    }
    const led = await writeLedger(session, {
      companyId: cid,
      itemCode: code,
      warehouse: w,
      movementType: "SALES_RESERVE_RELEASE",
      qtyDelta: -q,
      referenceType: referenceType || "",
      referenceId: referenceId ? String(referenceId) : "",
      referenceNumber: referenceNumber || "",
      remarks: remarks || "",
      createdBy,
    });
    ledgerIds.push(led._id);
  }
  return { ledgerIds };
}

/**
 * RTS approved: move qty from reserved staging to RTS staging (still not invoiced).
 * Physical quantity is unchanged.
 */
export async function applyReservedToRts({
  session,
  companyId,
  warehouse,
  lines,
  referenceType,
  referenceId,
  referenceNumber,
  remarks = "",
  createdBy = "",
}) {
  const w = normWh(warehouse);
  const cid = String(companyId || "");
  if (!cid) throw new Error("companyId is required");
  const byArticle = new Map();
  for (const ln of lines || []) {
    const code = normCode(ln.article);
    const q = Number(ln.qty) || 0;
    if (!code || !(q > 0)) continue;
    byArticle.set(code, (byArticle.get(code) || 0) + q);
  }
  const ledgerIds = [];
  for (const [code, q] of byArticle) {
    const updated = await StockBalance.findOneAndUpdate(
      {
        companyId: cid,
        itemCode: code,
        warehouse: w,
        $expr: { $gte: [{ $ifNull: ["$reservedQty", 0] }, q] },
      },
      { $inc: { reservedQty: -q, rtsQty: q } },
      { session, new: true }
    );
    if (!updated) {
      throw new Error(
        `Cannot move ${code} to RTS: reserved quantity is lower than ${q}. Approve RTS only after allocation reservation exists.`
      );
    }
    const led = await writeLedger(session, {
      companyId: cid,
      itemCode: code,
      warehouse: w,
      movementType: "SALES_RESERVED_TO_RTS",
      qtyDelta: 0,
      referenceType: referenceType || "",
      referenceId: referenceId ? String(referenceId) : "",
      referenceNumber: referenceNumber || "",
      remarks: (remarks || "") + " [reserved→RTS bucket]",
      createdBy,
    });
    ledgerIds.push(led._id);
  }
  return { ledgerIds };
}

/** RTS cancelled (was APPROVED): move qty from RTS bucket back to reserved. */
export async function applyRtsToReserved({
  session,
  companyId,
  warehouse,
  lines,
  referenceType,
  referenceId,
  referenceNumber,
  remarks = "",
  createdBy = "",
}) {
  const w = normWh(warehouse);
  const cid = String(companyId || "");
  if (!cid) throw new Error("companyId is required");
  const byArticle = new Map();
  for (const ln of lines || []) {
    const code = normCode(ln.article);
    const q = Number(ln.qty) || 0;
    if (!code || !(q > 0)) continue;
    byArticle.set(code, (byArticle.get(code) || 0) + q);
  }
  const ledgerIds = [];
  for (const [code, q] of byArticle) {
    const updated = await StockBalance.findOneAndUpdate(
      {
        companyId: cid,
        itemCode: code,
        warehouse: w,
        $expr: { $gte: [{ $ifNull: ["$rtsQty", 0] }, q] },
      },
      { $inc: { rtsQty: -q, reservedQty: q } },
      { session, new: true }
    );
    if (!updated) {
      throw new Error(`Cannot reverse RTS for ${code}: RTS bucket is lower than ${q}.`);
    }
    const led = await writeLedger(session, {
      companyId: cid,
      itemCode: code,
      warehouse: w,
      movementType: "SALES_RTS_TO_RESERVED",
      qtyDelta: 0,
      referenceType: referenceType || "",
      referenceId: referenceId ? String(referenceId) : "",
      referenceNumber: referenceNumber || "",
      remarks: (remarks || "") + " [RTS→reserved bucket]",
      createdBy,
    });
    ledgerIds.push(led._id);
  }
  return { ledgerIds };
}

/**
 * Sales invoice posting: reduce physical quantity and consume RTS first, then reserved
 * for any remainder (covers invoices that still carry full OA qty while RTS was partial).
 */
export async function applySalesInvoiceOut({
  session,
  companyId,
  warehouse,
  lines,
  referenceType,
  referenceId,
  referenceNumber,
  remarks = "",
  createdBy = "",
}) {
  const w = normWh(warehouse);
  const cid = String(companyId || "");
  if (!cid) throw new Error("companyId is required");
  const byArticle = new Map();
  for (const ln of lines || []) {
    const code = normCode(ln.article);
    const q = Number(ln.qty) || 0;
    if (!code || !(q > 0)) continue;
    byArticle.set(code, (byArticle.get(code) || 0) + q);
  }
  const ledgerIds = [];
  for (const [code, invQty] of byArticle) {
    const bal = await StockBalance.findOne({ companyId: cid, itemCode: code, warehouse: w }).session(session);
    if (!bal) throw new Error(`No stock balance for ${code} in ${w}`);
    const rts = Number(bal.rtsQty) || 0;
    const res = Number(bal.reservedQty) || 0;
    const phys = Number(bal.quantity) || 0;
    const fromRts = Math.min(invQty, rts);
    const rest = invQty - fromRts;
    if (rest > res) {
      throw new Error(
        `Cannot post invoice for ${code}: invoice qty ${invQty} exceeds RTS (${rts}) + reserved (${res}). Check RTS approval and allocation.`
      );
    }
    if (phys < invQty) throw new Error(`Cannot post invoice for ${code}: physical quantity insufficient (have ${phys}, need ${invQty}).`);

    const updated = await StockBalance.findOneAndUpdate(
      {
        companyId: cid,
        itemCode: code,
        warehouse: w,
        $expr: {
          $and: [
            { $gte: ["$quantity", invQty] },
            { $gte: [{ $ifNull: ["$rtsQty", 0] }, fromRts] },
            { $gte: [{ $ifNull: ["$reservedQty", 0] }, rest] },
          ],
        },
      },
      { $inc: { quantity: -invQty, rtsQty: -fromRts, reservedQty: -rest } },
      { session, new: true }
    );
    if (!updated) {
      throw new Error(`Cannot post invoice for ${code}: concurrent stock change or insufficient RTS/reserved split. Retry.`);
    }

    const led = await writeLedger(session, {
      companyId: cid,
      itemCode: code,
      warehouse: w,
      movementType: "SALES_INVOICE_OUT",
      qtyDelta: -invQty,
      referenceType: referenceType || "",
      referenceId: referenceId ? String(referenceId) : "",
      referenceNumber: referenceNumber || "",
      remarks:
        (remarks || "") +
        ` [invoice out: fromRts=${fromRts}, fromReserved=${rest}]`,
      createdBy,
    });
    ledgerIds.push(led._id);
  }
  return { ledgerIds };
}

/** Cancel sales invoice: restore physical qty and place goods back into RTS bucket (one step back). */
export async function applySalesInvoiceCancelRestore({
  session,
  companyId,
  warehouse,
  lines,
  referenceType,
  referenceId,
  referenceNumber,
  remarks = "",
  createdBy = "",
}) {
  const w = normWh(warehouse);
  const cid = String(companyId || "");
  if (!cid) throw new Error("companyId is required");
  const byArticle = new Map();
  for (const ln of lines || []) {
    const code = normCode(ln.article);
    const q = Number(ln.qty) || 0;
    if (!code || !(q > 0)) continue;
    byArticle.set(code, (byArticle.get(code) || 0) + q);
  }
  const ledgerIds = [];
  for (const [code, invQty] of byArticle) {
    await StockBalance.findOneAndUpdate(
      { companyId: cid, itemCode: code, warehouse: w },
      { $inc: { quantity: invQty, rtsQty: invQty } },
      { session, upsert: true, new: true }
    );
    const led = await writeLedger(session, {
      companyId: cid,
      itemCode: code,
      warehouse: w,
      movementType: "SALES_INVOICE_CANCEL_RESTORE",
      qtyDelta: invQty,
      referenceType: referenceType || "",
      referenceId: referenceId ? String(referenceId) : "",
      referenceNumber: referenceNumber || "",
      remarks: (remarks || "") + " [invoice cancel → RTS bucket]",
      createdBy,
    });
    ledgerIds.push(led._id);
  }
  return { ledgerIds };
}

export async function withTransaction(fn) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const result = await fn(session);
    await session.commitTransaction();
    return result;
  } catch (e) {
    await session.abortTransaction();
    throw e;
  } finally {
    session.endSession();
  }
}
