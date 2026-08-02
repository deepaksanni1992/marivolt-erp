/**
 * CG2 — Customs outbound FIFO ordering (single source of truth).
 *
 * Default order (all ascending; missing dates sort last):
 * 1. BOE Date
 * 2. Supplier Invoice Date
 * 3. Received Date
 * 4. GRN Created Date
 * 5. Customs Lot ID
 * 6. Customs Lot Item ID (stable tie-break)
 *
 * Do not hardcode this order elsewhere — import compareCustomsFifoOrder / sortCustomsLotsForFifo.
 */

export const CUSTOMS_FIFO_ORDER_KEYS = [
  "boeDate",
  "supplierInvoiceDate",
  "receivedDate",
  "grnCreatedAt",
  "customsLotId",
  "customsLotItemId",
];

function dateAscKey(value) {
  if (value == null || value === "") return Number.POSITIVE_INFINITY;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function idAscKey(value) {
  return String(value ?? "");
}

/**
 * Compare two enriched lot-item rows for CG2 FIFO.
 * Rows should carry: boeDate, supplierInvoiceDate, receivedDate, grnCreatedAt, customsLotId, _id.
 */
export function compareCustomsFifoOrder(a = {}, b = {}) {
  const aBoe = dateAscKey(a.boeDate);
  const bBoe = dateAscKey(b.boeDate);
  if (aBoe !== bBoe) return aBoe - bBoe;

  const aSi = dateAscKey(a.supplierInvoiceDate);
  const bSi = dateAscKey(b.supplierInvoiceDate);
  if (aSi !== bSi) return aSi - bSi;

  const aRecv = dateAscKey(a.receivedDate);
  const bRecv = dateAscKey(b.receivedDate);
  if (aRecv !== bRecv) return aRecv - bRecv;

  const aGrn = dateAscKey(a.grnCreatedAt ?? a.grnCreatedDate);
  const bGrn = dateAscKey(b.grnCreatedAt ?? b.grnCreatedDate);
  if (aGrn !== bGrn) return aGrn - bGrn;

  const aLot = idAscKey(a.customsLotId?._id ?? a.customsLotId);
  const bLot = idAscKey(b.customsLotId?._id ?? b.customsLotId);
  if (aLot !== bLot) return aLot.localeCompare(bLot);

  const aItem = idAscKey(a.customsLotItemId || a._id);
  const bItem = idAscKey(b.customsLotItemId || b._id);
  return aItem.localeCompare(bItem);
}

export function sortCustomsLotsForFifo(items = []) {
  return [...items].sort(compareCustomsFifoOrder);
}

/**
 * Pure FIFO walk: allocate requested qty across sorted available rows.
 * Does not touch the database.
 */
export function allocateQtyAcrossLotsFifo(sortedItems = [], qty = 0) {
  const need = Number(qty) || 0;
  if (need <= 0) return { allocations: [], shortfall: 0 };

  let remaining = need;
  const allocations = [];
  for (const item of sortedItems) {
    if (remaining <= 0.000001) break;
    const available = Number(item.qtyAvailable) || 0;
    if (available <= 0) continue;
    const take = Math.min(available, remaining);
    const remainingAfter = available - take;
    allocations.push({
      customsLotItemId: item._id,
      customsLotId: item.customsLotId,
      qty: take,
      remainingAfter,
      item,
    });
    remaining -= take;
  }

  return {
    allocations,
    shortfall: remaining > 0.000001 ? remaining : 0,
  };
}
