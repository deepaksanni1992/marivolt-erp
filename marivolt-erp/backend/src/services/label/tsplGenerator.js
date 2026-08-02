/**
 * TSPL generator for fixed 100 × 50 mm Marivolt Standard Label.
 * Uses native TSPL BARCODE (Code128). No PDF.
 */
import { LABEL_HEIGHT_MM, LABEL_WIDTH_MM } from "../../models/LabelTemplate.js";
import { encodeBarcodeValue } from "./barcodeGenerator.js";

const DOTS_PER_MM = 8; // 203 DPI ≈ 8 dots/mm

function t(v) {
  return String(v ?? "").trim();
}

function escapeTspl(s) {
  return t(s).replace(/"/g, "'");
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
  // Truncate last line with ellipsis if original longer
  const joined = lines.join(" ");
  if (raw.length > joined.length && lines.length) {
    const last = lines[lines.length - 1];
    if (last.length >= 3) lines[lines.length - 1] = `${last.slice(0, Math.max(0, last.length - 1))}…`;
  }
  return lines.slice(0, maxLines);
}

/**
 * Build TSPL for one physical label (one copy of one line).
 * Coordinates in dots; origin top-left.
 */
export function buildSingleLabelTspl(line = {}, opts = {}) {
  const companyName = escapeTspl(opts.companyName || "MARIVOLT FZE");
  const article = escapeTspl(line.article || "").toUpperCase();
  const descLines = wrapDescription(line.description || "");
  const spn = escapeTspl(line.spn || "");
  const materialCode = escapeTspl(line.materialCode || "");
  const qty = line.qty != null ? String(line.qty) : "";
  const uom = escapeTspl(line.uom || "PCS");
  const poNo = escapeTspl(line.poNo || "");
  const grnNo = escapeTspl(line.grnNo || "");
  const receivedDate = escapeTspl(line.receivedDate || "");
  const location = escapeTspl(line.location || "") || "—";
  const encoded = encodeBarcodeValue({
    mode: opts.barcodeMode || "ARTICLE",
    article,
    labelId: line.labelId,
  });
  const barcode = escapeTspl(encoded.value || article);
  const human = escapeTspl(encoded.humanReadable || article);

  const w = LABEL_WIDTH_MM;
  const h = LABEL_HEIGHT_MM;
  // Barcode ~65% of label width
  const barWidthDots = Math.round(w * DOTS_PER_MM * 0.65);
  const barX = Math.round((w * DOTS_PER_MM - barWidthDots) / 2);
  const barY = 250;
  const barHeight = 80;

  const cmds = [
    `SIZE ${w} mm,${h} mm`,
    "GAP 3 mm,0",
    "DIRECTION 1",
    "REFERENCE 0,0",
    "CLS",
    `TEXT 20,12,"0",0,1,1,"${companyName}"`,
    `TEXT 20,40,"0",0,2,2,"${article}"`,
  ];

  let y = 90;
  for (const dl of descLines) {
    cmds.push(`TEXT 20,${y},"0",0,1,1,"${escapeTspl(dl)}"`);
    y += 22;
  }
  y = Math.max(y, 130);
  cmds.push(`TEXT 20,${y},"0",0,1,1,"SPN: ${spn}"`);
  y += 20;
  cmds.push(`TEXT 20,${y},"0",0,1,1,"Mat: ${materialCode}"`);
  y += 20;
  cmds.push(`TEXT 20,${y},"0",0,1,1,"Qty: ${qty} ${uom}"`);
  y += 20;
  cmds.push(`TEXT 20,${y},"0",0,1,1,"PO: ${poNo}  GRN: ${grnNo}"`);
  y += 20;
  cmds.push(`TEXT 20,${y},"0",0,1,1,"Recv: ${receivedDate}  Bin: ${location}"`);

  // Code128 — TSPL BARCODE: BARCODE x,y,"128",height,human,rotation,narrow,wide,"data"
  // human=0 (we print human-readable ourselves for control)
  if (barcode) {
    cmds.push(
      `BARCODE ${barX},${barY},"128",${barHeight},0,0,2,4,"${barcode}"`
    );
    cmds.push(`TEXT ${barX},${barY + barHeight + 8},"0",0,1,1,"${human}"`);
  }

  cmds.push("PRINT 1,1");
  return cmds.join("\r\n") + "\r\n";
}

/**
 * Build full TSPL job payload for all label copies across lines.
 * @param {object[]} lines label job lines with labelQty
 * @param {{ copies?: number, companyName?: string, barcodeMode?: string }} opts
 */
export function buildJobTspl(lines = [], opts = {}) {
  const copies = Math.max(1, Number(opts.copies) || 1);
  const parts = [];
  for (const line of lines) {
    const n = Math.max(0, Math.floor(Number(line.labelQty) || 0)) * copies;
    for (let i = 0; i < n; i++) {
      parts.push(buildSingleLabelTspl(line, opts));
    }
  }
  return parts.join("");
}

export function getFixedLabelSize() {
  return { widthMm: LABEL_WIDTH_MM, heightMm: LABEL_HEIGHT_MM };
}
