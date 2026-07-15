/**
 * Frontend OA lifecycle helpers — mirrors backend progress derivation.
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

function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

export function oaPiProgressPercent(issued, commercial) {
  const c = Math.max(0, Number(commercial) || 0);
  if (c <= TOL) return 0;
  return roundMoney(Math.min(100, Math.max(0, ((Math.max(0, Number(issued) || 0) / c) * 100))));
}

export function resolveOaProgressStatus(oa = {}) {
  if (oa.progressStatus && OA_PROGRESS_STATUSES.includes(String(oa.progressStatus))) {
    return String(oa.progressStatus);
  }
  const st = String(oa.status || "").toUpperCase();
  if (st === "CANCELLED") return "CANCELLED";
  if (OA_PROGRESS_STATUSES.includes(st)) return st;

  const conv = Array.isArray(oa.convertedTo) ? oa.convertedTo.map(String) : [];
  if (st === "CLOSED" || st === "COMPLETED" || conv.includes("SALES_INVOICE")) return "COMPLETED";
  if (st === "PACKING" || st === "CONVERTED" || conv.includes("ORDER_ALLOCATION")) return "PACKING";

  const activePi =
    typeof oa.hasActiveProforma === "boolean"
      ? oa.hasActiveProforma
      : Math.max(0, Number(oa.activePiCount) || 0) > 0 || conv.includes("PROFORMA");
  const remaining = Number(oa.piRemainingEligibleAmount);
  const issued = Number(oa.piIssuedRequestedTotal) || 0;

  if (activePi || issued > TOL) {
    if (Number.isFinite(remaining) && remaining <= TOL) return "FULLY_PI_ISSUED";
    if (st === "FULLY_PI_ISSUED") return "FULLY_PI_ISSUED";
    return "PARTIALLY_PI_ISSUED";
  }
  return "ACTIVE";
}

export function formatOaProgressLabel(status = "") {
  const s = String(status || "").toUpperCase();
  switch (s) {
    case "PARTIALLY_PI_ISSUED":
      return "Partially PI Issued";
    case "FULLY_PI_ISSUED":
      return "Fully PI Issued";
    case "PACKING":
      return "Packing";
    case "COMPLETED":
      return "Completed";
    case "CANCELLED":
      return "Cancelled";
    case "ACTIVE":
      return "Active";
    default:
      return s.replaceAll("_", " ") || "—";
  }
}
