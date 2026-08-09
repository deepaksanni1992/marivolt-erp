/**
 * TSPL generator for fixed 100 × 50 mm Marivolt Standard Label.
 * Physical size is always mm-based (SIZE 100 mm,50 mm).
 * Coordinate DPI is configurable (default 203) for hardware layout only.
 */
import { LABEL_HEIGHT_MM, LABEL_WIDTH_MM } from "../../models/LabelTemplate.js";
import { encodeBarcodeValue } from "./barcodeGenerator.js";
import {
  fitPackingDescription,
  formatPackingQtyDisplay,
} from "../../utils/labelTextFit.js";

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

/**
 * Analyze packing Description fit for 100×50 layout (same rules as TSPL).
 * QTY row height is reserved so description never overlaps it.
 */
export function analyzePackingDescriptionLayout(description = "", opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const dpm = dotsPerMm(dpi);
  const scale = (dotsAt203) => Math.round(dotsAt203 * (dpm / 8));
  const heightDots = Math.round(LABEL_HEIGHT_MM * dpm);
  const margin = scale(10);
  const outerH = heightDots - margin * 2;
  const fixedRowH = scale(28);
  const qtyRowH = scale(36);
  const fixedBeforeDesc = 7;
  const usedFixed = fixedBeforeDesc * fixedRowH + qtyRowH;
  const availableForDesc = Math.max(fixedRowH, outerH - usedFixed);
  const availableMaxLines = Math.max(2, Math.floor(availableForDesc / scale(16)));

  const descFit = fitPackingDescription(description || "", {
    maxWidthChars: 36,
    maxLines: 5,
    preferredFontSize: 7,
    minFontSize: 5,
    availableMaxLines,
  });

  const descLineDots = Math.max(scale(16), Math.round((descFit.fontSize / 7) * scale(18)));
  const descH = Math.min(
    availableForDesc,
    Math.max(fixedRowH, descFit.lines.length * descLineDots + scale(4))
  );

  return {
    ...descFit,
    descH,
    availableForDesc,
    qtyRowReserved: true,
    descriptionTruncated: descFit.truncated === true,
  };
}

/**
 * One packing customer sticker (100×50 table layout, no barcode).
 * Copies are handled by buildPackingJobTspl — this builds a single face.
 */
export function buildSinglePackingLabelTspl(line = {}, opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const dpm = dotsPerMm(dpi);
  const scale = (dotsAt203) => Math.round(dotsAt203 * (dpm / 8));

  const customer = escapeTspl(line.customerName || "");
  const customerRef = escapeTspl(line.customerRef || "") || "—";
  const brand = escapeTspl(line.brand || "") || "—";
  const modelName = escapeTspl(line.modelName || "") || "—";
  const article = escapeTspl(t(line.article).toUpperCase()) || "—";
  const serialNo = escapeTspl(line.serialNo != null && line.serialNo !== "" ? String(line.serialNo) : "—");
  const partNo = escapeTspl(line.partNo || line.spn || "") || "—";
  const qtyDisplay = escapeTspl(
    line.qtyDisplay || formatPackingQtyDisplay(line.labelQty, line.totalQty ?? line.qty)
  );

  const w = LABEL_WIDTH_MM;
  const h = LABEL_HEIGHT_MM;
  const widthDots = Math.round(w * dpm);
  const heightDots = Math.round(h * dpm);
  const margin = scale(10);
  const outerX = margin;
  const outerY = margin;
  const outerW = widthDots - margin * 2;
  const outerH = heightDots - margin * 2;
  const labelColW = Math.round(outerW * 0.28);
  const valueColX = outerX + labelColW;
  const textPad = scale(6);

  // Fixed rows (except Description): Customer, Customer Ref, Brand, Model, Article, S.No., Part No., QTY
  // Description is dynamic between Part No. and QTY.
  const fixedRowH = scale(28);
  const qtyRowH = scale(36);
  const border = 2;

  const layout = analyzePackingDescriptionLayout(line.description || "", { dpi });
  const descFit = layout;
  const descH = layout.descH;

  const rows = [
    { label: "Customer", value: customer || "—", h: fixedRowH, boldValue: false },
    { label: "Customer Ref.", value: customerRef, h: fixedRowH, boldValue: false },
    { label: "Brand", value: brand, h: fixedRowH, boldValue: false },
    { label: "Model", value: modelName, h: fixedRowH, boldValue: false },
    { label: "Article", value: article, h: fixedRowH, boldValue: true },
    { label: "S. No.", value: serialNo, h: fixedRowH, boldValue: false },
    { label: "Part No.", value: partNo, h: fixedRowH, boldValue: false },
    { label: "Description", value: null, h: descH, desc: true },
    { label: "QTY", value: qtyDisplay, h: qtyRowH, boldValue: true },
  ];

  const cmds = [
    `SIZE ${w} mm,${h} mm`,
    "GAP 3 mm,0",
    "DIRECTION 1",
    "REFERENCE 0,0",
    "CLS",
    `BOX ${outerX},${outerY},${outerX + outerW},${outerY + outerH},${border}`,
    `BAR ${valueColX},${outerY},${border},${outerH}`,
  ];

  let y = outerY;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const y2 = y + row.h;
    if (i < rows.length - 1) {
      cmds.push(`BAR ${outerX},${y2},${outerW},${1}`);
    }
    const labelY = y + Math.max(scale(6), Math.floor((row.h - scale(16)) / 2));
    cmds.push(`TEXT ${outerX + textPad},${labelY},"0",0,1,1,"${escapeTspl(row.label)}"`);

    if (row.desc) {
      const lh = Math.max(scale(16), Math.round((descFit.fontSize / 7) * scale(18)));
      let dy = y + scale(4);
      const mul = 1;
      for (const dl of descFit.lines) {
        cmds.push(`TEXT ${valueColX + textPad},${dy},"0",0,${mul},${mul},"${escapeTspl(dl)}"`);
        dy += lh;
      }
    } else {
      const mul = row.boldValue ? 2 : 1;
      const valueY = y + Math.max(scale(4), Math.floor((row.h - scale(mul === 2 ? 28 : 16)) / 2));
      cmds.push(`TEXT ${valueColX + textPad},${valueY},"0",0,${mul},${mul === 2 ? 1 : 1},"${escapeTspl(row.value)}"`);
    }
    y = y2;
  }

  // Guard: QTY row always starts at or before outer bottom (no overlap beyond box).
  cmds.push("PRINT 1,1");
  return cmds.join("\r\n") + "\r\n";
}

/** Metadata companion for a packing face (overflow / fit). */
export function packingLabelDescriptionMeta(line = {}, opts = {}) {
  const layout = analyzePackingDescriptionLayout(line.description || "", opts);
  return {
    descriptionTruncated: layout.descriptionTruncated === true,
    descriptionOverflow: layout.descriptionTruncated === true,
    descriptionFontSize: layout.fontSize,
    descriptionLineCount: layout.lines.length,
    descriptionFullLineCount: layout.fullLineCount,
  };
}

/**
 * Packing job TSPL: each line produces lineCopies identical stickers showing full QTY face.
 * Independent of GRN unit-label semantics.
 */
export function buildPackingJobTspl(lines = [], opts = {}) {
  const parts = [];
  for (const line of lines) {
    const copies = Math.max(1, Math.min(50, Math.floor(Number(line.lineCopies ?? line.copies ?? opts.copies) || 1)));
    for (let i = 0; i < copies; i++) {
      parts.push(buildSinglePackingLabelTspl(line, opts));
    }
  }
  return parts.join("");
}

/** Preview-friendly rows from the same normalized packing line payload. */
export function packingLabelPreviewRows(line = {}) {
  const meta = packingLabelDescriptionMeta(line);
  return [
    { label: "Customer", value: t(line.customerName) || "—" },
    { label: "Customer Ref.", value: t(line.customerRef) || "—" },
    { label: "Brand", value: t(line.brand) || "—" },
    { label: "Model", value: t(line.modelName) || "—" },
    { label: "Article", value: t(line.article).toUpperCase() || "—" },
    { label: "S. No.", value: line.serialNo != null && line.serialNo !== "" ? String(line.serialNo) : "—" },
    { label: "Part No.", value: t(line.partNo || line.spn) || "—" },
    { label: "Description", value: t(line.description) || "—" },
    {
      label: "QTY",
      value: t(line.qtyDisplay) || formatPackingQtyDisplay(line.labelQty, line.totalQty ?? line.qty),
    },
  ].map((row) =>
    row.label === "Description"
      ? { ...row, descriptionTruncated: meta.descriptionTruncated }
      : row
  );
}

/** One-off test label for agent/printer connectivity checks. */
export function buildTestLabelTspl(info = {}, opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const dpm = dotsPerMm(dpi);
  const scale = (dotsAt203) => Math.round(dotsAt203 * (dpm / 8));
  const now = info.when ? new Date(info.when) : new Date();
  const dateStr = escapeTspl(now.toISOString().slice(0, 10));
  const timeStr = escapeTspl(now.toISOString().slice(11, 19) + "Z");
  const agent = escapeTspl(info.agentName || info.agentId || "—");
  const printer = escapeTspl(info.printerName || info.windowsPrinterName || "—");
  const conn = escapeTspl(info.connectionStatus || "OK");
  const w = LABEL_WIDTH_MM;
  const h = LABEL_HEIGHT_MM;
  return [
    `SIZE ${w} mm,${h} mm`,
    "GAP 3 mm,0",
    "DIRECTION 1",
    "REFERENCE 0,0",
    "CLS",
    `TEXT ${scale(20)},${scale(20)},"0",0,2,2,"MARIVOLT TEST LABEL"`,
    `TEXT ${scale(20)},${scale(70)},"0",0,1,1,"Date: ${dateStr}"`,
    `TEXT ${scale(20)},${scale(100)},"0",0,1,1,"Time: ${timeStr}"`,
    `TEXT ${scale(20)},${scale(130)},"0",0,1,1,"Agent: ${agent}"`,
    `TEXT ${scale(20)},${scale(160)},"0",0,1,1,"Printer: ${printer}"`,
    `TEXT ${scale(20)},${scale(190)},"0",0,1,1,"Connection: ${conn}"`,
    "PRINT 1,1",
    "",
  ].join("\r\n");
}
