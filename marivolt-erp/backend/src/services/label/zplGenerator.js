/**
 * Versioned ZPL renderer for MARIVOLT_STANDARD GRN labels on 100×50 mm / 8 dpmm (800×400 dots).
 * Content mirrors the TSPL standard GRN face. Never emits TSPL commands.
 */
import { encodeBarcodeValue } from "./barcodeGenerator.js";
import { wrapDescription } from "./tsplGenerator.js";
import {
  LABEL_LANGUAGE_ZPL,
  looksLikeTsplPayload,
} from "./labelLanguages.js";
import {
  ZPL_ASN_RU_LAYOUT_VERSION,
  ZPL_DOTS_PER_MM,
  ZPL_GRN_LAYOUT_VERSION,
  ZPL_HEIGHT_DOTS,
  ZPL_HEIGHT_MM,
  ZPL_WIDTH_DOTS,
  ZPL_WIDTH_MM,
} from "./labelPrinterProfile.js";

export const MARIVOLT_STANDARD_ZPL_V1 = "MARIVOLT_STANDARD_ZPL_V1";

const MARGIN = 16;
const ARTICLE_CHAR_W = 24;
const BODY_CHAR_W = 12;
const BODY_CHAR_H = 24;
const BAR_MODULE = 2;
const BAR_QUIET = 20;
const MAX_ASCII = 126;

function t(v) {
  if (v == null) return "";
  if (typeof v === "object") return "";
  return String(v).trim();
}

function routingError(message, code = "LABEL_ZPL_OVERFLOW") {
  const err = new Error(message);
  err.code = code;
  err.statusCode = 400;
  return err;
}

/** Printable ASCII only. Reject control chars and non-ASCII explicitly. */
export function assertZplEncodable(text, fieldName) {
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 32 || c > MAX_ASCII) {
      throw routingError(
        `Unsupported character in ${fieldName} for ZPL (code ${c}). Use printable ASCII.`,
        "LABEL_ZPL_ENCODING"
      );
    }
  }
  return s;
}

/**
 * ^FH_ hex-escape ZPL field data: ^ ~ _ and NUL-adjacent command starters.
 * Leaves ordinary ASCII (including barcode punctuation / leading zeros) intact.
 */
export function escapeZplField(raw) {
  const s = t(raw).replace(/[\r\n\t]+/g, " ");
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === "^" || ch === "~" || ch === "_" || c < 32 || c === 127) {
      out += `_${c.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return out.slice(0, 200);
}

export function hexEscapeZplBarcodeData(raw) {
  const s = String(raw ?? "");
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === "^" || ch === "~" || ch === "_" || ch === ">" || c < 32 || c === 127) {
      out += `_${c.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Code128 width in dots at module width 2 (subset B: start/stop/check + 11 modules/char). */
export function estimateCode128Dots(data, moduleDots = BAR_MODULE) {
  const n = String(data || "").length;
  const modules = 11 * n + 13 + 13 + 11;
  return modules * moduleDots;
}

export function zplCanvas(layoutVersion = ZPL_GRN_LAYOUT_VERSION) {
  return {
    language: LABEL_LANGUAGE_ZPL,
    layoutVersion,
    widthMm: ZPL_WIDTH_MM,
    heightMm: ZPL_HEIGHT_MM,
    dpi: Math.round(ZPL_DOTS_PER_MM * 25.4),
    dotsPerMm: ZPL_DOTS_PER_MM,
    widthDots: ZPL_WIDTH_DOTS,
    heightDots: ZPL_HEIGHT_DOTS,
  };
}

function fd(text) {
  return `^FH_^FD${escapeZplField(text)}^FS`;
}

function layoutStandardGrnFace(line = {}, opts = {}) {
  const articleRaw = t(line.article).toUpperCase();
  if (!articleRaw) {
    throw routingError("Article is required on each ZPL GRN label", "LABEL_ZPL_OVERFLOW");
  }
  assertZplEncodable(articleRaw, "Article");
  const companyName = t(opts.companyName || "COMPANY");
  assertZplEncodable(companyName, "Company");
  const desc = t(line.description);
  if (desc) assertZplEncodable(desc, "Description");
  const spn = t(line.spn || "") || "-";
  const materialCode = t(line.materialCode || "") || "-";
  const uom = t(line.uom || "PCS") || "PCS";
  const poNo = t(line.poNo || "") || "-";
  const grnNo = t(line.grnNo || "") || "-";
  const receivedDate = t(line.receivedDate || "") || "-";
  const location = t(line.location || "") || "-";
  for (const [name, val] of [
    ["SPN", spn],
    ["Material", materialCode],
    ["UOM", uom],
    ["PO", poNo],
    ["GRN", grnNo],
    ["Received date", receivedDate],
    ["Bin", location],
  ]) {
    assertZplEncodable(val, name);
  }

  const qtyOnLabel = opts.qtyPerLabel != null ? Number(opts.qtyPerLabel) : 1;
  const qtyDisplay = Number.isFinite(qtyOnLabel) && qtyOnLabel > 0 ? String(qtyOnLabel) : "1";
  assertZplEncodable(qtyDisplay, "Quantity");

  const encoded = encodeBarcodeValue({
    mode: opts.barcodeMode || "ARTICLE",
    article: articleRaw,
    labelId: line.labelId || line.barcodeValue || line.ruNo,
  });
  const barcodeRaw = encoded.value || articleRaw;
  assertZplEncodable(barcodeRaw, "Barcode");

  const textMax = ZPL_WIDTH_DOTS - MARGIN * 2;
  if (articleRaw.length * ARTICLE_CHAR_W > textMax) {
    throw routingError(
      `Article "${articleRaw}" does not fit the 100×50 mm ZPL text block`,
      "LABEL_ZPL_OVERFLOW"
    );
  }

  const barWidthDots = estimateCode128Dots(barcodeRaw, BAR_MODULE);
  const barTotal = barWidthDots + BAR_QUIET * 2;
  if (barTotal > ZPL_WIDTH_DOTS - MARGIN * 2) {
    throw routingError(
      `Article barcode "${barcodeRaw}" is too wide for a readable Code128 quiet zone on 100×50 mm`,
      "LABEL_ZPL_OVERFLOW"
    );
  }

  const descLines = wrapDescription(desc, 42, 2);
  for (const dl of descLines) {
    if (dl.length * BODY_CHAR_W > textMax) {
      throw routingError("Description does not fit the ZPL text block", "LABEL_ZPL_OVERFLOW");
    }
  }

  const rows = [
    `SPN: ${spn}`,
    `Mat: ${materialCode}`,
    `Qty: ${qtyDisplay} ${uom}`,
    `PO: ${poNo}  GRN: ${grnNo}`,
    `Recv: ${receivedDate}  Bin: ${location}`,
  ];
  for (const row of rows) {
    if (row.length * BODY_CHAR_W > textMax) {
      throw routingError(`Identifier line does not fit: ${row.slice(0, 48)}`, "LABEL_ZPL_OVERFLOW");
    }
  }

  const barH = 80;
  const barY = 250;
  const barX = Math.round((ZPL_WIDTH_DOTS - barWidthDots) / 2);
  return {
    articleRaw,
    barcodeRaw,
    human: encoded.humanReadable || articleRaw,
    companyName,
    descLines,
    rows,
    barX: Math.max(MARGIN + BAR_QUIET, barX),
    barY,
    barH,
    barWidthDots,
  };
}

function layoutAsnRuFace(line = {}, opts = {}) {
  const ruNo = t(line.ruNo || line.labelId || line.barcodeValue).toUpperCase();
  if (!ruNo) {
    throw routingError("Receiving Unit number is required on each ZPL RU label", "LABEL_ZPL_OVERFLOW");
  }
  assertZplEncodable(ruNo, "RU number");
  const articleRaw = t(line.article).toUpperCase();
  if (!articleRaw) {
    throw routingError("Article is required on each ZPL RU label", "LABEL_ZPL_OVERFLOW");
  }
  assertZplEncodable(articleRaw, "Article");
  const companyName = t(opts.companyName || "COMPANY");
  assertZplEncodable(companyName, "Company");
  const desc = t(line.description);
  if (desc) assertZplEncodable(desc, "Description");
  const partNo = t(line.partNo || line.spn || "") || "-";
  const uom = t(line.uom || "PCS") || "PCS";
  const asnNo = t(line.asnNo || "") || "-";
  for (const [name, val] of [
    ["Part", partNo],
    ["UOM", uom],
    ["ASN", asnNo],
  ]) {
    assertZplEncodable(val, name);
  }

  const qtyOnLabel = opts.qtyPerLabel != null ? Number(opts.qtyPerLabel) : Number(line.qtyPerLabel ?? line.qty);
  const qtyDisplay = Number.isFinite(qtyOnLabel) && qtyOnLabel > 0 ? String(qtyOnLabel) : "1";
  assertZplEncodable(qtyDisplay, "Quantity");

  const encoded = encodeBarcodeValue({ mode: "LABEL_ID", labelId: ruNo });
  const barcodeRaw = encoded.value;
  if (!barcodeRaw || barcodeRaw !== ruNo) {
    throw routingError("RU barcode value must equal the permanent RU number", "LABEL_ZPL_INVALID");
  }
  if (articleRaw && barcodeRaw === articleRaw && ruNo !== articleRaw) {
    throw routingError("RU identity must not be replaced with an Article barcode", "LABEL_ZPL_INVALID");
  }
  assertZplEncodable(barcodeRaw, "RU barcode");

  const textMax = ZPL_WIDTH_DOTS - MARGIN * 2;
  if (articleRaw.length * ARTICLE_CHAR_W > textMax) {
    throw routingError(
      `Article "${articleRaw}" does not fit the 100×50 mm ZPL text block`,
      "LABEL_ZPL_OVERFLOW"
    );
  }
  if (ruNo.length * BODY_CHAR_W > textMax) {
    throw routingError(`RU number "${ruNo}" does not fit the 100×50 mm ZPL text block`, "LABEL_ZPL_OVERFLOW");
  }

  const barWidthDots = estimateCode128Dots(barcodeRaw, BAR_MODULE);
  const barTotal = barWidthDots + BAR_QUIET * 2;
  if (barTotal > ZPL_WIDTH_DOTS - MARGIN * 2) {
    throw routingError(
      `RU barcode "${barcodeRaw}" is too wide for a readable Code128 quiet zone on 100×50 mm`,
      "LABEL_ZPL_OVERFLOW"
    );
  }

  const descLines = wrapDescription(desc, 42, 2);
  for (const dl of descLines) {
    if (dl.length * BODY_CHAR_W > textMax) {
      throw routingError("Description does not fit the ZPL text block", "LABEL_ZPL_OVERFLOW");
    }
  }

  const rows = [`Qty: ${qtyDisplay} ${uom}`, `ASN: ${asnNo}`, `RU: ${ruNo}`];
  for (const row of [partNo, ...rows]) {
    if (row.length * BODY_CHAR_W > textMax) {
      throw routingError(`Identifier line does not fit: ${row.slice(0, 48)}`, "LABEL_ZPL_OVERFLOW");
    }
  }

  const barH = 80;
  const barY = 250;
  const barX = Math.round((ZPL_WIDTH_DOTS - barWidthDots) / 2);
  return {
    variant: "ASN_RU",
    articleRaw,
    partNo,
    barcodeRaw,
    human: encoded.humanReadable || ruNo,
    companyName,
    descLines,
    rows,
    barX: Math.max(MARGIN + BAR_QUIET, barX),
    barY,
    barH,
    barWidthDots,
    code128Start: ">:",
    layoutVersion: ZPL_ASN_RU_LAYOUT_VERSION,
  };
}

function isAsnRuZplRequest(opts = {}) {
  return (
    String(opts.faceVariant || "").toUpperCase() === "ASN_RU" ||
    String(opts.barcodeMode || "").toUpperCase() === "LABEL_ID"
  );
}

function emitStandardFaceZpl(face) {
  const cmds = [
    "^XA",
    `^PW${ZPL_WIDTH_DOTS}`,
    `^LL${ZPL_HEIGHT_DOTS}`,
    "^LH0,0",
    "^LRN",
    "^CI0",
    `^FO20,12^A0N,24,24${fd(face.companyName)}`,
    `^FO20,40^A0N,48,48${fd(face.articleRaw)}`,
  ];
  let y = 90;
  if (face.partNo) {
    cmds.push(`^FO20,${y}^A0N,28,28${fd(face.partNo)}`);
    y += 28;
  }
  for (const dl of face.descLines) {
    cmds.push(`^FO20,${y}^A0N,${BODY_CHAR_H},${BODY_CHAR_H}${fd(dl)}`);
    y += 22;
  }
  y = Math.max(y, face.partNo ? 150 : 130);
  for (const row of face.rows) {
    cmds.push(`^FO20,${y}^A0N,${BODY_CHAR_H},${BODY_CHAR_H}${fd(row)}`);
    y += 20;
  }
  const start = face.code128Start || ">;";
  cmds.push(
    `^FO${face.barX},${face.barY}^BY${BAR_MODULE},3,${face.barH}^BCN,${face.barH},N,N,N^FH_^FD${start}${hexEscapeZplBarcodeData(face.barcodeRaw)}^FS`
  );
  cmds.push(`^FO${face.barX},${face.barY + face.barH + 8}^A0N,24,24${fd(face.human)}`);
  cmds.push("^PQ1,0,1,Y");
  cmds.push("^XZ");
  const payload = cmds.join("\r\n") + "\r\n";
  assertZplPayloadSafe(payload);
  return payload;
}

export function assertZplPayloadSafe(payload) {
  const s = String(payload || "");
  if (!/\^XA/.test(s) || !/\^XZ/.test(s)) {
    throw routingError("ZPL payload must contain ^XA / ^XZ", "LABEL_ZPL_INVALID");
  }
  if (looksLikeTsplPayload(s)) {
    throw routingError("ZPL payload must not contain TSPL commands", "LABEL_ZPL_INVALID");
  }
  if (/\bGAPDETECT\b/i.test(s) || /(?:^|\r?\n)\s*(CLS|HOME|PRINT\s+\d)\b/m.test(s)) {
    throw routingError("ZPL payload must not contain TSPL commands", "LABEL_ZPL_INVALID");
  }
  if (/~JC|\^JUS|\^MCY/i.test(s)) {
    throw routingError("ZPL payload must not include calibration or reset commands", "LABEL_ZPL_INVALID");
  }
  return true;
}

/**
 * One complete ZPL format for one physical 100×50 label (GRN Article or ASN RU identity).
 */
export function buildSingleLabelZpl(line = {}, opts = {}) {
  const face = isAsnRuZplRequest(opts) ? layoutAsnRuFace(line, opts) : layoutStandardGrnFace(line, opts);
  return emitStandardFaceZpl(face);
}

export function buildJobZpl(lines = [], opts = {}) {
  const copies = Math.max(1, Number(opts.copies) || 1);
  const parts = [];
  for (const line of lines) {
    const dist = Array.isArray(line.labelDistribution)
      ? line.labelDistribution.map((q) => Number(q)).filter((q) => Number.isFinite(q) && q > 0)
      : null;
    if (dist && dist.length > 0) {
      for (const faceQty of dist) {
        for (let c = 0; c < copies; c += 1) {
          parts.push(buildSingleLabelZpl(line, { ...opts, qtyPerLabel: faceQty }));
        }
      }
      continue;
    }
    const n = Math.max(0, Math.floor(Number(line.labelQty) || 0)) * copies;
    for (let i = 0; i < n; i += 1) {
      parts.push(buildSingleLabelZpl(line, { ...opts, qtyPerLabel: 1 }));
    }
  }
  const payload = parts.join("");
  if (payload) assertZplPayloadSafe(payload);
  return payload;
}

export function countZplFormats(payload) {
  return (String(payload || "").match(/\^XA/g) || []).length;
}

function layoutFaceSvg(face) {
  const canvas = zplCanvas(face.layoutVersion || ZPL_GRN_LAYOUT_VERSION);
  const texts = [
    { x: 20, y: 12 + 20, size: 16, text: face.companyName },
    { x: 20, y: 40 + 36, size: 28, text: face.articleRaw, weight: 700 },
  ];
  let y = 90 + 16;
  if (face.partNo) {
    texts.push({ x: 20, y, size: 16, text: face.partNo });
    y += 28;
  }
  for (const dl of face.descLines) {
    texts.push({ x: 20, y, size: 14, text: dl });
    y += 22;
  }
  y = Math.max(y, face.partNo ? 150 + 16 : 130 + 16);
  for (const row of face.rows) {
    texts.push({ x: 20, y, size: 14, text: row });
    y += 20;
  }
  const bar = {
    x: face.barX,
    y: face.barY,
    w: face.barWidthDots,
    h: face.barH,
  };
  texts.push({ x: face.barX, y: face.barY + face.barH + 22, size: 14, text: face.human });
  const textXml = texts
    .map(
      (el) =>
        `<text x="${el.x}" y="${el.y}" font-size="${el.size}" font-family="Arial, Helvetica, sans-serif" font-weight="${el.weight || 400}" fill="#111">${escapeXml(el.text)}</text>`
    )
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.widthMm}mm" height="${canvas.heightMm}mm" viewBox="0 0 ${canvas.widthDots} ${canvas.heightDots}">
<rect x="0" y="0" width="${canvas.widthDots}" height="${canvas.heightDots}" fill="#fff" stroke="#cbd5e1"/>
${textXml}
<rect x="${bar.x}" y="${bar.y}" width="${bar.w}" height="${bar.h}" fill="#111"/>
<text x="${bar.x}" y="${bar.y + bar.h / 2}" font-size="10" fill="#fff">${escapeXml("CODE128 " + face.barcodeRaw)}</text>
</svg>`;
  return {
    ok: true,
    svg,
    canvas,
    article: face.articleRaw,
    barcodeValue: face.barcodeRaw,
    ruNo: face.variant === "ASN_RU" ? face.barcodeRaw : undefined,
  };
}

export function layoutStandardGrnLabelSvg(line = {}, opts = {}) {
  return layoutFaceSvg(layoutStandardGrnFace(line, opts));
}

export function layoutAsnRuLabelSvg(line = {}, opts = {}) {
  return layoutFaceSvg(layoutAsnRuFace(line, { ...opts, faceVariant: "ASN_RU", barcodeMode: "LABEL_ID" }));
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildTestLabelZpl(info = {}, opts = {}) {
  const companyName = t(opts.companyName || info.title || "TEST LABEL");
  assertZplEncodable(companyName, "Test title");
  const now = info.when ? new Date(info.when) : new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = `${now.toISOString().slice(11, 19)}Z`;
  const agent = t(info.agentName || info.agentId || "-");
  const printer = t(info.printerName || info.windowsPrinterName || "-");
  const conn = t(info.connectionStatus || "OK");
  for (const [n, v] of [
    ["Date", dateStr],
    ["Time", timeStr],
    ["Agent", agent],
    ["Printer", printer],
    ["Connection", conn],
  ]) {
    assertZplEncodable(v, n);
  }
  const payload = [
    "^XA",
    `^PW${ZPL_WIDTH_DOTS}`,
    `^LL${ZPL_HEIGHT_DOTS}`,
    "^LH0,0",
    "^CI0",
    `^FO20,20^A0N,40,40${fd(companyName)}`,
    `^FO20,70^A0N,24,24${fd(`Date: ${dateStr}`)}`,
    `^FO20,100^A0N,24,24${fd(`Time: ${timeStr}`)}`,
    `^FO20,130^A0N,24,24${fd(`Agent: ${agent}`)}`,
    `^FO20,160^A0N,24,24${fd(`Printer: ${printer}`)}`,
    `^FO20,190^A0N,24,24${fd(`Connection: ${conn}`)}`,
    "^PQ1,0,1,Y",
    "^XZ",
    "",
  ].join("\r\n");
  assertZplPayloadSafe(payload);
  return payload;
}

export function buildStandardGrnPayload(lines, opts = {}) {
  const language = String(opts.language || LABEL_LANGUAGE_ZPL).toUpperCase();
  if (language !== LABEL_LANGUAGE_ZPL) {
    throw routingError("buildStandardGrnPayload is ZPL-only", "LABEL_ZPL_INVALID");
  }
  return buildJobZpl(lines, opts);
}
