/**
 * Order Acknowledgement lifecycle helpers (multi partial PI).
 *
 * progressStatus is the user-facing lifecycle state. It is derived from stored
 * status + downstream docs + PI issuance so historical rows (APPROVED/CONVERTED/
 * CLOSED/CONFIRMED/DRAFT) keep working without a data migration.
 */

export const OA_PROGRESS_STATUSES = [
  "ACTIVE",
  "PARTIALLY_PI_ISSUED",
  "FULLY_PI_ISSUED",
  "PACKING",
  "COMPLETED",
  "CANCELLED",
];

const TOL = 0.005;

export function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function oaPiProgressPercent(issued, commercial) {
  const c = Math.max(0, Number(commercial) || 0);
  if (c <= TOL) return 0;
  const pct = (Math.max(0, Number(issued) || 0) / c) * 100;
  return roundMoney(Math.min(100, Math.max(0, pct)));
}

/**
 * @param {object} oa
 * @param {{
 *   piIssuedRequestedTotal?: number,
 *   piRemainingEligibleAmount?: number,
 *   activePiCount?: number,
 *   hasSalesInvoice?: boolean,
 *   hasOrderAllocation?: boolean,
 * }} ctx
 */
export function resolveOaProgressStatus(oa = {}, ctx = {}) {
  const st = String(oa.status || "").toUpperCase();
  if (st === "CANCELLED") return "CANCELLED";

  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map(String) : [];
  const hasSI =
    ctx.hasSalesInvoice === true ||
    conv.includes("SALES_INVOICE") ||
    st === "COMPLETED" ||
    st === "CLOSED";
  if (hasSI) return "COMPLETED";

  const hasAlloc =
    ctx.hasOrderAllocation === true ||
    conv.includes("ORDER_ALLOCATION") ||
    st === "PACKING" ||
    st === "CONVERTED";
  if (hasAlloc) return "PACKING";

  const activePiCount = Math.max(0, Number(ctx.activePiCount) || 0);
  const remaining =
    ctx.piRemainingEligibleAmount != null
      ? Number(ctx.piRemainingEligibleAmount)
      : null;
  const issued = Math.max(0, Number(ctx.piIssuedRequestedTotal) || 0);

  if (activePiCount > 0 || issued > TOL) {
    if (remaining != null && remaining <= TOL) return "FULLY_PI_ISSUED";
    if (remaining == null && st === "FULLY_PI_ISSUED") return "FULLY_PI_ISSUED";
    return "PARTIALLY_PI_ISSUED";
  }

  return "ACTIVE";
}

/**
 * Persistable status for OA after a PI issuance change (not packing/SI).
 */
export function suggestOaStatusAfterPiIssuance(capacity = {}) {
  const activePiCount = Math.max(0, Number(capacity.activePiCount) || 0);
  const remaining = Number(capacity.piRemainingEligibleAmount);
  if (activePiCount <= 0) return "ACTIVE";
  if (Number.isFinite(remaining) && remaining <= TOL) return "FULLY_PI_ISSUED";
  return "PARTIALLY_PI_ISSUED";
}

/**
 * Edit lock: PI alone must NOT lock. Packing / SI / cancelled / completed do.
 */
export function isOaEditLockedByLifecycle(oa = {}, ctx = {}) {
  if (!oa) return true;
  const progress = resolveOaProgressStatus(oa, ctx);
  if (["CANCELLED", "COMPLETED", "PACKING"].includes(progress)) return true;
  const st = String(oa.status || "").toUpperCase();
  if (["CANCELLED", "CLOSED", "COMPLETED", "PACKING", "CONVERTED"].includes(st)) return true;
  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map(String) : [];
  if (conv.includes("SALES_INVOICE") || conv.includes("ORDER_ALLOCATION")) return true;
  if (ctx.hasSalesInvoice === true || ctx.hasOrderAllocation === true) return true;
  return false;
}

export function buildOaPiProgressSummary(oa = {}, capacity = {}) {
  const commercialTotal = roundMoney(
    Math.max(0, Number(capacity.oaCommercialGrandTotal ?? oa.grandTotal) || 0)
  );
  const piIssuedRequestedTotal = roundMoney(
    Math.max(0, Number(capacity.piIssuedRequestedTotal) || 0)
  );
  const piRemainingEligibleAmount = roundMoney(
    Math.max(
      0,
      Number(
        capacity.piRemainingEligibleAmount ?? commercialTotal - piIssuedRequestedTotal
      ) || 0
    )
  );
  const activePiCount = Math.max(0, Number(capacity.activePiCount) || 0);
  const progressStatus = resolveOaProgressStatus(oa, {
    ...capacity,
    piIssuedRequestedTotal,
    piRemainingEligibleAmount,
    activePiCount,
  });
  return {
    progressStatus,
    commercialTotal,
    piIssuedRequestedTotal,
    piRemainingEligibleAmount,
    piProgressPercent: oaPiProgressPercent(piIssuedRequestedTotal, commercialTotal),
    activePiCount,
    canCreateAdditionalProforma:
      piRemainingEligibleAmount > TOL && !["CANCELLED", "COMPLETED"].includes(progressStatus),
    isEditLocked: isOaEditLockedByLifecycle(oa, {
      ...capacity,
      piIssuedRequestedTotal,
      piRemainingEligibleAmount,
      activePiCount,
      hasOrderAllocation: capacity.hasOrderAllocation,
      hasSalesInvoice: capacity.hasSalesInvoice,
    }),
  };
}

/**
 * Build a commercial revision row when OA commercial total changes while PIs exist.
 * Throws Error on invalid reason / below-floor value.
 */
export function buildOaCommercialRevision({
  previousCommercial,
  revisedCommercial,
  issuedRequestedTotal = 0,
  existingRevisions = [],
  reason,
  revisedBy = "",
  revisionDate = new Date(),
} = {}) {
  const originalCommercialValue = roundMoney(Math.max(0, Number(previousCommercial) || 0));
  const revisedCommercialValue = roundMoney(Math.max(0, Number(revisedCommercial) || 0));
  const issued = roundMoney(Math.max(0, Number(issuedRequestedTotal) || 0));
  const revisionReason = String(reason || "").trim();

  if (!Number.isFinite(revisedCommercialValue) || Number.isNaN(revisedCommercialValue)) {
    throw new Error("Revised commercial value is invalid");
  }
  if (Math.abs(revisedCommercialValue - originalCommercialValue) <= TOL) {
    return null;
  }
  if (revisedCommercialValue + TOL < issued) {
    throw new Error(
      `Commercial total cannot be below PI amount already issued (${issued.toFixed(2)})`
    );
  }
  if (!revisionReason) {
    throw new Error("Revision reason is required when changing commercial value while active PIs exist");
  }

  const prior = Array.isArray(existingRevisions) ? existingRevisions : [];
  const revisionNumber = prior.length + 1;
  return {
    revisionNumber,
    revisionDate: revisionDate instanceof Date ? revisionDate : new Date(revisionDate),
    originalCommercialValue,
    revisedCommercialValue,
    difference: roundMoney(revisedCommercialValue - originalCommercialValue),
    reason: revisionReason,
    revisedBy: String(revisedBy || "").trim(),
  };
}

/** Recalculate PI % of revised OA commercial; requested amounts stay fixed. */
export function recalculatePiAdvancePercentage(requestedAmount, oaCommercial) {
  const commercial = roundMoney(Math.max(0, Number(oaCommercial) || 0));
  const requested = roundMoney(Math.max(0, Number(requestedAmount) || 0));
  if (commercial <= TOL) return null;
  return roundMoney((requested / commercial) * 100);
}
