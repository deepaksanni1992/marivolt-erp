/**
 * PACKING_QR_LANDSCAPE_150X100_V1 — Phase 1 shared geometry.
 * Design grid: 8 dots/mm. Physical SIZE 100 mm × 150 mm = 800 × 1200 dots.
 * Logical landscape (viewed): 1200 × 800. Safe content: 960 × 640.
 *
 * Boxes are half-open [x, x+w) × [y, y+h). Preview SVG viewBox is 0 0 1200 800.
 */
import QRCode from "qrcode";
import {
  TSPL_FONT0_CELL_DOTS,
  TSPL_FONT0_CELL_WIDTH_DOTS,
} from "./tsplGenerator.js";

export const PACKING_QR_LANDSCAPE_V1_CODE = "PACKING_QR_LANDSCAPE_150X100_V1";
export const PACKING_QR_LANDSCAPE_V1_NAME = "PACKING QR LANDSCAPE 100×150 V1";
export const PACKING_QR_LANDSCAPE_V1_UI_LABEL = "Packing QR Landscape 100×150 — Preview";
export const PACKING_QR_LANDSCAPE_V1_PRINT_HINT =
  "Landscape packing print requires a persisted label identity and an ACTIVE company signing key.";

export const DOTS_PER_MM = 8;
export const PHYSICAL_WIDTH_DOTS = 800;
export const PHYSICAL_HEIGHT_DOTS = 1200;
export const PHYSICAL_WIDTH_MM = 100;
export const PHYSICAL_HEIGHT_MM = 150;
export const PHYSICAL_MARGIN_LEFT = 80;
export const PHYSICAL_MARGIN_RIGHT = 80;
export const PHYSICAL_MARGIN_TOP = 120;
export const PHYSICAL_MARGIN_BOTTOM = 120;

export const PHYSICAL_SAFE = Object.freeze({
  x: 80,
  y: 120,
  w: 640,
  h: 960,
  x1: 720,
  y1: 1080,
});

export const LOGICAL_WIDTH_DOTS = 1200;
export const LOGICAL_HEIGHT_DOTS = 800;
export const LOGICAL_SAFE = Object.freeze({
  x: 120,
  y: 80,
  w: 960,
  h: 640,
  x1: 1080,
  y1: 720,
});

export const QR_ECC = "H";
/** Inclusive 30–35 mm budget for QR + 4-module quiet zone. */
export const QR_OUTER_MIN_DOTS = 240;
export const QR_OUTER_MAX_DOTS = 280;
export const QR_QUIET_MODULES = 4;
export const QR_PLACEHOLDER_MARK = "TEST/PREVIEW";
export const QR_TEST_CAPTION = "TEST QR — NOT VALID FOR PACKING";
export const QR_COLUMN_X = 778;

/** Table-style Phase 1 visual geometry. Outer path is inset 2 dots from the mandatory safe rectangle. */
export const PACKING_QR_LANDSCAPE_V1_TABLE = Object.freeze({
  x: 122,
  y: 82,
  w: 956,
  h: 636,
  x1: 1078,
  y1: 718,
  yHeader: 82,
  yRef: 166,
  yCommercial: 238,
  yMain: 310,
  yCustomer: 310,
  yArticle: 394,
  yDescription: 466,
  yPart: 550,
  yFooter: 622,
  yFooterQty: 650,
  yEnd: 718,
  xRefSplit: 440,
  xBrand: 440,
  xModel: 758,
  xQr: 778,
  captionColW: 152,
  bar: 2,
  pad: 8,
});

/** Compact versioned packing token. Analysis/spec only — HMAC is not implemented in Phase 1. */
export const MAR1_TOKEN_VERSION = "MAR1";
export const MAR1_HMAC_ALGORITHM = "HMAC-SHA256";
export const MAR1_SIGNATURE_BITS = 128;
export const MAR1_SIGNATURE_BYTES = 16;
export const MAR1_SIGNATURE_B64URL_CHARS = 22;
export const MAR1_LABEL_NO_TYPICAL = "MAR-PL-000001";
export const MAR1_LABEL_NO_MIN = "MAR-PL-0";
/** Maximum approved labelNo: MAR-PL- + 1–8 digits. */
export const MAR1_LABEL_NO_MAX = "MAR-PL-99999999";
export const MAR1_KEY_ID_TYPICAL = "K1";
export const MAR1_KEY_ID_MIN = "K0";
/** Maximum approved key id (K0…K99). */
export const MAR1_KEY_ID_MAX = "K99";
/** Rejected by spec: not ^K[0-9]{1,2}$. Kept as an overflow example only. */
export const MAR1_KEY_ID_YEAR_STYLE = "KEY2026A";
export const MAR1_LABEL_NO_PATTERN = /^MAR-PL-[0-9]{1,8}$/;
export const MAR1_KEY_ID_PATTERN = /^K[0-9]{1,2}$/;
export const MAR1_SIGNATURE_B64URL_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const MAR1_MAX_PAYLOAD_BYTES = 47;
export const MAR1_REQUIRED_QR_VERSION = 5;
export const MAR1_REQUIRED_MODULE_COUNT = 37;
export const MAR1_REQUIRED_CELL_DOTS = 6;
export const MAR1_REQUIRED_QUIET_MODULES = 4;
export const MAR1_REQUIRED_QUIET_DOTS = 24;
export const MAR1_REQUIRED_INNER_DOTS = 222;
export const MAR1_REQUIRED_OUTER_DOTS = 270;
export const LABEL_QR_PAYLOAD_OVERFLOW = "LABEL_QR_PAYLOAD_OVERFLOW";
/**
 * Structural Base64URL example only — not a valid HMAC.
 * Mixed case, hyphen and underscore match a real 16-byte Base64URL (no padding) signature.
 */
export const MAR1_SIGNATURE_B64URL_EXAMPLE = "xY7_k2LmN9pQrStUvWx-zA";

export const MAR1_PRODUCTION_QR_SPEC = Object.freeze({
  tokenForm: "MAR1.<labelNo>.<keyId>.<signatureBase64Url>",
  exampleStructure: "MAR1.MAR-PL-000001.K1.<22-character-signature>",
  labelNoPattern: "^MAR-PL-[0-9]{1,8}$",
  keyIdPattern: "^K[0-9]{1,2}$",
  signaturePattern: "^[A-Za-z0-9_-]{22}$",
  asciiOnly: true,
  maxPayloadBytes: MAR1_MAX_PAYLOAD_BYTES,
  qrVersion: MAR1_REQUIRED_QR_VERSION,
  ecc: QR_ECC,
  moduleCount: MAR1_REQUIRED_MODULE_COUNT,
  cellDots: MAR1_REQUIRED_CELL_DOTS,
  quietModules: MAR1_REQUIRED_QUIET_MODULES,
  quietDots: MAR1_REQUIRED_QUIET_DOTS,
  innerDots: MAR1_REQUIRED_INNER_DOTS,
  outerDots: MAR1_REQUIRED_OUTER_DOTS,
  overflowCode: LABEL_QR_PAYLOAD_OVERFLOW,
  doNotAdapt: [
    "do not generate Version 6",
    "do not reduce module size",
    "do not lower ECC",
    "do not truncate a field",
    "do not remove the quiet zone",
  ],
});

export const MAR1_CANONICAL_SIGNED_BYTES_SPEC = Object.freeze({
  description:
    "HMAC-SHA256 over an unambiguous length-prefixed UTF-8 envelope. Do not sign version+labelNo+keyId concatenated as a single string.",
  algorithm: MAR1_HMAC_ALGORITHM,
  truncate: "first 16 bytes (128 bits) of HMAC-SHA256, then Base64URL without padding (22 characters)",
  verify: "constant-time compare of the 16 raw signature bytes, not the Base64URL string",
  envelope: [
    "u8 formatTag = 0x01",
    "u16be(len(versionUtf8)) + versionUtf8  // 'MAR1'",
    "u16be(len(labelNoUtf8)) + labelNoUtf8",
    "u16be(len(keyIdUtf8)) + keyIdUtf8",
  ],
  notSigned: ["article", "customer", "quantity", "description", "partNo"],
  notInQr: ["article", "customer", "quantity"],
  doNotReduceBelowBits: 128,
});

/** TSPL BOX thickness. Conservative inset assumes stroke may grow fully outward. */
export const SAFE_FRAME_BOX_THICKNESS = 2;
export const SAFE_FRAME_INSET_DOTS = 2;

export const VESSEL_PLANT_SOURCE_STATUS =
  "MISSING: no dedicated vessel/plant field on allocation or packing. Do not use engine, ESN, config, model, or remarks. Phase 2: add additive vesselPlant snapshot on allocation and packing from a genuine sales/logistics vessel field.";

/** Canonical Phase 1 sample — not hardcoded onto production labels. */
export const SAMPLE_PACKING_QR_LANDSCAPE_V1_DATA = Object.freeze({
  customerName: "Mediterranean Shipping Company Cyprus",
  mvRef: "MAR-ALLOC-0001",
  customerPo: "PO-266564",
  vesselPlant: "",
  brand: "WARTSILA",
  modelName: "W34SG",
  article: "700004.28",
  description: "SET OF GASKETS FOR CYLINDER HEAD",
  partNo: "432108 AA",
  labelQty: 5,
  orderQty: 9,
  sequenceIndex: 1,
  sequenceTotal: 3,
});

const HEADER = Object.freeze({
  company: "MARIVOLT FZE",
  email: "sales@marivolt.co",
  web: "www.marivolt.co",
});

export function isPackingQrLandscapeV1(code) {
  return String(code || "").trim().toUpperCase() === PACKING_QR_LANDSCAPE_V1_CODE;
}

export function packingQrLandscapeV1Capabilities() {
  return {
    code: PACKING_QR_LANDSCAPE_V1_CODE,
    previewEnabled: true,
    printEnabled: false,
    requiresPersistentIdentity: true,
  };
}

export function packingQrLandscapeV1TemplateDocument() {
  return {
    companyId: null,
    code: PACKING_QR_LANDSCAPE_V1_CODE,
    name: PACKING_QR_LANDSCAPE_V1_NAME,
    widthMm: PHYSICAL_WIDTH_MM,
    heightMm: PHYSICAL_HEIGHT_MM,
    language: "TSPL",
    layoutVersion: 1,
    barcodeMode: "ARTICLE",
    isSystem: true,
    isActive: true,
    previewEnabled: true,
    printEnabled: false,
    requiresPersistentIdentity: true,
  };
}

let cachedTestQrModules = null;

export function qrIntegerGeometry(moduleCount, { minDots = QR_OUTER_MIN_DOTS, maxDots = QR_OUTER_MAX_DOTS } = {}) {
  const n = Math.max(1, Math.floor(Number(moduleCount) || 1));
  const totalMods = n + QR_QUIET_MODULES * 2;
  const cell = Math.max(1, Math.floor(maxDots / totalMods));
  const outer = totalMods * cell;
  return {
    moduleCount: n,
    quietModules: QR_QUIET_MODULES,
    cellDots: cell,
    innerDots: n * cell,
    quietDots: QR_QUIET_MODULES * cell,
    outerDots: outer,
    outerMm: outer / DOTS_PER_MM,
    innerMm: (n * cell) / DOTS_PER_MM,
    integerModules: true,
    withinBudget: outer >= minDots && outer <= maxDots,
  };
}

export function qrVersionFromModuleCount(moduleCount) {
  return 1 + (Number(moduleCount) - 21) / 4;
}

export function qrModulesFromPayload(payload, ecc = QR_ECC) {
  const qr = QRCode.create(String(payload), { errorCorrectionLevel: ecc });
  const size = qr.modules.size;
  const dark = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (qr.modules.get(x, y)) dark.push([x, y]);
    }
  }
  return {
    size,
    dark,
    payload: String(payload),
    ecc,
    validIdentity: false,
    version: Number(qr.version) || qrVersionFromModuleCount(size),
  };
}

export function buildMar1TokenExample(
  labelNo,
  keyId,
  signatureB64Url = MAR1_SIGNATURE_B64URL_EXAMPLE
) {
  return `${MAR1_TOKEN_VERSION}.${labelNo}.${keyId}.${signatureB64Url}`;
}

export function reservedMar1QrGeometry() {
  return {
    qrVersion: MAR1_REQUIRED_QR_VERSION,
    ecc: QR_ECC,
    moduleCount: MAR1_REQUIRED_MODULE_COUNT,
    quietModules: MAR1_REQUIRED_QUIET_MODULES,
    cellDots: MAR1_REQUIRED_CELL_DOTS,
    innerDots: MAR1_REQUIRED_INNER_DOTS,
    quietDots: MAR1_REQUIRED_QUIET_DOTS,
    outerDots: MAR1_REQUIRED_OUTER_DOTS,
    outerMm: MAR1_REQUIRED_OUTER_DOTS / DOTS_PER_MM,
    innerMm: MAR1_REQUIRED_INNER_DOTS / DOTS_PER_MM,
    integerModules: true,
    withinBudget: true,
  };
}

function isAsciiOnly(value) {
  const s = String(value ?? "");
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 127) return false;
  }
  return true;
}

function mar1Overflow(field, message) {
  return { code: LABEL_QR_PAYLOAD_OVERFLOW, field, message };
}

export function hasMar1ProductionQrInput(data = {}) {
  return Boolean(
    String(data.mar1QrToken ?? "").trim() ||
      String(data.mar1LabelNo ?? "").trim() ||
      String(data.mar1KeyId ?? "").trim() ||
      String(data.mar1Signature ?? "").trim()
  );
}

/**
 * Phase 1 specification/validation only.
 * Does not generate HMAC signatures or permanent label numbers.
 * Overflow is blocking: never Version 6, smaller modules, lower ECC, truncation, or omitted quiet zone.
 */
export function validateMar1ProductionQrToken(input = {}) {
  const errors = [];
  const src = typeof input === "string" ? { token: input } : input || {};
  let token = String(src.token ?? src.mar1QrToken ?? "").trim();
  let labelNo = String(src.labelNo ?? src.mar1LabelNo ?? "").trim();
  let keyId = String(src.keyId ?? src.mar1KeyId ?? "").trim();
  let signature = String(src.signature ?? src.mar1Signature ?? "").trim();

  if (!token && (labelNo || keyId || signature)) {
    token = buildMar1TokenExample(labelNo, keyId, signature);
  }

  if (!token) {
    errors.push(mar1Overflow("token", "Production QR token is required for capacity validation."));
    return {
      ok: false,
      present: true,
      token: null,
      labelNo: labelNo || null,
      keyId: keyId || null,
      signature: signature || null,
      payloadBytes: 0,
      payloadChars: 0,
      measured: null,
      reserved: reservedMar1QrGeometry(),
      adapted: false,
      errors,
      errorCodes: [LABEL_QR_PAYLOAD_OVERFLOW],
    };
  }

  const payloadBytes = Buffer.byteLength(token, "utf8");
  const payloadChars = token.length;

  if (!isAsciiOnly(token)) {
    errors.push(mar1Overflow("token", "Production QR payload must be ASCII only."));
  }
  if (payloadBytes > MAR1_MAX_PAYLOAD_BYTES) {
    errors.push(
      mar1Overflow(
        "token",
        `Production QR payload is ${payloadBytes} bytes; maximum approved capacity is ${MAR1_MAX_PAYLOAD_BYTES} bytes.`
      )
    );
  }

  const parts = token.split(".");
  if (parts.length !== 4) {
    errors.push(
      mar1Overflow("token", "Production QR token must be MAR1.<labelNo>.<keyId>.<signatureBase64Url>.")
    );
  } else {
    const [version, parsedLabelNo, parsedKeyId, parsedSignature] = parts;
    if (!labelNo) labelNo = parsedLabelNo;
    if (!keyId) keyId = parsedKeyId;
    if (!signature) signature = parsedSignature;
    if (version !== MAR1_TOKEN_VERSION) {
      errors.push(mar1Overflow("version", `QR token version must be ${MAR1_TOKEN_VERSION}.`));
    }
  }

  if (!MAR1_LABEL_NO_PATTERN.test(labelNo)) {
    errors.push(mar1Overflow("labelNo", "labelNo must match ^MAR-PL-[0-9]{1,8}$."));
  }
  if (!MAR1_KEY_ID_PATTERN.test(keyId)) {
    errors.push(mar1Overflow("keyId", "keyId must match ^K[0-9]{1,2}$."));
  }
  if (/=/.test(signature)) {
    errors.push(mar1Overflow("signature", "signature must be Base64URL without padding."));
  } else if (!MAR1_SIGNATURE_B64URL_PATTERN.test(signature)) {
    errors.push(
      mar1Overflow("signature", "signature must be exactly 22 Base64URL characters without padding.")
    );
  }

  let measured = null;
  if (errors.length === 0) {
    measured = qrModulesFromPayload(token, QR_ECC);
    if (
      measured.version > MAR1_REQUIRED_QR_VERSION ||
      measured.size > MAR1_REQUIRED_MODULE_COUNT
    ) {
      errors.push(
        mar1Overflow(
          "token",
          "Payload requires QR capacity beyond Version 5 ECC H (37 modules). Do not adapt Version, cell size, ECC, or quiet zone."
        )
      );
      measured = { ...measured, rejectedCapacity: true };
    }
  }

  return {
    ok: errors.length === 0,
    present: true,
    token,
    labelNo: labelNo || null,
    keyId: keyId || null,
    signature: signature || null,
    payloadBytes,
    payloadChars,
    measured,
    reserved: reservedMar1QrGeometry(),
    adapted: false,
    errors,
    errorCodes: [...new Set(errors.map((e) => e.code))],
  };
}

function measureMar1Payload(payload, role) {
  const modules = qrModulesFromPayload(payload, QR_ECC);
  const geometry = qrIntegerGeometry(modules.size);
  const nextCell = geometry.cellDots + 1;
  const totalMods = modules.size + QR_QUIET_MODULES * 2;
  return {
    role,
    payload,
    payloadChars: payload.length,
    payloadBytes: Buffer.byteLength(payload, "utf8"),
    qrVersion: modules.version,
    moduleCount: modules.size,
    ...geometry,
    nextIntegerCellDots: nextCell,
    nextIntegerOuterDots: totalMods * nextCell,
    nextIntegerExceedsBudget: totalMods * nextCell > QR_OUTER_MAX_DOTS,
  };
}

let cachedMar1Analysis = null;

/**
 * Production QR capacity for the compact MAR1 token.
 * The Phase 1 TEST/PREVIEW symbol is Version 2 and must not size the reserved box.
 */
export function analyzeMar1HmacQrGeometry() {
  if (cachedMar1Analysis) return cachedMar1Analysis;
  const typical = measureMar1Payload(
    buildMar1TokenExample(MAR1_LABEL_NO_TYPICAL, MAR1_KEY_ID_TYPICAL),
    "typical"
  );
  const longest = measureMar1Payload(
    buildMar1TokenExample(MAR1_LABEL_NO_MAX, MAR1_KEY_ID_MAX),
    "longestRealistic"
  );
  const yearKey = measureMar1Payload(
    buildMar1TokenExample(MAR1_LABEL_NO_MAX, MAR1_KEY_ID_YEAR_STYLE),
    "yearStyleKeyId"
  );
  const version6 = measureMar1Payload(
    buildMar1TokenExample(MAR1_LABEL_NO_MAX, "KEY2026AB"),
    "version6Threshold"
  );
  const testPreview = measureMar1Payload(QR_PLACEHOLDER_MARK, "phase1TestPreview");
  const rightW = LOGICAL_SAFE.x1 - QR_COLUMN_X;
  const locked = reservedMar1QrGeometry();
  cachedMar1Analysis = {
    spec: {
      ...MAR1_PRODUCTION_QR_SPEC,
      ...MAR1_CANONICAL_SIGNED_BYTES_SPEC,
    },
    typical,
    longestRealistic: longest,
    yearStyleKeyId: {
      ...yearKey,
      rejectedBySpec: true,
      note: "KEY2026A is outside ^K[0-9]{1,2}$ and must return LABEL_QR_PAYLOAD_OVERFLOW. Do not size the reserved box from this payload.",
    },
    version6Threshold: {
      ...version6,
      rejectedBySpec: true,
      note: "53-byte / Version 6 payloads are outside approved capacity. Return LABEL_QR_PAYLOAD_OVERFLOW; do not generate Version 6.",
    },
    phase1TestPreview: {
      ...testPreview,
      note: "TEST/PREVIEW is Version 2 (25 modules). It is not the production payload and must not size the reserved box.",
    },
    reserved: {
      sizedFrom: "MAR1_PRODUCTION_QR_SPEC",
      payloadChars: MAR1_MAX_PAYLOAD_BYTES,
      payloadBytes: MAR1_MAX_PAYLOAD_BYTES,
      qrVersion: locked.qrVersion,
      moduleCount: locked.moduleCount,
      ecc: locked.ecc,
      cellDots: locked.cellDots,
      quietModules: locked.quietModules,
      quietDots: locked.quietDots,
      innerDots: locked.innerDots,
      outerDots: locked.outerDots,
      innerMm: locked.innerMm,
      outerMm: locked.outerMm,
      withinBudget: locked.withinBudget,
      nextIntegerExceedsBudget: true,
      boxProof: {
        rightColumnDots: rightW,
        outerFitsColumn: locked.outerDots <= rightW,
        horizontalSlackDots: rightW - locked.outerDots,
        minDots: QR_OUTER_MIN_DOTS,
        maxDots: QR_OUTER_MAX_DOTS,
        mmBudget: [QR_OUTER_MIN_DOTS / DOTS_PER_MM, QR_OUTER_MAX_DOTS / DOTS_PER_MM],
      },
    },
    tsplQrcode: {
      command: 'QRCODE x,y,ECC,cellWidth,mode,rotation,"data"',
      includesQuietZone: false,
      quietZoneParameter: null,
      cellWidthRange: [1, 10],
      origin: "upper-left of the QR symbol (finder patterns). TSPL does not add a 4-module quiet zone.",
      layoutPolicy:
        "Reserve a 4-module quiet zone in layout. Phase 2 must place QRCODE at the inner-module origin with cellWidth = cellDots. Do not offset by another 4 modules, and do not omit the reserved quiet.",
      phase1: "No QRCODE command is emitted. Preview draws modules in SVG only.",
    },
    dpi203: {
      dotsPerMm: DOTS_PER_MM,
      dpi: DOTS_PER_MM * 25.4,
      moduleMm: locked.cellDots / DOTS_PER_MM,
      quietMm: locked.quietDots / DOTS_PER_MM,
      scanability:
        "A 6-dot module at 8 dots/mm is 0.75 mm (6 printer dots at 203 DPI). Handheld scanners typically need ≥0.4 mm modules; 0.75 mm with a 3.00 mm (4-module) quiet zone is expected to scan reliably at ECC H.",
    },
  };
  return cachedMar1Analysis;
}

/** Visual TEST/PREVIEW QR only — not a valid ERP scan identity. Does not size the reserved box. */
export function buildTestQrModules() {
  if (cachedTestQrModules) return cachedTestQrModules;
  cachedTestQrModules = qrModulesFromPayload(QR_PLACEHOLDER_MARK, QR_ECC);
  return cachedTestQrModules;
}

export function assertPackingQrLandscapeV1Printable(templateCode) {
  if (!isPackingQrLandscapeV1(templateCode)) return { ok: true };
  const e = new Error(PACKING_QR_LANDSCAPE_V1_PRINT_HINT);
  e.statusCode = 409;
  e.code = "LABEL_IDENTITY_REQUIRED";
  throw e;
}

export function logicalToPhysicalPoint(xLogical, yLogical) {
  return {
    x: PHYSICAL_WIDTH_DOTS - yLogical,
    y: xLogical,
  };
}

export function logicalBoxToPhysical(b) {
  const x = Number(b.x);
  const y = Number(b.y);
  const w = Number(b.w);
  const h = Number(b.h);
  const c = [
    logicalToPhysicalPoint(x, y),
    logicalToPhysicalPoint(x + w, y),
    logicalToPhysicalPoint(x, y + h),
    logicalToPhysicalPoint(x + w, y + h),
  ];
  const xs = c.map((p) => p.x);
  const ys = c.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, x1: maxX, y1: maxY, corners: c };
}

export function glyphSize(xMul = 1, yMul = 1) {
  const xm = Math.max(1, Math.floor(Number(xMul) || 1));
  const ym = Math.max(1, Math.floor(Number(yMul) || 1));
  return {
    xMul: xm,
    yMul: ym,
    charW: TSPL_FONT0_CELL_WIDTH_DOTS * xm,
    charH: TSPL_FONT0_CELL_DOTS * ym,
  };
}

function t(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function box(x, y, w, h) {
  return { x, y, w, h, x1: x + w, y1: y + h };
}

function boxesOverlap(a, b) {
  return a.x < b.x1 && a.x1 > b.x && a.y < b.y1 && a.y1 > b.y;
}

function boxContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}

function insideLogicalSafe(b) {
  return b.x >= LOGICAL_SAFE.x && b.x1 <= LOGICAL_SAFE.x1 && b.y >= LOGICAL_SAFE.y && b.y1 <= LOGICAL_SAFE.y1;
}

function insidePhysicalSafe(b) {
  return b.x >= PHYSICAL_SAFE.x && b.x1 <= PHYSICAL_SAFE.x1 && b.y >= PHYSICAL_SAFE.y && b.y1 <= PHYSICAL_SAFE.y1;
}

export function wrapWordsExact(text, maxCharsPerLine) {
  const raw = t(text);
  const max = Math.max(1, Math.floor(Number(maxCharsPerLine) || 1));
  if (!raw) return { lines: [], overflow: false };
  const words = raw.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (w.length > max) {
      return { lines: cur ? [...lines, cur, w] : [...lines, w], overflow: true, overflowWord: w };
    }
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= max) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return { lines, overflow: false };
}

export function fitBlockingText({
  text,
  maxWidthDots,
  maxHeightDots,
  maxLines,
  preferredXMul = 1,
  minXMul = 1,
  yMul = 1,
} = {}) {
  const raw = t(text);
  const maxW = Math.max(0, Math.floor(Number(maxWidthDots) || 0));
  const maxH = Math.max(0, Math.floor(Number(maxHeightDots) || 0));
  const maxL = Math.max(1, Math.floor(Number(maxLines) || 1));
  const minX = Math.max(1, Math.floor(Number(minXMul) || 1));
  let xMul = Math.max(minX, Math.floor(Number(preferredXMul) || 1));
  const ym = Math.max(1, Math.floor(Number(yMul) || 1));
  if (!raw) {
    const g = glyphSize(xMul, ym);
    return { ok: true, text: "", lines: [], xMul, yMul: ym, charW: g.charW, charH: g.charH, overflow: false };
  }
  while (xMul >= minX) {
    const g = glyphSize(xMul, ym);
    const maxChars = Math.max(1, Math.floor(maxW / g.charW));
    const wrapped = wrapWordsExact(raw, maxChars);
    const fitsLines = wrapped.lines.length <= maxL && !wrapped.overflow;
    const fitsHeight = wrapped.lines.length * g.charH <= maxH;
    const complete = wrapped.lines.join(" ") === raw;
    if (fitsLines && fitsHeight && complete) {
      return { ok: true, text: raw, lines: wrapped.lines, xMul, yMul: ym, charW: g.charW, charH: g.charH, overflow: false };
    }
    if (xMul === minX) {
      return { ok: false, text: raw, lines: wrapped.lines, xMul, yMul: ym, charW: g.charW, charH: g.charH, overflow: true };
    }
    xMul -= 1;
  }
  const g = glyphSize(minX, ym);
  return { ok: false, text: raw, lines: [], xMul: minX, yMul: ym, charW: g.charW, charH: g.charH, overflow: true };
}

function pushError(errors, code, message) {
  errors.push({ code, message });
}

function addPrimitive(primitives, p) {
  const logical = box(p.x, p.y, p.w, p.h);
  primitives.push({
    ...p,
    logical,
    physical: logicalBoxToPhysical(logical),
    rotationLogical: 0,
    rotationPhysicalCw: 90,
  });
  return primitives[primitives.length - 1];
}

export function layoutPackingQrLandscapeV1(data = {}) {
  const errors = [];
  const primitives = [];
  const notes = [];

  const customerName = t(data.customerName);
  const mvRef = t(data.mvRef);
  const customerPo = t(data.customerPo);
  const vesselPlant = t(data.vesselPlant);
  const brand = t(data.brand);
  const modelName = t(data.modelName);
  const article = t(data.article).toUpperCase();
  const description = t(data.description);
  const partNo = t(data.partNo);
  const labelQty = String(Math.max(0, Math.floor(Number(data.labelQty) || 0)));
  const orderQty = String(Math.max(0, Math.floor(Number(data.orderQty ?? data.totalQty) || 0)));
  const seqIndex = Math.max(1, Math.floor(Number(data.sequenceIndex) || 1));
  const seqTotal = Math.max(seqIndex, Math.floor(Number(data.sequenceTotal) || 1));
  const sequence = `${seqIndex} of ${seqTotal}`;
  if (!vesselPlant) notes.push(VESSEL_PLANT_SOURCE_STATUS);

  const T = PACKING_QR_LANDSCAPE_V1_TABLE;
  const L = LOGICAL_SAFE;
  const frame = box(T.x, T.y, T.w, T.h);
  const previewLabelId = t(data.previewLabelId);
  const persistedLabelNo = t(data.labelNo);
  const labelIdDisplay = persistedLabelNo || previewLabelId || "PREVIEW";
  const qrCell = box(T.xQr, T.yMain, T.x1 - T.xQr, T.yFooter - T.yMain);
  const rightW = qrCell.w;

  function addBar(id, x, y, w, h) {
    addPrimitive(primitives, { id, type: "bar", field: "GRID", x, y, w, h });
  }

  function addText({
    id,
    field,
    value,
    x,
    y,
    xMul = 1,
    yMul = 1,
    align = "left",
    cell = null,
    line = 0,
    maxLines = 1,
    note = "",
  }) {
    const raw = String(value ?? "");
    const g = glyphSize(xMul, yMul);
    const w = raw.length * g.charW;
    const h = g.charH;
    let tx = x;
    if (align === "center" && cell) tx = cell.x + Math.floor((cell.w - w) / 2);
    addPrimitive(primitives, {
      id,
      type: "text",
      field,
      value: raw,
      x: tx,
      y,
      w,
      h,
      font: "0",
      xMul: g.xMul,
      yMul: g.yMul,
      lines: [raw],
      line,
      lineSpacing: g.charH,
      maxLines,
      align,
      note,
    });
  }

  addPrimitive(primitives, {
    id: "outer-box",
    type: "box",
    field: "SAFE_FRAME",
    x: frame.x,
    y: frame.y,
    w: frame.w,
    h: frame.h,
    thickness: SAFE_FRAME_BOX_THICKNESS,
    note: "TSPL BOX path inset by thickness so a fully outward 2-dot stroke stays inside the mandatory safe rectangle.",
  });
  addBar("row-ref", T.x, T.yRef, T.w, T.bar);
  addBar("row-commercial", T.x, T.yCommercial, T.w, T.bar);
  addBar("row-main", T.x, T.yMain, T.w, T.bar);
  addBar("row-article", T.x, T.yArticle, T.xQr - T.x, T.bar);
  addBar("row-description", T.x, T.yDescription, T.xQr - T.x, T.bar);
  addBar("row-part", T.x, T.yPart, T.xQr - T.x, T.bar);
  addBar("row-footer", T.x, T.yFooter, T.w, T.bar);
  addBar("row-footer-qty", T.x, T.yFooterQty, T.w, T.bar);
  addBar("col-ref-split", T.xRefSplit, T.yRef, T.bar, T.yCommercial - T.yRef);
  addBar("col-brand", T.xBrand, T.yCommercial, T.bar, T.yMain - T.yCommercial);
  addBar("col-model", T.xModel, T.yCommercial, T.bar, T.yMain - T.yCommercial);
  addBar("col-qr", T.xQr, T.yMain, T.bar, T.yFooter - T.yMain);
  addBar("col-footer-mid", T.xBrand, T.yFooterQty, T.bar, T.yEnd - T.yFooterQty);
  addBar("col-footer-right", T.xModel, T.yFooterQty, T.bar, T.yEnd - T.yFooterQty);

  const mar1Qr = analyzeMar1HmacQrGeometry();
  const testQr = buildTestQrModules();
  const qrGeo = reservedMar1QrGeometry();
  if (
    qrGeo.qrVersion !== MAR1_REQUIRED_QR_VERSION ||
    qrGeo.ecc !== QR_ECC ||
    qrGeo.moduleCount !== MAR1_REQUIRED_MODULE_COUNT ||
    qrGeo.cellDots !== MAR1_REQUIRED_CELL_DOTS ||
    qrGeo.quietDots !== MAR1_REQUIRED_QUIET_DOTS ||
    qrGeo.outerDots !== MAR1_REQUIRED_OUTER_DOTS
  ) {
    pushError(
      errors,
      LABEL_QR_PAYLOAD_OVERFLOW,
      "Reserved QR capacity must stay Version 5 ECC H, 37 modules, 6 dots/module, 4-module quiet, 270×270 dots."
    );
  }
  let productionQr = { present: false, ok: true, token: null, errors: [], adapted: false };
  if (hasMar1ProductionQrInput(data)) {
    productionQr = validateMar1ProductionQrToken({
      token: data.mar1QrToken,
      labelNo: data.mar1LabelNo,
      keyId: data.mar1KeyId,
      signature: data.mar1Signature,
    });
    for (const e of productionQr.errors || []) {
      pushError(errors, e.code, e.message);
    }
  }
  const useProductionQr = Boolean(productionQr.present && productionQr.ok && productionQr.token);
  const productionModules = useProductionQr
    ? qrModulesFromPayload(productionQr.token, QR_ECC)
    : null;
  if (
    useProductionQr &&
    (productionModules.size !== MAR1_REQUIRED_MODULE_COUNT ||
      productionModules.version !== MAR1_REQUIRED_QR_VERSION)
  ) {
    pushError(
      errors,
      LABEL_QR_PAYLOAD_OVERFLOW,
      "Production QR must encode as Version 5 ECC H (37 modules). Do not use Version 6."
    );
  }
  const renderedModules = useProductionQr && productionModules ? productionModules : testQr;
  const qrX = qrCell.x + Math.floor((qrCell.w - qrGeo.outerDots) / 2);
  const qrY = qrCell.y + Math.floor((qrCell.h - qrGeo.outerDots) / 2);
  const qrInner = box(qrX + qrGeo.quietDots, qrY + qrGeo.quietDots, qrGeo.innerDots, qrGeo.innerDots);
  const renderedDots = renderedModules.size * qrGeo.cellDots;
  const renderOff = useProductionQr ? 0 : Math.floor((qrGeo.innerDots - renderedDots) / 2);
  const qrRendered = box(qrInner.x + renderOff, qrInner.y + renderOff, renderedDots, renderedDots);
  addPrimitive(primitives, {
    id: "qr-quiet",
    type: "qr-quiet",
    field: "QR_QUIET",
    x: qrX,
    y: qrY,
    w: qrGeo.outerDots,
    h: qrGeo.outerDots,
    ecc: QR_ECC,
    placeholder: !useProductionQr,
    mark: useProductionQr ? productionQr.token : QR_PLACEHOLDER_MARK,
    cellDots: qrGeo.cellDots,
    note: "Explicit 4-module quiet zone. TSPL QRCODE does not include quiet zone; QRCODE is placed at qr-inner origin.",
  });
  addPrimitive(primitives, {
    id: "qr-inner",
    type: "qr-placeholder",
    field: "QR",
    x: qrInner.x,
    y: qrInner.y,
    w: qrInner.w,
    h: qrInner.h,
    ecc: QR_ECC,
    placeholder: !useProductionQr,
    mark: useProductionQr ? productionQr.token : QR_PLACEHOLDER_MARK,
    identity: useProductionQr ? t(data.labelNo) : null,
    cellDots: qrGeo.cellDots,
    note: "Reserved production inner (Version 5 / 37 modules). Pre-mint TEST/PREVIEW is smaller and centered inside this box.",
  });
  addPrimitive(primitives, {
    id: "qr-rendered",
    type: "qr-modules",
    field: useProductionQr ? "QR_MODULES" : "QR_TEST_MODULES",
    x: qrRendered.x,
    y: qrRendered.y,
    w: qrRendered.w,
    h: qrRendered.h,
    ecc: QR_ECC,
    placeholder: !useProductionQr,
    mark: useProductionQr ? productionQr.token : QR_PLACEHOLDER_MARK,
    identity: useProductionQr ? t(data.labelNo) : null,
    cellDots: qrGeo.cellDots,
    moduleCount: renderedModules.size,
  });

  function cellBox(x, y, x1, y1) {
    return box(x, y, x1 - x, y1 - y);
  }

  function placeFitLines(id, field, fit, area, { align = "left", overflowCode, caption, required = true } = {}) {
    const lines = fit.lines || [];
    const lineH = fit.charH || 24;
    let ty = area.y;
    if (align === "center" && lines.length) {
      const blockH = lines.length * lineH;
      ty = area.y + Math.max(0, Math.floor((area.h - blockH) / 2));
    }
    lines.forEach((ln, i) => {
      const lineW = String(ln).length * (fit.charW || 12);
      let lx = area.x;
      if (align === "center") lx = area.x + Math.max(0, Math.floor((area.w - lineW) / 2));
      addText({
        id: `${id}-line-${i}`,
        field,
        value: ln,
        x: lx,
        y: ty,
        xMul: fit.xMul,
        yMul: fit.yMul,
        line: i,
        maxLines: lines.length,
      });
      ty += lineH;
    });
    if (required && !fit.ok) {
      pushError(errors, overflowCode, `${caption} cannot fit without truncation.`);
    }
    return fit;
  }

  function placeStackedCell(cell, opts) {
    addText({
      id: `${opts.id}-label`,
      field: `${opts.field}_LABEL`,
      value: opts.caption,
      x: cell.x + T.pad,
      y: cell.y + 4,
      xMul: 1,
      yMul: 1,
    });
    const valueArea = box(cell.x + T.pad, cell.y + 28, cell.w - T.pad * 2, Math.max(24, cell.h - 34));
    const fit = fitBlockingText({
      text: opts.value,
      maxWidthDots: opts.maxWidthDots || valueArea.w,
      maxHeightDots: valueArea.h,
      maxLines: opts.maxLines,
      preferredXMul: opts.preferredXMul,
      minXMul: opts.minXMul,
      yMul: opts.yMul || 1,
    });
    return placeFitLines(opts.id, opts.field, fit, valueArea, {
      align: opts.align || "center",
      overflowCode: opts.overflowCode,
      caption: opts.caption,
      required: Boolean(opts.value) || opts.required === true,
    });
  }

  function placeSideCaptionCell(cell, opts) {
    addText({
      id: `${opts.id}-label`,
      field: `${opts.field}_LABEL`,
      value: opts.caption,
      x: cell.x + T.pad,
      y: cell.y + 6,
      xMul: 1,
      yMul: 1,
    });
    const valueX = cell.x + T.pad + T.captionColW;
    const valueArea = box(valueX, cell.y + 6, cell.x1 - T.pad - valueX, cell.h - 12);
    const fit = fitBlockingText({
      text: opts.value,
      maxWidthDots: opts.maxWidthDots || valueArea.w,
      maxHeightDots: valueArea.h,
      maxLines: opts.maxLines,
      preferredXMul: opts.preferredXMul,
      minXMul: opts.minXMul,
      yMul: opts.yMul || 1,
    });
    return placeFitLines(opts.id, opts.field, fit, valueArea, {
      align: opts.align || "left",
      overflowCode: opts.overflowCode,
      caption: opts.caption,
      required: Boolean(opts.value) || opts.required === true,
    });
  }

  const headerCell = cellBox(T.x, T.yHeader, T.x1, T.yRef);
  addText({
    id: "header-company",
    field: "HEADER",
    value: HEADER.company,
    x: 0,
    y: headerCell.y + 8,
    xMul: 2,
    yMul: 2,
    align: "center",
    cell: headerCell,
  });
  const emailW = HEADER.email.length * 12;
  const webW = HEADER.web.length * 12;
  const contactGap = 32;
  const contactGroupW = emailW + contactGap + webW;
  const contactX = headerCell.x + Math.floor((headerCell.w - contactGroupW) / 2);
  const contactY = headerCell.y + 8 + 48 + 4;
  addText({ id: "header-email", field: "HEADER", value: HEADER.email, x: contactX, y: contactY, xMul: 1, yMul: 1 });
  addText({
    id: "header-web",
    field: "HEADER",
    value: HEADER.web,
    x: contactX + emailW + contactGap,
    y: contactY,
    xMul: 1,
    yMul: 1,
  });

  placeStackedCell(cellBox(T.x, T.yRef, T.xRefSplit, T.yCommercial), {
    id: "mv-ref",
    caption: "MV Ref No.",
    field: "MV_REF",
    value: mvRef,
    maxLines: 1,
    preferredXMul: 2,
    minXMul: 1,
    yMul: 1,
    overflowCode: "LABEL_REFERENCE_OVERFLOW",
  });
  placeSideCaptionCell(cellBox(T.xRefSplit, T.yRef, T.x1, T.yCommercial), {
    id: "vessel-plant",
    caption: "Vessel/Plant",
    field: "VESSEL_PLANT",
    value: vesselPlant,
    maxLines: 2,
    preferredXMul: 2,
    minXMul: 1,
    yMul: 1,
    overflowCode: "LABEL_REFERENCE_OVERFLOW",
    required: false,
  });

  placeStackedCell(cellBox(T.x, T.yCommercial, T.xBrand, T.yMain), {
    id: "customer-po",
    caption: "Customer PO",
    field: "CUSTOMER_PO",
    value: customerPo,
    maxLines: 1,
    preferredXMul: 2,
    minXMul: 1,
    overflowCode: "LABEL_REFERENCE_OVERFLOW",
  });
  placeStackedCell(cellBox(T.xBrand, T.yCommercial, T.xModel, T.yMain), {
    id: "brand",
    caption: "Brand",
    field: "BRAND",
    value: brand,
    maxLines: 1,
    preferredXMul: 2,
    minXMul: 1,
    overflowCode: "LABEL_REFERENCE_OVERFLOW",
  });
  placeStackedCell(cellBox(T.xModel, T.yCommercial, T.x1, T.yMain), {
    id: "model",
    caption: "Model",
    field: "MODEL",
    value: modelName,
    maxLines: 1,
    preferredXMul: 2,
    minXMul: 1,
    overflowCode: "LABEL_REFERENCE_OVERFLOW",
  });

  const customerCell = cellBox(T.x, T.yCustomer, T.xQr, T.yArticle);
  let customerUsed = fitBlockingText({
    text: customerName,
    maxWidthDots: Math.min(480, customerCell.w - T.pad * 2 - T.captionColW),
    maxHeightDots: customerCell.h - 12,
    maxLines: 3,
    preferredXMul: 2,
    minXMul: 1,
    yMul: 1,
  });
  if (customerName && (!customerUsed.ok || (customerUsed.lines || []).length > 3)) {
    customerUsed = fitBlockingText({
      text: customerName,
      maxWidthDots: Math.min(480, customerCell.w - T.pad * 2 - T.captionColW),
      maxHeightDots: customerCell.h - 12,
      maxLines: 3,
      preferredXMul: 1,
      minXMul: 1,
      yMul: 1,
    });
  }
  addText({
    id: "customer-label",
    field: "CUSTOMER_LABEL",
    value: "Customer",
    x: customerCell.x + T.pad,
    y: customerCell.y + 6,
    xMul: 1,
    yMul: 1,
  });
  placeFitLines(
    "customer",
    "CUSTOMER",
    customerName ? customerUsed : { ok: true, lines: ["—"], xMul: 1, yMul: 1, charW: 12, charH: 24 },
    box(
      customerCell.x + T.pad + T.captionColW,
      customerCell.y + 6,
      customerCell.x1 - T.pad - (customerCell.x + T.pad + T.captionColW),
      customerCell.h - 12
    ),
    { overflowCode: "LABEL_CUSTOMER_OVERFLOW", caption: "Customer", required: Boolean(customerName) }
  );

  if (!article) {
    pushError(errors, "LABEL_ARTICLE_OVERFLOW", "Article is required and cannot be omitted.");
  }
  const articleFit = placeSideCaptionCell(cellBox(T.x, T.yArticle, T.xQr, T.yDescription), {
    id: "article",
    caption: "Article",
    field: "ARTICLE",
    value: article,
    maxLines: 1,
    preferredXMul: 3,
    minXMul: 1,
    yMul: 2,
    overflowCode: "LABEL_ARTICLE_OVERFLOW",
    required: true,
  });

  placeSideCaptionCell(cellBox(T.x, T.yDescription, T.xQr, T.yPart), {
    id: "description",
    caption: "Description",
    field: "DESCRIPTION",
    value: description,
    maxLines: 3,
    preferredXMul: 1,
    minXMul: 1,
    yMul: 1,
    overflowCode: "LABEL_DESCRIPTION_OVERFLOW",
  });
  placeSideCaptionCell(cellBox(T.x, T.yPart, T.xQr, T.yFooter), {
    id: "part-no",
    caption: "Part No.",
    field: "PART_NO",
    value: partNo,
    maxLines: 1,
    preferredXMul: 2,
    minXMul: 1,
    yMul: 1,
    overflowCode: "LABEL_PART_NO_OVERFLOW",
  });

  addText({
    id: "label-id-caption",
    field: "LABEL_ID_CAPTION",
    value: "Label ID",
    x: T.x + T.pad,
    y: T.yFooter + 4,
    xMul: 1,
    yMul: 1,
  });
  addText({
    id: "label-id-value-0",
    field: "LABEL_ID",
    value: labelIdDisplay,
    x: T.x + T.pad + "Label ID".length * 12 + 12,
    y: T.yFooter + 4,
    xMul: 1,
    yMul: 1,
    note: persistedLabelNo
      ? "Persisted PackingLabelUnit labelNo."
      : "PREVIEW marker. Not a persisted PackingLabelUnit or scan identity.",
  });
  if (!useProductionQr) {
    const captionFit = fitBlockingText({
      text: QR_TEST_CAPTION,
      maxWidthDots: 560,
      maxHeightDots: 24,
      maxLines: 1,
      preferredXMul: 1,
      minXMul: 1,
      yMul: 1,
    });
    const capLine = (captionFit.lines && captionFit.lines[0]) || QR_TEST_CAPTION;
    const capW = capLine.length * 12;
    addText({
      id: "qr-test-caption-0",
      field: "QR_TEST_CAPTION",
      value: capLine,
      x: T.x1 - T.pad - capW,
      y: T.yFooter + 4,
      xMul: 1,
      yMul: 1,
    });
    if (!captionFit.ok) {
      pushError(errors, "LABEL_REFERENCE_OVERFLOW", "QR test caption cannot fit.");
    }
  }

  const qtyCell = cellBox(T.x, T.yFooterQty, T.xBrand, T.yEnd);
  const orderCell = cellBox(T.xBrand, T.yFooterQty, T.xModel, T.yEnd);
  const seqCell = cellBox(T.xModel, T.yFooterQty, T.x1, T.yEnd);

  function placeFooterCell(cell, opts) {
    addText({
      id: `${opts.id}-label`,
      field: `${opts.field}_LABEL`,
      value: opts.caption,
      x: cell.x + T.pad,
      y: cell.y + 4,
      xMul: 1,
      yMul: 1,
    });
    const fit = fitBlockingText({
      text: opts.value,
      maxWidthDots: cell.w - T.pad * 2,
      maxHeightDots: (opts.yMul || 1) === 2 ? 48 : 24,
      maxLines: 1,
      preferredXMul: opts.preferredXMul,
      minXMul: opts.minXMul,
      yMul: opts.yMul || 1,
    });
    const line = (fit.lines || [opts.value])[0] || "";
    const lineW = String(line).length * (fit.charW || 12);
    const vx = cell.x + Math.max(T.pad, Math.floor((cell.w - lineW) / 2));
    const vy = cell.y1 - 2 - (fit.charH || 24);
    addText({
      id: `${opts.id}-line-0`,
      field: opts.field,
      value: line,
      x: vx,
      y: vy,
      xMul: fit.xMul,
      yMul: fit.yMul,
    });
    if (!fit.ok) pushError(errors, opts.overflowCode, `${opts.caption} cannot fit without truncation.`);
    return fit;
  }

  placeFooterCell(qtyCell, {
    id: "label-qty",
    caption: "LABEL QTY",
    field: "LABEL_QTY",
    value: labelQty,
    preferredXMul: 3,
    minXMul: 2,
    yMul: 2,
    overflowCode: "LABEL_REFERENCE_OVERFLOW",
  });
  placeFooterCell(orderCell, {
    id: "order-qty",
    caption: "ORDER/PO QTY",
    field: "ORDER_QTY",
    value: orderQty,
    preferredXMul: 2,
    minXMul: 2,
    yMul: 1,
    overflowCode: "LABEL_REFERENCE_OVERFLOW",
  });
  placeFooterCell(seqCell, {
    id: "sequence",
    caption: "SEQUENCE",
    field: "SEQUENCE",
    value: sequence,
    preferredXMul: 2,
    minXMul: 1,
    yMul: 1,
    overflowCode: "LABEL_REFERENCE_OVERFLOW",
  });

  const y = T.yEnd;
  if (y > L.y1) {
    pushError(errors, "LABEL_SAFE_MARGIN_VIOLATION", `Table overflow: y=${y} exceeds ${L.y1}`);
  }

  const qrQuietPrim = primitives.find((p) => p.id === "qr-quiet");
  const qrInnerPrim = primitives.find((p) => p.id === "qr-inner");
  const qrRenderedPrim = primitives.find((p) => p.id === "qr-rendered");
  if (qrQuietPrim.logical.w !== qrQuietPrim.logical.h || qrInnerPrim.logical.w !== qrInnerPrim.logical.h) {
    pushError(errors, "LABEL_QR_OUT_OF_BOUNDS", "QR is not square.");
  }
  if (qrQuietPrim.physical.w !== qrQuietPrim.physical.h) {
    pushError(errors, "LABEL_QR_OUT_OF_BOUNDS", "Physical QR AABB is not square.");
  }
  if (qrRenderedPrim.logical.w !== qrRenderedPrim.logical.h) {
    pushError(errors, "LABEL_QR_OUT_OF_BOUNDS", "Rendered QR is not square.");
  }
  if (
    qrGeo.cellDots !== Math.floor(qrGeo.cellDots) ||
    qrInner.w !== qrGeo.moduleCount * qrGeo.cellDots ||
    qrRendered.w !== renderedModules.size * qrGeo.cellDots
  ) {
    pushError(errors, "LABEL_QR_OUT_OF_BOUNDS", "QR modules are not integer-sized.");
  }
  if (!boxContains(qrInner, qrRendered)) {
    pushError(errors, "LABEL_QR_OUT_OF_BOUNDS", "Rendered QR is outside the reserved production inner box.");
  }
  if (qrGeo.outerDots < QR_OUTER_MIN_DOTS || qrGeo.outerDots > QR_OUTER_MAX_DOTS) {
    pushError(errors, "LABEL_QR_OUT_OF_BOUNDS", "Reserved QR including quiet zone is outside the 30–35 mm budget.");
  }
  if (qrGeo.outerDots > rightW) {
    pushError(errors, "LABEL_QR_OUT_OF_BOUNDS", "Reserved QR does not fit the right column.");
  }

  for (const p of primitives) {
    if (!insideLogicalSafe(p.logical)) {
      pushError(errors, "LABEL_SAFE_MARGIN_VIOLATION", `${p.id} exceeds logical safe area`);
    }
    if (!insidePhysicalSafe(p.physical)) {
      pushError(errors, "LABEL_SAFE_MARGIN_VIOLATION", `${p.id} exceeds physical safe area`);
    }
  }

  const qrBox = qrQuietPrim.logical;
  for (const p of primitives.filter((pr) => pr.type === "text")) {
    if (boxesOverlap(p.logical, qrBox)) {
      pushError(errors, "LABEL_GEOMETRY_OVERLAP", `${p.id} overlaps QR quiet zone`);
    }
  }
  for (const bar of primitives.filter((pr) => pr.type === "bar")) {
    for (const p of primitives.filter((pr) => pr.type === "text")) {
      if (boxesOverlap(bar.logical, p.logical)) {
        pushError(errors, "LABEL_GEOMETRY_OVERLAP", `${bar.id} crosses ${p.id}`);
      }
    }
    if (boxesOverlap(bar.logical, qrBox)) {
      pushError(errors, "LABEL_GEOMETRY_OVERLAP", `${bar.id} crosses QR quiet zone`);
    }
  }

  const textBoxes = primitives.filter((p) => p.type === "text");
  for (let i = 0; i < textBoxes.length; i += 1) {
    for (let j = i + 1; j < textBoxes.length; j += 1) {
      const a = textBoxes[i];
      const b = textBoxes[j];
      if (a.field === b.field) continue;
      if (a.field.endsWith("_LABEL") || b.field.endsWith("_LABEL")) continue;
      if (a.field === "HEADER" && b.field === "HEADER") continue;
      if (a.field.startsWith("LABEL_ID") && b.field.startsWith("LABEL_ID")) continue;
      if (a.field === "QR_TEST_CAPTION" && b.field === "QR_TEST_CAPTION") continue;
      if (boxesOverlap(a.logical, b.logical)) {
        pushError(errors, "LABEL_GEOMETRY_OVERLAP", `${a.id} overlaps ${b.id}`);
      }
    }
  }

  const identityReady = useProductionQr && errors.length === 0;
  const printAuthorized = data.printAuthorized === true && identityReady;
  let printBlockedCode = "";
  let printBlockedMessage = "";
  if (errors.length) {
    printBlockedCode = errors[0].code;
    printBlockedMessage = errors[0].message;
  } else if (!identityReady) {
    printBlockedCode = "LABEL_IDENTITY_REQUIRED";
    printBlockedMessage = PACKING_QR_LANDSCAPE_V1_PRINT_HINT;
  }

  return {
    templateCode: PACKING_QR_LANDSCAPE_V1_CODE,
    ok: errors.length === 0,
    previewEnabled: true,
    printEnabled: printAuthorized,
    requiresPersistentIdentity: true,
    printBlockedCode,
    printBlockedMessage,
    canvas: {
      dotsPerMm: DOTS_PER_MM,
      physical: { w: PHYSICAL_WIDTH_DOTS, h: PHYSICAL_HEIGHT_DOTS, sizeMm: [PHYSICAL_WIDTH_MM, PHYSICAL_HEIGHT_MM] },
      logical: { w: LOGICAL_WIDTH_DOTS, h: LOGICAL_HEIGHT_DOTS },
      physicalSafe: PHYSICAL_SAFE,
      logicalSafe: LOGICAL_SAFE,
      transform: "xp = 800 - yLogical; yp = xLogical",
      rotationCw: 90,
      viewBox: "0 0 1200 800",
    },
    fields: {
      customerName,
      mvRef,
      customerPo,
      vesselPlant,
      vesselPlantSourceMissing: !vesselPlant,
      brand,
      modelName,
      article,
      description,
      partNo,
      labelQty,
      orderQty,
      sequence,
      sequenceIndex: seqIndex,
      sequenceTotal: seqTotal,
      labelId: persistedLabelNo || null,
      previewLabelId: previewLabelId || null,
    },
    customerLines: customerUsed.lines || [],
    articleFit,
    table: T,
    qr: {
      ecc: QR_ECC,
      logical: qrQuietPrim.logical,
      quiet: qrGeo.quietDots,
      quietModules: QR_QUIET_MODULES,
      cellDots: qrGeo.cellDots,
      inner: qrInner,
      rendered: qrRendered,
      placeholder: !useProductionQr,
      mark: useProductionQr ? productionQr.token : QR_PLACEHOLDER_MARK,
      caption: useProductionQr ? "" : QR_TEST_CAPTION,
      identity: useProductionQr ? persistedLabelNo : null,
      validIdentity: useProductionQr,
      token: useProductionQr ? productionQr.token : null,
      modules: renderedModules,
      geometry: qrGeo,
      reserved: mar1Qr.reserved,
      productionToken: productionQr,
      tsplQrcode: mar1Qr.tsplQrcode,
      boxProof: {
        rightColumnDots: rightW,
        reservedOuterDots: qrGeo.outerDots,
        reservedOuterMm: qrGeo.outerMm,
        reservedInnerDots: qrGeo.innerDots,
        testModuleCount: testQr.size,
        renderedModuleCount: renderedModules.size,
        testRenderedDots: useProductionQr ? null : renderedDots,
        fitsRightColumn: qrGeo.outerDots <= rightW,
        horizontalSlackDots: rightW - qrGeo.outerDots,
        testCenteredInReservedInner: boxContains(qrInner, qrRendered),
        quietReservedOnce: true,
        tsplIncludesQuietZone: false,
      },
    },
    primitives,
    notes,
    errors,
    errorCodes: [...new Set(errors.map((e) => e.code))],
    leftColumnEndY: T.yEnd,
    leftColumnBudgetY: L.y1,
  };
}

export function packingQrLandscapeV1CoordinateRows(layout) {
  return (layout.primitives || []).map((p) => ({
    field: p.field,
    id: p.id,
    type: p.type,
    logicalX: p.logical.x,
    logicalY: p.logical.y,
    logicalW: p.logical.w,
    logicalH: p.logical.h,
    physicalMinX: p.physical.x,
    physicalMinY: p.physical.y,
    physicalMaxX: p.physical.x1,
    physicalMaxY: p.physical.y1,
    font: p.font || "",
    xMul: p.xMul ?? "",
    yMul: p.yMul ?? "",
    maxLines: p.maxLines ?? "",
    value: p.value || "",
  }));
}

export function layoutToSvg(layout, { showOverflowBanner = true } = {}) {
  const w = LOGICAL_WIDTH_DOTS;
  const h = LOGICAL_HEIGHT_DOTS;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`,
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#e4e4e7"/>`,
    `<rect x="${LOGICAL_SAFE.x}" y="${LOGICAL_SAFE.y}" width="${LOGICAL_SAFE.w}" height="${LOGICAL_SAFE.h}" fill="#fff"/>`,
  ];
  const qrModules = layout.qr?.modules || buildTestQrModules();
  const cell = Number(layout.qr?.cellDots || qrModules.geometry?.cellDots || 1);
  for (const p of layout.primitives || []) {
    if (p.type === "box") {
      parts.push(
        `<rect x="${p.logical.x}" y="${p.logical.y}" width="${p.logical.w}" height="${p.logical.h}" fill="none" stroke="#111" stroke-width="${p.thickness || 2}"/>`
      );
    } else if (p.type === "bar") {
      parts.push(
        `<rect x="${p.logical.x}" y="${p.logical.y}" width="${p.logical.w}" height="${p.logical.h}" fill="#111"/>`
      );
    } else if (p.type === "qr-quiet") {
      parts.push(
        `<rect x="${p.logical.x}" y="${p.logical.y}" width="${p.logical.w}" height="${p.logical.h}" fill="#fff"/>`
      );
    } else if (p.type === "qr-placeholder") {
      parts.push(
        `<rect x="${p.logical.x}" y="${p.logical.y}" width="${p.logical.w}" height="${p.logical.h}" fill="#fff"/>`
      );
    } else if (p.type === "qr-modules") {
      for (const [mx, my] of qrModules.dark) {
        parts.push(
          `<rect x="${p.logical.x + mx * cell}" y="${p.logical.y + my * cell}" width="${cell}" height="${cell}" fill="#111"/>`
        );
      }
    } else if (p.type === "text") {
      const size =
        p.field === "LABEL_QTY" && p.yMul === 2
          ? 28
          : p.field === "ARTICLE" && p.yMul === 2
            ? 26
            : p.field === "HEADER" && p.yMul === 2
              ? 24
              : p.yMul === 2
                ? 22
                : p.xMul >= 2
                  ? 16
                  : p.field.endsWith("_LABEL") || p.field.endsWith("_CAPTION")
                    ? 12
                    : 13;
      const weight =
        p.field === "ARTICLE" || p.field === "LABEL_QTY" || (p.field === "HEADER" && p.yMul === 2) ? "700" : "500";
      const fill = p.field === "QR_TEST_CAPTION" ? "#9a3412" : "#111";
      const escaped = String(p.value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;");
      parts.push(
        `<text x="${p.logical.x}" y="${p.logical.y + p.logical.h * 0.8}" font-family="ui-monospace, Consolas, monospace" font-size="${size}" font-weight="${weight}" fill="${fill}">${escaped}</text>`
      );
    }
  }
  if (showOverflowBanner && !layout.ok) {
    parts.push(
      `<rect x="120" y="8" width="960" height="56" fill="#fee2e2" stroke="#b91c1c" stroke-width="2"/>`,
      `<text x="136" y="32" font-family="sans-serif" font-size="16" font-weight="700" fill="#991b1b">PREVIEW BLOCKED — printing disabled</text>`,
      `<text x="136" y="52" font-family="sans-serif" font-size="13" fill="#991b1b">${escapeXml((layout.errorCodes || []).join(", "))} · ${escapeXml(layout.printBlockedMessage || "")}</text>`
    );
  }
  parts.push("</svg>");
  return parts.join("");
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function reviewLayoutMetrics(layout) {
  const texts = (layout.primitives || []).filter((p) => p.type === "text");
  const minMul = texts.reduce((m, p) => Math.min(m, Number(p.xMul) || 1, Number(p.yMul) || 1), 8);
  return {
    physicalPaperDots: [PHYSICAL_WIDTH_DOTS, PHYSICAL_HEIGHT_DOTS],
    physicalPaperMm: [PHYSICAL_WIDTH_MM, PHYSICAL_HEIGHT_MM],
    safePhysicalBox: PHYSICAL_SAFE,
    logicalContentDots: [LOGICAL_SAFE.w, LOGICAL_SAFE.h],
    qrOuterDots: layout.qr?.logical?.w ?? null,
    qrQuietDots: layout.qr?.quiet ?? null,
    qrQuietModules: layout.qr?.quietModules ?? QR_QUIET_MODULES,
    qrCellDots: layout.qr?.cellDots ?? null,
    qrReservedModuleCount: layout.qr?.geometry?.moduleCount ?? null,
    qrTestModuleCount: layout.qr?.modules?.size ?? null,
    qrRenderedDots: layout.qr?.rendered?.w ?? null,
    qrOuterMm: layout.qr?.geometry?.outerMm ?? null,
    smallestFontMagnification: minMul,
    smallestFontCellDots: { w: 12 * minMul, h: 24 * minMul },
    customerLineCount: (layout.customerLines || []).length,
    descriptionLineCount: texts.filter((p) => p.field === "DESCRIPTION").length,
    ok: layout.ok,
    printEnabled: layout.printEnabled,
    errorCodes: layout.errorCodes || [],
  };
}

export function packingQrLandscapeV1SafeCornersLogical() {
  return {
    topLeft: { x: LOGICAL_SAFE.x, y: LOGICAL_SAFE.y },
    topRight: { x: LOGICAL_SAFE.x1, y: LOGICAL_SAFE.y },
    bottomLeft: { x: LOGICAL_SAFE.x, y: LOGICAL_SAFE.y1 },
    bottomRight: { x: LOGICAL_SAFE.x1, y: LOGICAL_SAFE.y1 },
  };
}

export function packingQrLandscapeV1SafeCornersPhysical() {
  const c = packingQrLandscapeV1SafeCornersLogical();
  return {
    topLeft: logicalToPhysicalPoint(c.topLeft.x, c.topLeft.y),
    topRight: logicalToPhysicalPoint(c.topRight.x, c.topRight.y),
    bottomLeft: logicalToPhysicalPoint(c.bottomLeft.x, c.bottomLeft.y),
    bottomRight: logicalToPhysicalPoint(c.bottomRight.x, c.bottomRight.y),
  };
}

export function faceDataFromPackingLine(ln = {}, resolved = {}, { sequenceIndex = 1, sequenceTotal = 1 } = {}) {
  return {
    customerName: ln.customerName || "",
    mvRef: resolved.sourceNo || ln.sourceNo || "",
    customerPo: ln.customerRef || "",
    vesselPlant: "",
    brand: ln.brand || "",
    modelName: ln.modelName || "",
    article: ln.article || "",
    description: ln.description || "",
    partNo: ln.partNo || ln.spn || "",
    labelQty: ln.labelQty,
    orderQty: ln.totalQty ?? ln.qty,
    sequenceIndex,
    sequenceTotal,
  };
}
