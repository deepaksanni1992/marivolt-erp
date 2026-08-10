/** Helpers for warehouse label printing UI (Phase 1 GRN + Phase 2 Packing). */

import {
  distributeByQtyPerLabel,
  distributeByLabelCount,
  formatLabelDistribution,
  validateGrnLabelLinePrintConfig,
  buildGrnLabelConfigFingerprint,
  newGrnDraftRef,
  isSuccessfulLabelJobStatus,
  formatGrnLabelPreviewSummaryLine,
} from "./grnLabelDistribution.js";

export const LABEL_TEMPLATE_NAME = "MARIVOLT STANDARD LABEL";
export const PACKING_LABEL_TEMPLATE_NAME = "PACKING STANDARD 100×50";

/** Confirm before queueing this many physical labels (Preview / Post & Print). */
export const GRN_LABEL_LARGE_PRINT_CONFIRM_AT = 100;

export const REPRINT_REASONS = [
  "Damaged Label",
  "Lost Label",
  "Replacement",
  "Customer Request",
  "Other",
];

export {
  distributeByQtyPerLabel,
  distributeByLabelCount,
  formatLabelDistribution,
  buildGrnLabelConfigFingerprint,
  newGrnDraftRef,
  isSuccessfulLabelJobStatus,
  formatGrnLabelPreviewSummaryLine,
};

/** Default: Qty/Label = 1, No. Labels derived from GRN Qty (decimal-safe). */
export function defaultLabelLineFields(grnQty) {
  const q = Math.max(0, Number(grnQty) || 0);
  const dist = q > 0 ? distributeByQtyPerLabel(q, 1) : [];
  const count = dist.length;
  return {
    printLabel: true,
    labelQtyPerLabel: "1",
    labelCount: String(count),
    /** @deprecated kept in sync as physical label count for older callers */
    labelQty: String(count),
    labelConfigCustomized: false,
    /** 'perLabel' | 'count' — which field last drove distribution */
    labelEditMode: "perLabel",
  };
}

/** Apply GRN qty change; preserve deliberate custom label config unless forceDefault. */
export function applyGrnQtyToLabelFields(ed, grnQty, { forceDefault = false } = {}) {
  const q = Math.max(0, Number(grnQty) || 0);
  const qStr = String(grnQty);
  if (!forceDefault && ed?.labelConfigCustomized) {
    if (ed.labelEditMode === "count") {
      const count = Math.max(0, Math.floor(Number(ed.labelCount) || 0));
      if (count > 0) {
        const dist = distributeByLabelCount(q, count);
        return {
          ...ed,
          grnQty: qStr,
          labelCount: String(dist.length),
          labelQty: String(dist.length),
          labelQtyPerLabel: dist[0] != null ? String(dist[0]) : ed.labelQtyPerLabel,
          labelEditMode: "count",
        };
      }
    }
    const per = Math.max(0, Number(ed.labelQtyPerLabel) || 0);
    if (per > 0) {
      const dist = distributeByQtyPerLabel(q, per);
      return {
        ...ed,
        grnQty: qStr,
        labelQtyPerLabel: String(ed.labelQtyPerLabel),
        labelCount: String(dist.length),
        labelQty: String(dist.length),
        labelEditMode: "perLabel",
      };
    }
  }
  return {
    ...ed,
    grnQty: qStr,
    ...defaultLabelLineFields(q),
    printLabel: ed?.printLabel !== false,
    labelConfigCustomized: false,
  };
}

export function syncLabelFieldsFromQtyPerLabel(ed, qtyPerLabelRaw) {
  const grnQty = Math.max(0, Number(ed?.grnQty) || 0);
  const per = Number(qtyPerLabelRaw);
  if (!Number.isFinite(per) || per <= 0) {
    return {
      ...ed,
      labelQtyPerLabel: qtyPerLabelRaw,
      labelConfigCustomized: true,
      labelEditMode: "perLabel",
    };
  }
  const dist = distributeByQtyPerLabel(grnQty, per);
  return {
    ...ed,
    labelQtyPerLabel: String(qtyPerLabelRaw),
    labelCount: String(dist.length),
    labelQty: String(dist.length),
    labelConfigCustomized: true,
    labelEditMode: "perLabel",
  };
}

export function syncLabelFieldsFromLabelCount(ed, labelCountRaw) {
  const grnQty = Math.max(0, Number(ed?.grnQty) || 0);
  const count = Number(labelCountRaw);
  if (!Number.isFinite(count) || count <= 0) {
    return {
      ...ed,
      labelCount: labelCountRaw,
      labelConfigCustomized: true,
      labelEditMode: "count",
    };
  }
  const dist = distributeByLabelCount(grnQty, Math.floor(count));
  const primary = dist[0] != null ? dist[0] : 1;
  return {
    ...ed,
    labelCount: String(Math.floor(count)),
    labelQty: String(dist.length),
    labelQtyPerLabel: String(primary),
    labelConfigCustomized: true,
    labelEditMode: "count",
  };
}

export function getLineLabelDistribution(ed) {
  const grnQty = Number(ed?.grnQty) || 0;
  const per = Number(ed?.labelQtyPerLabel);
  const count = Number(ed?.labelCount);
  if (ed?.labelEditMode === "count" && Number.isFinite(count) && count > 0) {
    return distributeByLabelCount(grnQty, Math.floor(count));
  }
  if (Number.isFinite(per) && per > 0) {
    return distributeByQtyPerLabel(grnQty, per);
  }
  if (Number.isFinite(count) && count > 0) {
    return distributeByLabelCount(grnQty, Math.floor(count));
  }
  return distributeByQtyPerLabel(grnQty, 1);
}

export function buildLabelLinesFromEdits(selectedLines, lineEdits) {
  return (selectedLines || []).map((ln) => {
    const id = ln.poLineId != null ? String(ln.poLineId) : "";
    const ed = lineEdits[id] || {};
    const receivedQty = Number(ed.grnQty) || 0;
    const dist = getLineLabelDistribution(ed);
    const qtyPerLabel = Number(ed.labelQtyPerLabel) || (dist[0] ?? 1);
    const labelCount = dist.length;
    return {
      poLineId: ln.poLineId,
      article: ln.article,
      description: ln.description,
      spn: ln.spn,
      materialCode: ln.materialCode,
      uom: ln.uom,
      location: ed.location,
      print: ed.printLabel !== false,
      qtyPerLabel,
      labelQtyPerLabel: qtyPerLabel,
      labelCount,
      labelDistribution: dist,
      labelQty: labelCount,
      receivedQty,
      grnQty: receivedQty,
    };
  });
}

/** Sum of physical labels for print-enabled lines. */
export function sumPhysicalLabelQty(labelLines) {
  return (labelLines || []).reduce((sum, ln) => {
    if (ln?.print === false) return sum;
    if (Array.isArray(ln.labelDistribution) && ln.labelDistribution.length) {
      return sum + ln.labelDistribution.length;
    }
    const q = Number(ln?.labelCount ?? ln?.labelQty);
    if (!Number.isFinite(q) || q <= 0) return sum;
    return sum + q;
  }, 0);
}

/** Lines that would produce at least one physical label. */
export function countPrintableLabelArticles(labelLines) {
  return (labelLines || []).filter((ln) => {
    if (ln?.print === false) return false;
    if (Array.isArray(ln.labelDistribution) && ln.labelDistribution.length) return true;
    const q = Number(ln?.labelCount ?? ln?.labelQty);
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

/** Pre-GRN print idempotency: draft session + config fingerprint. */
export function buildGrnPrepostIdempotencyKey(draftRef, fingerprint) {
  const ref = String(draftRef || "").trim();
  const fp = String(fingerprint || "").trim();
  if (!ref) return `grn-prepost:unknown:${Date.now()}`;
  let hash = fp;
  if (fp.length > 40) {
    let h = 0;
    for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) >>> 0;
    hash = h.toString(16);
  }
  return `grn-prepost:${ref}:${hash}`.slice(0, 120);
}

/**
 * Refresh whether a stored pre/post print state is COMPLETED for the given fingerprint.
 * Non-COMPLETED jobs are never treated as successfully printed.
 */
export async function resolveCompletedGrnLabelPrint(printState, fingerprint, fetchJob) {
  const fp = String(fingerprint || "").trim();
  if (!printState?.jobId || !fp || String(printState.fingerprint || "") !== fp) {
    return { matched: false, completed: false, status: "", jobId: printState?.jobId || "" };
  }
  if (!fetchJob) {
    return {
      matched: true,
      completed: isSuccessfulLabelJobStatus(printState.status),
      status: printState.status || "",
      jobId: printState.jobId,
    };
  }
  try {
    const data = await fetchJob(printState.jobId);
    const job = data?.job || data;
    const status = String(job?.status || "").toUpperCase();
    return {
      matched: true,
      completed: isSuccessfulLabelJobStatus(status),
      status,
      jobId: printState.jobId,
    };
  } catch {
    return { matched: true, completed: false, status: "UNKNOWN", jobId: printState.jobId };
  }
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

/** Validate label lines for GRN print (distribution must equal received qty). */
export function validateInitialLabelLines(labelLines) {
  for (const ln of labelLines || []) {
    if (ln.print === false) continue;
    const v = validateGrnLabelLinePrintConfig({
      print: true,
      article: ln.article,
      receivedQty: ln.receivedQty ?? ln.grnQty,
      qtyPerLabel: ln.qtyPerLabel ?? ln.labelQtyPerLabel,
      labelCount: ln.labelCount,
      labelDistribution: ln.labelDistribution,
    });
    if (!v.ok) return { ok: false, message: v.message };
  }
  return { ok: true, message: "" };
}

export function buildGrnLabelPreviewRows(labelLines) {
  return (labelLines || [])
    .filter((ln) => ln.print !== false)
    .map((ln) => {
      const dist = Array.isArray(ln.labelDistribution)
        ? ln.labelDistribution
        : getLineLabelDistribution({
            grnQty: ln.receivedQty ?? ln.grnQty,
            labelQtyPerLabel: ln.qtyPerLabel ?? ln.labelQtyPerLabel,
            labelCount: ln.labelCount,
          });
      return {
        article: ln.article,
        poLineId: ln.poLineId,
        grnQty: Number(ln.receivedQty ?? ln.grnQty) || 0,
        labelCount: dist.length,
        labelDistribution: dist,
        distributionText: formatLabelDistribution(dist),
        labels: dist.map((qty, index) => ({ index: index + 1, qty })),
      };
    });
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
  if (type === "GRN_PREPOST") {
    const linked = String(job?.linkedGrnNo || "").trim();
    const draft = String(job?.draftRef || job?.sourceNo || "").trim();
    if (linked) return `GRN PRE ${linked}`;
    return draft ? `GRN PRE ${draft}` : "GRN PRE";
  }
  const no = String(job?.sourceNo || "").trim();
  return no ? `${type} ${no}` : type || "—";
}
