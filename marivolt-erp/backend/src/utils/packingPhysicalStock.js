/**
 * Physical stock visibility helpers for package-based packing.
 * Pure functions — no DB writes. Does not change reservation/ledger math.
 */
import { deriveAvailableQty } from "../services/stockExpectedBuckets.js";

export const PACKING_STOCK_STATUSES = Object.freeze([
  "READY",
  "PARTIAL",
  "SHORTAGE",
  "NEGATIVE_ALLOCATION",
  "UNKNOWN",
]);

export const PACKING_STORE_STATUSES = Object.freeze([
  "READY TO PICK",
  "PARTIAL STOCK",
  "NO STOCK",
  "NO STOCK / SHORTAGE",
  "RESERVED FOR OTHER ALLOCATION",
  "NEGATIVE ALLOCATION",
  "PACKED",
  "UNKNOWN",
]);

/**
 * Derive packing-relevant stock quantities for one allocation line.
 *
 * Formulas (avoid double-subtracting this allocation's reservation):
 * - onHandQty: physical warehouse stock
 * - reservedForThisAllocationQty: remaining allocation claim (allocated − previously packed)
 * - reservedForOtherAllocationsQty: max(0, totalReserved − reservedForThis)
 * - freeAvailableQty: onHand − reservedForOthers − warehousePacked
 * - physicalPackableQty: max(0, min(allocationBalance, freeAvailable))
 * - shortageQty: max(0, allocationBalance − physicalPackable)
 */
export function derivePackingLineStock(
  stock = {},
  { allocatedQty = 0, alreadyPacked = 0, isNegativeAllocation = false } = {}
) {
  const onHandQty = Number(stock?.onHandQty ?? stock?.quantity ?? 0) || 0;
  const totalReserved =
    Math.max(Number(stock?.allocatedQty || 0), Number(stock?.reservedQty || 0)) || 0;
  const warehousePackedQty = Number(stock?.packedQty || 0) || 0;
  const previouslyPackedQty = Math.max(0, Number(alreadyPacked) || 0);
  const allocationBalanceQty = Math.max(0, (Number(allocatedQty) || 0) - previouslyPackedQty);
  const reservedForThisAllocationQty = allocationBalanceQty;
  const reservedForOtherAllocationsQty = Math.max(0, totalReserved - reservedForThisAllocationQty);
  const freeAvailableQty = onHandQty - reservedForOtherAllocationsQty - warehousePackedQty;
  const physicalPackableQty = Math.max(0, Math.min(allocationBalanceQty, freeAvailableQty));
  const shortageQty = Math.max(0, allocationBalanceQty - physicalPackableQty);
  const availableStock = deriveAvailableQty({
    onHandQty,
    reservedQty: totalReserved,
    packedQty: warehousePackedQty,
  });
  // Negative allocation = this line's claim exceeds physical on-hand (or explicit flag).
  // Other allocations reducing freeAvailable is PARTIAL/SHORTAGE, not NEGATIVE_ALLOCATION.
  const isNeg =
    Boolean(isNegativeAllocation) || onHandQty + 1e-9 < reservedForThisAllocationQty;

  let stockStatus = "UNKNOWN";
  if (!(Number.isFinite(onHandQty) && Number.isFinite(totalReserved))) {
    stockStatus = "UNKNOWN";
  } else if (allocationBalanceQty <= 1e-9) {
    stockStatus = "READY";
  } else if (physicalPackableQty <= 1e-9) {
    stockStatus = isNeg ? "NEGATIVE_ALLOCATION" : "SHORTAGE";
  } else if (shortageQty > 1e-9) {
    stockStatus = isNeg ? "NEGATIVE_ALLOCATION" : "PARTIAL";
  } else {
    stockStatus = "READY";
  }

  return {
    onHandQty,
    reservedQty: totalReserved,
    reservedForThisAllocationQty,
    reservedForOtherAllocationsQty,
    previouslyPackedQty,
    allocationBalanceQty,
    warehousePackedQty,
    freeAvailableQty,
    physicalPackableQty,
    shortageQty,
    availableStock,
    isNegativeAllocation: isNeg,
    stockStatus,
  };
}

/**
 * Store-friendly status labels (display only — does not change packing validation).
 */
export function mapPackingStoreStatus(derived = {}) {
  const status = String(derived.stockStatus || "").toUpperCase();
  const onHand = Number(derived.onHandQty) || 0;
  const balance = Number(derived.allocationBalanceQty) || 0;
  const pick = Number(derived.physicalPackableQty) || 0;
  const others = Number(derived.reservedForOtherAllocationsQty) || 0;

  if (balance <= 1e-9 && (status === "READY" || pick <= 1e-9)) {
    return "PACKED";
  }
  if (status === "READY") return "READY TO PICK";
  if (status === "PARTIAL") return "PARTIAL STOCK";
  if (status === "NEGATIVE_ALLOCATION") return "NEGATIVE ALLOCATION";
  if (status === "SHORTAGE") {
    if (onHand > 1e-9 && others > 1e-9 && pick <= 1e-9) {
      return "RESERVED FOR OTHER ALLOCATION";
    }
    if (onHand <= 1e-9) return "NO STOCK";
    return "NO STOCK / SHORTAGE";
  }
  return "UNKNOWN";
}

/**
 * Location/stock remarks for Phase 1 (historical putaway ≠ current bin qty).
 */
export function mapPackingStoreRemarks(derived = {}, lastKnownPutaway = null) {
  const onHand = Number(derived.onHandQty) || 0;
  const hasPutaway = Boolean(String(lastKnownPutaway?.value || "").trim());
  const storeStatus = mapPackingStoreStatus(derived);

  if (onHand > 1e-9) {
    if (hasPutaway) return "STOCK EXISTS — BIN QTY NOT TRACKED";
    return "STOCK EXISTS — LOCATION NOT RECORDED";
  }
  if (hasPutaway) return "NO STOCK — HISTORICAL PUTAWAY ONLY";
  if (storeStatus === "RESERVED FOR OTHER ALLOCATION") {
    return "STOCK RESERVED FOR OTHER ALLOCATION";
  }
  return "NO STOCK / LOCATION NOT ASSIGNED";
}

/** PDF remark line — never claims current bin availability. */
export function mapPackingPdfRemarks(derived = {}, lastKnownPutaway = null) {
  const storeStatus = mapPackingStoreStatus(derived);
  const onHand = Number(derived.onHandQty) || 0;
  const hasPutaway = Boolean(String(lastKnownPutaway?.value || "").trim());
  const pick = Number(derived.physicalPackableQty) || 0;
  const shortage = Number(derived.shortageQty) || 0;

  if (storeStatus === "READY TO PICK") {
    return hasPutaway ? "READY TO PICK — VERIFY BIN" : "READY TO PICK";
  }
  if (storeStatus === "PARTIAL STOCK") {
    return `PARTIAL STOCK — AVAILABLE ${pick} / SHORT ${shortage}`;
  }
  if (storeStatus === "PACKED") return "PACKED";
  if (onHand <= 1e-9 && hasPutaway) return "NO STOCK — HISTORICAL PUTAWAY ONLY";
  if (onHand <= 1e-9) return "NO STOCK / LOCATION NOT ASSIGNED";
  if (storeStatus === "RESERVED FOR OTHER ALLOCATION") {
    return "RESERVED FOR OTHER ALLOCATION";
  }
  return mapPackingStoreRemarks(derived, lastKnownPutaway);
}

export function buildPackingStorePresentation(derived = {}, lastKnownPutaway = null) {
  return {
    pickQty: Math.max(0, Number(derived.physicalPackableQty) || 0),
    storeStatus: mapPackingStoreStatus(derived),
    storeRemarks: mapPackingStoreRemarks(derived, lastKnownPutaway),
    pdfRemarks: mapPackingPdfRemarks(derived, lastKnownPutaway),
    lastKnownPutaway: lastKnownPutaway || null,
  };
}

/** Parse putaway text from StockLedger remarks (`Putaway: …`). */
export function parsePutawayFromLedgerRemarks(remarks = "") {
  const raw = String(remarks || "");
  const m = raw.match(/Putaway:\s*(.+?)(?:\s*\||$)/i);
  if (!m) return "";
  return String(m[1] || "").trim();
}

/**
 * From a flat list of GRN putaway candidates (already company-scoped),
 * pick the latest valid putaway per article for one warehouse.
 * Ignores cancelled / draft / empty putaway / other warehouses.
 */
export function selectLatestPutawayByArticle(candidates = [], warehouse = "MAIN") {
  const wh = String(warehouse || "MAIN").trim().toUpperCase();
  const invalidStatuses = new Set(["CANCELLED", "DRAFT"]);
  const byArticle = new Map();

  for (const row of candidates) {
    const st = String(row.status || "").toUpperCase();
    if (invalidStatuses.has(st)) continue;
    const art = String(row.article || "").trim().toUpperCase();
    const put = String(row.putaway || "").trim();
    if (!art || !put) continue;
    const rowWh = String(row.warehouse || wh).trim().toUpperCase() || wh;
    if (rowWh !== wh) continue;

    const ts = new Date(row.date || row.postedAt || row.grnDate || 0).getTime() || 0;
    const prev = byArticle.get(art);
    if (
      !prev ||
      ts > prev._ts ||
      (ts === prev._ts && String(row.sourceDocument || "") > String(prev.sourceDocument || ""))
    ) {
      byArticle.set(art, {
        value: put,
        source: row.source || "GRN",
        sourceDocument: row.sourceDocument || "",
        date: row.date || row.postedAt || row.grnDate || null,
        historical: true,
        _ts: ts,
      });
    }
  }

  for (const v of byArticle.values()) delete v._ts;
  return byArticle;
}

/** Shortage for a requested pack quantity against free physical availability. */
export function shortageForRequestedQty(freeAvailableQty, requestedQty) {
  const free = Math.max(0, Number(freeAvailableQty) || 0);
  const req = Math.max(0, Number(requestedQty) || 0);
  const shortageQty = Math.max(0, req - free);
  return {
    physicalAvailableQty: free,
    shortageQty,
    hasShortage: shortageQty > 1e-9,
  };
}

/**
 * Aggregate packing line shortages for post validation.
 * @param {Array<{article, packQty, warehouseCode?, freeAvailableQty}>} rows
 */
export function collectPackingShortages(rows = [], warehouseCode = "MAIN") {
  const shortages = [];
  for (const row of rows) {
    const article = String(row?.article || "").trim().toUpperCase();
    const requestedQty = Number(row?.packQty ?? row?.requestedQty) || 0;
    if (!article || requestedQty <= 0) continue;
    const { physicalAvailableQty, shortageQty, hasShortage } = shortageForRequestedQty(
      row?.freeAvailableQty,
      requestedQty
    );
    if (!hasShortage) continue;
    shortages.push({
      article,
      requestedQty,
      physicalAvailableQty,
      shortageQty,
      warehouseCode: String(row?.warehouseCode || warehouseCode || "MAIN").toUpperCase(),
    });
  }
  return shortages;
}

export const PACKING_OVERRIDE_PHYSICAL_SHORTAGE_PERMISSION = "PACKING.overridePhysicalShortage";

/**
 * Future-ready gate. Until a caller passes allowOverride=true with an approved
 * permission check, shortages always block.
 */
export function shouldBlockPhysicalShortagePost(shortages = [], { allowOverride = false } = {}) {
  if (!Array.isArray(shortages) || !shortages.length) return false;
  return !allowOverride;
}
