/**
 * Label print transport modes.
 * SINGLE_RAW — one TSPL WritePrinter (GRN / ASN / RU / test); full SIZE+GAP per job.
 * TSPL_LABEL_BATCH — packing/custom packing: agent GAPDETECT once, then N faces with
 *   SIZE + HOME (sensor origin) + CLS + content + PRINT 1,1; no hardcoded GAP.
 * RAW_FACE_BATCH — legacy packing mode (faces omitted media setup). Kept for
 *   historical jobs only; new packing enqueues use TSPL_LABEL_BATCH.
 * DRIVER_PAGES — abandoned GDI path (enum only).
 */

export const LABEL_PAYLOAD_MODE_SINGLE_RAW = "SINGLE_RAW";
export const LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH = "TSPL_LABEL_BATCH";
/** @deprecated Prefer TSPL_LABEL_BATCH for new packing jobs. */
export const LABEL_PAYLOAD_MODE_RAW_FACE_BATCH = "RAW_FACE_BATCH";

/** @deprecated Abandoned — GDI DRIVER_PAGES is not used for production packing. */
export const LABEL_PAYLOAD_MODE_DRIVER_PAGES = "DRIVER_PAGES";

export const LABEL_PAYLOAD_MODES = Object.freeze([
  LABEL_PAYLOAD_MODE_SINGLE_RAW,
  LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH,
  LABEL_PAYLOAD_MODE_RAW_FACE_BATCH,
  LABEL_PAYLOAD_MODE_DRIVER_PAGES,
]);

export function normalizeLabelPayloadMode(mode) {
  const m = String(mode || LABEL_PAYLOAD_MODE_SINGLE_RAW)
    .trim()
    .toUpperCase();
  return LABEL_PAYLOAD_MODES.includes(m) ? m : LABEL_PAYLOAD_MODE_SINGLE_RAW;
}

export function isMultiLabelFaceBatchMode(mode) {
  const m = normalizeLabelPayloadMode(mode);
  return m === LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH || m === LABEL_PAYLOAD_MODE_RAW_FACE_BATCH;
}

/**
 * Validate TSPL_LABEL_BATCH (GAPDETECT + detected-media faces with HOME).
 * Each face: SIZE + HOME before CLS + PRINT 1,1; must not reissue GAP / FEED / FORMFEED /
 * GAPDETECT. Agent issues GAPDETECT once before face 1.
 * @param {{ payloadMode?: string, requestedLabels?: number, rawFacePayloads?: unknown[] }} job
 */
export function validateTsplLabelBatchPayload(job = {}) {
  const mode = normalizeLabelPayloadMode(job.payloadMode);
  if (mode !== LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH) {
    return { ok: true, mode };
  }
  const faces = Array.isArray(job.rawFacePayloads) ? job.rawFacePayloads : [];
  const requested = Math.max(0, Number(job.requestedLabels) || 0);
  if (!faces.length || faces.length !== requested) {
    return {
      ok: false,
      mode,
      error: `TSPL_LABEL_BATCH face count ${faces.length} != requestedLabels ${requested}`,
    };
  }
  for (let i = 0; i < faces.length; i++) {
    const payload = String(faces[i] || "");
    if (!payload.trim()) {
      return { ok: false, mode, error: `TSPL_LABEL_BATCH face ${i + 1} empty` };
    }
    const cls = (payload.match(/\bCLS\b/g) || []).length;
    const print = (payload.match(/\bPRINT\s+1\s*,\s*1\b/gi) || []).length;
    const size = (payload.match(/\bSIZE\b/gi) || []).length;
    const home = (payload.match(/(?:^|\r?\n)\s*HOME\b/gim) || []).length;
    // Match GAP as a command, not GAPDETECT (should also be absent from faces).
    const gapCmd = (payload.match(/(?:^|\r?\n)\s*GAP\b/gim) || []).length;
    const gapDetect = (payload.match(/\bGAPDETECT\b/gi) || []).length;
    const feed = (payload.match(/(?:^|\r?\n)\s*FEED\b/gim) || []).length;
    const formfeed = (payload.match(/\bFORMFEED\b/gi) || []).length;
    if (cls !== 1) {
      return { ok: false, mode, error: `TSPL_LABEL_BATCH face ${i + 1} must contain CLS exactly once` };
    }
    if (print !== 1) {
      return {
        ok: false,
        mode,
        error: `TSPL_LABEL_BATCH face ${i + 1} must contain PRINT 1,1 exactly once`,
      };
    }
    if (size < 1) {
      // SIZE kept after GAPDETECT: defines imaging width/length for TEXT/BOX coords.
      return { ok: false, mode, error: `TSPL_LABEL_BATCH face ${i + 1} must include SIZE` };
    }
    if (home !== 1) {
      return {
        ok: false,
        mode,
        error: `TSPL_LABEL_BATCH face ${i + 1} must contain HOME exactly once`,
      };
    }
    const homeIdx = payload.search(/(?:^|\r?\n)\s*HOME\b/im);
    const clsIdx = payload.search(/\bCLS\b/);
    if (homeIdx < 0 || clsIdx < 0 || homeIdx > clsIdx) {
      return {
        ok: false,
        mode,
        error: `TSPL_LABEL_BATCH face ${i + 1} must place HOME before CLS`,
      };
    }
    if (gapCmd > 0) {
      return {
        ok: false,
        mode,
        error: `TSPL_LABEL_BATCH face ${i + 1} must not include GAP after GAPDETECT`,
      };
    }
    if (gapDetect > 0) {
      return {
        ok: false,
        mode,
        error: `TSPL_LABEL_BATCH face ${i + 1} must not include GAPDETECT (agent-only once)`,
      };
    }
    if (feed > 0 || formfeed > 0) {
      return {
        ok: false,
        mode,
        error: `TSPL_LABEL_BATCH face ${i + 1} must not include FEED/FORMFEED`,
      };
    }
  }
  return { ok: true, mode, faceCount: faces.length };
}

/**
 * Legacy RAW_FACE_BATCH + routes TSPL_LABEL_BATCH to the new validator.
 * @param {{ payloadMode?: string, requestedLabels?: number, rawFacePayloads?: unknown[] }} job
 */
export function validateRawFaceBatchPayload(job = {}) {
  const mode = normalizeLabelPayloadMode(job.payloadMode);
  if (mode === LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH) {
    return validateTsplLabelBatchPayload(job);
  }
  if (mode !== LABEL_PAYLOAD_MODE_RAW_FACE_BATCH) {
    return { ok: true, mode };
  }
  const faces = Array.isArray(job.rawFacePayloads) ? job.rawFacePayloads : [];
  const requested = Math.max(0, Number(job.requestedLabels) || 0);
  if (!faces.length || faces.length !== requested) {
    return {
      ok: false,
      mode,
      error: `RAW_FACE_BATCH face count ${faces.length} != requestedLabels ${requested}`,
    };
  }
  for (let i = 0; i < faces.length; i++) {
    const payload = String(faces[i] || "");
    if (!payload.trim()) {
      return { ok: false, mode, error: `RAW_FACE_BATCH face ${i + 1} empty` };
    }
    const cls = (payload.match(/\bCLS\b/g) || []).length;
    const print = (payload.match(/\bPRINT\s+1\s*,\s*1\b/gi) || []).length;
    if (cls !== 1) {
      return { ok: false, mode, error: `RAW_FACE_BATCH face ${i + 1} must contain CLS exactly once` };
    }
    if (print !== 1) {
      return {
        ok: false,
        mode,
        error: `RAW_FACE_BATCH face ${i + 1} must contain PRINT 1,1 exactly once`,
      };
    }
  }
  return { ok: true, mode, faceCount: faces.length };
}
