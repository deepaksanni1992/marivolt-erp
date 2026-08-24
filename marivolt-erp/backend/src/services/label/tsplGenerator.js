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

/**
 * Typical TSPL built-in font "0" cell height (dots) at 1× magnification.
 * TEXT yMul multiplies this for physical glyph extent (not the scale(28) estimate).
 */
export const TSPL_FONT0_CELL_DOTS = 24;

/**
 * Typical TSPL font "0" character advance width (dots) at 1× magnification.
 * Font 0 is roughly half as wide as tall (~12×24); raster must not use square cells.
 */
export const TSPL_FONT0_CELL_WIDTH_DOTS = 12;

/** Safe bottom margin inside the physical label (dots). */
export const PACKING_LABEL_BOTTOM_SAFE_DOTS = 4;

export function labelDotDimensions(dpi = 203) {
  const dpm = dotsPerMm(dpi);
  return {
    dpi: Number(dpi) || 203,
    widthDots: Math.round(LABEL_WIDTH_MM * dpm),
    heightDots: Math.round(LABEL_HEIGHT_MM * dpm),
    dotsPerMm: dpm,
  };
}

/** Physical glyph height for TSPL font "0" at given multipliers. */
export function tsplFont0GlyphHeight(yMul = 1) {
  return TSPL_FONT0_CELL_DOTS * Math.max(1, Math.floor(Number(yMul) || 1));
}

/** Physical glyph advance width for TSPL font "0" at given x multiplier. */
export function tsplFont0GlyphWidth(xMul = 1) {
  return TSPL_FONT0_CELL_WIDTH_DOTS * Math.max(1, Math.floor(Number(xMul) || 1));
}

/** Monospace text width in dots for TSPL font "0". */
export function measureTsplFont0TextWidth(text, xMul = 1) {
  return String(text ?? "").length * tsplFont0GlyphWidth(xMul);
}

/**
 * Shrink xMul (and truncate if still too wide) so text fits maxWidthDots.
 * Preserves preferred emphasis when it fits; never increases multipliers.
 */
export function fitTsplFont0TextToWidth(
  text,
  preferredXMul = 1,
  maxWidthDots = 0,
  { minXMul = 1, allowTruncate = true } = {}
) {
  let t = String(text ?? "");
  const maxW = Math.max(0, Math.floor(Number(maxWidthDots) || 0));
  let xMul = Math.max(minXMul, Math.floor(Number(preferredXMul) || 1));
  if (maxW <= 0) return { text: t, xMul };

  while (xMul > minXMul && measureTsplFont0TextWidth(t, xMul) > maxW) {
    xMul -= 1;
  }
  if (allowTruncate && measureTsplFont0TextWidth(t, xMul) > maxW) {
    const charW = tsplFont0GlyphWidth(xMul);
    const maxChars = Math.max(1, Math.floor(maxW / charW));
    if (t.length > maxChars) {
      t = maxChars <= 2 ? t.slice(0, maxChars) : `${t.slice(0, maxChars - 2)}..`;
    }
  }
  return { text: t, xMul };
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
 *
 * Custom packing (`omitArticle: true`) intentionally reflows after Article removal:
 * Description does not absorb all leftover height (that mismatched preview vs TSPL),
 * and QTY row is sized for real 2×2 font glyph extent so it cannot spill onto the next sticker.
 */
export function computePackingLabelLayout(description = "", opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const dpm = dotsPerMm(dpi);
  const scale = (dotsAt203) => Math.round(dotsAt203 * (dpm / 8));
  const heightDots = Math.round(LABEL_HEIGHT_MM * dpm);
  const margin = scale(10);
  const outerH = heightDots - margin * 2;
  const labelColRatio = 0.26;
  const omitArticle = opts.omitArticle === true;

  // Minimums — slightly taller than prior 28 for readability; QTY reserved for real 2×2 glyph.
  const minNormalH = scale(26);
  const minEmphasisH = scale(30); // Customer / Article / Part No.
  const minDescH = scale(24);
  const qtyGlyphH = tsplFont0GlyphHeight(2);
  // Must fit 2×2 QTY glyph with padding and stay above bottom safe margin.
  const qtyRowH = Math.max(scale(44), qtyGlyphH + scale(12));

  const fixedSpecs = [
    { key: "Customer", minH: minEmphasisH, grow: 1.2 },
    { key: "Customer Ref.", minH: minNormalH, grow: 0.8 },
    { key: "Brand", minH: minNormalH, grow: 0.8 },
    { key: "Model", minH: minNormalH, grow: 0.8 },
    { key: "Article", minH: minEmphasisH, grow: 1.1 },
    { key: "S. No.", minH: minNormalH, grow: 0.7 },
    { key: "Part No.", minH: minEmphasisH, grow: 1.1 },
  ].filter((row) => !(omitArticle && row.key === "Article"));

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
    // Custom (no Article): allow header rows a bit more growth; do not dump all leftover into Description.
    const headerCapExtra = omitArticle ? scale(14) : scale(10);
    for (const r of fixedSpecs) {
      const share = Math.floor((leftover * r.grow) / growTotal);
      const cap = r.minH + headerCapExtra;
      const next = Math.min(cap, heights[r.key] + share);
      leftover -= next - heights[r.key];
      heights[r.key] = next;
    }
    // Remaining leftover → Description, but custom packing caps inflation so QTY geometry stays stable
    // and description text can be vertically centered (preview parity).
    if (leftover > 0) {
      const room = availableForDesc - descH;
      const maxDescExtra = omitArticle ? scale(24) : room;
      const add = Math.min(leftover, Math.max(0, room), Math.max(0, maxDescExtra));
      descH += add;
      leftover -= add;
    }
    if (leftover > 0) {
      // Park residual in Customer (top), never push QTY down past the box.
      heights.Customer = (heights.Customer || minEmphasisH) + leftover;
      leftover = 0;
    }
  }

  // Final guard: total must not exceed outerH (prefer trimming desc).
  used =
    fixedSpecs.reduce((s, r) => s + heights[r.key], 0) + descH + qtyRowH;
  if (used > outerH) {
    descH = Math.max(minDescH, descH - (used - outerH));
  }

  // Absolute physical guard: QTY glyph must stay above bottom safe margin.
  const outerY = margin;
  const qtyTop = outerY + outerH - qtyRowH;
  const qtyTextMaxBottom = heightDots - PACKING_LABEL_BOTTOM_SAFE_DOTS;
  if (qtyTop + qtyGlyphH > qtyTextMaxBottom) {
    const overflow = qtyTop + qtyGlyphH - qtyTextMaxBottom;
    descH = Math.max(minDescH, descH - overflow);
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
    qtyGlyphH,
    omitArticle,
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
  const layout = computePackingLabelLayout(line.description || "", {
    dpi,
    omitArticle: opts.omitArticle === true,
  });
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
    ...(opts.omitArticle
      ? []
      : [
          {
            label: "Article",
            value: article,
            h: rh.Article,
            valueMul: fonts.valueEmphasis,
            labelMul: fonts.fieldLabel,
          },
        ]),
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

  // RAW_FACE_BATCH (omitMediaSetup): CLS + face + PRINT only — no SIZE/GAP/DIRECTION/REFERENCE.
  // Resident calibrated media advances one physical label per independent RAW document.
  const cmds = opts.omitMediaSetup
    ? [
        "CLS",
        `BOX ${outerX},${outerY},${outerX + outerW},${outerY + outerH},${border}`,
        `BAR ${valueColX},${outerY},${border},${outerH}`,
      ]
    : [
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
    const labelGlyphH = tsplFont0GlyphHeight(ly);
    const labelY = y + Math.max(scale(2), Math.floor((row.h - labelGlyphH) / 2));
    // Keep label text inside the row / label face.
    const labelYClamped = Math.min(labelY, Math.max(y, y2 - labelGlyphH - 1));
    cmds.push(
      `TEXT ${outerX + textPad},${labelYClamped},"0",0,${lx},${ly},"${escapeTspl(row.label)}"`
    );

    if (row.desc) {
      const lh = layout.descLineDots || Math.max(scale(17), Math.round((layout.fontSize / 8) * scale(20)));
      const [dx, dyMul] = fonts.description;
      const blockH = Math.max(lh, (layout.lines.length || 0) * lh);
      // Vertically center the description block in its cell (matches CSS table preview).
      let dy = y + Math.max(scale(3), Math.floor((row.h - blockH) / 2));
      const dyMax = y2 - lh - 1;
      for (const dl of layout.lines) {
        const lineY = Math.min(dy, dyMax);
        cmds.push(
          `TEXT ${valueColX + textPad},${lineY},"0",0,${dx},${dyMul},"${escapeTspl(dl)}"`
        );
        dy += lh;
      }
    } else {
      const [vx, vy] = row.valueMul || [1, 1];
      const glyphH = tsplFont0GlyphHeight(vy);
      let valueY = y + Math.max(scale(2), Math.floor((row.h - glyphH) / 2));
      // Never let QTY (or any value) glyph cross the physical label bottom.
      const maxBottom = Math.min(
        heightDots - PACKING_LABEL_BOTTOM_SAFE_DOTS,
        y2 - 1
      );
      if (valueY + glyphH > maxBottom) {
        valueY = Math.max(y, maxBottom - glyphH);
      }
      cmds.push(
        `TEXT ${valueColX + textPad},${valueY},"0",0,${vx},${vy},"${escapeTspl(row.value)}"`
      );
    }
    y = y2;
  }

  cmds.push("PRINT 1,1");
  return cmds.join("\r\n") + "\r\n";
}

/**
 * Measure max physical Y extent (including font glyph height) for a packing/custom face.
 * Used by geometry regression tests — must stay within labelDotDimensions().heightDots.
 */
export function measurePackingLabelGeometry(line = {}, opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const { heightDots, widthDots } = labelDotDimensions(dpi);
  const layout = computePackingLabelLayout(line.description || "", {
    dpi,
    omitArticle: opts.omitArticle === true,
  });
  const scale = layout.scale;
  const margin = layout.margin ?? scale(10);
  const outerY = margin;
  const keys = [
    "Customer",
    "Customer Ref.",
    "Brand",
    "Model",
    ...(opts.omitArticle ? [] : ["Article"]),
    "S. No.",
    "Part No.",
    "Description",
    "QTY",
  ];
  let y = outerY;
  let maxY = outerY;
  const elements = [];
  for (const key of keys) {
    const h = Number(layout.rowHeights[key]) || 0;
    const y2 = y + h;
    let textTop = y;
    let textBottom = y2;
    let yMul = 1;
    if (key === "Description") {
      const lh = layout.descLineDots || scale(20);
      const blockH = Math.max(lh, (layout.lines.length || 0) * lh);
      textTop = y + Math.max(scale(3), Math.floor((h - blockH) / 2));
      textBottom = textTop + blockH;
    } else if (key === "QTY") {
      yMul = 2;
      const glyphH = tsplFont0GlyphHeight(yMul);
      textTop = y + Math.max(scale(2), Math.floor((h - glyphH) / 2));
      const maxBottom = Math.min(heightDots - PACKING_LABEL_BOTTOM_SAFE_DOTS, y2 - 1);
      if (textTop + glyphH > maxBottom) textTop = Math.max(y, maxBottom - glyphH);
      textBottom = textTop + glyphH;
    } else {
      yMul = key === "Part No." || key === "Article" ? 1 : 1;
      const xMul = key === "Part No." || key === "Article" || key === "Customer" ? 2 : 1;
      // Customer may use 2×1; Part/Article 2×1
      const glyphH = tsplFont0GlyphHeight(1);
      textTop = y + Math.max(scale(2), Math.floor((h - glyphH) / 2));
      textBottom = textTop + glyphH;
      void xMul;
    }
    maxY = Math.max(maxY, textBottom, y2);
    elements.push({ key, rowY: y, rowBottom: y2, textTop, textBottom });
    y = y2;
  }
  return {
    widthDots,
    heightDots,
    maxY,
    boxBottom: outerY + (layout.outerH || 0),
    withinLabel: maxY <= heightDots - PACKING_LABEL_BOTTOM_SAFE_DOTS,
    qtyWithinLabel:
      (elements.find((e) => e.key === "QTY")?.textBottom || 0) <=
      heightDots - PACKING_LABEL_BOTTOM_SAFE_DOTS,
    descriptionAboveQty: (() => {
      const d = elements.find((e) => e.key === "Description");
      const q = elements.find((e) => e.key === "QTY");
      return d && q ? d.textBottom <= q.rowY + 1 : false;
    })(),
    elements,
    rowHeights: layout.rowHeights,
    omitArticle: opts.omitArticle === true,
  };
}

/**
 * Diagnostic faces: outer rectangle + top/bottom rules + sequence number.
 * Used to distinguish true media feed drift from content overflow.
 */
export function buildPackingGeometryDiagnosticTspl(count = 6, opts = {}) {
  const dpi = Number(opts.dpi) || 203;
  const dpm = dotsPerMm(dpi);
  const scale = (dotsAt203) => Math.round(dotsAt203 * (dpm / 8));
  const w = LABEL_WIDTH_MM;
  const h = LABEL_HEIGHT_MM;
  const widthDots = Math.round(w * dpm);
  const heightDots = Math.round(h * dpm);
  const margin = scale(10);
  const n = Math.max(1, Math.min(20, Math.floor(Number(count) || 6)));
  const parts = [];
  for (let i = 1; i <= n; i++) {
    parts.push(
      [
        `SIZE ${w} mm,${h} mm`,
        "GAP 3 mm,0",
        "DIRECTION 1",
        "REFERENCE 0,0",
        "CLS",
        `BOX ${margin},${margin},${widthDots - margin},${heightDots - margin},3`,
        `BAR ${margin},${margin},${widthDots - margin * 2},2`,
        `BAR ${margin},${heightDots - margin - 2},${widthDots - margin * 2},2`,
        `TEXT ${scale(40)},${scale(160)},"0",0,3,3,"DIAG ${i}/${n}"`,
        "PRINT 1,1",
        "",
      ].join("\r\n")
    );
  }
  return parts.join("");
}

/** Metadata companion for a packing face (overflow / fit). */
export function packingLabelDescriptionMeta(line = {}, opts = {}) {
  const layout = computePackingLabelLayout(line.description || "", {
    ...opts,
    omitArticle: opts.omitArticle === true,
  });
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
 * NOTE: concatenates faces into one string — do not use for production packing RAW_FACE_BATCH.
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

/**
 * One independent RAW TSPL document per physical packing face (ab61a9d geometry).
 * Each payload: CLS … face content … PRINT 1,1 — no SIZE/GAP/DIRECTION/REFERENCE.
 */
export function buildPackingRawFacePayloads(lines = [], opts = {}) {
  const faceOpts = { ...opts, omitMediaSetup: true };
  const payloads = [];
  for (const line of lines) {
    const copies = Math.max(
      1,
      Math.min(50, Math.floor(Number(line.lineCopies ?? line.copies ?? opts.copies) || 1))
    );
    for (let i = 0; i < copies; i++) {
      payloads.push(buildSinglePackingLabelTspl(line, faceOpts));
    }
  }
  return payloads;
}

/** Preview-friendly rows from the same normalized packing line payload + layout weights. */
export function packingLabelPreviewRows(line = {}, opts = {}) {
  const meta = packingLabelDescriptionMeta(line, opts);
  const heights = meta.rowHeights || {};
  const totalH =
    Object.values(heights).reduce((s, n) => s + (Number(n) || 0), 0) || 1;
  const weight = (key, fallback = 1) =>
    Math.max(0.5, ((Number(heights[key]) || fallback) / totalH) * 100);

  const qtyValue =
    t(line.qtyDisplay) || formatPackingQtyDisplay(line.labelQty, line.totalQty ?? line.qty);

  const rows = [
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
    ...(opts.omitArticle
      ? []
      : [
          {
            label: "Article",
            value: t(line.article).toUpperCase() || "—",
            emphasis: "strong",
            weight: weight("Article", 30),
          },
        ]),
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
  return rows;
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
