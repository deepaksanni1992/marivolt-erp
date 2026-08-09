/** Helpers for warehouse label printing UI (Phase 1 GRN + Phase 2 Packing). */

export const LABEL_TEMPLATE_NAME = "MARIVOLT STANDARD LABEL";
export const PACKING_LABEL_TEMPLATE_NAME = "PACKING STANDARD 100×50";

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

/** Stable initial packing label key — selection-aware (server is source of truth). */
export function buildPackingSelectionFingerprint(lines = []) {
  const parts = (lines || [])
    .map((ln) => {
      const lineId = String(ln.packingLineId || ln.allocationLineId || ln.lineId || "").trim();
      const packageId = String(ln.packageId || "").trim();
      const qty = Math.max(0, Math.floor(Number(ln.labelQty) || 0));
      if (packageId) return `package:${packageId}:line:${lineId}:qty:${qty}`;
      return `line:${lineId}:qty:${qty}`;
    })
    .filter(Boolean)
    .sort();
  return parts.join("|");
}

/**
 * Client helper for display/tests. Official POSTED keys are hashed server-side.
 * Format without hash: packing:{no}:initial:{fingerprint} — server uses sha256 slice.
 */
export function buildInitialPackingLabelIdempotencyKey(packingNo, lines = []) {
  const no = String(packingNo || "").trim();
  if (!no) return `packing:unknown:initial:${Date.now()}`;
  const fingerprint = buildPackingSelectionFingerprint(lines);
  return fingerprint
    ? `packing:${no}:initial:${fingerprint}`
    : `packing:${no}:initial`;
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

/** Packing label QTY face format. */
export function formatPackingQtyOf(labelQty, totalQty) {
  return `${Math.max(0, Math.floor(Number(labelQty) || 0))} of ${Math.max(0, Math.floor(Number(totalQty) || 0))}`;
}

/**
 * Build editable packing label rows from allocation/packing lines.
 */
export function defaultPackingLabelRows(lines = [], { mode = "PRE_PACKING" } = {}) {
  return (lines || []).map((ln, idx) => {
    const allocatedQty = Math.max(0, Number(ln.allocatedQty ?? ln.qty) || 0);
    const packedQty = Math.max(0, Number(ln.packQty ?? ln.packedQty) || 0);
    const packable = Math.max(0, Number(ln.physicalPackableQty ?? ln.pickQty ?? packedQty) || 0);
    const capQty = mode === "PRE_PACKING" ? packable : packedQty || packable;
    const key =
      (ln.packingLineId && String(ln.packingLineId)) ||
      (ln._id && String(ln._id)) ||
      (ln.allocationLineId && String(ln.allocationLineId)) ||
      `row-${idx}`;
    return {
      key,
      selected: false,
      article: ln.article || "",
      description: ln.description || "",
      partNumber: ln.partNumber || ln.spn || "",
      allocatedQty,
      capQty,
      packedQty,
      physicalPackableQty: packable,
      packingLineId: ln.packingLineId || (ln.packQty != null && ln._id ? String(ln._id) : "") || "",
      allocationLineId: ln.allocationLineId ? String(ln.allocationLineId) : "",
      labelQty: String(capQty > 0 ? capQty : allocatedQty || ""),
      copies: "1",
    };
  });
}

export function selectAllPackingLabelRows(rows) {
  return (rows || []).map((r) => ({
    ...r,
    selected: true,
    labelQty: String(r.labelQty || r.allocatedQty || r.capQty || 1),
  }));
}

export function selectAvailablePackingLabelRows(rows, { mode = "PRE_PACKING" } = {}) {
  return (rows || []).map((r) => {
    const avail = Number(mode === "PRE_PACKING" ? r.physicalPackableQty ?? r.capQty : r.capQty) || 0;
    if (avail <= 0) return { ...r, selected: false };
    return { ...r, selected: true, labelQty: String(avail) };
  });
}

export function buildPackingLabelSelections(rows) {
  return (rows || [])
    .filter((r) => r.selected)
    .map((r) => ({
      packingLineId: r.packingLineId || undefined,
      allocationLineId: r.allocationLineId || undefined,
      labelQty: Number(r.labelQty) || 0,
      copies: Math.max(1, Math.floor(Number(r.copies) || 1)),
    }));
}

/** Blank row for Custom Packing Label modal (manual entry). */
export function emptyCustomPackingLabelRow() {
  return {
    key: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    customerName: "",
    customerRef: "",
    brand: "",
    modelName: "",
    article: "",
    serialNo: "",
    partNo: "",
    description: "",
    labelQty: "1",
    totalQty: "",
    copies: "1",
  };
}

/** Display label for Label Queue source column. */
export function formatLabelJobSource(job) {
  const type = String(job?.sourceType || "").toUpperCase();
  if (type === "CUSTOM_PACKING") return "CUSTOM LABEL";
  const no = String(job?.sourceNo || "").trim();
  return no ? `${type} ${no}` : type || "—";
}
