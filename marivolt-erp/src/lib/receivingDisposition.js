/**
 * Tablet convenience only. Backend validates disposition totals and condition.
 */

export function allGoodDisposition(actualQty) {
  const actual = Number(actualQty);
  const qty = Number.isFinite(actual) && actual >= 0 ? actual : 0;
  if (qty === 0) return notReceivedDisposition();
  return {
    acceptedQty: qty,
    damagedQty: 0,
    rejectedQty: 0,
    condition: "GOOD",
  };
}

export function notReceivedDisposition() {
  return {
    acceptedQty: 0,
    damagedQty: 0,
    rejectedQty: 0,
    condition: "NOT_RECEIVED",
  };
}

export function dispositionTotal(acceptedQty, damagedQty, rejectedQty) {
  return (Number(acceptedQty) || 0) + (Number(damagedQty) || 0) + (Number(rejectedQty) || 0);
}

export function suggestConditionFromDisposition(actualQty, acceptedQty, damagedQty, rejectedQty) {
  const actual = Number(actualQty) || 0;
  const a = Number(acceptedQty) || 0;
  const d = Number(damagedQty) || 0;
  const r = Number(rejectedQty) || 0;
  if (actual === 0) return "NOT_RECEIVED";
  const buckets = [a > 0, d > 0, r > 0].filter(Boolean).length;
  if (buckets > 1) return "MIXED";
  if (d === actual && actual > 0) return "DAMAGED";
  if (r === actual && actual > 0) return "REJECTED";
  if (a === actual) return "GOOD";
  return "MIXED";
}

export function hasDiscrepancy({ plannedQty, actualQty, damagedQty, rejectedQty, shortQty, excessQty, condition } = {}) {
  const planned = Number(plannedQty) || 0;
  const actual = actualQty == null ? planned : Number(actualQty) || 0;
  return (
    String(condition || "").toUpperCase() === "NOT_RECEIVED" ||
    actual !== planned ||
    (Number(damagedQty) || 0) > 0 ||
    (Number(rejectedQty) || 0) > 0 ||
    (Number(shortQty) || 0) > 0 ||
    (Number(excessQty) || 0) > 0 ||
    actual === 0
  );
}

export function discrepancyFlags(row = {}) {
  const actual = row.actualQty == null || row.actualQty === "" ? null : Number(row.actualQty);
  const cond = String(row.condition || "").toUpperCase();
  const flags = [];
  if (cond === "NOT_RECEIVED" || actual === 0) {
    flags.push("NOT RECEIVED");
  } else {
    if ((Number(row.shortQty) || 0) > 0) flags.push("SHORT");
    if (cond === "MIXED") flags.push("MIXED");
    if ((Number(row.damagedQty) || 0) > 0 || cond === "DAMAGED") flags.push("DAMAGED");
    if ((Number(row.rejectedQty) || 0) > 0 || cond === "REJECTED") flags.push("REJECTED");
  }
  if ((Number(row.excessQty) || 0) > 0) flags.push("EXCESS");
  return flags;
}
