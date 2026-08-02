/**
 * TSPL generator for fixed 100 × 50 mm Marivolt Standard Label.
 * Physical size is always mm-based (SIZE 100 mm,50 mm).
 * Coordinate DPI is configurable (default 203) for hardware layout only.
 */
import { LABEL_HEIGHT_MM, LABEL_WIDTH_MM } from "../../models/LabelTemplate.js";
import { encodeBarcodeValue } from "./barcodeGenerator.js";

/** Dots per mm for layout coordinates. 203 DPI ≈ 8; 300 DPI ≈ 11.81 */
export function dotsPerMm(dpi = 203) {
  const d = Number(dpi) || 203;
  return d / 25.4;
}

export function labelDotDimensions(dpi = 203) {
  const dpm = dotsPerMm(dpi);
  return {
    dpi: Number(dpi) || 203,
    widthDots: Math.round(LABEL_WIDTH_MM * dpm),
    heightDots: Math.round(LABEL_HEIGHT_MM * dpm),
    dotsPerMm: dpm,
  };
}

function t(v) {
  if (v == null) return "";
  if (typeof v === "object") return "";
  return String(v).trim();
}

/** Sanitize for TSPL quoted strings — no quotes, CR/LF, or nullish junk. */
export function escapeTspl(s) {
  return t(s)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\\/g, "/")
    .slice(0, 200);
}

/** Wrap description to max 2 lines; truncate gracefully. */
export function wrapDescription(text, maxCharsPerLine = 42, maxLines = 2) {
  const raw = t(text).replace(/\s+/g, " ");
  if (!raw) return [];
  const words = raw.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxCharsPerLine) {
      cur = next;
    } else {
      if (cur) lines.push(cur);
      cur = w.length > maxCharsPerLine ? w.slice(0, maxCharsPerLine) : w;
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length > maxLines) return lines.slice(0, maxLines);
  const joined = lines.join(" ");
  if (raw.length > joined.length && lines.length) {
    const last = lines[lines.length - 1];
    if (last.length >= 3) lines[lines.length - 1] = `${last.slice(0, Math.max(0, last.length - 1))}…`;
  }
  return lines.slice(0, maxLines);
}

/**
 * Build TSPL for one physical label.
 * Phase 1 rule: each label represents one received unit → display Qty: 1 UOM.
 */
export function buildSingleLabelTspl(line = {}, opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const dpm = dotsPerMm(dpi);
  const scale = (dotsAt203) => Math.round(dotsAt203 * (dpm / 8));

  const companyName = escapeTspl(opts.companyName || "MARIVOLT FZE");
  // Article for barcode/human must not be mutated beyond trim+uppercase for Code128 safety
  const articleRaw = t(line.article).toUpperCase();
  const article = escapeTspl(articleRaw);
  const descLines = wrapDescription(line.description || "");
  const spn = escapeTspl(line.spn || "") || "—";
  const materialCode = escapeTspl(line.materialCode || "") || "—";
  // Phase 1: one physical label = one unit
  const qtyOnLabel = opts.qtyPerLabel != null ? Number(opts.qtyPerLabel) : 1;
  const qtyDisplay = Number.isFinite(qtyOnLabel) && qtyOnLabel > 0 ? String(qtyOnLabel) : "1";
  const uom = escapeTspl(line.uom || "PCS") || "PCS";
  const poNo = escapeTspl(line.poNo || "") || "—";
  const grnNo = escapeTspl(line.grnNo || "") || "—";
  const receivedDate = escapeTspl(line.receivedDate || "") || "—";
  const location = escapeTspl(line.location || "") || "—";
  const encoded = encodeBarcodeValue({
    mode: opts.barcodeMode || "ARTICLE",
    article: articleRaw,
    labelId: line.labelId,
  });
  const barcode = escapeTspl(encoded.value || articleRaw);
  const human = escapeTspl(encoded.humanReadable || articleRaw);

  const w = LABEL_WIDTH_MM;
  const h = LABEL_HEIGHT_MM;
  const widthDots = Math.round(w * dpm);
  const barWidthDots = Math.round(widthDots * 0.65);
  const barX = Math.round((widthDots - barWidthDots) / 2);
  const barY = scale(250);
  const barHeight = scale(80);

  const cmds = [
    `SIZE ${w} mm,${h} mm`,
    "GAP 3 mm,0",
    "DIRECTION 1",
    "REFERENCE 0,0",
    "CLS",
    `TEXT ${scale(20)},${scale(12)},"0",0,1,1,"${companyName}"`,
    `TEXT ${scale(20)},${scale(40)},"0",0,2,2,"${article}"`,
  ];

  let y = scale(90);
  const lineH = scale(22);
  for (const dl of descLines) {
    cmds.push(`TEXT ${scale(20)},${y},"0",0,1,1,"${escapeTspl(dl)}"`);
    y += lineH;
  }
  y = Math.max(y, scale(130));
  const row = scale(20);
  cmds.push(`TEXT ${scale(20)},${y},"0",0,1,1,"SPN: ${spn}"`);
  y += row;
  cmds.push(`TEXT ${scale(20)},${y},"0",0,1,1,"Mat: ${materialCode}"`);
  y += row;
  cmds.push(`TEXT ${scale(20)},${y},"0",0,1,1,"Qty: ${qtyDisplay} ${uom}"`);
  y += row;
  cmds.push(`TEXT ${scale(20)},${y},"0",0,1,1,"PO: ${poNo}  GRN: ${grnNo}"`);
  y += row;
  cmds.push(`TEXT ${scale(20)},${y},"0",0,1,1,"Recv: ${receivedDate}  Bin: ${location}"`);

  if (barcode) {
    cmds.push(`BARCODE ${barX},${barY},"128",${barHeight},0,0,2,4,"${barcode}"`);
    cmds.push(`TEXT ${barX},${barY + barHeight + scale(8)},"0",0,1,1,"${human}"`);
  }

  cmds.push("PRINT 1,1");
  return cmds.join("\r\n") + "\r\n";
}

/**
 * Build full TSPL: labelQty × copies physical labels, each showing Qty: 1 UOM.
 */
export function buildJobTspl(lines = [], opts = {}) {
  const copies = Math.max(1, Number(opts.copies) || 1);
  const parts = [];
  for (const line of lines) {
    const n = Math.max(0, Math.floor(Number(line.labelQty) || 0)) * copies;
    for (let i = 0; i < n; i++) {
      parts.push(buildSingleLabelTspl(line, { ...opts, qtyPerLabel: 1 }));
    }
  }
  return parts.join("");
}

export function getFixedLabelSize() {
  return { widthMm: LABEL_WIDTH_MM, heightMm: LABEL_HEIGHT_MM };
}
