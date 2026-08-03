/** Helpers for warehouse label printing UI (Phase 1). */

export const LABEL_TEMPLATE_NAME = "MARIVOLT STANDARD LABEL";

export const REPRINT_REASONS = [
  "Damaged Label",
  "Lost Label",
  "Replacement",
  "Customer Request",
  "Other",
];

export function defaultLabelLineFields(grnQty) {
  const q = String(Math.max(0, Number(grnQty) || 0));
  return {
    printLabel: true,
    labelQty: q,
  };
}

export function buildLabelLinesFromEdits(selectedLines, lineEdits) {
  return (selectedLines || []).map((ln) => {
    const id = ln.poLineId != null ? String(ln.poLineId) : "";
    const ed = lineEdits[id] || {};
    const receivedQty = Number(ed.grnQty) || 0;
    return {
      poLineId: ln.poLineId,
      article: ln.article,
      print: ed.printLabel !== false,
      labelQty: Number(ed.labelQty ?? ed.grnQty) || 0,
      receivedQty,
    };
  });
}

/** Sum of Label Qty for lines checked for print (excludes unchecked / zero). */
export function sumPhysicalLabelQty(labelLines) {
  return (labelLines || []).reduce((sum, ln) => {
    if (ln?.print === false) return sum;
    const q = Number(ln?.labelQty);
    if (!Number.isFinite(q) || q <= 0) return sum;
    return sum + q;
  }, 0);
}

/** Lines that would produce at least one physical label. */
export function countPrintableLabelArticles(labelLines) {
  return (labelLines || []).filter((ln) => {
    if (ln?.print === false) return false;
    const q = Number(ln?.labelQty);
    return Number.isFinite(q) && q > 0;
  }).length;
}

export function formatLabelsQueuedMessage(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return n === 1 ? "1 label queued successfully." : `${n} labels queued successfully.`;
}

/** Stable initial-print key so retries return the same job for a GRN. */
export function buildInitialGrnLabelIdempotencyKey(grnNo) {
  const no = String(grnNo || "").trim();
  return no ? `grn:${no}:initial` : `grn:unknown:initial:${Date.now()}`;
}

/**
 * Decide post-GRN label UX from settings (frontend only).
 * @returns {'none'|'ask'|'auto'}
 */
export function resolvePostGrnLabelMode(settings) {
  if (!settings || settings.enabled !== true) return "none";
  if (settings.autoPrintAfterGrn === true) return "auto";
  return "ask";
}

/** Validate label lines for initial GRN print (non-negative, not over received). */
export function validateInitialLabelLines(labelLines) {
  for (const ln of labelLines || []) {
    if (ln.print === false) continue;
    const q = Number(ln.labelQty);
    if (!Number.isFinite(q) || q < 0) {
      return { ok: false, message: "Label Qty must be a non-negative number." };
    }
    if (q > (Number(ln.receivedQty) || 0) + 1e-9) {
      return {
        ok: false,
        message: `Label Qty (${q}) cannot exceed received qty (${ln.receivedQty}) for ${ln.article || "line"}.`,
      };
    }
  }
  return { ok: true, message: "" };
}
