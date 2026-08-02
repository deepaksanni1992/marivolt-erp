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
    return {
      poLineId: ln.poLineId,
      article: ln.article,
      print: ed.printLabel !== false,
      labelQty: Number(ed.labelQty ?? ed.grnQty) || 0,
    };
  });
}
