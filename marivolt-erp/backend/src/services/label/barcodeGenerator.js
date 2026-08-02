/**
 * Barcode value helpers for warehouse labels.
 * Phase 1: ARTICLE mode. Architecture reserved for LABEL_ID / GS1.
 */

export const BARCODE_MODES = Object.freeze(["ARTICLE", "LABEL_ID", "GS1"]);

/**
 * @param {{ mode?: string, article?: string, labelId?: string, gs1?: string }} opts
 * @returns {{ value: string, humanReadable: string, mode: string }}
 */
export function encodeBarcodeValue(opts = {}) {
  const mode = String(opts.mode || "ARTICLE").toUpperCase();
  if (mode === "LABEL_ID") {
    const id = String(opts.labelId || "").trim();
    return { value: id, humanReadable: id, mode: "LABEL_ID" };
  }
  if (mode === "GS1") {
    const gs1 = String(opts.gs1 || "").trim();
    return { value: gs1, humanReadable: gs1, mode: "GS1" };
  }
  const article = String(opts.article || "")
    .trim()
    .toUpperCase();
  return { value: article, humanReadable: article, mode: "ARTICLE" };
}
