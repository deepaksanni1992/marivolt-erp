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
 * Build TSPL for one physical label (MARIVOLT_STANDARD).
 * Face qty defaults to 1 (legacy unit sticker); pass opts.qtyPerLabel for distributed GRN labels.
 */
export function buildSingleLabelTspl(line = {}, opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const dpm = dotsPerMm(dpi);
  const scale = (dotsAt203) => Math.round(dotsAt203 * (dpm / 8));

  const companyName = escapeTspl(opts.companyName || "COMPANY");
  // Article for barcode/human must not be mutated beyond trim+uppercase for Code128 safety
  const articleRaw = t(line.article).toUpperCase();
  const article = escapeTspl(articleRaw);
  const descLines = wrapDescription(line.description || "");
  const spn = escapeTspl(line.spn || "") || "—";
  const materialCode = escapeTspl(line.materialCode || "") || "—";
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
    labelId: line.labelId || line.barcodeValue || line.ruNo,
  });
  const barcode = escapeTspl(encoded.value || articleRaw);
  const human = escapeTspl(encoded.humanReadable || articleRaw);

  if (opts.faceVariant === "ASN_RU") {
    return buildAsnReceivingUnitFace(line, opts, {
      dpi,
      dpm,
      scale,
      companyName,
      article,
      descLines,
      qtyDisplay,
      uom,
      barcode,
      human,
    });
  }

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
 * ASN Receiving Unit face — same 100×50 TSPL engine, LABEL_ID barcode.
 * Does not change GRN ARTICLE layout. Called only when opts.faceVariant === "ASN_RU".
 */
function buildAsnReceivingUnitFace(line, opts, ctx) {
  const { scale, companyName, article, descLines, qtyDisplay, uom, barcode, human } = ctx;
  const articleFit = String(article || "").slice(0, 32) || "—";
  const partNo = escapeTspl(line.partNo || line.spn || "").slice(0, 42) || "—";
  const asnNo = escapeTspl(line.asnNo || line.grnNo || "") || "—";
  const ruNo = escapeTspl(line.ruNo || line.labelId || line.barcodeValue || "") || "—";
  const w = LABEL_WIDTH_MM;
  const h = LABEL_HEIGHT_MM;
  const dpm = ctx.dpm;
  const widthDots = Math.round(w * dpm);
  const barWidthDots = Math.round(widthDots * 0.7);
  const barX = Math.round((widthDots - barWidthDots) / 2);
  const barY = scale(255);
  const barHeight = scale(72);

  const cmds = [
    `SIZE ${w} mm,${h} mm`,
    "GAP 3 mm,0",
    "DIRECTION 1",
    "REFERENCE 0,0",
    "CLS",
    `TEXT ${scale(20)},${scale(8)},"0",0,1,1,"${companyName}"`,
    `TEXT ${scale(20)},${scale(32)},"0",0,2,2,"${articleFit}"`,
    `TEXT ${scale(20)},${scale(78)},"0",0,2,1,"${partNo}"`,
  ];

  let y = scale(108);
  const lineH = scale(20);
  for (const dl of descLines) {
    cmds.push(`TEXT ${scale(20)},${y},"0",0,1,1,"${escapeTspl(dl)}"`);
    y += lineH;
  }
  y = Math.max(y, scale(148));
  cmds.push(`TEXT ${scale(20)},${y},"0",0,2,1,"Qty: ${qtyDisplay} ${uom}"`);
  y += scale(28);
  cmds.push(`TEXT ${scale(20)},${y},"0",0,1,1,"ASN: ${asnNo}"`);
  y += scale(20);
  cmds.push(`TEXT ${scale(20)},${y},"0",0,1,1,"RU: ${ruNo}"`);

  if (barcode) {
    cmds.push(`BARCODE ${barX},${barY},"128",${barHeight},0,0,2,4,"${barcode}"`);
    cmds.push(`TEXT ${barX},${barY + barHeight + scale(6)},"0",0,1,1,"${human}"`);
  }

  cmds.push("PRINT 1,1");
  return cmds.join("\r\n") + "\r\n";
}

/**
 * Build full TSPL for GRN / stock / manual jobs.
 *
 * Legacy (no labelDistribution):
 *   labelQty × copies physical labels, each showing Qty: 1 UOM (unit stickers).
 *
 * Distribution mode (labelDistribution: [10,10,5]):
 *   one physical label per entry with that face qty (× copies).
 *   Remainder labels show the actual remainder — never padded to a full chunk.
 */
export function buildJobTspl(lines = [], opts = {}) {
  const copies = Math.max(1, Number(opts.copies) || 1);
  const parts = [];
  for (const line of lines) {
    const dist = Array.isArray(line.labelDistribution)
      ? line.labelDistribution
          .map((q) => Number(q))
          .filter((q) => Number.isFinite(q) && q > 0)
      : null;

    if (dist && dist.length > 0) {
      for (const faceQty of dist) {
        for (let c = 0; c < copies; c++) {
          parts.push(buildSingleLabelTspl(line, { ...opts, qtyPerLabel: faceQty }));
        }
      }
      continue;
    }

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
 * Prefer dynamic desc height from content; leftover height redistributes to fixed rows.
 */
export function computePackingLabelLayout(description = "", opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const dpm = dotsPerMm(dpi);
  const scale = (dotsAt203) => Math.round(dotsAt203 * (dpm / 8));
  const heightDots = Math.round(LABEL_HEIGHT_MM * dpm);
  const margin = scale(10);
  const outerH = heightDots - margin * 2;
  const labelColRatio = 0.26;

  // Minimums — slightly taller than prior 28 for readability; QTY reserved largest.
  const minNormalH = scale(26);
  const minEmphasisH = scale(30); // Customer / Article / Part No.
  const minDescH = scale(24);
  const qtyRowH = scale(44);

  const fixedSpecs = [
    { key: "Customer", minH: minEmphasisH, grow: 1.2 },
    { key: "Customer Ref.", minH: minNormalH, grow: 0.8 },
    { key: "Brand", minH: minNormalH, grow: 0.8 },
    { key: "Model", minH: minNormalH, grow: 0.8 },
    { key: "Article", minH: minEmphasisH, grow: 1.1 },
    { key: "S. No.", minH: minNormalH, grow: 0.7 },
    { key: "Part No.", minH: minEmphasisH, grow: 1.1 },
  ];

  const fixedMinSum = fixedSpecs.reduce((s, r) => s + r.minH, 0);
  const reserved = fixedMinSum + qtyRowH;
  const availableForDesc = Math.max(minDescH, outerH - reserved);
  const availableMaxLines = Math.max(2, Math.floor(availableForDesc / scale(18)));

  // Prefer slightly larger description text; shrink only when needed.
  const descFit = fitPackingDescription(description || "", {
    maxWidthChars: 40,
    maxLines: 5,
    preferredFontSize: 8,
    minFontSize: 5,
    availableMaxLines,
  });

  const descLineDots = Math.max(scale(17), Math.round((descFit.fontSize / 8) * scale(20)));
  const contentDescH = Math.max(
    minDescH,
    descFit.lines.length * descLineDots + scale(6)
  );
  // Dynamic: short text → one-line-ish row; long text grows up to available.
  let descH = Math.min(availableForDesc, contentDescH);

  // Leftover when description is short — distribute to improve fixed-row readability.
  let used = fixedMinSum + descH + qtyRowH;
  let leftover = Math.max(0, outerH - used);
  const heights = Object.fromEntries(fixedSpecs.map((r) => [r.key, r.minH]));
  if (leftover > 0) {
    const growTotal = fixedSpecs.reduce((s, r) => s + r.grow, 0) || 1;
    for (const r of fixedSpecs) {
      const share = Math.floor((leftover * r.grow) / growTotal);
      const cap = r.minH + scale(10);
      const next = Math.min(cap, heights[r.key] + share);
      leftover -= next - heights[r.key];
      heights[r.key] = next;
    }
    // Any remaining dots go to Description (still below availableForDesc).
    if (leftover > 0) {
      const room = availableForDesc - descH;
      const add = Math.min(leftover, Math.max(0, room));
      descH += add;
      leftover -= add;
    }
    if (leftover > 0) {
      heights.Customer = (heights.Customer || minEmphasisH) + leftover;
    }
  }

  // Final guard: total must not exceed outerH (prefer trimming desc).
  used =
    fixedSpecs.reduce((s, r) => s + heights[r.key], 0) + descH + qtyRowH;
  if (used > outerH) {
    descH = Math.max(minDescH, descH - (used - outerH));
  }

  return {
    ...descFit,
    dpi,
    scale,
    margin,
    outerH,
    labelColRatio,
    qtyRowH,
    descH,
    availableForDesc,
    qtyRowReserved: true,
    descriptionTruncated: descFit.truncated === true,
    descLineDots,
    rowHeights: {
      ...heights,
      Description: descH,
      QTY: qtyRowH,
    },
    fonts: {
      // TSPL font "0" multipliers [xMul, yMul]
      fieldLabel: [1, 1],
      valueNormal: [1, 1],
      valueCustomer: [2, 1], // stronger when space allows (short names); layout still works for long
      valueEmphasis: [2, 1], // Article / Part No.
      valueQty: [2, 2], // strongest
      description: [1, 1],
    },
  };
}

export function analyzePackingDescriptionLayout(description = "", opts = {}) {
  return computePackingLabelLayout(description, opts);
}

/**
 * One packing customer sticker (100×50 table layout, no barcode).
 * Copies are handled by buildPackingJobTspl — this builds a single face.
 */
export function buildSinglePackingLabelTspl(line = {}, opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const dpm = dotsPerMm(dpi);
  const scale = (dotsAt203) => Math.round(dotsAt203 * (dpm / 8));

  const customerRaw = t(line.customerName);
  const customer = escapeTspl(customerRaw);
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
  const layout = computePackingLabelLayout(line.description || "", { dpi });
  const margin = layout.margin ?? scale(10);
  const outerX = margin;
  const outerY = margin;
  const outerW = widthDots - margin * 2;
  const outerH = layout.outerH ?? heightDots - margin * 2;
  const labelColW = Math.round(outerW * (layout.labelColRatio || 0.26));
  const valueColX = outerX + labelColW;
  const textPad = scale(5);
  const border = 2;

  const rh = layout.rowHeights;
  const fonts = layout.fonts;
  // Customer double-width only when name is short enough for the value column.
  const customerMul =
    customerRaw.length > 0 && customerRaw.length <= 22 ? fonts.valueCustomer : fonts.valueNormal;

  const rows = [
    {
      label: "Customer",
      value: customer || "—",
      h: rh.Customer,
      valueMul: customerMul,
      labelMul: fonts.fieldLabel,
    },
    {
      label: "Customer Ref.",
      value: customerRef,
      h: rh["Customer Ref."],
      valueMul: fonts.valueNormal,
      labelMul: fonts.fieldLabel,
    },
    {
      label: "Brand",
      value: brand,
      h: rh.Brand,
      valueMul: fonts.valueNormal,
      labelMul: fonts.fieldLabel,
    },
    {
      label: "Model",
      value: modelName,
      h: rh.Model,
      valueMul: fonts.valueNormal,
      labelMul: fonts.fieldLabel,
    },
    {
      label: "Article",
      value: article,
      h: rh.Article,
      valueMul: fonts.valueEmphasis,
      labelMul: fonts.fieldLabel,
    },
    {
      label: "S. No.",
      value: serialNo,
      h: rh["S. No."],
      valueMul: fonts.valueNormal,
      labelMul: fonts.fieldLabel,
    },
    {
      label: "Part No.",
      value: partNo,
      h: rh["Part No."],
      valueMul: fonts.valueEmphasis,
      labelMul: fonts.fieldLabel,
    },
    {
      label: "Description",
      value: null,
      h: rh.Description,
      desc: true,
      valueMul: fonts.description,
      labelMul: fonts.fieldLabel,
    },
    {
      label: "QTY",
      value: qtyDisplay,
      h: rh.QTY,
      valueMul: fonts.valueQty,
      labelMul: fonts.fieldLabel,
    },
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
    const [lx, ly] = row.labelMul || [1, 1];
    const labelTextH = scale(ly >= 2 ? 22 : 16);
    const labelY = y + Math.max(scale(4), Math.floor((row.h - labelTextH) / 2));
    cmds.push(
      `TEXT ${outerX + textPad},${labelY},"0",0,${lx},${ly},"${escapeTspl(row.label)}"`
    );

    if (row.desc) {
      const lh = layout.descLineDots || Math.max(scale(17), Math.round((layout.fontSize / 8) * scale(20)));
      let dy = y + scale(4);
      const [dx, dyMul] = fonts.description;
      for (const dl of layout.lines) {
        cmds.push(
          `TEXT ${valueColX + textPad},${dy},"0",0,${dx},${dyMul},"${escapeTspl(dl)}"`
        );
        dy += lh;
      }
    } else {
      const [vx, vy] = row.valueMul || [1, 1];
      const valueTextH = scale(vy >= 2 ? 28 : vx >= 2 ? 20 : 16);
      const valueY = y + Math.max(scale(3), Math.floor((row.h - valueTextH) / 2));
      cmds.push(
        `TEXT ${valueColX + textPad},${valueY},"0",0,${vx},${vy},"${escapeTspl(row.value)}"`
      );
    }
    y = y2;
  }

  cmds.push("PRINT 1,1");
  return cmds.join("\r\n") + "\r\n";
}

/** Metadata companion for a packing face (overflow / fit). */
export function packingLabelDescriptionMeta(line = {}, opts = {}) {
  const layout = computePackingLabelLayout(line.description || "", opts);
  return {
    descriptionTruncated: layout.descriptionTruncated === true,
    descriptionOverflow: layout.descriptionTruncated === true,
    descriptionFontSize: layout.fontSize,
    descriptionLineCount: layout.lines.length,
    descriptionFullLineCount: layout.fullLineCount,
    descriptionLines: layout.lines,
    rowHeights: layout.rowHeights,
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

/** Preview-friendly rows from the same normalized packing line payload + layout weights. */
export function packingLabelPreviewRows(line = {}) {
  const meta = packingLabelDescriptionMeta(line);
  const heights = meta.rowHeights || {};
  const totalH =
    Object.values(heights).reduce((s, n) => s + (Number(n) || 0), 0) || 1;
  const weight = (key, fallback = 1) =>
    Math.max(0.5, ((Number(heights[key]) || fallback) / totalH) * 100);

  const qtyValue =
    t(line.qtyDisplay) || formatPackingQtyDisplay(line.labelQty, line.totalQty ?? line.qty);

  return [
    {
      label: "Customer",
      value: t(line.customerName) || "—",
      emphasis: "customer",
      weight: weight("Customer", 30),
    },
    {
      label: "Customer Ref.",
      value: t(line.customerRef) || "—",
      emphasis: "normal",
      weight: weight("Customer Ref.", 26),
    },
    {
      label: "Brand",
      value: t(line.brand) || "—",
      emphasis: "normal",
      weight: weight("Brand", 26),
    },
    {
      label: "Model",
      value: t(line.modelName) || "—",
      emphasis: "normal",
      weight: weight("Model", 26),
    },
    {
      label: "Article",
      value: t(line.article).toUpperCase() || "—",
      emphasis: "strong",
      weight: weight("Article", 30),
    },
    {
      label: "S. No.",
      value: line.serialNo != null && line.serialNo !== "" ? String(line.serialNo) : "—",
      emphasis: "normal",
      weight: weight("S. No.", 26),
    },
    {
      label: "Part No.",
      value: t(line.partNo || line.spn) || "—",
      emphasis: "strong",
      weight: weight("Part No.", 30),
    },
    {
      label: "Description",
      value: (meta.descriptionLines && meta.descriptionLines.length
        ? meta.descriptionLines.join("\n")
        : t(line.description)) || "—",
      emphasis: "desc",
      weight: weight("Description", 40),
      descriptionTruncated: meta.descriptionTruncated,
      descriptionLines: meta.descriptionLines || [],
    },
    {
      label: "QTY",
      value: qtyValue,
      emphasis: "qty",
      weight: weight("QTY", 44),
    },
  ];
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
  const title = escapeTspl(info.title || opts.companyName || "TEST LABEL");
  const w = LABEL_WIDTH_MM;
  const h = LABEL_HEIGHT_MM;
  return [
    `SIZE ${w} mm,${h} mm`,
    "GAP 3 mm,0",
    "DIRECTION 1",
    "REFERENCE 0,0",
    "CLS",
    `TEXT ${scale(20)},${scale(20)},"0",0,2,2,"${title}"`,
    `TEXT ${scale(20)},${scale(70)},"0",0,1,1,"Date: ${dateStr}"`,
    `TEXT ${scale(20)},${scale(100)},"0",0,1,1,"Time: ${timeStr}"`,
    `TEXT ${scale(20)},${scale(130)},"0",0,1,1,"Agent: ${agent}"`,
    `TEXT ${scale(20)},${scale(160)},"0",0,1,1,"Printer: ${printer}"`,
    `TEXT ${scale(20)},${scale(190)},"0",0,1,1,"Connection: ${conn}"`,
    "PRINT 1,1",
    "",
  ].join("\r\n");
}
