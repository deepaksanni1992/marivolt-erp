/**
 * Allocation line stock-position read model.
 * Ownership: OrderAllocation.lines (qty − packedQty).
 * Aggregate: StockBalance buckets.
 * Does NOT mutate inventory.
 */
import mongoose from "mongoose";
import OrderAllocation from "../models/OrderAllocation.js";
import StockBalance from "../models/StockBalance.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import {
  ALLOCATION_STATUSES_HOLDING_RESERVED,
  allocationLineRemainingReserved,
  deriveAvailableQty,
} from "./stockExpectedBuckets.js";

const EPS = 1e-6;

function n(v) {
  return Number(v) || 0;
}
function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

/** Active PO statuses that count toward "PO created" conversion qty. */
export const STOCK_POSITION_ACTIVE_PO_STATUSES = Object.freeze([
  "DRAFT",
  "SAVED",
  "SENT",
  "REJECTED",
  "PARTIAL_RECEIVED",
  "RECEIVED",
  "CLOSED",
]);

/** PO statuses that still represent outstanding inbound cover (not yet closed into stock). */
export const OUTSTANDING_INCOMING_PO_STATUSES = Object.freeze([
  "DRAFT",
  "SAVED",
  "SENT",
  "REJECTED",
  "PARTIAL_RECEIVED",
]);

export const ALLOCATION_STOCK_STATUSES = Object.freeze({
  FULLY_RESERVED: "FULLY_RESERVED",
  AVAILABLE: "AVAILABLE",
  PARTIALLY_RESERVED: "PARTIALLY_RESERVED",
  PURCHASE_REQUIRED: "PURCHASE_REQUIRED",
  PACKED: "PACKED",
  COMPLETED: "COMPLETED",
});

export const ALLOCATION_PROCUREMENT_STATUSES = Object.freeze({
  NOT_REQUIRED: "NOT_REQUIRED",
  NOT_CONVERTED: "NOT_CONVERTED",
  PARTIALLY_CONVERTED: "PARTIALLY_CONVERTED",
  PO_CREATED: "PO_CREATED",
  PARTIALLY_RECEIVED: "PARTIALLY_RECEIVED",
  RECEIVED: "RECEIVED",
});

export function derivePoConversionStatusLocal(orderedQty, activeConvertedQty) {
  const ordered = Math.max(0, n(orderedQty));
  const converted = Math.max(0, n(activeConvertedQty));
  if (converted <= EPS) return "NOT_CONVERTED";
  if (converted + EPS >= ordered) return "FULLY_CONVERTED";
  return "PARTIALLY_CONVERTED";
}

/**
 * Outstanding inbound PO qty for one PO line (excludes already received).
 * Cancelled / received / closed contribute 0.
 */
export function computeOutstandingIncomingPoLineQty(line = {}, poStatus) {
  const st = up(poStatus);
  if (st === "CANCELLED" || !OUTSTANDING_INCOMING_PO_STATUSES.includes(st)) return 0;
  const qty = Math.max(0, n(line.sourceConvertedQty ?? line.qty ?? line.orderedQty));
  const received = Math.max(0, n(line.receivedQty));
  return Math.max(0, qty - received);
}

/**
 * Pure: compute coverage / shortfall / statuses for one allocation line.
 */
export function computeAllocationLineStockPosition(input = {}) {
  const orderedQty = Math.max(0, n(input.orderedQty));
  const physicalQty = n(input.physicalQty);
  const totalReservedQty = Math.max(0, n(input.totalReservedQty));
  const totalPackedQty = Math.max(0, n(input.totalPackedQty));
  const packedForThisAllocation = Math.max(0, n(input.packedForThisAllocation));
  const reservedForThisAllocation = Math.max(0, n(input.reservedForThisAllocation));

  const otherReservations = Array.isArray(input.otherReservations) ? input.otherReservations : [];
  const reservedForOtherAllocations =
    input.reservedForOtherAllocations != null
      ? Math.max(0, n(input.reservedForOtherAllocations))
      : Math.max(
          0,
          otherReservations.reduce((s, r) => s + Math.max(0, n(r.reservedQty)), 0)
        );

  // Genuinely free stock (canonical). Do not use persisted availableQty.
  const freeAvailableQty = deriveAvailableQty({
    onHandQty: physicalQty,
    reservedQty: totalReservedQty,
    allocatedQty: totalReservedQty,
    packedQty: totalPackedQty,
  });

  // Packing-oriented free (includes this allocation's hold) — for reconcile/diagnostics only.
  const packingFreeAvailableQty = physicalQty - reservedForOtherAllocations - totalPackedQty;

  // Coverage: remaining reserved + already packed for this line (no double-count).
  const remainingReservedForThis = reservedForThisAllocation;
  const currentAllocationCoverageQty = remainingReservedForThis + packedForThisAllocation;

  const uncoveredDemand = Math.max(0, orderedQty - currentAllocationCoverageQty);
  const freeCover = Math.max(0, freeAvailableQty);
  const afterFree = Math.max(0, uncoveredDemand - freeCover);
  const incomingPoCoverageQty = Math.max(0, n(input.incomingPoCoverageQty));
  const purchaseShortfallQty = Math.max(0, afterFree - incomingPoCoverageQty);

  const poCreatedQty = Math.max(0, n(input.poCreatedQty));
  const poConversionStatus = derivePoConversionStatusLocal(orderedQty, poCreatedQty);
  const poQtyNotConverted = Math.max(0, orderedQty - poCreatedQty);

  const allocationStatus = up(input.allocationStatus);
  const stockStatus = deriveStockStatus({
    orderedQty,
    reservedForThisAllocation,
    packedForThisAllocation,
    currentAllocationCoverageQty,
    freeAvailableQty,
    purchaseShortfallQty,
    allocationStatus,
  });

  const procurementStatus = deriveProcurementStatus({
    purchaseShortfallQty,
    poCreatedQty,
    orderedQty,
    poStatuses: input.poStatuses || [],
    poConversionStatus,
  });

  const ownedRemainingSum = reservedForThisAllocation + reservedForOtherAllocations;
  const reservedReconcileDelta = totalReservedQty - ownedRemainingSum;

  return {
    orderedQty,
    physicalQty,
    totalReservedQty,
    reservedForThisAllocation,
    reservedForOtherAllocations,
    packedForThisAllocation,
    totalPackedQty,
    freeAvailableQty,
    packingFreeAvailableQty,
    canonicalFreeAvailableQty: freeAvailableQty,
    remainingReservedForThis,
    currentAllocationCoverageQty,
    uncoveredDemand,
    incomingPoCoverageQty,
    purchaseShortfallQty,
    poCreatedQty,
    poQtyNotConverted,
    poConversionStatus,
    stockStatus,
    procurementStatus,
    reservedReconcileDelta,
  };
}

export function deriveStockStatus({
  orderedQty,
  reservedForThisAllocation,
  packedForThisAllocation,
  currentAllocationCoverageQty,
  freeAvailableQty,
  purchaseShortfallQty,
  allocationStatus,
} = {}) {
  const ordered = Math.max(0, n(orderedQty));
  const reserved = Math.max(0, n(reservedForThisAllocation));
  const packed = Math.max(0, n(packedForThisAllocation));
  const coverage = Math.max(0, n(currentAllocationCoverageQty));
  const free = n(freeAvailableQty);
  const shortfall = Math.max(0, n(purchaseShortfallQty));
  const st = up(allocationStatus);

  if (st === "CLOSED" && coverage + EPS >= ordered && ordered > 0) {
    return ALLOCATION_STOCK_STATUSES.COMPLETED;
  }
  if (ordered > 0 && packed + EPS >= ordered) {
    return ALLOCATION_STOCK_STATUSES.PACKED;
  }
  if (ordered > 0 && coverage + EPS >= ordered && reserved > EPS) {
    return ALLOCATION_STOCK_STATUSES.FULLY_RESERVED;
  }
  if (ordered > 0 && coverage + EPS >= ordered && packed > EPS) {
    return ALLOCATION_STOCK_STATUSES.PACKED;
  }
  if (shortfall > EPS) {
    return ALLOCATION_STOCK_STATUSES.PURCHASE_REQUIRED;
  }
  if (reserved > EPS && coverage + EPS < ordered) {
    return ALLOCATION_STOCK_STATUSES.PARTIALLY_RESERVED;
  }
  if (ordered > 0 && free + EPS >= ordered && reserved <= EPS && packed <= EPS) {
    return ALLOCATION_STOCK_STATUSES.AVAILABLE;
  }
  if (reserved > EPS) {
    return ALLOCATION_STOCK_STATUSES.PARTIALLY_RESERVED;
  }
  if (shortfall <= EPS && free > EPS) {
    return ALLOCATION_STOCK_STATUSES.AVAILABLE;
  }
  return ALLOCATION_STOCK_STATUSES.PURCHASE_REQUIRED;
}

export function deriveProcurementStatus({
  purchaseShortfallQty,
  poCreatedQty,
  orderedQty,
  poStatuses = [],
  poConversionStatus,
} = {}) {
  // Primary rule: no further procurement needed → NOT_REQUIRED (even if no PO exists).
  if (Math.max(0, n(purchaseShortfallQty)) <= EPS) {
    return ALLOCATION_PROCUREMENT_STATUSES.NOT_REQUIRED;
  }
  const statuses = (poStatuses || []).map(up);
  if (statuses.some((s) => s === "RECEIVED" || s === "CLOSED")) {
    if (statuses.every((s) => s === "RECEIVED" || s === "CLOSED")) {
      return ALLOCATION_PROCUREMENT_STATUSES.RECEIVED;
    }
    return ALLOCATION_PROCUREMENT_STATUSES.PARTIALLY_RECEIVED;
  }
  if (statuses.some((s) => s === "PARTIAL_RECEIVED")) {
    return ALLOCATION_PROCUREMENT_STATUSES.PARTIALLY_RECEIVED;
  }
  const created = Math.max(0, n(poCreatedQty));
  const ordered = Math.max(0, n(orderedQty));
  if (created <= EPS) {
    return ALLOCATION_PROCUREMENT_STATUSES.NOT_CONVERTED;
  }
  if (created + EPS >= ordered) {
    return ALLOCATION_PROCUREMENT_STATUSES.PO_CREATED;
  }
  if (poConversionStatus === "PARTIALLY_CONVERTED") {
    return ALLOCATION_PROCUREMENT_STATUSES.PARTIALLY_CONVERTED;
  }
  return ALLOCATION_PROCUREMENT_STATUSES.PARTIALLY_CONVERTED;
}

/**
 * Batched stock position for one Order Allocation document.
 */
export async function getAllocationStockPosition(companyId, allocationId) {
  if (!mongoose.Types.ObjectId.isValid(String(allocationId || ""))) {
    throw new Error("Invalid order allocation id");
  }
  const allocation = await OrderAllocation.findOne({ companyId, _id: allocationId }).lean();
  if (!allocation) throw new Error("Order allocation not found");

  const warehouse = up(allocation.warehouse) || "MAIN";
  const articles = [
    ...new Set((allocation.lines || []).map((l) => up(l.article)).filter(Boolean)),
  ];

  const [balances, peerAllocations, pos] = await Promise.all([
    articles.length
      ? StockBalance.find({
          companyId,
          article: { $in: articles },
          $or: [{ warehouse }, { location: warehouse }],
        })
          .select(
            "article warehouse location onHandQty quantity reservedQty allocatedQty packedQty availableQty"
          )
          .lean()
      : [],
    articles.length
      ? OrderAllocation.find({
          companyId,
          warehouse,
          status: { $in: [...ALLOCATION_STATUSES_HOLDING_RESERVED] },
          "lines.article": { $in: articles },
        })
          .select(
            "allocationNo status customerName warehouse linkedOANo linkedProformaNo linkedOAId linkedProformaId lines.article lines.qty lines.packedQty lines._id"
          )
          .lean()
      : [],
    articles.length
      ? PurchaseOrder.find({
          companyId,
          sourceOrderAllocationId: allocation._id,
          status: { $in: [...STOCK_POSITION_ACTIVE_PO_STATUSES] },
        })
          .select("poNumber status lines")
          .lean()
      : [],
  ]);

  const balanceByArticle = new Map();
  for (const b of balances) {
    const art = up(b.article);
    const wh = up(b.warehouse || b.location) || "MAIN";
    if (wh !== warehouse) continue;
    const prev = balanceByArticle.get(art) || {
      onHandQty: 0,
      reservedQty: 0,
      allocatedQty: 0,
      packedQty: 0,
    };
    prev.onHandQty += n(b.onHandQty ?? b.quantity);
    prev.reservedQty += n(b.reservedQty);
    prev.allocatedQty += n(b.allocatedQty);
    prev.packedQty += n(b.packedQty);
    balanceByArticle.set(art, prev);
  }

  const ownershipByArticle = new Map();
  for (const alloc of peerAllocations) {
    const allocWh = up(alloc.warehouse) || "MAIN";
    if (allocWh !== warehouse) continue;
    for (const ln of alloc.lines || []) {
      const art = up(ln.article);
      if (!articles.includes(art)) continue;
      const remaining = allocationLineRemainingReserved(ln);
      if (remaining <= EPS) continue;
      const list = ownershipByArticle.get(art) || [];
      list.push({
        allocationId: String(alloc._id),
        allocationNo: alloc.allocationNo || "",
        customerName: alloc.customerName || "",
        linkedOANo: alloc.linkedOANo || "",
        linkedProformaNo: alloc.linkedProformaNo || "",
        warehouse: allocWh,
        reservedQty: remaining,
        packedQty: Math.max(0, n(ln.packedQty)),
        orderedQty: Math.max(0, n(ln.qty)),
        status: alloc.status || "",
        isCurrent: String(alloc._id) === String(allocation._id),
      });
      ownershipByArticle.set(art, list);
    }
  }

  const incomingByLineId = new Map();
  const poStatusesByLineId = new Map();
  const poCreatedByLineId = new Map();
  const poNumbersByLineId = new Map();

  for (const po of pos) {
    const st = up(po.status);
    for (const line of po.lines || []) {
      const lineId = String(line.sourceOrderAllocationLineId || "");
      if (!lineId) continue;
      const converted = Math.max(0, n(line.sourceConvertedQty ?? line.qty));
      poCreatedByLineId.set(lineId, (poCreatedByLineId.get(lineId) || 0) + converted);
      const nums = poNumbersByLineId.get(lineId) || [];
      if (po.poNumber && !nums.includes(po.poNumber)) nums.push(po.poNumber);
      poNumbersByLineId.set(lineId, nums);
      const statuses = poStatusesByLineId.get(lineId) || [];
      statuses.push(st);
      poStatusesByLineId.set(lineId, statuses);
      const outstanding = computeOutstandingIncomingPoLineQty(line, st);
      if (outstanding > EPS) {
        incomingByLineId.set(lineId, (incomingByLineId.get(lineId) || 0) + outstanding);
      }
    }
  }

  const lines = [];
  for (const line of allocation.lines || []) {
    const art = up(line.article);
    const lineId = String(line._id || "");
    const orderedQty = Math.max(0, n(line.qty));
    const packedForThisAllocation = Math.max(0, n(line.packedQty));
    const reservedForThisAllocation = allocationLineRemainingReserved(line);

    const bal = balanceByArticle.get(art) || {
      onHandQty: 0,
      reservedQty: 0,
      allocatedQty: 0,
      packedQty: 0,
    };
    const totalReservedQty = Math.max(n(bal.allocatedQty), n(bal.reservedQty));
    const totalPackedQty = Math.max(0, n(bal.packedQty));
    const physicalQty = n(bal.onHandQty);

    const ownership = ownershipByArticle.get(art) || [];
    const others = ownership.filter((o) => !o.isCurrent);
    const currentRows = ownership.filter((o) => o.isCurrent);

    const poCreatedQty = Math.max(0, n(poCreatedByLineId.get(lineId) || 0));
    const incomingPoCoverageQty = Math.max(0, n(incomingByLineId.get(lineId) || 0));

    const computed = computeAllocationLineStockPosition({
      orderedQty,
      physicalQty,
      totalReservedQty,
      totalPackedQty,
      reservedForThisAllocation,
      packedForThisAllocation,
      otherReservations: others,
      incomingPoCoverageQty,
      poCreatedQty,
      allocationStatus: allocation.status,
      poStatuses: poStatusesByLineId.get(lineId) || [],
    });

    if (Math.abs(computed.reservedReconcileDelta) > EPS) {
      console.warn(
        `[allocationStockPosition] reserved reconcile mismatch company=${companyId} alloc=${allocation.allocationNo} article=${art} delta=${computed.reservedReconcileDelta} balanceReserved=${totalReservedQty} ownedSum=${reservedForThisAllocation + computed.reservedForOtherAllocations}`
      );
    }

    const reservationBreakdown = [
      ...currentRows.map((r) => ({
        ...r,
        ownershipLabel: "This allocation",
      })),
      ...others.map((r) => ({
        ...r,
        ownershipLabel: "Reserved for another allocation",
      })),
    ];

    // If current hold exists on the line but peer scan missed (edge), still expose this row.
    if (!currentRows.length && reservedForThisAllocation > EPS) {
      reservationBreakdown.unshift({
        allocationId: String(allocation._id),
        allocationNo: allocation.allocationNo || "",
        customerName: allocation.customerName || "",
        linkedOANo: allocation.linkedOANo || "",
        linkedProformaNo: allocation.linkedProformaNo || "",
        warehouse,
        reservedQty: reservedForThisAllocation,
        packedQty: packedForThisAllocation,
        orderedQty,
        status: allocation.status || "",
        isCurrent: true,
        ownershipLabel: "This allocation",
      });
    }

    lines.push({
      allocationLineId: line._id,
      serialNo: line.serialNo,
      article: line.article,
      description: line.description || "",
      partNumber: line.partNumber || "",
      materialCode: line.materialCode || "",
      uom: line.uom || "PCS",
      warehouse,
      ...computed,
      reservationBreakdown,
      linkedPoNumbers: poNumbersByLineId.get(lineId) || [],
    });
  }

  return {
    allocationId: String(allocation._id),
    allocationNo: allocation.allocationNo,
    warehouse,
    customerName: allocation.customerName || "",
    status: allocation.status,
    linkedOANo: allocation.linkedOANo || "",
    linkedProformaNo: allocation.linkedProformaNo || "",
    lines,
  };
}

export default {
  computeAllocationLineStockPosition,
  deriveStockStatus,
  deriveProcurementStatus,
  getAllocationStockPosition,
  computeOutstandingIncomingPoLineQty,
  ALLOCATION_STOCK_STATUSES,
  ALLOCATION_PROCUREMENT_STATUSES,
  OUTSTANDING_INCOMING_PO_STATUSES,
};
