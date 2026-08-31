/**
 * TSPL emitter for PACKING_QR_LANDSCAPE_150X100_V1.
 * Geometry authority: packingQrLandscapeV1 layout primitives (approved V2 table).
 *
 * Physical face (TSPL_LABEL_BATCH / detected media):
 *   SIZE 100 mm,150 mm
 *   DIRECTION 1
 *   REFERENCE 0,0
 *   HOME
 *   CLS
 *   [transformed V2 content]
 *   QRCODE at inner symbol origin, ECC H, cellWidth 6
 *   PRINT 1,1
 *
 * No GAP / GAPDETECT / FEED per face. Agent GAPDETECT once per batch.
 *
 * TSPL TEXT rotation anchors are not assumed to match SVG. Helpers below map:
 *   TEXT origin = physical image of the logical top-left, rotation 90 CW
 *   BOX/BAR = physical AABB of the logical rectangle
 *   QRCODE origin = physical image of the logical inner-module origin, rotation 90
 */
import { escapeTspl } from "./tsplGenerator.js";
import {
  PHYSICAL_HEIGHT_MM,
  PHYSICAL_WIDTH_MM,
  QR_ECC,
  MAR1_REQUIRED_CELL_DOTS,
  layoutPackingQrLandscapeV1,
  logicalToPhysicalPoint,
} from "./packingQrLandscapeV1.js";
import { validateTsplLabelBatchPayload, LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH } from "./labelPayloadModes.js";

export function transformTextOrigin(primitive) {
  const x = Number(primitive.x ?? primitive.logical?.x);
  const y = Number(primitive.y ?? primitive.logical?.y);
  const origin = logicalToPhysicalPoint(x, y);
  return {
    x: origin.x,
    y: origin.y,
    rotation: 90,
    xMul: Number(primitive.xMul) || 1,
    yMul: Number(primitive.yMul) || 1,
  };
}

export function transformBoxEndpoints(primitive) {
  const p = primitive.physical || {};
  return {
    x1: Number(p.x),
    y1: Number(p.y),
    x2: Number(p.x1),
    y2: Number(p.y1),
    thickness: Number(primitive.thickness) || 2,
  };
}

export function transformBarEndpoints(primitive) {
  const p = primitive.physical || {};
  return {
    x: Number(p.x),
    y: Number(p.y),
    width: Number(p.w),
    height: Number(p.h),
  };
}

export function transformQrcodeOrigin(layout) {
  const inner = layout?.qr?.inner || {};
  const origin = logicalToPhysicalPoint(Number(inner.x), Number(inner.y));
  return {
    x: origin.x,
    y: origin.y,
    rotation: 90,
    ecc: QR_ECC,
    cellWidth: MAR1_REQUIRED_CELL_DOTS,
    quietAppliedByLayout: true,
    extraQuiet: false,
  };
}

export function emitLandscapeTextCommand(primitive) {
  const t = transformTextOrigin(primitive);
  return `TEXT ${t.x},${t.y},"0",${t.rotation},${t.xMul},${t.yMul},"${escapeTspl(primitive.value)}"`;
}

export function emitLandscapeBoxCommand(primitive) {
  const b = transformBoxEndpoints(primitive);
  return `BOX ${b.x1},${b.y1},${b.x2},${b.y2},${b.thickness}`;
}

export function emitLandscapeBarCommand(primitive) {
  const b = transformBarEndpoints(primitive);
  return `BAR ${b.x},${b.y},${b.width},${b.height}`;
}

export function emitLandscapeQrcodeCommand(layout, token) {
  const q = transformQrcodeOrigin(layout);
  return `QRCODE ${q.x},${q.y},${q.ecc},${q.cellWidth},A,${q.rotation},"${escapeTspl(token)}"`;
}

function primitiveInPhysicalSafe(layout, primitive) {
  const safe = layout?.canvas?.physicalSafe;
  const p = primitive.physical;
  if (!safe || !p) return false;
  return p.x >= safe.x && p.y >= safe.y && p.x1 <= safe.x1 && p.y1 <= safe.y1;
}

/**
 * One complete TSPL_LABEL_BATCH face from an already-laid-out V2 result.
 */
export function buildPackingQrLandscapeV1FaceTspl(layout, { token } = {}) {
  if (!layout || layout.ok !== true) {
    const err = new Error(layout?.printBlockedMessage || "Landscape packing label layout failed");
    err.statusCode = 409;
    err.code = layout?.printBlockedCode || layout?.errorCodes?.[0] || "LABEL_GEOMETRY";
    throw err;
  }
  const qrToken = String(token || layout.qr?.token || layout.fields?.mar1QrToken || "").trim();
  if (!qrToken) {
    const err = new Error("Persisted MAR1 token is required to emit TSPL");
    err.statusCode = 409;
    err.code = "LABEL_IDENTITY_REQUIRED";
    throw err;
  }
  const cmds = [
    `SIZE ${PHYSICAL_WIDTH_MM} mm,${PHYSICAL_HEIGHT_MM} mm`,
    "DIRECTION 1",
    "REFERENCE 0,0",
    "HOME",
    "CLS",
  ];
  for (const p of layout.primitives || []) {
    if (!primitiveInPhysicalSafe(layout, p) && (p.type === "text" || p.type === "box" || p.type === "bar")) {
      const err = new Error(`${p.id} exceeds physical safe area`);
      err.statusCode = 409;
      err.code = "LABEL_SAFE_MARGIN_VIOLATION";
      throw err;
    }
    if (p.type === "box") cmds.push(emitLandscapeBoxCommand(p));
    else if (p.type === "bar") cmds.push(emitLandscapeBarCommand(p));
    else if (p.type === "text") cmds.push(emitLandscapeTextCommand(p));
  }
  cmds.push(emitLandscapeQrcodeCommand(layout, qrToken));
  cmds.push("PRINT 1,1");
  return cmds.join("\r\n") + "\r\n";
}

export function buildPackingQrLandscapeV1FaceTsplFromData(data = {}, opts = {}) {
  const layout = layoutPackingQrLandscapeV1(data);
  return {
    layout,
    tspl: buildPackingQrLandscapeV1FaceTspl(layout, { token: opts.token || data.mar1QrToken }),
  };
}

export function buildPackingQrLandscapeV1BatchPayloads(faceInputs = []) {
  const payloads = [];
  const layouts = [];
  for (const input of faceInputs) {
    const data = input.data || input;
    const token = input.token || data.mar1QrToken;
    const layout = input.layout || layoutPackingQrLandscapeV1(data);
    payloads.push(buildPackingQrLandscapeV1FaceTspl(layout, { token }));
    layouts.push(layout);
  }
  const check = validateTsplLabelBatchPayload({
    payloadMode: LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH,
    requestedLabels: payloads.length,
    rawFacePayloads: payloads,
  });
  if (!check.ok) {
    const err = new Error(check.error || "TSPL_LABEL_BATCH validation failed");
    err.statusCode = 400;
    err.code = "LABEL_FACE_COUNT";
    throw err;
  }
  return { payloads, layouts };
}

export function redactTsplSecrets(tspl = "") {
  return String(tspl || "").replace(
    /(QRCODE\s+\d+,\d+,H,6,A,90,")([^"]+)(")/g,
    '$1MAR1.MAR-PL-000001.K1.<redacted>$3'
  );
}
