/**
 * Label print transport modes.
 * SINGLE_RAW — legacy TSPL via one WritePrinter (GRN / ASN / RU / test).
 * RAW_FACE_BATCH — packing/custom packing: N independent RAW TSPL documents
 *   (one StartDoc/WritePrinter/EndDoc per physical face). Not concatenated.
 */

export const LABEL_PAYLOAD_MODE_SINGLE_RAW = "SINGLE_RAW";
export const LABEL_PAYLOAD_MODE_RAW_FACE_BATCH = "RAW_FACE_BATCH";

/** @deprecated Abandoned — GDI DRIVER_PAGES is not used for production packing. */
export const LABEL_PAYLOAD_MODE_DRIVER_PAGES = "DRIVER_PAGES";

export const LABEL_PAYLOAD_MODES = Object.freeze([
  LABEL_PAYLOAD_MODE_SINGLE_RAW,
  LABEL_PAYLOAD_MODE_RAW_FACE_BATCH,
  LABEL_PAYLOAD_MODE_DRIVER_PAGES,
]);

export function normalizeLabelPayloadMode(mode) {
  const m = String(mode || LABEL_PAYLOAD_MODE_SINGLE_RAW)
    .trim()
    .toUpperCase();
  return LABEL_PAYLOAD_MODES.includes(m) ? m : LABEL_PAYLOAD_MODE_SINGLE_RAW;
}

/**
 * @param {{ payloadMode?: string, requestedLabels?: number, rawFacePayloads?: unknown[] }} job
 */
export function validateRawFaceBatchPayload(job = {}) {
  const mode = normalizeLabelPayloadMode(job.payloadMode);
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
    if (/\bSIZE\b/i.test(payload)) {
      return { ok: false, mode, error: `RAW_FACE_BATCH face ${i + 1} must omit SIZE` };
    }
    if (/\bGAP\b/i.test(payload)) {
      return { ok: false, mode, error: `RAW_FACE_BATCH face ${i + 1} must omit GAP` };
    }
    if (/\bDIRECTION\b/i.test(payload)) {
      return { ok: false, mode, error: `RAW_FACE_BATCH face ${i + 1} must omit DIRECTION` };
    }
    if (/\bREFERENCE\b/i.test(payload)) {
      return { ok: false, mode, error: `RAW_FACE_BATCH face ${i + 1} must omit REFERENCE` };
    }
  }
  return { ok: true, mode, faceCount: faces.length };
}
