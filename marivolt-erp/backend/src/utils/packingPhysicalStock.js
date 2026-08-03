/**
 * Physical stock visibility helpers for package-based packing.
 * Pure functions — no DB writes. Does not change reservation/ledger math.
 */

export const PACKING_STOCK_STATUSES = Object.freeze([
  "READY",
  "PARTIAL",
  "SHORTAGE",
  "NEGATIVE_ALLOCATION",
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
  const availableStock =
    stock?.availableQty != null
      ? Number(stock.availableQty) || 0
      : onHandQty - totalReserved - warehousePackedQty;
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
