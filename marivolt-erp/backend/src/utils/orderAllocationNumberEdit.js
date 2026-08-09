/**
 * P3 — Order Allocation number edit eligibility (backend authority).
 *
 * Conservative: block once packing / SI / dispatch / PO / fulfilment starts,
 * or when legacy v1 reservation identity would break rename-safe release.
 */
import StorePacking from "../models/StorePacking.js";
import StoreDispatch from "../models/StoreDispatch.js";
import SalesInvoice from "../models/SalesInvoice.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import {
  allocationRemainingReservedQty,
  allocationUsesV2ReservationIdentity,
} from "./allocationReservationKeys.js";

function statusError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

const NOT_CANCELLED = { status: { $ne: "CANCELLED" } };

/**
 * @param {{
 *   companyId: any,
 *   allocation: object,
 *   existsFns?: {
 *     packing?: Function,
 *     salesInvoice?: Function,
 *     storeDispatch?: Function,
 *     purchaseOrder?: Function,
 *   }
 * }} args
 * @returns {Promise<{ allowed: boolean, reason: string }>}
 */
export async function evaluateOrderAllocationNumberEditability({
  companyId,
  allocation,
  existsFns = {},
} = {}) {
  if (!allocation) {
    return { allowed: false, reason: "Allocation not found." };
  }

  const status = String(allocation.status || "").toUpperCase();
  if (status === "CANCELLED") {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed because the allocation is cancelled.",
    };
  }
  if (status !== "OPEN") {
    return {
      allowed: false,
      reason: "Allocation number can only be changed while the allocation is OPEN.",
    };
  }

  const packingStatus = String(allocation.packingStatus || "NOT_PACKED").toUpperCase();
  if (packingStatus !== "NOT_PACKED") {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed after packing has started.",
    };
  }

  if ((allocation.lines || []).some((l) => Number(l.packedQty) > 0)) {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed after packing has started.",
    };
  }

  if (allocation.linkedSalesInvoiceId) {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed because a Sales Invoice exists.",
    };
  }

  const invoiceStatus = String(allocation.invoiceStatus || "NOT_INVOICED").toUpperCase();
  if (invoiceStatus !== "NOT_INVOICED") {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed because a Sales Invoice exists.",
    };
  }

  const dispatchStatus = String(allocation.dispatchStatus || "NOT_DISPATCHED").toUpperCase();
  if (dispatchStatus !== "NOT_DISPATCHED") {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed because a Sales Dispatch exists.",
    };
  }

  const documentId = allocation._id;
  const hasPacking = existsFns.packing
    ? await existsFns.packing()
    : await StorePacking.exists({ companyId, allocationId: documentId, ...NOT_CANCELLED });
  if (hasPacking) {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed because a Packing document exists.",
    };
  }

  const hasSi = existsFns.salesInvoice
    ? await existsFns.salesInvoice()
    : await SalesInvoice.exists({
        companyId,
        linkedOrderAllocationId: documentId,
        ...NOT_CANCELLED,
      });
  if (hasSi) {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed because a Sales Invoice exists.",
    };
  }

  const hasStoreDispatch = existsFns.storeDispatch
    ? await existsFns.storeDispatch()
    : await StoreDispatch.exists({ companyId, allocationId: documentId, ...NOT_CANCELLED });
  if (hasStoreDispatch) {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed because a Dispatch exists.",
    };
  }

  const hasPo = existsFns.purchaseOrder
    ? await existsFns.purchaseOrder()
    : await PurchaseOrder.exists({
        companyId,
        sourceOrderAllocationId: documentId,
        ...NOT_CANCELLED,
      });
  if (hasPo) {
    return {
      allowed: false,
      reason: "Allocation number cannot be changed because a Purchase Order exists.",
    };
  }

  // Legacy active reservation protection:
  // - identity family is v1 (missing fields / default 1 / explicit 1)
  // - stockReservedAt proves a reserve was applied
  // - remaining unpacked qty > 0 means release/pack still depends on that identity
  // Historical v1 OPEN rows with no stockReservedAt (never reserved) may rename.
  const usesV2 = allocationUsesV2ReservationIdentity(allocation);
  const remainingReservedQty = allocationRemainingReservedQty(allocation);
  const hasActiveLegacyReservation =
    !usesV2 && remainingReservedQty > 0 && Boolean(allocation.stockReservedAt);
  if (hasActiveLegacyReservation) {
    return {
      allowed: false,
      reason: "Legacy reservation identity prevents safe renumbering.",
    };
  }

  return { allowed: true, reason: "" };
}

/**
 * Throw if allocation number change is not allowed.
 */
export async function assertOrderAllocationNumberChangeAllowed(args) {
  const result = await evaluateOrderAllocationNumberEditability(args);
  if (!result.allowed) {
    throw statusError(result.reason || "Allocation number cannot be changed.", 400);
  }
  return result;
}
