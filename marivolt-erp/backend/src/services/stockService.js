/**
 * services/stockService.js
 * ---------------------------------------------------------------
 * Centralised, reusable Stock service. This is the single entry
 * point for new ERP stock movements going forward (Phase-3).
 *
 * Design notes:
 *   • All movements persist running balances on the ledger row
 *     itself (onHandAfter / allocatedAfter / rtsAfter /
 *     availableAfter) so the unified Stock Ledger view never has
 *     to aggregate the entire ledger to render a row.
 *   • Allocation is allowed to push availableAfter < 0. The
 *     caller can opt-out by passing `allowNegative: false`.
 *   • The legacy `salesStockService.js` (InventoryLedger writer)
 *     and `stockLedgerService.postLedgerMovement` (StockLedger
 *     writer for GRN/Adjustment/Transfer) are NOT modified by
 *     this module. They keep working until each call site is
 *     migrated to use `stockService` directly.
 *   • The Phase-3 unified projection endpoint (`/api/store/
 *     stock-ledger/unified`) merges StockLedger + InventoryLedger
 *     rows, so any caller migrated to `stockService` continues to
 *     show up correctly in the Store > Stock Ledger UI.
 * ---------------------------------------------------------------
 */

import mongoose from "mongoose";
import StockBalance from "../models/StockBalance.js";
import StockLedger from "../models/StockLedger.js";
import InventoryLedger from "../models/InventoryLedger.js";

/* --------------------------------------------------------------- */
/*  Constants                                                       */
/* --------------------------------------------------------------- */

/** Unified Phase-3 movement-type vocabulary. */
export const MOVEMENT_TYPES = Object.freeze({
  GRN_IN: "GRN_IN",
  LANDED_COST_ADJUSTMENT: "LANDED_COST_ADJUSTMENT",
  KIT_ASSEMBLY_OUT: "KIT_ASSEMBLY_OUT",
  KIT_ASSEMBLY_IN: "KIT_ASSEMBLY_IN",
  DEKIT_OUT: "DEKIT_OUT",
  DEKIT_IN: "DEKIT_IN",
  ALLOCATION: "ALLOCATION",
  ALLOCATION_CANCEL: "ALLOCATION_CANCEL",
  RTS_TRANSFER: "RTS_TRANSFER",
  RTS_CANCEL: "RTS_CANCEL",
  SALES_INVOICE_OUT: "SALES_INVOICE_OUT",
  SALES_INVOICE_CANCEL: "SALES_INVOICE_CANCEL",
  STOCK_TRANSFER_OUT: "STOCK_TRANSFER_OUT",
  STOCK_TRANSFER_IN: "STOCK_TRANSFER_IN",
  STOCK_ADJUSTMENT: "STOCK_ADJUSTMENT",
  OPENING_BALANCE: "OPENING_BALANCE",
  PACKED: "PACKED",
  UNPACKED: "UNPACKED",
  DISPATCH_OUT: "DISPATCH_OUT",
  DISPATCH_CANCEL: "DISPATCH_CANCEL",
});

/**
 * Maps unified movement types back to a legacy `transactionType`
 * (StockLedger enum) so the schema's enum validator accepts the
 * row. This keeps backward-compat reads of `transactionType`
 * working unchanged.
 */
const UNIFIED_TO_LEGACY_TX = Object.freeze({
  GRN_IN: "GRN",
  LANDED_COST_ADJUSTMENT: "STOCK_ADJUSTMENT",
  KIT_ASSEMBLY_OUT: "STOCK_ADJUSTMENT",
  KIT_ASSEMBLY_IN: "STOCK_ADJUSTMENT",
  DEKIT_OUT: "STOCK_ADJUSTMENT",
  DEKIT_IN: "STOCK_ADJUSTMENT",
  ALLOCATION: "SALES_ALLOCATION",
  ALLOCATION_CANCEL: "ORDER_ALLOCATION_CANCEL",
  RTS_TRANSFER: "RTS",
  RTS_CANCEL: "RTS_CANCEL",
  SALES_INVOICE_OUT: "SALES_INVOICE",
  SALES_INVOICE_CANCEL: "SALES_INVOICE_CANCEL",
  STOCK_TRANSFER_OUT: "TRANSFER_OUT",
  STOCK_TRANSFER_IN: "TRANSFER_IN",
  STOCK_ADJUSTMENT: "STOCK_ADJUSTMENT",
  OPENING_BALANCE: "OPENING",
  PACKED: "PACKED",
  UNPACKED: "UNPACKED",
  DISPATCH_OUT: "DISPATCH_OUT",
  DISPATCH_CANCEL: "DISPATCH_CANCEL",
});

/* --------------------------------------------------------------- */
/*  Internal helpers                                                */
/* --------------------------------------------------------------- */

function s(v) {
  return String(v ?? "").trim();
}

function up(v) {
  return s(v).toUpperCase();
}

function normWarehouse(warehouse) {
  return up(warehouse) || "MAIN";
}

function normArticle(article) {
  return up(article);
}

function requireCompanyId(companyId) {
  if (!companyId) throw new Error("companyId is required");
  return String(companyId);
}

/**
 * Reads the current StockBalance row for an article+warehouse.
 * Always returns a derived view with the same shape as the rest
 * of the ERP, regardless of whether the row exists yet.
 */
export async function getStockBalance({ companyId, article, warehouse, session }) {
  requireCompanyId(companyId);
  const code = normArticle(article);
  const wh = normWarehouse(warehouse);
  if (!code) throw new Error("article is required");
  const query = StockBalance.findOne({
    companyId,
    $or: [
      { itemCode: code, warehouse: wh },
      { article: code, location: wh },
    ],
  });
  if (session) query.session(session);
  const row = await query.lean();
  return deriveBalanceShape(row, { companyId, code, wh });
}

function deriveBalanceShape(row, fallback = {}) {
  const onHand = Number(row?.onHandQty ?? row?.quantity ?? 0) || 0;
  const allocated = Math.max(
    Number(row?.allocatedQty || 0),
    Number(row?.reservedQty || 0)
  );
  const rts = Number(row?.rtsQty || 0);
  const packed = Number(row?.packedQty || 0) || 0;
  const dispatched = Number(row?.dispatchedQty || 0) || 0;
  const available = onHand - allocated - rts - packed;
  return {
    _id: row?._id || null,
    companyId: row?.companyId || fallback.companyId || null,
    article: String(row?.article || row?.itemCode || fallback.code || "").toUpperCase(),
    warehouse: String(row?.warehouse || row?.location || fallback.wh || "MAIN").toUpperCase(),
    onHandQty: onHand,
    allocatedQty: allocated,
    reservedQty: allocated,
    rtsQty: rts,
    packedQty: packed,
    dispatchedQty: dispatched,
    availableQty: available,
    isNegativeAvailable: available < 0,
    raw: row || null,
  };
}

/**
 * Captures the Stock Balance state AFTER a mutation has been
 * applied. Returned shape is the four `*After` fields the new
 * ledger schemas require.
 *
 * Aggregates across all batch/serial sub-rows for the same
 * (article, warehouse) so callers always see warehouse-level
 * running balances on the ledger row, regardless of whether the
 * write was on a specific batched sub-row.
 */
async function snapshotAfter({ companyId, article, warehouse, session }) {
  const code = normArticle(article);
  const wh = normWarehouse(warehouse);
  const query = StockBalance.find({
    companyId,
    $or: [
      { itemCode: code, warehouse: wh },
      { article: code, location: wh },
    ],
  });
  if (session) query.session(session);
  const rows = await query.lean();
  let onHand = 0;
  let allocated = 0;
  let rts = 0;
  let packed = 0;
  let dispatched = 0;
  for (const r of rows) {
    onHand += Number(r?.onHandQty ?? r?.quantity ?? 0) || 0;
    allocated += Math.max(Number(r?.allocatedQty || 0), Number(r?.reservedQty || 0));
    rts += Number(r?.rtsQty || 0);
    packed += Number(r?.packedQty || 0) || 0;
    dispatched += Number(r?.dispatchedQty || 0) || 0;
  }
  const available = onHand - allocated - rts - packed;
  return {
    onHandAfter: onHand,
    allocatedAfter: allocated,
    rtsAfter: rts,
    packedAfter: packed,
    dispatchedAfter: dispatched,
    availableAfter: available,
    isNegativeAvailable: available < 0,
  };
}

/**
 * Recomputes `availableQty` on the StockBalance row from the
 * persisted on-hand/allocated/rts buckets and ensures the
 * canonical bucket fields stay in sync with their legacy
 * aliases (`quantity`, `reservedQty`).
 *
 * Useful for repair scripts and after data import; not part
 * of the hot path.
 */
export async function recalculateStockBalance({ companyId, article, warehouse, session }) {
  requireCompanyId(companyId);
  const code = normArticle(article);
  const wh = normWarehouse(warehouse);
  const filter = { companyId, $or: [{ itemCode: code, warehouse: wh }, { article: code, location: wh }] };
  const query = StockBalance.findOne(filter);
  if (session) query.session(session);
  const row = await query;
  if (!row) return null;
  const onHand = Number(row.onHandQty ?? row.quantity ?? 0) || 0;
  const allocated = Math.max(Number(row.allocatedQty || 0), Number(row.reservedQty || 0));
  const rts = Number(row.rtsQty || 0);
  const packed = Number(row.packedQty || 0) || 0;
  const dispatched = Math.max(0, Number(row.dispatchedQty || 0));
  row.onHandQty = onHand;
  row.quantity = onHand;
  row.allocatedQty = allocated;
  row.reservedQty = allocated;
  row.rtsQty = rts;
  row.packedQty = packed;
  row.dispatchedQty = dispatched;
  row.availableQty = onHand - allocated - rts - packed;
  row.itemCode = code;
  row.article = code;
  row.warehouse = wh;
  row.location = wh;
  await row.save({ session });
  return deriveBalanceShape(row.toObject(), { companyId, code, wh });
}

/**
 * Builds a unified StockLedger row payload. We populate BOTH
 * legacy and Phase-3 fields so historical readers continue to
 * work unchanged.
 */
function buildLedgerRow({
  companyId,
  movementType,
  transactionDate,
  article,
  warehouse,
  locationFrom = "",
  locationTo = "",
  qtyIn = 0,
  qtyOut = 0,
  referenceType = "",
  referenceNo = "",
  customerName = "",
  supplierName = "",
  remarks = "",
  createdBy = "",
  unitCost = 0,
  oldCost = null,
  newCost = null,
  valuationDelta = null,
  allocationId = null,
  currency = "USD",
  sourceModule = "",
  isNegativeAllocation = false,
  onHandAfter = null,
  allocatedAfter = null,
  rtsAfter = null,
  packedAfter = null,
  availableAfter = null,
  batchNo = "",
  serialNo = "",
}) {
  const code = normArticle(article);
  const wh = normWarehouse(warehouse);
  const legacyTx = UNIFIED_TO_LEGACY_TX[movementType] || "STOCK_ADJUSTMENT";
  const physicalLocation = locationTo || warehouse || locationFrom;
  return {
    companyId,
    transactionDate: transactionDate || new Date(),
    transactionType: legacyTx,
    movementType,
    sourceModule: s(sourceModule),
    referenceType: s(referenceType),
    referenceNo: s(referenceNo),
    article: code,
    location: up(physicalLocation),
    warehouse: wh,
    locationFrom: up(locationFrom),
    locationTo: up(locationTo),
    customerName: s(customerName),
    supplierName: s(supplierName),
    batchNo: s(batchNo),
    serialNo: s(serialNo),
    qtyIn: Math.max(0, Number(qtyIn) || 0),
    qtyOut: Math.max(0, Number(qtyOut) || 0),
    balanceQty: onHandAfter == null ? 0 : Number(onHandAfter),
    onHandAfter,
    allocatedAfter,
    rtsAfter,
    packedAfter,
    availableAfter,
    isNegativeAllocation: Boolean(isNegativeAllocation),
    unitCost: Number(unitCost) || 0,
    oldCost: oldCost == null ? null : Number(oldCost),
    newCost: newCost == null ? null : Number(newCost),
    valuationDelta: valuationDelta == null ? null : Number(valuationDelta),
    allocationId: allocationId || null,
    currency: up(currency) || "USD",
    remarks: s(remarks),
    createdBy: s(createdBy),
  };
}

/**
 * Writes a single unified ledger row. This is the only path
 * that creates StockLedger documents inside `stockService` —
 * every higher-level operation funnels through here so the
 * Phase-3 invariants (after-balances persisted, customer/
 * supplier captured, sourceModule tagged) are uniformly
 * applied.
 */
export async function createStockLedgerEntry(data) {
  requireCompanyId(data?.companyId);
  const row = buildLedgerRow(data);
  const [doc] = await StockLedger.create([row], { session: data?.session });
  return doc;
}

/* --------------------------------------------------------------- */
/*  StockBalance mutators (private to this module)                  */
/* --------------------------------------------------------------- */

/**
 * Atomically adjusts one or more bucket counters on a stock row,
 * with an optional availability guard for non-negative paths.
 * Returns the post-mutation document.
 */
async function bumpBuckets({
  session,
  companyId,
  article,
  warehouse,
  inc,
  guard = null,
  upsert = false,
  batchNo = "",
  serialNo = "",
}) {
  const code = normArticle(article);
  const wh = normWarehouse(warehouse);
  const bn = s(batchNo);
  const sn = s(serialNo);
  // The StockBalance unique index is (companyId, article, location,
  // batchNo, serialNo). We filter by that canonical key so any legacy
  // row written by GRN / Sales / Inventory paths is found regardless
  // of which alias pair (itemCode/warehouse vs article/location) the
  // older writer used. The $setOnInsert below seeds both pairs for
  // brand-new rows so every consumer sees the same data.
  const filter = {
    companyId,
    article: code,
    location: wh,
    batchNo: bn,
    serialNo: sn,
  };
  if (guard) Object.assign(filter, guard);
  const update = { $inc: inc };
  if (upsert) {
    const insertDefaults = {
      companyId,
      article: code,
      location: wh,
      itemCode: code,
      warehouse: wh,
      batchNo: bn,
      serialNo: sn,
      quantity: 0,
      onHandQty: 0,
      allocatedQty: 0,
      rtsQty: 0,
      packedQty: 0,
      dispatchedQty: 0,
    };
    for (const field of Object.keys(inc || {})) {
      delete insertDefaults[field];
    }
    update.$setOnInsert = insertDefaults;
  }
  const updated = await StockBalance.findOneAndUpdate(filter, update, {
    session,
    new: true,
    upsert,
    setDefaultsOnInsert: false,
  });
  return updated;
}

/* --------------------------------------------------------------- */
/*  High-level operations                                           */
/* --------------------------------------------------------------- */

/**
 * GRN_IN — register a Goods-Received movement. Increases on-hand
 * physical quantity. Both `onHandQty` and the legacy `quantity`
 * alias are kept in sync.
 */
export async function grnReceive({
  session,
  companyId,
  article,
  warehouse,
  qty,
  referenceType = "GRN",
  referenceNo,
  supplierName = "",
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  unitCost = 0,
  currency = "USD",
  batchNo = "",
  serialNo = "",
  transactionDate = null,
  /** Free-text putaway / bin (GRN line); appended to ledger remarks for traceability. */
  putawayLocation = "",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("grnReceive: qty must be > 0");
  const put = s(putawayLocation || "");
  const remarkParts = [s(remarks), put ? `Putaway: ${put}` : ""].filter(Boolean);
  const remarksCombined = remarkParts.join(" | ");
  await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    batchNo,
    serialNo,
    inc: { quantity: q, onHandQty: q },
    upsert: true,
  });
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.GRN_IN,
    article,
    warehouse,
    locationTo: warehouse,
    qtyIn: q,
    referenceType,
    referenceNo,
    supplierName,
    remarks: remarksCombined,
    createdBy,
    sourceModule,
    unitCost,
    currency,
    batchNo,
    serialNo,
    ...after,
  });
}

/**
 * GRN_CANCEL — undo a previously-posted GRN line. Only allowed if
 * the qty hasn't already been allocated/sold (we guard against
 * negative on-hand or available). Writes a STOCK_ADJUSTMENT
 * ledger row tagged with `referenceType: "GRN_CANCEL"` so it
 * stays distinct from manual adjustments in reports.
 */
export async function cancelGrn({
  session,
  companyId,
  article,
  warehouse,
  qty,
  referenceNo,
  supplierName = "",
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  unitCost = 0,
  currency = "USD",
  batchNo = "",
  serialNo = "",
  transactionDate = null,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("cancelGrn: qty must be > 0");
  // Guard: the canonical row must have at least `q` on-hand AND at
  // least `q` Available (on-hand − reserved − rts). This matches the
  // legacy `cancelGrn` controller's own pre-check but does it
  // atomically inside the transaction.
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    batchNo,
    serialNo,
    inc: { quantity: -q, onHandQty: -q },
    guard: {
      $expr: {
        $and: [
          { $gte: [{ $ifNull: ["$onHandQty", 0] }, q] },
          {
            $gte: [
              {
                $subtract: [
                  { $ifNull: ["$onHandQty", 0] },
                  {
                    $add: [
                      { $ifNull: ["$reservedQty", 0] },
                      { $ifNull: ["$rtsQty", 0] },
                      { $ifNull: ["$packedQty", 0] },
                    ],
                  },
                ],
              },
              q,
            ],
          },
        ],
      },
    },
  });
  if (!updated) {
    throw new Error(
      `cancelGrn: cannot reduce ${normArticle(article)} by ${q} in ${normWarehouse(warehouse)} — stock already allocated/sold.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    // Tag the row as STOCK_ADJUSTMENT so it lands in the same bucket
    // as other manual adjustments; the `referenceType: GRN_CANCEL`
    // filter still lets reports separate them when needed.
    movementType: MOVEMENT_TYPES.STOCK_ADJUSTMENT,
    article,
    warehouse,
    locationFrom: warehouse,
    qtyOut: q,
    referenceType: "GRN_CANCEL",
    referenceNo,
    supplierName,
    remarks,
    createdBy,
    sourceModule,
    unitCost,
    currency,
    batchNo,
    serialNo,
    ...after,
  });
}

/**
 * OPENING_BALANCE — sets up the very first physical quantity
 * for an article+warehouse pair. Behaves like a GRN_IN with a
 * different label.
 */
export async function openingBalance({
  session,
  companyId,
  article,
  warehouse,
  qty,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  unitCost = 0,
  currency = "USD",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("openingBalance: qty must be > 0");
  await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { quantity: q, onHandQty: q },
    upsert: true,
  });
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    movementType: MOVEMENT_TYPES.OPENING_BALANCE,
    article,
    warehouse,
    locationTo: warehouse,
    qtyIn: q,
    referenceType: "OPENING",
    remarks,
    createdBy,
    sourceModule,
    unitCost,
    currency,
    ...after,
  });
}

/**
 * ALLOCATION — reserves stock for a customer/order. Increases
 * `allocatedQty` (and its legacy alias `reservedQty`). Allowed
 * to push `availableAfter` below zero when `allowNegative` is
 * truthy; otherwise throws a structured `STOCK_INSUFFICIENT`
 * error compatible with the existing frontend confirm-flow.
 */
export async function allocateStock({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType,
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "SALES",
  allowNegative = false,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("allocateStock: qty must be > 0");

  let updated;
  // Note: we deliberately mutate only `reservedQty` and NOT
  // `allocatedQty` here. Legacy rows (created before Phase-3) carry
  // their reservation only on `reservedQty` while `allocatedQty`
  // remained 0. Touching both buckets symmetrically would push
  // `allocatedQty` negative when the matching cancellation runs on
  // those legacy rows. The unified Stock View already takes
  // `Math.max(allocatedQty, reservedQty)` so the read-side picks up
  // the canonical value either way.
  if (allowNegative) {
    updated = await bumpBuckets({
      session,
      companyId,
      article,
      warehouse,
      inc: { reservedQty: q },
      upsert: true,
    });
  } else {
    // Guard ensures (quantity − reserved − rts) ≥ qty before incrementing.
    updated = await bumpBuckets({
      session,
      companyId,
      article,
      warehouse,
      inc: { reservedQty: q },
      guard: {
        $expr: {
          $gte: [
            {
              $subtract: [
                { $ifNull: ["$quantity", 0] },
                {
                  $add: [
                    { $ifNull: ["$reservedQty", 0] },
                    { $ifNull: ["$rtsQty", 0] },
                    { $ifNull: ["$packedQty", 0] },
                  ],
                },
              ],
            },
            q,
          ],
        },
      },
    });
    if (!updated) {
      const view = await getStockBalance({ companyId, article, warehouse, session });
      const err = new Error(
        `Insufficient available stock to reserve for ${normArticle(article)} (need ${q} in ${normWarehouse(warehouse)}, available ${view.availableQty}). Pass allowNegative:true to override.`
      );
      err.statusCode = 409;
      err.code = "STOCK_INSUFFICIENT";
      err.details = {
        article: normArticle(article),
        needed: q,
        available: view.availableQty,
        warehouse: normWarehouse(warehouse),
      };
      throw err;
    }
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    movementType: MOVEMENT_TYPES.ALLOCATION,
    article,
    warehouse,
    qtyOut: q, // allocation drains Available, surface as out for that pool
    referenceType,
    referenceNo,
    customerName,
    remarks: after.isNegativeAvailable
      ? `${remarks || ""}${remarks ? " " : ""}[NEGATIVE: available ${after.availableAfter}]`
      : remarks,
    createdBy,
    sourceModule,
    isNegativeAllocation: after.isNegativeAvailable,
    ...after,
  });
}

/**
 * ALLOCATION_CANCEL — releases an existing reservation back to
 * the free pool. Decreases `allocatedQty`/`reservedQty`. Does
 * not change physical on-hand.
 */
export async function cancelAllocation({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType,
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "SALES",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("cancelAllocation: qty must be > 0");
  // See note in `allocateStock`: only mutate the `reservedQty` bucket
  // so legacy rows do not push `allocatedQty` negative.
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { reservedQty: -q },
    guard: { $expr: { $gte: [{ $ifNull: ["$reservedQty", 0] }, q] } },
  });
  if (!updated) {
    throw new Error(
      `cancelAllocation: reserved bucket lower than ${q} for ${normArticle(article)} in ${normWarehouse(warehouse)}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    movementType: MOVEMENT_TYPES.ALLOCATION_CANCEL,
    article,
    warehouse,
    qtyIn: q, // releasing makes Available rise — surface as in for that pool
    referenceType,
    referenceNo,
    customerName,
    remarks,
    createdBy,
    sourceModule,
    ...after,
  });
}

/**
 * RTS_TRANSFER — moves qty from `allocatedQty` to `rtsQty`
 * (Ready-To-Ship staging). Available is unchanged. No physical
 * goods move.
 */
export async function moveAllocationToRTS({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType,
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "SALES",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("moveAllocationToRTS: qty must be > 0");
  // See note in `allocateStock`: only mutate the `reservedQty` bucket.
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { reservedQty: -q, rtsQty: q },
    guard: { $expr: { $gte: [{ $ifNull: ["$reservedQty", 0] }, q] } },
  });
  if (!updated) {
    throw new Error(
      `moveAllocationToRTS: allocated bucket lower than ${q} for ${normArticle(article)} in ${normWarehouse(warehouse)}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    movementType: MOVEMENT_TYPES.RTS_TRANSFER,
    article,
    warehouse,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[allocated→RTS]`.trim(),
    createdBy,
    sourceModule,
    ...after,
  });
}

/** RTS_CANCEL — moves qty back from `rtsQty` to `allocatedQty`. */
export async function cancelRTS({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType,
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "SALES",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("cancelRTS: qty must be > 0");
  // See note in `allocateStock`: only mutate the `reservedQty` bucket.
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { rtsQty: -q, reservedQty: q },
    guard: { $expr: { $gte: [{ $ifNull: ["$rtsQty", 0] }, q] } },
  });
  if (!updated) {
    throw new Error(
      `cancelRTS: rts bucket lower than ${q} for ${normArticle(article)} in ${normWarehouse(warehouse)}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    movementType: MOVEMENT_TYPES.RTS_CANCEL,
    article,
    warehouse,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[RTS→allocated]`.trim(),
    createdBy,
    sourceModule,
    ...after,
  });
}

/**
 * SALES_INVOICE_OUT — physical goods leave inventory. Consumes
 * `rtsQty` first, then `allocatedQty`/`reservedQty` for any
 * remainder. Decreases `quantity`/`onHandQty` by the full qty.
 */
export async function invoiceFromRTS({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType,
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "SALES",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("invoiceFromRTS: qty must be > 0");
  const code = normArticle(article);
  const wh = normWarehouse(warehouse);
  const bal = await StockBalance.findOne({ companyId, itemCode: code, warehouse: wh }).session(session);
  if (!bal) throw new Error(`No stock balance for ${code} in ${wh}`);
  const rts = Number(bal.rtsQty) || 0;
  const allocated = Math.max(Number(bal.allocatedQty || 0), Number(bal.reservedQty || 0));
  const fromRts = Math.min(q, rts);
  const fromAllocated = q - fromRts;
  if (fromAllocated > allocated) {
    throw new Error(
      `invoiceFromRTS: invoice qty ${q} exceeds RTS (${rts}) + allocated (${allocated}) for ${code}.`
    );
  }
  const updated = await StockBalance.findOneAndUpdate(
    {
      companyId,
      itemCode: code,
      warehouse: wh,
      $expr: {
        $and: [
          { $gte: [{ $ifNull: ["$quantity", 0] }, q] },
          { $gte: [{ $ifNull: ["$rtsQty", 0] }, fromRts] },
          { $gte: [{ $ifNull: ["$reservedQty", 0] }, fromAllocated] },
        ],
      },
    },
    {
      $inc: {
        quantity: -q,
        onHandQty: -q,
        rtsQty: -fromRts,
        // See note in `allocateStock`: legacy rows track allocation
        // only on `reservedQty`, so we only decrement that.
        reservedQty: -fromAllocated,
      },
    },
    { session, new: true }
  );
  if (!updated) {
    throw new Error(
      `invoiceFromRTS: concurrent stock change or insufficient buckets for ${code}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    movementType: MOVEMENT_TYPES.SALES_INVOICE_OUT,
    article,
    warehouse,
    qtyOut: q,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[fromRts=${fromRts}, fromAllocated=${fromAllocated}]`.trim(),
    createdBy,
    sourceModule,
    ...after,
  });
}

/**
 * SALES_INVOICE_CANCEL — undoes a posted invoice. Restores
 * `onHandQty` and pushes the qty back into `rtsQty` (one step
 * back from where the invoice flow consumed it).
 */
export async function cancelInvoice({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType,
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "SALES",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("cancelInvoice: qty must be > 0");
  await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { quantity: q, onHandQty: q, rtsQty: q },
    upsert: true,
  });
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    movementType: MOVEMENT_TYPES.SALES_INVOICE_CANCEL,
    article,
    warehouse,
    qtyIn: q,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[invoice cancel → RTS]`.trim(),
    createdBy,
    sourceModule,
    ...after,
  });
}

/**
 * STOCK_TRANSFER_OUT + STOCK_TRANSFER_IN — atomically moves qty
 * from one warehouse to another. Two ledger entries are written
 * so each warehouse sees its own balance change.
 */
export async function stockTransfer({
  session,
  companyId,
  article,
  fromWarehouse,
  toWarehouse,
  qty,
  referenceType = "TRANSFER",
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  allowNegative = false,
  transactionDate = null,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("stockTransfer: qty must be > 0");
  const fromWh = normWarehouse(fromWarehouse);
  const toWh = normWarehouse(toWarehouse);
  if (fromWh === toWh) throw new Error("stockTransfer: from and to warehouse must differ");
  // OUT side
  const outGuard = allowNegative
    ? null
    : {
        $expr: {
          $gte: [
            {
              $subtract: [
                { $ifNull: ["$quantity", 0] },
                { $add: [{ $ifNull: ["$reservedQty", 0] }, { $ifNull: ["$rtsQty", 0] }, { $ifNull: ["$packedQty", 0] }] },
              ],
            },
            q,
          ],
        },
      };
  const outUpdated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse: fromWh,
    inc: { quantity: -q, onHandQty: -q },
    guard: outGuard,
  });
  if (!outUpdated) {
    throw new Error(
      `stockTransfer: insufficient available qty in ${fromWh} for ${normArticle(article)}.`
    );
  }
  await bumpBuckets({
    session,
    companyId,
    article,
    warehouse: toWh,
    inc: { quantity: q, onHandQty: q },
    upsert: true,
  });
  const fromAfter = await snapshotAfter({ companyId, article, warehouse: fromWh, session });
  const outRow = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.STOCK_TRANSFER_OUT,
    article,
    warehouse: fromWh,
    locationFrom: fromWh,
    locationTo: toWh,
    qtyOut: q,
    referenceType,
    referenceNo,
    remarks,
    createdBy,
    sourceModule,
    ...fromAfter,
  });
  const toAfter = await snapshotAfter({ companyId, article, warehouse: toWh, session });
  const inRow = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.STOCK_TRANSFER_IN,
    article,
    warehouse: toWh,
    locationFrom: fromWh,
    locationTo: toWh,
    qtyIn: q,
    referenceType,
    referenceNo,
    remarks,
    createdBy,
    sourceModule,
    ...toAfter,
  });
  return { out: outRow, in: inRow };
}

/**
 * STOCK_ADJUSTMENT — manual increase or decrease of physical
 * quantity (cycle-count fix, damage write-off, etc).
 */
export async function stockAdjustment({
  session,
  companyId,
  article,
  warehouse,
  qty,
  direction = "Increase",
  referenceType = "STOCK_ADJUSTMENT",
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  allowNegative = false,
  movementType = MOVEMENT_TYPES.STOCK_ADJUSTMENT,
  transactionDate = null,
}) {
  requireCompanyId(companyId);
  const q = Math.abs(Number(qty) || 0);
  if (!(q > 0)) throw new Error("stockAdjustment: qty must be > 0");
  const isIncrease = String(direction).toLowerCase() === "increase";
  const incQty = isIncrease ? q : -q;
  const guard =
    isIncrease || allowNegative
      ? null
      : {
          $expr: {
            $gte: [
              {
                $subtract: [
                  { $ifNull: ["$quantity", 0] },
                  { $add: [{ $ifNull: ["$reservedQty", 0] }, { $ifNull: ["$rtsQty", 0] }, { $ifNull: ["$packedQty", 0] }] },
                ],
              },
              q,
            ],
          },
        };
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { quantity: incQty, onHandQty: incQty },
    guard,
    upsert: isIncrease,
  });
  if (!updated) {
    throw new Error(
      `stockAdjustment: insufficient available qty for decrease in ${normWarehouse(warehouse)}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType,
    article,
    warehouse,
    qtyIn: isIncrease ? q : 0,
    qtyOut: isIncrease ? 0 : q,
    referenceType,
    referenceNo,
    remarks,
    createdBy,
    sourceModule,
    ...after,
  });
}

/**
 * PACKED — moves qty from reserved (allocation) into packed staging.
 * Physical on-hand unchanged; available unchanged.
 */
export async function packFromAllocation({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType = "STORE_PACKING",
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  allocationId = null,
  transactionDate = null,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("packFromAllocation: qty must be > 0");
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { reservedQty: -q, packedQty: q },
    guard: { $expr: { $gte: [{ $ifNull: ["$reservedQty", 0] }, q] } },
  });
  if (!updated) {
    throw new Error(
      `packFromAllocation: reserved bucket lower than ${q} for ${normArticle(article)} in ${normWarehouse(warehouse)}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.PACKED,
    article,
    warehouse,
    qtyOut: q,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[reserved→packed]`.trim(),
    createdBy,
    sourceModule,
    allocationId,
    ...after,
  });
}

/**
 * UNPACKED — reverses posted packing: packed → reserved.
 */
export async function unpackFromPacked({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType = "STORE_PACKING",
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  allocationId = null,
  transactionDate = null,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("unpackFromPacked: qty must be > 0");
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { packedQty: -q, reservedQty: q },
    guard: { $expr: { $gte: [{ $ifNull: ["$packedQty", 0] }, q] } },
  });
  if (!updated) {
    throw new Error(
      `unpackFromPacked: packed bucket lower than ${q} for ${normArticle(article)} in ${normWarehouse(warehouse)}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.UNPACKED,
    article,
    warehouse,
    qtyIn: q,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[packed→reserved]`.trim(),
    createdBy,
    sourceModule,
    allocationId,
    ...after,
  });
}

/**
 * DISPATCH_OUT — removes physical stock that was in packed staging.
 */
export async function dispatchFromPacked({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType = "STORE_DISPATCH",
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  transactionDate = null,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("dispatchFromPacked: qty must be > 0");
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { packedQty: -q, dispatchedQty: q, quantity: -q, onHandQty: -q },
    guard: {
      $expr: {
        $and: [{ $gte: [{ $ifNull: ["$packedQty", 0] }, q] }, { $gte: [{ $ifNull: ["$onHandQty", 0] }, q] }],
      },
    },
  });
  if (!updated) {
    throw new Error(
      `dispatchFromPacked: insufficient packed/on-hand for ${normArticle(article)} in ${normWarehouse(warehouse)}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.DISPATCH_OUT,
    article,
    warehouse,
    locationFrom: warehouse,
    qtyOut: q,
    referenceType,
    referenceNo,
    customerName,
    remarks,
    createdBy,
    sourceModule,
    ...after,
  });
}

/**
 * DISPATCH_CANCEL — restores physical stock and packed staging after dispatch cancel.
 */
export async function cancelDispatchFromPacked({
  session,
  companyId,
  article,
  warehouse,
  qty,
  customerName = "",
  referenceType = "STORE_DISPATCH",
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  transactionDate = null,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("cancelDispatchFromPacked: qty must be > 0");
  const before = await getStockBalance({ companyId, article, warehouse, session });
  const reverseDispatchedQty = Math.min(q, Math.max(0, Number(before?.dispatchedQty || 0)));
  await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: {
      packedQty: q,
      ...(reverseDispatchedQty > 0 ? { dispatchedQty: -reverseDispatchedQty } : {}),
      quantity: q,
      onHandQty: q,
    },
    upsert: true,
  });
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  return createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.DISPATCH_CANCEL,
    article,
    warehouse,
    locationTo: warehouse,
    qtyIn: q,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[dispatch cancel → restore packed+onHand]`.trim(),
    createdBy,
    sourceModule,
    ...after,
  });
}

/* --------------------------------------------------------------- */
/*  Read-side helpers used by reports / unified ledger              */
/* --------------------------------------------------------------- */

/**
 * Returns the most recent N ledger rows for an article+warehouse,
 * preferring the new unified StockLedger but falling back to the
 * legacy InventoryLedger when no unified rows exist yet. Helpful
 * for the customer-allocation drill-down.
 */
export async function getRecentLedgerEntries({ companyId, article, warehouse, limit = 50 }) {
  requireCompanyId(companyId);
  const code = normArticle(article);
  const wh = normWarehouse(warehouse);
  const q = StockLedger.find({
    companyId,
    article: code,
    $or: [{ warehouse: wh }, { location: wh }],
  })
    .sort({ transactionDate: -1, createdAt: -1 })
    .limit(limit)
    .lean();
  const rows = await q;
  if (rows.length) return rows;
  return InventoryLedger.find({ companyId, itemCode: code, warehouse: wh })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

/* --------------------------------------------------------------- */
/*  Transaction helper                                              */
/* --------------------------------------------------------------- */

/**
 * Runs `fn(session)` inside a Mongo transaction. Keeps the API
 * consistent with `salesStockService.withTransaction` so callers
 * can swap services without changing transaction wrapping code.
 */
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

export default {
  MOVEMENT_TYPES,
  getStockBalance,
  recalculateStockBalance,
  createStockLedgerEntry,
  grnReceive,
  openingBalance,
  allocateStock,
  cancelAllocation,
  moveAllocationToRTS,
  cancelRTS,
  invoiceFromRTS,
  cancelInvoice,
  stockTransfer,
  stockAdjustment,
  packFromAllocation,
  unpackFromPacked,
  dispatchFromPacked,
  cancelDispatchFromPacked,
  getRecentLedgerEntries,
  withTransaction,
};
