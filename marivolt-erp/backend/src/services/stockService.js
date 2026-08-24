/**
 * services/stockService.js
 * ---------------------------------------------------------------
 * Centralised, reusable Stock service. This is the single entry
 * point for new ERP stock movements going forward (Phase-3).
 *
 * Design notes:
 *   • All movements persist running balances on the ledger row
 *     itself (onHandAfter / allocatedAfter / packedAfter /
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
import { buildPhysicalEffectKey, deriveStockBuckets, deriveAvailableQty } from "./stockExpectedBuckets.js";

/**
 * Debounced Reservation Integrity re-check after bucket mutations.
 * Defers until the Mongo session commits when a session is present.
 * Never throws into the stock mutation path.
 */
function notifyReservationIntegrity(companyId, warehouse, article, reason, session = null) {
  try {
    if (!companyId || !article) return;
    import("./reservationIntegrityService.js")
      .then((m) => {
        m.scheduleReservationIntegrityAfterCommit(
          { companyId, warehouse, article, reason },
          session
        );
      })
      .catch((err) => {
        console.error("[stockService] reservation integrity schedule failed:", err?.message || err);
      });
  } catch (err) {
    console.error("[stockService] reservation integrity notify failed:", err?.message || err);
  }
}

/** Soft idempotency: return existing ledger when effectKey already posted. */
async function findLedgerByEffectKey(effectKey, session) {
  const ek = s(effectKey);
  if (!ek) return null;
  const q = StockLedger.findOne({ effectKey: ek });
  if (session) q.session(session);
  return q;
}

/**
 * Resolve physical effectKey — prefer explicit, else build deterministic key.
 * Empty referenceNo still produces a key (NOREF) so callers should pass stable refs.
 */
function resolvePhysicalEffectKey(opts) {
  if (s(opts.effectKey)) return s(opts.effectKey);
  if (!opts.article || !opts.companyId) return "";
  return buildPhysicalEffectKey({
    movementType: opts.movementType,
    companyId: opts.companyId,
    referenceNo: opts.referenceNo,
    article: opts.article,
    warehouse: opts.warehouse,
    lineId: opts.lineId,
    batchNo: opts.batchNo,
    serialNo: opts.serialNo,
    direction: opts.direction,
    qty: opts.qty,
    extra: opts.extra,
  });
}

/* --------------------------------------------------------------- */
/*  Constants                                                       */
/* --------------------------------------------------------------- */

/** Unified Phase-3 movement-type vocabulary. */
export const MOVEMENT_TYPES = Object.freeze({
  GRN_IN: "GRN_IN",
  LANDED_COST_ADJUSTMENT: "LANDED_COST_ADJUSTMENT",
  KIT_ASSEMBLY_OUT: "KIT_ASSEMBLY_OUT",
  KIT_ASSEMBLY_IN: "KIT_ASSEMBLY_IN",
  KIT_ASSEMBLY_REVERSAL_OUT: "KIT_ASSEMBLY_REVERSAL_OUT",
  KIT_ASSEMBLY_REVERSAL_IN: "KIT_ASSEMBLY_REVERSAL_IN",
  DEKIT_OUT: "DEKIT_OUT",
  DEKIT_IN: "DEKIT_IN",
  DEKIT_REVERSAL_OUT: "DEKIT_REVERSAL_OUT",
  DEKIT_REVERSAL_IN: "DEKIT_REVERSAL_IN",
  ALLOCATION: "ALLOCATION",
  ALLOCATION_CANCEL: "ALLOCATION_CANCEL",
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
  ARTICLE_CONVERSION_OUT: "ARTICLE_CONVERSION_OUT",
  ARTICLE_CONVERSION_IN: "ARTICLE_CONVERSION_IN",
  ARTICLE_CONVERSION_REVERSAL_OUT: "ARTICLE_CONVERSION_REVERSAL_OUT",
  ARTICLE_CONVERSION_REVERSAL_IN: "ARTICLE_CONVERSION_REVERSAL_IN",
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
  KIT_ASSEMBLY_REVERSAL_OUT: "STOCK_ADJUSTMENT",
  KIT_ASSEMBLY_REVERSAL_IN: "STOCK_ADJUSTMENT",
  DEKIT_OUT: "STOCK_ADJUSTMENT",
  DEKIT_IN: "STOCK_ADJUSTMENT",
  DEKIT_REVERSAL_OUT: "STOCK_ADJUSTMENT",
  DEKIT_REVERSAL_IN: "STOCK_ADJUSTMENT",
  ALLOCATION: "SALES_ALLOCATION",
  ALLOCATION_CANCEL: "ORDER_ALLOCATION_CANCEL",
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
  ARTICLE_CONVERSION_OUT: "STOCK_ADJUSTMENT",
  ARTICLE_CONVERSION_IN: "STOCK_ADJUSTMENT",
  ARTICLE_CONVERSION_REVERSAL_OUT: "STOCK_ADJUSTMENT",
  ARTICLE_CONVERSION_REVERSAL_IN: "STOCK_ADJUSTMENT",
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
  const buckets = deriveStockBuckets(row || {});
  const dispatched = Number(row?.dispatchedQty || 0) || 0;
  return {
    _id: row?._id || null,
    companyId: row?.companyId || fallback.companyId || null,
    article: String(row?.article || row?.itemCode || fallback.code || "").toUpperCase(),
    warehouse: String(row?.warehouse || row?.location || fallback.wh || "MAIN").toUpperCase(),
    onHandQty: buckets.onHandQty,
    allocatedQty: buckets.allocatedQty,
    reservedQty: buckets.reservedQty,
    packedQty: buckets.packedQty,
    dispatchedQty: dispatched,
    availableQty: buckets.availableQty,
    isNegativeAvailable: buckets.isNegativeAvailable,
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
  let packed = 0;
  let dispatched = 0;
  for (const r of rows) {
    onHand += Number(r?.onHandQty ?? r?.quantity ?? 0) || 0;
    allocated += Math.max(Number(r?.allocatedQty || 0), Number(r?.reservedQty || 0));
    packed += Number(r?.packedQty || 0) || 0;
    dispatched += Number(r?.dispatchedQty || 0) || 0;
  }
  const available = onHand - allocated - packed;
  return {
    onHandAfter: onHand,
    allocatedAfter: allocated,
    packedAfter: packed,
    dispatchedAfter: dispatched,
    availableAfter: available,
    isNegativeAvailable: available < 0,
  };
}

/**
 * Recomputes `availableQty` on the StockBalance row from the
 * persisted on-hand/allocated/packed buckets and ensures the
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
  const packed = Number(row.packedQty || 0) || 0;
  const dispatched = Math.max(0, Number(row.dispatchedQty || 0));
  row.onHandQty = onHand;
  row.quantity = onHand;
  row.allocatedQty = allocated;
  row.reservedQty = allocated;
  row.packedQty = packed;
  row.dispatchedQty = dispatched;
  row.availableQty = deriveAvailableQty({
    onHandQty: onHand,
    reservedQty: allocated,
    packedQty: packed,
  });
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
  packedAfter = null,
  availableAfter = null,
  batchNo = "",
  serialNo = "",
  sourceDocumentType = "",
  sourceDocumentId = null,
  sourceLineId = null,
  sourceAllocationId = null,
  sourceAllocationLineId = null,
  sourcePackingId = null,
  sourcePackingLineId = null,
  sourceSalesInvoiceId = null,
  sourceSalesInvoiceLineId = null,
  asnId = null,
  asnNo = "",
  asnLineId = null,
  receivingSessionId = null,
  postingOperationId = "",
  cancellationOperationId = "",
  effectKey = "",
  originalEffectKey = "",
  reversedFromLedgerId = null,
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
    sourceDocumentType: s(sourceDocumentType),
    sourceDocumentId: sourceDocumentId || null,
    sourceLineId: sourceLineId || null,
    sourceAllocationId: sourceAllocationId || null,
    sourceAllocationLineId: sourceAllocationLineId || null,
    sourcePackingId: sourcePackingId || null,
    sourcePackingLineId: sourcePackingLineId || null,
    sourceSalesInvoiceId: sourceSalesInvoiceId || null,
    sourceSalesInvoiceLineId: sourceSalesInvoiceLineId || null,
    asnId: asnId || null,
    asnNo: up(asnNo),
    asnLineId: asnLineId || null,
    receivingSessionId: receivingSessionId || null,
    postingOperationId: s(postingOperationId),
    cancellationOperationId: s(cancellationOperationId),
    effectKey: s(effectKey),
    originalEffectKey: s(originalEffectKey),
    reversedFromLedgerId: reversedFromLedgerId || null,
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
  // Single ledger row: array create + ordered keeps session semantics valid under Mongoose 9.
  const [doc] = await StockLedger.create([row], {
    session: data?.session,
    ordered: true,
  });
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

/**
 * Persist StockBalance.availableQty from authoritative buckets via canonical
 * deriveAvailableQty. Does not mutate onHand / reserved / allocated / packed.
 * Used by article conversion (and reverse) after physical $inc — not a global
 * bumpBuckets change.
 */
async function refreshStoredAvailableQty(balanceDoc, session = null) {
  if (!balanceDoc) return null;
  const projected = deriveAvailableQty({
    onHandQty: balanceDoc.onHandQty,
    quantity: balanceDoc.quantity,
    reservedQty: balanceDoc.reservedQty,
    allocatedQty: balanceDoc.allocatedQty,
    packedQty: balanceDoc.packedQty,
  });
  if (Number(balanceDoc.availableQty) === projected) {
    return balanceDoc;
  }
  balanceDoc.availableQty = projected;
  await balanceDoc.save({ session });
  return balanceDoc;
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
  effectKey = "",
  lineId = "",
  sourceDocumentType = "",
  sourceDocumentId = null,
  sourceLineId = null,
  asnId = null,
  asnNo = "",
  asnLineId = null,
  receivingSessionId = null,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("grnReceive: qty must be > 0");

  const ek = resolvePhysicalEffectKey({
    effectKey,
    movementType: MOVEMENT_TYPES.GRN_IN,
    companyId,
    referenceNo,
    article,
    warehouse,
    lineId,
    batchNo,
    serialNo,
    qty: q,
  });
  if (ek) {
    const existing = await findLedgerByEffectKey(ek, session);
    if (existing) return existing;
  }

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
  const ledger = await createStockLedgerEntry({
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
    effectKey: ek,
    sourceDocumentType,
    sourceDocumentId,
    sourceLineId,
    asnId,
    asnNo,
    asnLineId,
    receivingSessionId,
    ...after,
  });
  notifyReservationIntegrity(companyId, warehouse, article, "GRN", session);
  return ledger;
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
  effectKey = "",
  lineId = "",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("cancelGrn: qty must be > 0");

  const ek = resolvePhysicalEffectKey({
    effectKey,
    movementType: "GRN_CANCEL",
    companyId,
    referenceNo,
    article,
    warehouse,
    lineId,
    batchNo,
    serialNo,
    qty: q,
  });
  if (ek) {
    const existing = await findLedgerByEffectKey(ek, session);
    if (existing) return existing;
  }

  // Guard: the canonical row must have at least `q` on-hand AND at
  // least `q` Available (on-hand − reserved − packed). This matches the
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
    effectKey: ek,
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
  referenceNo = "",
  effectKey = "",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("openingBalance: qty must be > 0");

  const ek = resolvePhysicalEffectKey({
    effectKey,
    movementType: MOVEMENT_TYPES.OPENING_BALANCE,
    companyId,
    referenceNo: referenceNo || `OPENING:${normArticle(article)}:${normWarehouse(warehouse)}`,
    article,
    warehouse,
    qty: q,
  });
  if (ek) {
    const existing = await findLedgerByEffectKey(ek, session);
    if (existing) return existing;
  }

  await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    inc: { quantity: q, onHandQty: q },
    upsert: true,
  });
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  const ledger = await createStockLedgerEntry({
    session,
    companyId,
    movementType: MOVEMENT_TYPES.OPENING_BALANCE,
    article,
    warehouse,
    locationTo: warehouse,
    qtyIn: q,
    referenceType: "OPENING",
    referenceNo: referenceNo || ek,
    remarks,
    createdBy,
    sourceModule,
    unitCost,
    currency,
    effectKey: ek,
    ...after,
  });
  notifyReservationIntegrity(companyId, warehouse, article, "INVENTORY_IMPORT", session);
  return ledger;
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
  effectKey = "",
  allocationId = null,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("allocateStock: qty must be > 0");

  const ek = s(effectKey);
  if (ek) {
    const existingQuery = StockLedger.findOne({ effectKey: ek });
    if (session) existingQuery.session(session);
    const existing = await existingQuery;
    if (existing) return existing;
  }

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
    // Guard ensures (quantity − reserved − packed) ≥ qty before incrementing.
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
  const ledger = await createStockLedgerEntry({
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
    effectKey: ek,
    allocationId: allocationId || null,
    sourceAllocationId: allocationId || null,
    ...after,
  });
  notifyReservationIntegrity(companyId, warehouse, article, "ALLOCATION", session);
  return ledger;
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
  effectKey = "",
  allocationId = null,
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("cancelAllocation: qty must be > 0");

  const ek = s(effectKey);
  if (ek) {
    const existingQuery = StockLedger.findOne({ effectKey: ek });
    if (session) existingQuery.session(session);
    const existing = await existingQuery;
    if (existing) return existing;
  }

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
  const ledger = await createStockLedgerEntry({
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
    effectKey: ek,
    allocationId: allocationId || null,
    sourceAllocationId: allocationId || null,
    ...after,
  });
  notifyReservationIntegrity(companyId, warehouse, article, "ALLOCATION_CANCEL", session);
  return ledger;
}

/**
 * SALES_INVOICE_CANCEL — undoes a posted invoice that had no
 * Store Packing link (legacy direct-invoice flow). Restores
 * `onHandQty` and `reservedQty` since the qty is no longer
 * physically shipped and goes back to the allocated pool.
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
    inc: { quantity: q, onHandQty: q, reservedQty: q },
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
    remarks: `${remarks || ""}${remarks ? " " : ""}[invoice cancel → allocated]`.trim(),
    createdBy,
    sourceModule,
    ...after,
  });
}

/**
 * STOCK_TRANSFER_OUT + STOCK_TRANSFER_IN — atomically moves qty
 * from one warehouse to another. Two ledger entries are written
 * so each warehouse sees its own balance change.
 *
 * Deterministic physical effectKeys (via buildPhysicalEffectKey):
 *   OUT: phys:STOCK_TRANSFER_OUT:{company}:{transferNo}:{article}:{fromWh}:{lineId}:TO:{toWh}:qty
 *   IN:  phys:STOCK_TRANSFER_IN:{company}:{transferNo}:{article}:{toWh}:{lineId}:FROM:{fromWh}:qty
 * Replay / retry returns existing ledgers without changing StockBalance.
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
  effectKeyOut = "",
  effectKeyIn = "",
  transferLineId = "",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("stockTransfer: qty must be > 0");
  const fromWh = normWarehouse(fromWarehouse);
  const toWh = normWarehouse(toWarehouse);
  if (fromWh === toWh) throw new Error("stockTransfer: from and to warehouse must differ");

  const lineId = s(transferLineId) || s(referenceNo) || "manual";
  const outEk =
    s(effectKeyOut) ||
    resolvePhysicalEffectKey({
      movementType: MOVEMENT_TYPES.STOCK_TRANSFER_OUT,
      companyId,
      referenceNo,
      article,
      warehouse: fromWh,
      lineId,
      qty: q,
      extra: `TO:${toWh}`,
    });
  const inEk =
    s(effectKeyIn) ||
    resolvePhysicalEffectKey({
      movementType: MOVEMENT_TYPES.STOCK_TRANSFER_IN,
      companyId,
      referenceNo,
      article,
      warehouse: toWh,
      lineId,
      qty: q,
      extra: `FROM:${fromWh}`,
    });

  if (outEk && inEk) {
    const [existingOut, existingIn] = await Promise.all([
      findLedgerByEffectKey(outEk, session),
      findLedgerByEffectKey(inEk, session),
    ]);
    if (existingOut && existingIn) {
      return { out: existingOut, in: existingIn, idempotent: true };
    }
    // Partial prior write: do not bump again — return whatever exists.
    if (existingOut || existingIn) {
      return {
        out: existingOut || null,
        in: existingIn || null,
        idempotent: true,
        partial: true,
      };
    }
  }

  // OUT side
  const outGuard = allowNegative
    ? null
    : {
        $expr: {
          $gte: [
            {
              $subtract: [
                { $ifNull: ["$quantity", 0] },
                { $add: [{ $ifNull: ["$reservedQty", 0] }, { $ifNull: ["$packedQty", 0] }] },
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
    effectKey: outEk,
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
    effectKey: inEk,
    ...toAfter,
  });
  notifyReservationIntegrity(companyId, fromWh, article, "STOCK_TRANSFER", session);
  notifyReservationIntegrity(companyId, toWh, article, "STOCK_TRANSFER", session);
  return { out: outRow, in: inRow };
}

/**
 * Reverse a posted stock transfer (B→A). Uses distinct REV effectKeys so
 * cancel cannot collide with the original post keys.
 * Does not change StockTransfer document lifecycle — caller owns that.
 */
export async function reverseStockTransfer({
  session,
  companyId,
  article,
  fromWarehouse,
  toWarehouse,
  qty,
  referenceType = "TRANSFER_CANCEL",
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  allowNegative = false,
  transactionDate = null,
  transferLineId = "",
  effectKeyOut = "",
  effectKeyIn = "",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("reverseStockTransfer: qty must be > 0");
  // Reverse moves stock from original toWarehouse back to fromWarehouse
  const origFrom = normWarehouse(fromWarehouse);
  const origTo = normWarehouse(toWarehouse);
  if (origFrom === origTo) throw new Error("reverseStockTransfer: warehouses must differ");

  const lineId = s(transferLineId) || s(referenceNo) || "manual";
  const outEk =
    s(effectKeyOut) ||
    resolvePhysicalEffectKey({
      movementType: MOVEMENT_TYPES.STOCK_TRANSFER_OUT,
      companyId,
      referenceNo,
      article,
      warehouse: origTo,
      lineId,
      qty: q,
      extra: `REV:TO:${origFrom}`,
    });
  const inEk =
    s(effectKeyIn) ||
    resolvePhysicalEffectKey({
      movementType: MOVEMENT_TYPES.STOCK_TRANSFER_IN,
      companyId,
      referenceNo,
      article,
      warehouse: origFrom,
      lineId,
      qty: q,
      extra: `REV:FROM:${origTo}`,
    });

  return stockTransfer({
    session,
    companyId,
    article,
    fromWarehouse: origTo,
    toWarehouse: origFrom,
    qty: q,
    referenceType,
    referenceNo,
    remarks: remarks || `Reversal of transfer ${referenceNo || ""}`.trim(),
    createdBy,
    sourceModule,
    allowNegative,
    transactionDate,
    effectKeyOut: outEk,
    effectKeyIn: inEk,
    transferLineId: lineId,
  });
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
  effectKey = "",
  lineId = "",
  reversedFromLedgerId = null,
  originalEffectKey = "",
  cancellationOperationId = "",
}) {
  requireCompanyId(companyId);
  const q = Math.abs(Number(qty) || 0);
  if (!(q > 0)) throw new Error("stockAdjustment: qty must be > 0");
  const isIncrease = String(direction).toLowerCase() === "increase";
  const dir = isIncrease ? "IN" : "OUT";

  const ek = resolvePhysicalEffectKey({
    effectKey,
    movementType: movementType || MOVEMENT_TYPES.STOCK_ADJUSTMENT,
    companyId,
    referenceNo,
    article,
    warehouse,
    lineId,
    direction: dir,
    qty: q,
  });
  if (ek) {
    const existing = await findLedgerByEffectKey(ek, session);
    if (existing) return existing;
  }

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
                  { $add: [{ $ifNull: ["$reservedQty", 0] }, { $ifNull: ["$packedQty", 0] }] },
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
  const ledger = await createStockLedgerEntry({
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
    effectKey: ek,
    reversedFromLedgerId,
    originalEffectKey: originalEffectKey || "",
    cancellationOperationId,
    ...after,
  });
  notifyReservationIntegrity(companyId, warehouse, article, "STOCK_ADJUSTMENT", session);
  return ledger;
}

/**
 * ARTICLE_CONVERSION_OUT + ARTICLE_CONVERSION_IN — same warehouse,
 * different articles. Requires real physical available stock on source
 * (no negative conversion). Carries unitCost onto both ledger legs.
 * Optional effectKeys for idempotent retries.
 */
export async function articleConversion({
  session,
  companyId,
  sourceArticle,
  targetArticle,
  warehouse,
  sourceQty,
  targetQty,
  unitCost = 0,
  currency = "USD",
  referenceType = "ARTICLE_STOCK_CONVERSION",
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  transactionDate = null,
  sourceDocumentType = "",
  sourceDocumentId = null,
  postingOperationId = "",
  outEffectKey = "",
  inEffectKey = "",
  locationFrom = "",
  locationTo = "",
}) {
  requireCompanyId(companyId);
  const src = normArticle(sourceArticle);
  const tgt = normArticle(targetArticle);
  if (!src || !tgt) throw new Error("articleConversion: source and target articles required");
  if (src === tgt) throw new Error("articleConversion: source and target articles must differ");
  const srcQty = Number(sourceQty) || 0;
  const tgtQty = Number(targetQty) || 0;
  if (!(srcQty > 0) || !(tgtQty > 0)) throw new Error("articleConversion: quantities must be > 0");
  const wh = normWarehouse(warehouse);
  const cost = Math.max(0, Number(unitCost) || 0);

  const outGuard = {
    $expr: {
      $gte: [
        {
          $subtract: [
            { $ifNull: ["$quantity", 0] },
            { $add: [{ $ifNull: ["$reservedQty", 0] }, { $ifNull: ["$packedQty", 0] }] },
          ],
        },
        srcQty,
      ],
    },
  };
  const outUpdated = await bumpBuckets({
    session,
    companyId,
    article: src,
    warehouse: wh,
    inc: { quantity: -srcQty, onHandQty: -srcQty },
    guard: outGuard,
  });
  if (!outUpdated) {
    const err = new Error(
      `articleConversion: insufficient available qty for ${src} in ${wh}`
    );
    err.code = "ARTICLE_CONVERSION_STOCK_SHORTAGE";
    err.article = src;
    err.requestedQty = srcQty;
    throw err;
  }
  await refreshStoredAvailableQty(outUpdated, session);

  const inUpdated = await bumpBuckets({
    session,
    companyId,
    article: tgt,
    warehouse: wh,
    inc: { quantity: tgtQty, onHandQty: tgtQty },
    upsert: true,
  });
  await refreshStoredAvailableQty(inUpdated, session);

  const fromAfter = await snapshotAfter({ companyId, article: src, warehouse: wh, session });
  const outRow = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.ARTICLE_CONVERSION_OUT,
    article: src,
    warehouse: wh,
    locationFrom: locationFrom || wh,
    locationTo: locationTo || wh,
    qtyOut: srcQty,
    unitCost: cost,
    currency,
    referenceType,
    referenceNo,
    remarks,
    createdBy,
    sourceModule,
    sourceDocumentType,
    sourceDocumentId,
    postingOperationId,
    effectKey: outEffectKey,
    ...fromAfter,
  });
  const toAfter = await snapshotAfter({ companyId, article: tgt, warehouse: wh, session });
  const inRow = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.ARTICLE_CONVERSION_IN,
    article: tgt,
    warehouse: wh,
    locationFrom: locationFrom || wh,
    locationTo: locationTo || wh,
    qtyIn: tgtQty,
    unitCost: cost,
    currency,
    referenceType,
    referenceNo,
    remarks,
    createdBy,
    sourceModule,
    sourceDocumentType,
    sourceDocumentId,
    postingOperationId,
    effectKey: inEffectKey,
    ...toAfter,
  });
  return { out: outRow, in: inRow };
}

/**
 * Reverse a posted article conversion: target OUT, source IN.
 * Requires available (unreserved/unpacked) target stock.
 */
export async function reverseArticleConversion({
  session,
  companyId,
  sourceArticle,
  targetArticle,
  warehouse,
  sourceQty,
  targetQty,
  unitCost = 0,
  currency = "USD",
  referenceType = "ARTICLE_STOCK_CONVERSION",
  referenceNo,
  remarks = "",
  createdBy = "",
  sourceModule = "STORE",
  transactionDate = null,
  sourceDocumentType = "",
  sourceDocumentId = null,
  cancellationOperationId = "",
  outEffectKey = "",
  inEffectKey = "",
  originalOutEffectKey = "",
  originalInEffectKey = "",
  reversedFromOutLedgerId = null,
  reversedFromInLedgerId = null,
  locationFrom = "",
  locationTo = "",
}) {
  requireCompanyId(companyId);
  const src = normArticle(sourceArticle);
  const tgt = normArticle(targetArticle);
  const srcQty = Number(sourceQty) || 0;
  const tgtQty = Number(targetQty) || 0;
  if (!(srcQty > 0) || !(tgtQty > 0)) throw new Error("reverseArticleConversion: quantities must be > 0");
  const wh = normWarehouse(warehouse);
  const cost = Math.max(0, Number(unitCost) || 0);

  const outGuard = {
    $expr: {
      $gte: [
        {
          $subtract: [
            { $ifNull: ["$quantity", 0] },
            { $add: [{ $ifNull: ["$reservedQty", 0] }, { $ifNull: ["$packedQty", 0] }] },
          ],
        },
        tgtQty,
      ],
    },
  };
  const outUpdated = await bumpBuckets({
    session,
    companyId,
    article: tgt,
    warehouse: wh,
    inc: { quantity: -tgtQty, onHandQty: -tgtQty },
    guard: outGuard,
  });
  if (!outUpdated) {
    const err = new Error(
      `reverseArticleConversion: insufficient available target qty for ${tgt} in ${wh}`
    );
    err.code = "ARTICLE_CONVERSION_REVERSAL_BLOCKED";
    err.article = tgt;
    err.requestedQty = tgtQty;
    throw err;
  }
  await refreshStoredAvailableQty(outUpdated, session);

  const inUpdated = await bumpBuckets({
    session,
    companyId,
    article: src,
    warehouse: wh,
    inc: { quantity: srcQty, onHandQty: srcQty },
    upsert: true,
  });
  await refreshStoredAvailableQty(inUpdated, session);

  const tgtAfter = await snapshotAfter({ companyId, article: tgt, warehouse: wh, session });
  const outRow = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.ARTICLE_CONVERSION_REVERSAL_OUT,
    article: tgt,
    warehouse: wh,
    locationFrom: locationFrom || wh,
    locationTo: locationTo || wh,
    qtyOut: tgtQty,
    unitCost: cost,
    currency,
    referenceType,
    referenceNo,
    remarks,
    createdBy,
    sourceModule,
    sourceDocumentType,
    sourceDocumentId,
    cancellationOperationId,
    effectKey: outEffectKey,
    originalEffectKey: originalOutEffectKey,
    reversedFromLedgerId: reversedFromOutLedgerId,
    ...tgtAfter,
  });
  const srcAfter = await snapshotAfter({ companyId, article: src, warehouse: wh, session });
  const inRow = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.ARTICLE_CONVERSION_REVERSAL_IN,
    article: src,
    warehouse: wh,
    locationFrom: locationFrom || wh,
    locationTo: locationTo || wh,
    qtyIn: srcQty,
    unitCost: cost,
    currency,
    referenceType,
    referenceNo,
    remarks,
    createdBy,
    sourceModule,
    sourceDocumentType,
    sourceDocumentId,
    cancellationOperationId,
    effectKey: inEffectKey,
    originalEffectKey: originalInEffectKey,
    reversedFromLedgerId: reversedFromInLedgerId,
    ...srcAfter,
  });
  return { out: outRow, in: inRow };
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
  sourceDocumentType = "",
  sourceDocumentId = null,
  sourceLineId = null,
  sourceAllocationId = null,
  sourceAllocationLineId = null,
  postingOperationId = "",
  effectKey = "",
  batchNo = "",
  serialNo = "",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("packFromAllocation: qty must be > 0");
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    batchNo,
    serialNo,
    inc: { reservedQty: -q, packedQty: q },
    guard: { $expr: { $gte: [{ $ifNull: ["$reservedQty", 0] }, q] } },
  });
  if (!updated) {
    throw new Error(
      `packFromAllocation: reserved bucket lower than ${q} for ${normArticle(article)} in ${normWarehouse(warehouse)}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  const ledger = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.PACKED,
    article,
    warehouse,
    batchNo,
    serialNo,
    qtyOut: q,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[reserved→packed]`.trim(),
    createdBy,
    sourceModule,
    allocationId,
    sourceDocumentType,
    sourceDocumentId,
    sourceLineId,
    sourceAllocationId: sourceAllocationId || allocationId || null,
    sourceAllocationLineId,
    postingOperationId,
    effectKey,
    ...after,
  });
  notifyReservationIntegrity(companyId, warehouse, article, "PACKING", session);
  return ledger;
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
  sourceDocumentType = "",
  sourceDocumentId = null,
  sourceLineId = null,
  sourceAllocationId = null,
  sourceAllocationLineId = null,
  cancellationOperationId = "",
  effectKey = "",
  originalEffectKey = "",
  reversedFromLedgerId = null,
  batchNo = "",
  serialNo = "",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("unpackFromPacked: qty must be > 0");
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    batchNo,
    serialNo,
    inc: { packedQty: -q, reservedQty: q },
    guard: { $expr: { $gte: [{ $ifNull: ["$packedQty", 0] }, q] } },
  });
  if (!updated) {
    throw new Error(
      `unpackFromPacked: packed bucket lower than ${q} for ${normArticle(article)} in ${normWarehouse(warehouse)}.`
    );
  }
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  const ledger = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.UNPACKED,
    article,
    warehouse,
    batchNo,
    serialNo,
    qtyIn: q,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[packed→reserved]`.trim(),
    createdBy,
    sourceModule,
    allocationId,
    sourceDocumentType,
    sourceDocumentId,
    sourceLineId,
    sourceAllocationId: sourceAllocationId || allocationId || null,
    sourceAllocationLineId,
    cancellationOperationId,
    effectKey,
    originalEffectKey,
    reversedFromLedgerId,
    ...after,
  });
  notifyReservationIntegrity(companyId, warehouse, article, "PACKING_CANCEL", session);
  return ledger;
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
  batchNo = "",
  serialNo = "",
  sourceDocumentType = "",
  sourceDocumentId = null,
  sourceLineId = null,
  sourceAllocationId = null,
  sourceAllocationLineId = null,
  sourcePackingId = null,
  sourcePackingLineId = null,
  sourceSalesInvoiceId = null,
  sourceSalesInvoiceLineId = null,
  postingOperationId = "",
  effectKey = "",
}) {
  requireCompanyId(companyId);
  const q = Number(qty) || 0;
  if (!(q > 0)) throw new Error("dispatchFromPacked: qty must be > 0");
  const updated = await bumpBuckets({
    session,
    companyId,
    article,
    warehouse,
    batchNo,
    serialNo,
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
  const ledger = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.DISPATCH_OUT,
    article,
    warehouse,
    batchNo,
    serialNo,
    locationFrom: warehouse,
    qtyOut: q,
    referenceType,
    referenceNo,
    customerName,
    remarks,
    createdBy,
    sourceModule,
    allocationId: sourceAllocationId || null,
    sourceDocumentType,
    sourceDocumentId,
    sourceLineId,
    sourceAllocationId,
    sourceAllocationLineId,
    sourcePackingId,
    sourcePackingLineId,
    sourceSalesInvoiceId,
    sourceSalesInvoiceLineId,
    postingOperationId,
    effectKey,
    ...after,
  });
  notifyReservationIntegrity(companyId, warehouse, article, "DISPATCH", session);
  return ledger;
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
  batchNo = "",
  serialNo = "",
  sourceDocumentType = "",
  sourceDocumentId = null,
  sourceLineId = null,
  sourceAllocationId = null,
  sourceAllocationLineId = null,
  sourcePackingId = null,
  sourcePackingLineId = null,
  sourceSalesInvoiceId = null,
  sourceSalesInvoiceLineId = null,
  cancellationOperationId = "",
  effectKey = "",
  originalEffectKey = "",
  reversedFromLedgerId = null,
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
    batchNo,
    serialNo,
    inc: {
      packedQty: q,
      ...(reverseDispatchedQty > 0 ? { dispatchedQty: -reverseDispatchedQty } : {}),
      quantity: q,
      onHandQty: q,
    },
    upsert: true,
  });
  const after = await snapshotAfter({ companyId, article, warehouse, session });
  const ledger = await createStockLedgerEntry({
    session,
    companyId,
    transactionDate,
    movementType: MOVEMENT_TYPES.DISPATCH_CANCEL,
    article,
    warehouse,
    batchNo,
    serialNo,
    locationTo: warehouse,
    qtyIn: q,
    referenceType,
    referenceNo,
    customerName,
    remarks: `${remarks || ""}${remarks ? " " : ""}[dispatch cancel → restore packed+onHand]`.trim(),
    createdBy,
    sourceModule,
    allocationId: sourceAllocationId || null,
    sourceDocumentType,
    sourceDocumentId,
    sourceLineId,
    sourceAllocationId,
    sourceAllocationLineId,
    sourcePackingId,
    sourcePackingLineId,
    sourceSalesInvoiceId,
    sourceSalesInvoiceLineId,
    cancellationOperationId,
    effectKey,
    originalEffectKey,
    reversedFromLedgerId,
    ...after,
  });
  notifyReservationIntegrity(companyId, warehouse, article, "DISPATCH_CANCEL", session);
  return ledger;
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
    try {
      const ri = await import("./reservationIntegrityService.js");
      ri.releaseReservationIntegritySessionPending(session);
    } catch (err) {
      console.error("[stockService] RI post-commit release failed:", err?.message || err);
    }
    return result;
  } catch (e) {
    try {
      const ri = await import("./reservationIntegrityService.js");
      ri.discardReservationIntegritySessionPending(session);
    } catch {
      /* ignore */
    }
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
  cancelInvoice,
  stockTransfer,
  reverseStockTransfer,
  stockAdjustment,
  articleConversion,
  reverseArticleConversion,
  packFromAllocation,
  unpackFromPacked,
  dispatchFromPacked,
  cancelDispatchFromPacked,
  getRecentLedgerEntries,
  withTransaction,
  deriveAvailableQty,
  deriveStockBuckets,
};

export { deriveAvailableQty, deriveStockBuckets };
