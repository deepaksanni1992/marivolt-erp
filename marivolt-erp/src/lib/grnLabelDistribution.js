/**
 * GRN physical-label quantity distribution helpers.
 * Separates received qty from qty-per-label and label count.
 * Does not touch stock / GRN posting.
 */

function toFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** True when qty is a whole number within float tolerance. */
export function isWholeQty(qty) {
  const n = toFiniteNumber(qty);
  if (!Number.isFinite(n)) return false;
  return Math.abs(n - Math.round(n)) < 1e-9;
}

/**
 * Distribute GRN qty into physical label face quantities using qty-per-label.
 * Final label gets the remainder (never padded).
 *
 * @example distributeByQtyPerLabel(25, 10) → [10, 10, 5]
 * @example distributeByQtyPerLabel(30, 15) → [15, 15]
 * @example distributeByQtyPerLabel(30, 1) → [1,1,...] × 30
 */
export function distributeByQtyPerLabel(grnQty, qtyPerLabel) {
  const total = toFiniteNumber(grnQty);
  const per = toFiniteNumber(qtyPerLabel);
  if (!Number.isFinite(total) || total <= 0) return [];
  if (!Number.isFinite(per) || per <= 0) return [];

  if (isWholeQty(total) && isWholeQty(per)) {
    const T = Math.round(total);
    const P = Math.round(per);
    const out = [];
    let remaining = T;
    while (remaining > 0) {
      const chunk = Math.min(P, remaining);
      out.push(chunk);
      remaining -= chunk;
    }
    return out;
  }

  // Decimal-safe: ceil count, full chunks + remainder
  const count = Math.ceil(total / per - 1e-12);
  const out = [];
  let remaining = total;
  for (let i = 0; i < count; i++) {
    if (i === count - 1) {
      // last gets exact remainder so sum === total
      out.push(roundQty(remaining));
      remaining = 0;
    } else {
      const chunk = Math.min(per, remaining);
      out.push(roundQty(chunk));
      remaining = roundQty(remaining - chunk);
    }
  }
  return out.filter((q) => q > 0);
}

/**
 * Distribute GRN qty across an explicit number of physical labels as evenly as practical.
 * Deterministic: larger shares first when remainder exists.
 *
 * @example distributeByLabelCount(30, 2) → [15, 15]
 * @example distributeByLabelCount(25, 2) → [13, 12]
 * @example distributeByLabelCount(10, 3) → [4, 3, 3]
 */
export function distributeByLabelCount(grnQty, labelCount) {
  const total = toFiniteNumber(grnQty);
  const nRaw = toFiniteNumber(labelCount);
  if (!Number.isFinite(total) || total <= 0) return [];
  if (!Number.isFinite(nRaw) || nRaw <= 0) return [];
  const n = Math.max(1, Math.floor(nRaw));

  if (isWholeQty(total)) {
    const T = Math.round(total);
    const base = Math.floor(T / n);
    const rem = T - base * n;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(base + (i < rem ? 1 : 0));
    }
    return out.filter((q) => q > 0);
  }

  const base = total / n;
  const out = [];
  let allocated = 0;
  for (let i = 0; i < n; i++) {
    if (i === n - 1) {
      out.push(roundQty(total - allocated));
    } else {
      const q = roundQty(base);
      out.push(q);
      allocated = roundQty(allocated + q);
    }
  }
  return out.filter((q) => q > 0);
}

function roundQty(n) {
  // Keep up to 6 dp for decimal UOMs; integers stay integers.
  const r = Math.round(Number(n) * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}

/** Sum of distribution (float-safe for integers). */
export function sumDistribution(dist = []) {
  return (dist || []).reduce((s, q) => s + (toFiniteNumber(q) || 0), 0);
}

/** Display helper: "10 + 10 + 5" */
export function formatLabelDistribution(dist = []) {
  const parts = (dist || []).map((q) => {
    const n = toFiniteNumber(q);
    if (!Number.isFinite(n)) return String(q);
    return isWholeQty(n) ? String(Math.round(n)) : String(n);
  });
  return parts.join(" + ");
}

/**
 * Resolve distribution for a print-enabled GRN line.
 * Prefer explicit labelDistribution when valid; else qtyPerLabel; else labelCount; else unit stickers.
 */
export function resolveLabelDistribution({
  grnQty,
  qtyPerLabel,
  labelCount,
  labelDistribution,
} = {}) {
  const total = toFiniteNumber(grnQty);
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, distribution: [], message: "GRN Qty must be greater than 0." };
  }

  if (Array.isArray(labelDistribution) && labelDistribution.length > 0) {
    const dist = labelDistribution.map((q) => toFiniteNumber(q)).filter((q) => Number.isFinite(q) && q > 0);
    const sum = sumDistribution(dist);
    if (Math.abs(sum - total) > 1e-6) {
      return {
        ok: false,
        distribution: dist,
        message: `Label distribution sum (${sum}) must equal GRN Qty (${total}).`,
      };
    }
    return { ok: true, distribution: dist, message: "" };
  }

  const per = toFiniteNumber(qtyPerLabel);
  const count = toFiniteNumber(labelCount);

  if (Number.isFinite(per) && per > 0 && !(Number.isFinite(count) && count > 0 && labelCount != null && labelCount !== "")) {
    const dist = distributeByQtyPerLabel(total, per);
    return { ok: true, distribution: dist, message: "" };
  }

  if (Number.isFinite(count) && count > 0 && !(Number.isFinite(per) && per > 0)) {
    const dist = distributeByLabelCount(total, count);
    return { ok: true, distribution: dist, message: "" };
  }

  // Both provided: prefer qty-per-label primary rule, then verify count matches length (or recompute count).
  if (Number.isFinite(per) && per > 0) {
    const dist = distributeByQtyPerLabel(total, per);
    return { ok: true, distribution: dist, message: "" };
  }

  if (Number.isFinite(count) && count > 0) {
    const dist = distributeByLabelCount(total, count);
    return { ok: true, distribution: dist, message: "" };
  }

  // Legacy default: one unit per label
  const dist = distributeByQtyPerLabel(total, 1);
  return { ok: true, distribution: dist, message: "" };
}

/**
 * Validate print-enabled line fields.
 * Physical label face qtys must sum exactly to GRN qty (except reprint overrides).
 */
export function validateGrnLabelLinePrintConfig(line = {}, { allowExceed = false } = {}) {
  if (line.print === false) return { ok: true, distribution: [], message: "" };

  const grnQty = toFiniteNumber(line.receivedQty ?? line.grnQty);
  const qtyPerLabel = toFiniteNumber(line.qtyPerLabel ?? line.labelQtyPerLabel);
  const labelCount = toFiniteNumber(line.labelCount ?? line.noOfLabels);

  if (!Number.isFinite(grnQty) || grnQty <= 0) {
    return { ok: false, distribution: [], message: "GRN Qty must be greater than 0 for print-enabled lines." };
  }
  if (!Number.isFinite(qtyPerLabel) || qtyPerLabel <= 0) {
    return { ok: false, distribution: [], message: "Qty / Label must be greater than 0 for print-enabled lines." };
  }
  if (!Number.isFinite(labelCount) || labelCount <= 0) {
    return { ok: false, distribution: [], message: "No. Labels must be greater than 0 for print-enabled lines." };
  }

  const resolved = resolveLabelDistribution({
    grnQty,
    qtyPerLabel,
    labelCount,
    labelDistribution: line.labelDistribution,
  });
  if (!resolved.ok) return resolved;

  const dist = resolved.distribution;
  const sum = sumDistribution(dist);
  if (Math.abs(sum - grnQty) > 1e-6) {
    return {
      ok: false,
      distribution: dist,
      message: `Distributed qty (${sum}) must equal GRN Qty (${grnQty}) for ${line.article || "line"}.`,
    };
  }

  if (!allowExceed && sum > grnQty + 1e-6) {
    return {
      ok: false,
      distribution: dist,
      message: `Label quantities cannot exceed GRN Qty (${grnQty}) for ${line.article || "line"}.`,
    };
  }

  // If user set both fields, ensure labelCount matches resolved length when integer mode
  if (isWholeQty(labelCount) && Math.round(labelCount) !== dist.length) {
    // Soft: auto-derived count from qty/label wins; still ok if distribution sums correctly.
    // Prefer updating caller to use dist.length.
  }

  return {
    ok: true,
    distribution: dist,
    qtyPerLabel,
    labelCount: dist.length,
    message: "",
  };
}

/** Stable fingerprint of print selection for idempotency / stale detection. */
export function buildGrnLabelConfigFingerprint(lines = []) {
  const parts = (lines || [])
    .filter((ln) => ln && ln.print !== false)
    .map((ln) => {
      const id = String(ln.poLineId || ln.article || "").trim();
      const article = String(ln.article || "").trim().toUpperCase();
      const grnQty = toFiniteNumber(ln.receivedQty ?? ln.grnQty) || 0;
      const per = toFiniteNumber(ln.qtyPerLabel ?? ln.labelQtyPerLabel) || 0;
      const count = toFiniteNumber(ln.labelCount) || 0;
      const dist = Array.isArray(ln.labelDistribution)
        ? ln.labelDistribution.map((q) => String(toFiniteNumber(q) || 0)).join(",")
        : "";
      return `${id}|${article}|g:${grnQty}|p:${per}|n:${count}|d:${dist}`;
    })
    .filter(Boolean)
    .sort();
  return parts.join(";");
}

/**
 * Canonical successful print completion for GRN pre/post skip & stale logic.
 * PENDING / LEASED / PRINTING / FAILED / UNCERTAIN / PARTIAL are NOT success.
 */
export function isSuccessfulLabelJobStatus(status) {
  return String(status || "").trim().toUpperCase() === "COMPLETED";
}

/** Human-readable one-line summary for preview lists. */
export function formatGrnLabelPreviewSummaryLine(ln = {}) {
  const article = String(ln.article || "—").trim() || "—";
  const grnQty = ln.grnQty ?? ln.receivedQty ?? "";
  const count = ln.labelCount ?? (Array.isArray(ln.labelDistribution) ? ln.labelDistribution.length : "");
  const distText =
    ln.distributionText ||
    formatLabelDistribution(ln.labelDistribution || []);
  return `${article} — GRN ${grnQty} — ${count} label${Number(count) === 1 ? "" : "s"} — ${distText || "—"}`;
}

/** New draft reference for pre-GRN printing (no fake GRN number). */
export function newGrnDraftRef() {
  const uuid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  return `GRN-DRAFT-${uuid}`;
}
