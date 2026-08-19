/**
 * ASN Phase 3A — warehouse receiving inspection rules (pure).
 * Physical count + photos + disposition. Never posts stock, GRN, customs, or accounting.
 */

import { ASN_QTY_EPS, roundAsnQty } from "./asnRules.js";
import {
  ReceivingUnitError,
  isActiveRuStatus,
  isCancelledRuStatus,
  isPlannedRuStatus,
  isPrintedRuStatus,
  isSupersededRuStatus,
} from "./receivingUnitRules.js";

export const RECEIVING_SESSION_STATUSES = Object.freeze([
  "DRAFT",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);

export const RECEIVING_SESSION_ACTIVE_STATUSES = Object.freeze(["DRAFT", "IN_PROGRESS"]);

export const RECEIVING_UNIT_RESULT_STATUSES = Object.freeze([
  "NOT_STARTED",
  "IN_PROGRESS",
  "COMPLETED",
]);

export const RECEIVING_CONDITIONS = Object.freeze([
  "GOOD",
  "DAMAGED",
  "REJECTED",
  "MIXED",
  "NOT_RECEIVED",
]);

export const RECEIVING_PHOTO_CATEGORIES = Object.freeze([
  "OVERALL",
  "FRONT",
  "BACK",
  "MARKING",
  "PART_NUMBER",
  "DAMAGE",
  "PACKING",
  "OTHER",
]);

export const RECEIVING_PHOTO_STATUSES = Object.freeze(["ACTIVE", "DELETED"]);

export const RECEIVING_PHOTO_ALLOWED_MIME = Object.freeze([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
]);

export const DEFAULT_RECEIVING_PHOTO_MAX_LONG_EDGE = 1800;
export const DEFAULT_RECEIVING_PHOTO_JPEG_QUALITY = 0.8;
export const DEFAULT_RECEIVING_PHOTO_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_RECEIVING_MIN_PHOTOS_PER_RU = 1;

export class ReceivingInspectionError extends Error {
  constructor(message, status = 400, code = "RECEIVING_ERROR") {
    super(message);
    this.name = "ReceivingInspectionError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
  }
}

export function isActiveReceivingSessionStatus(status) {
  return RECEIVING_SESSION_ACTIVE_STATUSES.includes(String(status || "").toUpperCase());
}

export function isCompletedReceivingUnitResult(status) {
  return String(status || "").toUpperCase() === "COMPLETED";
}

export function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function parseQuality(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0.1, n));
}

export function receivingPhotoSettingsFromEnv(env = process.env) {
  return {
    maxLongEdge: parsePositiveInt(
      env.RECEIVING_PHOTO_MAX_LONG_EDGE,
      DEFAULT_RECEIVING_PHOTO_MAX_LONG_EDGE
    ) || DEFAULT_RECEIVING_PHOTO_MAX_LONG_EDGE,
    jpegQuality: parseQuality(
      env.RECEIVING_PHOTO_JPEG_QUALITY,
      DEFAULT_RECEIVING_PHOTO_JPEG_QUALITY
    ),
    maxBytes: parsePositiveInt(
      env.RECEIVING_PHOTO_MAX_BYTES,
      DEFAULT_RECEIVING_PHOTO_MAX_BYTES
    ) || DEFAULT_RECEIVING_PHOTO_MAX_BYTES,
    minPhotosPerRU: parsePositiveInt(
      env.RECEIVING_MIN_PHOTOS_PER_RU,
      DEFAULT_RECEIVING_MIN_PHOTOS_PER_RU
    ),
    outputMime: "image/jpeg",
  };
}

/**
 * Resize so the long edge does not exceed maxEdge. Never enlarges.
 */
export function resizeToMaxLongEdge(width, height, maxEdge = DEFAULT_RECEIVING_PHOTO_MAX_LONG_EDGE) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const max = Math.max(1, Number(maxEdge) || DEFAULT_RECEIVING_PHOTO_MAX_LONG_EDGE);
  if (!(w > 0) || !(h > 0)) return { width: 0, height: 0, scale: 1, resized: false };
  const longEdge = Math.max(w, h);
  if (longEdge <= max) return { width: w, height: h, scale: 1, resized: false };
  const scale = max / longEdge;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
    resized: true,
  };
}

/**
 * EXIF orientations 5–8 swap width/height for the displayed image.
 */
export function swapDimensionsForExifOrientation(width, height, orientation) {
  const o = Number(orientation) || 1;
  if (o >= 5 && o <= 8) return { width: height, height: width };
  return { width, height };
}

export function receivingQtyEq(a, b) {
  return Math.abs(roundAsnQty(Number(a) || 0) - roundAsnQty(Number(b) || 0)) <= ASN_QTY_EPS;
}

export function receivingQtyPositive(value) {
  return roundAsnQty(Number(value) || 0) > ASN_QTY_EPS;
}

export function assertReceivingActualQty(value) {
  if (value == null || value === "") {
    throw new ReceivingInspectionError("Actual quantity is required", 400, "RECEIVING_QTY_REQUIRED");
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ReceivingInspectionError("Actual quantity must be a finite number", 400, "RECEIVING_QTY_INVALID");
  }
  if (n < 0) {
    throw new ReceivingInspectionError("Actual quantity cannot be negative", 400, "RECEIVING_QTY_NEGATIVE");
  }
  return roundAsnQty(n);
}

export function assertReceivingDispositionQty(value, field = "Disposition quantity") {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new ReceivingInspectionError(`${field} must be a finite number`, 400, "RECEIVING_DISPOSITION_INVALID");
  }
  if (n < 0) {
    throw new ReceivingInspectionError(`${field} cannot be negative`, 400, "RECEIVING_DISPOSITION_NEGATIVE");
  }
  return roundAsnQty(n);
}

export function dispositionTotal(acceptedQty, damagedQty, rejectedQty) {
  return roundAsnQty(
    (Number(acceptedQty) || 0) + (Number(damagedQty) || 0) + (Number(rejectedQty) || 0)
  );
}

export function shortQty(plannedQty, actualQty) {
  if (actualQty == null || actualQty === "") return null;
  return roundAsnQty(Math.max(0, roundAsnQty(plannedQty) - roundAsnQty(actualQty)));
}

export function excessQty(plannedQty, actualQty) {
  if (actualQty == null || actualQty === "") return null;
  return roundAsnQty(Math.max(0, roundAsnQty(actualQty) - roundAsnQty(plannedQty)));
}

export function computeDispositionDerived({
  plannedQty,
  actualQty,
  acceptedQty,
  damagedQty,
  rejectedQty,
} = {}) {
  const actual = actualQty == null || actualQty === "" ? null : roundAsnQty(actualQty);
  const accepted = acceptedQty == null || acceptedQty === "" ? null : roundAsnQty(acceptedQty);
  const damaged = damagedQty == null || damagedQty === "" ? null : roundAsnQty(damagedQty);
  const rejected = rejectedQty == null || rejectedQty === "" ? null : roundAsnQty(rejectedQty);
  const hasBuckets = accepted != null || damaged != null || rejected != null;
  return {
    acceptedQty: accepted,
    damagedQty: damaged,
    rejectedQty: rejected,
    dispositionTotal: hasBuckets ? dispositionTotal(accepted || 0, damaged || 0, rejected || 0) : null,
    variance: varianceQty(plannedQty, actual),
    shortQty: shortQty(plannedQty, actual),
    excessQty: excessQty(plannedQty, actual),
  };
}

export function applyNotReceivedDisposition() {
  return {
    acceptedQty: 0,
    damagedQty: 0,
    rejectedQty: 0,
    condition: "NOT_RECEIVED",
  };
}

export function applyAllGoodDisposition(actualQty) {
  const actual = assertReceivingActualQty(actualQty);
  if (actual === 0) return applyNotReceivedDisposition();
  return {
    acceptedQty: actual,
    damagedQty: 0,
    rejectedQty: 0,
    condition: "GOOD",
  };
}

export function suggestConditionFromDisposition({
  actualQty,
  acceptedQty,
  damagedQty,
  rejectedQty,
} = {}) {
  const actual = roundAsnQty(actualQty || 0);
  const a = roundAsnQty(acceptedQty || 0);
  const d = roundAsnQty(damagedQty || 0);
  const r = roundAsnQty(rejectedQty || 0);
  if (actual === 0) return "NOT_RECEIVED";
  const buckets = [receivingQtyPositive(a), receivingQtyPositive(d), receivingQtyPositive(r)].filter(Boolean).length;
  if (buckets > 1) return "MIXED";
  if (receivingQtyEq(d, actual) && actual > 0) return "DAMAGED";
  if (receivingQtyEq(r, actual) && actual > 0) return "REJECTED";
  if (receivingQtyEq(a, actual)) return "GOOD";
  return "MIXED";
}

export function resolveDispositionForComplete({
  actualQty,
  condition,
  acceptedQty,
  damagedQty,
  rejectedQty,
} = {}) {
  const actual = assertReceivingActualQty(actualQty);
  if (actual === 0) {
    const provided = assertReceivingCondition(condition, { required: false });
    if (provided && provided !== "NOT_RECEIVED") {
      throw new ReceivingInspectionError(
        "Actual quantity 0 must be recorded as NOT_RECEIVED. Missing goods are a shortage, not a rejection.",
        400,
        "RECEIVING_ZERO_QTY_CONDITION"
      );
    }
    const accepted = assertReceivingDispositionQty(acceptedQty ?? 0, "Accepted quantity") ?? 0;
    const damaged = assertReceivingDispositionQty(damagedQty ?? 0, "Damaged quantity") ?? 0;
    const rejected = assertReceivingDispositionQty(rejectedQty ?? 0, "Rejected quantity") ?? 0;
    return {
      acceptedQty: accepted,
      damagedQty: damaged,
      rejectedQty: rejected,
      condition: "NOT_RECEIVED",
    };
  }
  const hasBuckets = acceptedQty != null || damagedQty != null || rejectedQty != null;
  if (!hasBuckets) {
    const c = assertReceivingCondition(condition, { required: true });
    if (c === "NOT_RECEIVED") {
      throw new ReceivingInspectionError(
        "NOT_RECEIVED is only valid when actual quantity is 0",
        400,
        "RECEIVING_DISPOSITION_CONDITION"
      );
    }
    if (c === "GOOD") return { acceptedQty: actual, damagedQty: 0, rejectedQty: 0, condition: c };
    if (c === "DAMAGED") return { acceptedQty: 0, damagedQty: actual, rejectedQty: 0, condition: c };
    if (c === "REJECTED") return { acceptedQty: 0, damagedQty: 0, rejectedQty: actual, condition: c };
    throw new ReceivingInspectionError(
      "Enter accepted, damaged, and rejected quantities for a mixed receipt",
      400,
      "RECEIVING_DISPOSITION_REQUIRED"
    );
  }
  const accepted = assertReceivingDispositionQty(acceptedQty ?? 0, "Accepted quantity") ?? 0;
  const damaged = assertReceivingDispositionQty(damagedQty ?? 0, "Damaged quantity") ?? 0;
  const rejected = assertReceivingDispositionQty(rejectedQty ?? 0, "Rejected quantity") ?? 0;
  const suggested = suggestConditionFromDisposition({
    actualQty: actual,
    acceptedQty: accepted,
    damagedQty: damaged,
    rejectedQty: rejected,
  });
  const provided = assertReceivingCondition(condition, { required: false });
  if (provided === "NOT_RECEIVED") {
    throw new ReceivingInspectionError(
      "NOT_RECEIVED is only valid when actual quantity is 0",
      400,
      "RECEIVING_DISPOSITION_CONDITION"
    );
  }
  return {
    acceptedQty: accepted,
    damagedQty: damaged,
    rejectedQty: rejected,
    condition: provided || suggested,
  };
}

export function assertDispositionTotalsActual({ actualQty, acceptedQty, damagedQty, rejectedQty } = {}) {
  const actual = assertReceivingActualQty(actualQty);
  const total = dispositionTotal(acceptedQty, damagedQty, rejectedQty);
  if (!receivingQtyEq(total, actual)) {
    throw new ReceivingInspectionError(
      `Accepted + damaged + rejected (${total}) must equal actual quantity (${actual})`,
      400,
      "RECEIVING_DISPOSITION_MISMATCH"
    );
  }
}

export function assertConditionDispositionConsistent({
  condition,
  actualQty,
  acceptedQty,
  damagedQty,
  rejectedQty,
} = {}) {
  const actual = assertReceivingActualQty(actualQty);
  const c = assertReceivingCondition(condition, { required: true });
  const a = roundAsnQty(acceptedQty || 0);
  const d = roundAsnQty(damagedQty || 0);
  const r = roundAsnQty(rejectedQty || 0);
  if (actual === 0) {
    if (c !== "NOT_RECEIVED") {
      throw new ReceivingInspectionError(
        "Actual quantity 0 must be recorded as NOT_RECEIVED. Missing goods are a shortage, not a rejection.",
        400,
        "RECEIVING_ZERO_QTY_CONDITION"
      );
    }
    if (!receivingQtyEq(a, 0) || !receivingQtyEq(d, 0) || !receivingQtyEq(r, 0)) {
      throw new ReceivingInspectionError(
        "Zero actual quantity cannot record accepted, damaged, or rejected pieces. Record shortage, not rejection.",
        400,
        "RECEIVING_ZERO_QTY_DISPOSITION"
      );
    }
    return;
  }
  if (c === "NOT_RECEIVED") {
    throw new ReceivingInspectionError(
      "NOT_RECEIVED is only valid when actual quantity is 0",
      400,
      "RECEIVING_DISPOSITION_CONDITION"
    );
  }
  const okGood = receivingQtyEq(a, actual) && receivingQtyEq(d, 0) && receivingQtyEq(r, 0);
  const okDamaged = receivingQtyEq(d, actual) && receivingQtyEq(a, 0) && receivingQtyEq(r, 0);
  const okRejected = receivingQtyEq(r, actual) && receivingQtyEq(a, 0) && receivingQtyEq(d, 0);
  const buckets = [receivingQtyPositive(a), receivingQtyPositive(d), receivingQtyPositive(r)].filter(Boolean).length;
  if (c === "GOOD" && !okGood) {
    throw new ReceivingInspectionError(
      "GOOD requires all physically counted quantity to be accepted",
      400,
      "RECEIVING_DISPOSITION_CONDITION"
    );
  }
  if (c === "DAMAGED" && !okDamaged) {
    throw new ReceivingInspectionError(
      "DAMAGED requires all physically counted quantity to be damaged. Use MIXED when some pieces are good.",
      400,
      "RECEIVING_DISPOSITION_CONDITION"
    );
  }
  if (c === "REJECTED" && !okRejected) {
    throw new ReceivingInspectionError(
      "REJECTED requires all physically counted quantity to be rejected. Use MIXED when some pieces are accepted.",
      400,
      "RECEIVING_DISPOSITION_CONDITION"
    );
  }
  if (c === "MIXED" && buckets < 2) {
    throw new ReceivingInspectionError(
      "MIXED requires more than one disposition bucket",
      400,
      "RECEIVING_DISPOSITION_CONDITION"
    );
  }
}

export function assertDiscrepancyRemarks({
  plannedQty,
  actualQty,
  acceptedQty,
  damagedQty,
  rejectedQty,
  remarks,
} = {}) {
  const derived = computeDispositionDerived({
    plannedQty,
    actualQty,
    acceptedQty,
    damagedQty,
    rejectedQty,
  });
  const plannedKnown = plannedQty != null && plannedQty !== "";
  const need =
    (plannedKnown && (derived.shortQty || 0) > ASN_QTY_EPS) ||
    (plannedKnown && (derived.excessQty || 0) > ASN_QTY_EPS) ||
    receivingQtyPositive(derived.damagedQty) ||
    receivingQtyPositive(derived.rejectedQty) ||
    roundAsnQty(actualQty) === 0;
  if (need && !String(remarks || "").trim()) {
    throw new ReceivingInspectionError(
      "Remarks are required for shortage, excess, damage, rejection, or zero quantity",
      400,
      "RECEIVING_DISCREPANCY_REMARKS"
    );
  }
}

export function assertDamagePhotoRequired({ damagedQty, photos = [] } = {}) {
  if (!receivingQtyPositive(damagedQty)) return;
  const hasDamage = (photos || []).some((p) => String(p.category || "").toUpperCase() === "DAMAGE");
  if (!hasDamage) {
    throw new ReceivingInspectionError(
      "A DAMAGE photo is required when damaged quantity is greater than zero",
      400,
      "RECEIVING_DAMAGE_PHOTO_REQUIRED"
    );
  }
}

export function assertRejectedEvidence({ rejectedQty, photoCount, remarks } = {}) {
  if (!receivingQtyPositive(rejectedQty)) return;
  if ((Number(photoCount) || 0) < 1) {
    throw new ReceivingInspectionError(
      "At least one photo is required when rejected quantity is greater than zero",
      400,
      "RECEIVING_PHOTO_REQUIRED"
    );
  }
  if (!String(remarks || "").trim()) {
    throw new ReceivingInspectionError(
      "Remarks are required when rejected quantity is greater than zero",
      400,
      "RECEIVING_DISCREPANCY_REMARKS"
    );
  }
}

export function hasStoredDispositionBuckets(unit = {}) {
  return unit.acceptedQty != null || unit.damagedQty != null || unit.rejectedQty != null;
}

export function hasValidDisposition(unit = {}) {
  if (unit.actualQty == null || unit.actualQty === "") return false;
  if (!hasStoredDispositionBuckets(unit)) return false;
  try {
    const resolved = resolveDispositionForComplete(unit);
    assertDispositionTotalsActual({ actualQty: unit.actualQty, ...resolved });
    assertConditionDispositionConsistent({
      condition: resolved.condition || unit.condition,
      actualQty: unit.actualQty,
      ...resolved,
    });
    return true;
  } catch {
    return false;
  }
}

/** Derived — never a stored status. Legacy COMPLETED rows without buckets need review. */
export function isDispositionRequired(unit = {}) {
  return isCompletedReceivingUnitResult(unit.status) && !hasValidDisposition(unit);
}

/**
 * Phase 4 readiness only. Does not mean GRN created, stock posted, or ASN completed.
 * Derived — never a persisted ReceivingSession status.
 */
export function computeDispositionReadiness(units = []) {
  const list = Array.isArray(units) ? units : [];
  const dispositionRequiredCount = list.filter((u) => isDispositionRequired(u)).length;
  const dispositionReady = list.length > 0 && list.every((u) => hasValidDisposition(u));
  return { dispositionReady, dispositionRequiredCount };
}

export function assertPhase4CanConsumeReceivingUnits(units = []) {
  const { dispositionReady, dispositionRequiredCount } = computeDispositionReadiness(units);
  if (!dispositionReady) {
    throw new ReceivingInspectionError(
      dispositionRequiredCount
        ? `Phase 4 cannot consume receiving until disposition is complete (${dispositionRequiredCount} unit(s) DISPOSITION_REQUIRED)`
        : "Phase 4 cannot consume receiving until every current Receiving Unit has a valid disposition",
      409,
      "RECEIVING_DISPOSITION_REQUIRED"
    );
  }
  return { dispositionReady: true, dispositionRequiredCount: 0 };
}

export function aggregateAsnLineDisposition(rows = []) {
  const plannedQty = roundAsnQty(rows.reduce((s, r) => s + (Number(r.plannedQty) || 0), 0));
  const actualQty = roundAsnQty(rows.reduce((s, r) => s + (r.actualQty == null ? 0 : Number(r.actualQty) || 0), 0));
  const acceptedQty = roundAsnQty(rows.reduce((s, r) => s + (Number(r.acceptedQty) || 0), 0));
  const damagedQty = roundAsnQty(rows.reduce((s, r) => s + (Number(r.damagedQty) || 0), 0));
  const rejectedQty = roundAsnQty(rows.reduce((s, r) => s + (Number(r.rejectedQty) || 0), 0));
  return {
    plannedQty,
    actualQty,
    acceptedQty,
    damagedQty,
    rejectedQty,
    variance: varianceQty(plannedQty, actualQty),
    shortQty: shortQty(plannedQty, actualQty),
    excessQty: excessQty(plannedQty, actualQty),
  };
}

export function assertReceivingCondition(value, { required = false } = {}) {
  const c = String(value || "").trim().toUpperCase();
  if (!c) {
    if (required) {
      throw new ReceivingInspectionError("Condition is required", 400, "RECEIVING_CONDITION_REQUIRED");
    }
    return "";
  }
  if (!RECEIVING_CONDITIONS.includes(c)) {
    throw new ReceivingInspectionError(
      `Invalid condition. Allowed: ${RECEIVING_CONDITIONS.join(", ")}`,
      400,
      "RECEIVING_CONDITION_INVALID"
    );
  }
  return c;
}

export function normalizePhotoCategory(value) {
  const c = String(value || "").trim().toUpperCase();
  if (!c) return "";
  if (!RECEIVING_PHOTO_CATEGORIES.includes(c)) {
    throw new ReceivingInspectionError(
      `Invalid photo category. Allowed: ${RECEIVING_PHOTO_CATEGORIES.join(", ")}`,
      400,
      "RECEIVING_PHOTO_CATEGORY_INVALID"
    );
  }
  return c;
}

export function normalizePhotoMime(value) {
  const mime = String(value || "").trim().toLowerCase();
  if (mime === "image/jpg") return "image/jpeg";
  return mime;
}

export function sniffReceivingImageMime(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return "image/webp";
  }
  return "";
}

export function assertReceivingPhotoUpload({ mimeType, sizeBytes, maxBytes, buffer } = {}) {
  let mime = normalizePhotoMime(mimeType);
  if (buffer && (buffer.length || buffer.byteLength)) {
    const sniffed = sniffReceivingImageMime(buffer);
    if (!sniffed) {
      throw new ReceivingInspectionError(
        "File is not a JPEG, PNG, or WebP image",
        400,
        "RECEIVING_PHOTO_MIME"
      );
    }
    mime = sniffed;
  }
  if (!RECEIVING_PHOTO_ALLOWED_MIME.includes(mime) && mime !== "image/jpeg") {
    throw new ReceivingInspectionError(
      `Invalid image type. Allowed: JPEG, PNG, WebP. Got: ${mime || "unknown"}`,
      400,
      "RECEIVING_PHOTO_MIME"
    );
  }
  const size = Number(sizeBytes) || 0;
  const limit = Number(maxBytes) || DEFAULT_RECEIVING_PHOTO_MAX_BYTES;
  if (!(size > 0)) {
    throw new ReceivingInspectionError("Photo file is empty", 400, "RECEIVING_PHOTO_EMPTY");
  }
  if (size > limit) {
    const mb = Math.round((limit / (1024 * 1024)) * 10) / 10;
    throw new ReceivingInspectionError(
      `Photo exceeds maximum size of ${mb} MB after compression. Capture again or reduce quality.`,
      400,
      "RECEIVING_PHOTO_TOO_LARGE"
    );
  }
  return { mimeType: mime === "image/jpg" ? "image/jpeg" : mime, sizeBytes: size };
}

/**
 * Server-authoritative scan eligibility. Only current PRINTED RUs may enter normal receiving.
 */
export function evaluateReceivingScanEligibility(ru, { current = false } = {}) {
  const status = String(ru?.status || "").toUpperCase();
  const currentPlan = current === true;

  if (!ru) {
    return {
      canReceive: false,
      code: "BARCODE_NOT_FOUND",
      message: "Barcode not found",
      userMessage: "Barcode not found",
    };
  }

  if (isCancelledRuStatus(status)) {
    return {
      canReceive: false,
      code: "RU_CANCELLED",
      message: "This Receiving Unit is cancelled and cannot be received",
      userMessage: "This Receiving Unit is cancelled and cannot be received.",
    };
  }

  if (isSupersededRuStatus(status) || !currentPlan) {
    const replacements = Array.isArray(ru.replacementRuNos) ? ru.replacementRuNos.filter(Boolean) : [];
    return {
      canReceive: false,
      code: "RU_SUPERSEDED",
      inactive: true,
      replacementRuNos: replacements,
      message: "This label has been replaced. Please use the current label.",
      userMessage: replacements.length
        ? `This label has been replaced. Please use the current label: ${replacements.join(", ")}.`
        : "This label has been replaced. Please use the current label.",
    };
  }

  if (isPlannedRuStatus(status) || !isPrintedRuStatus(status)) {
    return {
      canReceive: false,
      code: "RU_NOT_PRINTED",
      message: "This Receiving Unit has not been printed yet",
      userMessage: "This label has not been printed yet. Print and paste the label before receiving.",
    };
  }

  if (!isActiveRuStatus(status)) {
    return {
      canReceive: false,
      code: "RU_NOT_ELIGIBLE",
      message: "This Receiving Unit is not eligible for receiving",
      userMessage: "This Receiving Unit is not eligible for receiving.",
    };
  }

  return {
    canReceive: true,
    code: "OK",
    message: "",
    userMessage: "",
  };
}

export function assertQtyConfirmedForComplete(qtyConfirmed) {
  if (qtyConfirmed !== true) {
    throw new ReceivingInspectionError(
      "Confirm the actual quantity before completing this item",
      400,
      "RECEIVING_QTY_NOT_CONFIRMED"
    );
  }
}

export function assertZeroQtyCompletionPolicy({ actualQty, condition, remarks } = {}) {
  const qty = Number(actualQty);
  if (!(qty === 0)) return;
  const c = String(condition || "").trim().toUpperCase();
  if (c !== "NOT_RECEIVED") {
    throw new ReceivingInspectionError(
      "Actual quantity 0 must be recorded as NOT_RECEIVED. Missing goods are a shortage, not a rejection.",
      400,
      "RECEIVING_ZERO_QTY_CONDITION"
    );
  }
  if (!String(remarks || "").trim()) {
    throw new ReceivingInspectionError(
      "Remarks are required when actual quantity is 0",
      400,
      "RECEIVING_ZERO_QTY_REMARKS"
    );
  }
}

export function assertUnitCompletable({
  actualQty,
  condition,
  photoCount,
  minPhotosPerRU = DEFAULT_RECEIVING_MIN_PHOTOS_PER_RU,
  qtyConfirmed,
  remarks,
  plannedQty,
  acceptedQty,
  damagedQty,
  rejectedQty,
  photos,
} = {}) {
  assertReceivingActualQty(actualQty);
  assertReceivingCondition(condition, { required: true });
  assertQtyConfirmedForComplete(qtyConfirmed);
  assertZeroQtyCompletionPolicy({ actualQty, condition, remarks });
  const photosN = Number(photoCount) || 0;
  const min = Math.max(0, Number(minPhotosPerRU) || 0);
  if (photosN < min) {
    throw new ReceivingInspectionError(
      min === 1
        ? "At least one photo is required before completing this item"
        : `At least ${min} photos are required before completing this item`,
      400,
      "RECEIVING_PHOTO_REQUIRED"
    );
  }
  const resolved = resolveDispositionForComplete({
    actualQty,
    condition,
    acceptedQty,
    damagedQty,
    rejectedQty,
  });
  assertDispositionTotalsActual({ actualQty, ...resolved });
  assertConditionDispositionConsistent({
    condition: resolved.condition,
    actualQty,
    acceptedQty: resolved.acceptedQty,
    damagedQty: resolved.damagedQty,
    rejectedQty: resolved.rejectedQty,
  });
  assertDiscrepancyRemarks({
    plannedQty,
    actualQty,
    acceptedQty: resolved.acceptedQty,
    damagedQty: resolved.damagedQty,
    rejectedQty: resolved.rejectedQty,
    remarks,
  });
  assertDamagePhotoRequired({ damagedQty: resolved.damagedQty, photos: photos || [] });
  assertRejectedEvidence({
    rejectedQty: resolved.rejectedQty,
    photoCount: photosN,
    remarks,
  });
  return resolved;
}

export function nextOptimisticVersion(current) {
  const n = Number(current);
  return Number.isFinite(n) && n >= 0 ? n + 1 : 1;
}

export function assertOptimisticVersion(currentVersion, expectedVersion) {
  const cur = Number(currentVersion);
  const expected = Number(expectedVersion);
  if (!Number.isFinite(expected)) {
    throw new ReceivingInspectionError(
      "version is required to save receiving changes",
      400,
      "RECEIVING_VERSION_REQUIRED"
    );
  }
  if (!Number.isFinite(cur) || cur !== expected) {
    throw new ReceivingInspectionError(
      "This item was updated on another device. Reload the current count and try again.",
      409,
      "RECEIVING_CONFLICT"
    );
  }
}

/**
 * One active receiving session per ASN (DRAFT / IN_PROGRESS).
 * Concurrent callers: first insert wins; loser resumes the winner.
 */
export function tryStartOrResumeReceivingSession(sessions, input = {}) {
  const companyId = String(input.companyId || "");
  const asnId = String(input.asnId || "");
  const active = (sessions || []).find(
    (row) =>
      String(row.companyId) === companyId &&
      String(row.asnId) === asnId &&
      isActiveReceivingSessionStatus(row.status)
  );
  if (active) {
    return { created: false, resumed: true, session: active };
  }
  const session = {
    _id: input._id || `sess-${sessions.length + 1}`,
    companyId: input.companyId,
    sessionNo: input.sessionNo,
    asnId: input.asnId,
    asnNo: input.asnNo || "",
    status: "DRAFT",
    startedBy: input.actor || "",
    startedAt: input.now || new Date(),
    lastActivityBy: input.actor || "",
    lastActivityAt: input.now || new Date(),
    completedBy: "",
    completedAt: null,
  };
  sessions.push(session);
  return { created: true, resumed: false, session };
}

export async function raceStartOrResumeReceivingSessions({ attempts, factory }) {
  const sessions = [];
  let gate = Promise.resolve();
  const results = new Array(attempts);
  await Promise.all(
    Array.from({ length: attempts }, (_, i) => {
      const job = gate.then(() => {
        results[i] = tryStartOrResumeReceivingSession(sessions, factory(i));
        return results[i];
      });
      gate = job.then(
        () => undefined,
        () => undefined
      );
      return job;
    })
  );
  return { sessions, results };
}

export function uniqueSessionUnitKey({ companyId, receivingSessionId, receivingUnitId }) {
  return `${companyId}|${receivingSessionId}|${receivingUnitId}`;
}

export function upsertReceivingSessionUnit(units, input = {}) {
  const key = uniqueSessionUnitKey(input);
  const existing = (units || []).find(
    (row) => uniqueSessionUnitKey(row) === key && row.status !== "DELETED"
  );
  if (existing) return { created: false, unit: existing };
  const unit = {
    _id: input._id || `unit-${units.length + 1}`,
    companyId: input.companyId,
    receivingSessionId: input.receivingSessionId,
    asnId: input.asnId,
    asnLineId: input.asnLineId,
    receivingUnitId: input.receivingUnitId,
    ruNo: input.ruNo,
    article: input.article || "",
    partNo: input.partNo || "",
    description: input.description || "",
    uom: input.uom || "PCS",
    plannedQty: roundAsnQty(input.plannedQty),
    actualQty: input.actualQty == null ? null : roundAsnQty(input.actualQty),
    condition: input.condition || "",
    remarks: input.remarks || "",
    qtyConfirmed: input.qtyConfirmed === true,
    acceptedQty: input.acceptedQty == null ? null : roundAsnQty(input.acceptedQty),
    damagedQty: input.damagedQty == null ? null : roundAsnQty(input.damagedQty),
    rejectedQty: input.rejectedQty == null ? null : roundAsnQty(input.rejectedQty),
    status: "IN_PROGRESS",
    version: 1,
    photoCount: 0,
    startedBy: input.actor || "",
    startedAt: input.now || new Date(),
    lastSavedBy: input.actor || "",
    lastSavedAt: input.now || new Date(),
    completedBy: "",
    completedAt: null,
  };
  units.push(unit);
  return { created: true, unit };
}

export function applyReceivingDraftSave(unit, patch = {}) {
  if (isCompletedReceivingUnitResult(unit.status) && patch.allowCompleted !== true) {
    throw new ReceivingInspectionError(
      "This Receiving Unit inspection is already completed",
      409,
      "RECEIVING_UNIT_ALREADY_COMPLETED"
    );
  }
  if (patch.expectedVersion != null) {
    assertOptimisticVersion(unit.version, patch.expectedVersion);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "actualQty")) {
    unit.actualQty = assertReceivingActualQty(patch.actualQty);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "condition")) {
    unit.condition = assertReceivingCondition(patch.condition, { required: false });
  }
  if (Object.prototype.hasOwnProperty.call(patch, "remarks")) {
    unit.remarks = String(patch.remarks || "").trim().slice(0, 2000);
  }
  if (patch.qtyConfirmed === true) unit.qtyConfirmed = true;
  if (Object.prototype.hasOwnProperty.call(patch, "acceptedQty")) {
    unit.acceptedQty = assertReceivingDispositionQty(patch.acceptedQty, "Accepted quantity");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "damagedQty")) {
    unit.damagedQty = assertReceivingDispositionQty(patch.damagedQty, "Damaged quantity");
  }
  if (Object.prototype.hasOwnProperty.call(patch, "rejectedQty")) {
    unit.rejectedQty = assertReceivingDispositionQty(patch.rejectedQty, "Rejected quantity");
  }
  if (unit.status === "NOT_STARTED") unit.status = "IN_PROGRESS";
  unit.version = nextOptimisticVersion(unit.version);
  unit.lastSavedBy = patch.actor || unit.lastSavedBy;
  unit.lastSavedAt = patch.now || new Date();
  return unit;
}

export function applyReceivingUnitComplete(unit, { photoCount, minPhotosPerRU, actor, now, photos } = {}) {
  if (isCompletedReceivingUnitResult(unit.status)) {
    return { alreadyCompleted: true, unit };
  }
  const resolved = assertUnitCompletable({
    actualQty: unit.actualQty,
    condition: unit.condition,
    photoCount,
    minPhotosPerRU,
    qtyConfirmed: unit.qtyConfirmed,
    remarks: unit.remarks,
    plannedQty: unit.plannedQty,
    acceptedQty: unit.acceptedQty,
    damagedQty: unit.damagedQty,
    rejectedQty: unit.rejectedQty,
    photos,
  });
  unit.acceptedQty = resolved.acceptedQty;
  unit.damagedQty = resolved.damagedQty;
  unit.rejectedQty = resolved.rejectedQty;
  unit.condition = resolved.condition;
  unit.status = "COMPLETED";
  unit.completedBy = actor || unit.completedBy;
  unit.completedAt = now || new Date();
  unit.version = nextOptimisticVersion(unit.version);
  unit.lastSavedBy = actor || unit.lastSavedBy;
  unit.lastSavedAt = now || new Date();
  return { alreadyCompleted: false, unit };
}

export function applyReceivingSessionComplete(session, { allRusComplete, allDispositionValid = true, actor, now } = {}) {
  if (String(session.status || "").toUpperCase() === "COMPLETED") {
    return { alreadyCompleted: true, session };
  }
  if (!allRusComplete) {
    throw new ReceivingInspectionError(
      "Cannot complete receiving while Receiving Units are unfinished",
      409,
      "RECEIVING_SESSION_INCOMPLETE"
    );
  }
  if (!allDispositionValid) {
    throw new ReceivingInspectionError(
      "Every completed Receiving Unit must have a valid accepted/damaged/rejected disposition",
      409,
      "RECEIVING_DISPOSITION_REQUIRED"
    );
  }
  session.status = "COMPLETED";
  session.completedBy = actor || session.completedBy;
  session.completedAt = now || session.completedAt || new Date();
  session.lastActivityBy = actor || session.lastActivityBy;
  session.lastActivityAt = now || new Date();
  return { alreadyCompleted: false, session };
}

/**
 * After CAS-complete, recount active photos. If a delete raced in, revert.
 */
export function evaluateCompleteDispositionEvidence({
  status,
  damagedQty,
  rejectedQty,
  photos = [],
  photoCount,
} = {}) {
  if (String(status || "").toUpperCase() !== "COMPLETED") return { ok: true, revert: false };
  try {
    assertDamagePhotoRequired({ damagedQty, photos });
    assertRejectedEvidence({
      rejectedQty,
      photoCount: photoCount != null ? photoCount : (photos || []).length,
      remarks: "ok",
    });
    return { ok: true, revert: false };
  } catch (err) {
    return { ok: false, revert: true, code: err.code, message: err.message };
  }
}

export function evaluateCompletePhotoInvariant({ status, photoCount, minPhotosPerRU = 1 } = {}) {
  const completed = String(status || "").toUpperCase() === "COMPLETED";
  const photos = Number(photoCount) || 0;
  const min = Math.max(0, Number(minPhotosPerRU) || 0);
  if (completed && photos < min) {
    return { ok: false, revert: true };
  }
  return { ok: true, revert: false };
}

/**
 * Delete racing with Complete Item: if the RU is already COMPLETED, refuse and restore.
 */
export function evaluatePhotoDeleteAgainstUnitStatus(unitStatus) {
  if (isCompletedReceivingUnitResult(unitStatus)) {
    return { allow: false, restore: true };
  }
  return { allow: true, restore: false };
}

export function simulatePhotoDeleteVsCompleteRace({ deleteFirst, photosBefore = 1, minPhotos = 1 } = {}) {
  let photos = photosBefore;
  let status = "IN_PROGRESS";
  if (deleteFirst) {
    photos = Math.max(0, photos - 1);
    status = "COMPLETED";
    const inv = evaluateCompletePhotoInvariant({ status, photoCount: photos, minPhotosPerRU: minPhotos });
    if (inv.revert) status = "IN_PROGRESS";
  } else {
    status = "COMPLETED";
    const del = evaluatePhotoDeleteAgainstUnitStatus(status);
    if (!del.allow) {
      /* photo restored — count unchanged */
    } else {
      photos = Math.max(0, photos - 1);
    }
    const inv = evaluateCompletePhotoInvariant({ status, photoCount: photos, minPhotosPerRU: minPhotos });
    if (inv.revert) status = "IN_PROGRESS";
  }
  return {
    status,
    photos,
    invariantHolds: !(status === "COMPLETED" && photos < minPhotos),
  };
}

export function varianceQty(plannedQty, actualQty) {
  if (actualQty == null || actualQty === "") return null;
  return roundAsnQty(roundAsnQty(actualQty) - roundAsnQty(plannedQty));
}

export function canCompleteReceivingSession({ requiredRus, completedRuIds } = {}) {
  const required = (requiredRus || []).map((ru) => String(ru._id || ru.receivingUnitId || ru));
  const done = new Set((completedRuIds || []).map(String));
  const missing = required.filter((id) => !done.has(id));
  return { ok: missing.length === 0, missingRuIds: missing, requiredCount: required.length };
}

export function hasReceivingActivity(units = [], photos = []) {
  if ((photos || []).length > 0) return true;
  return (units || []).some((u) => {
    if (!u) return false;
    const status = String(u.status || "").toUpperCase();
    if (status) return true;
    if (u.startedAt) return true;
    if (u.lastSavedAt) return true;
    if (u.actualQty != null) return true;
    if (u.condition) return true;
    if (u.remarks) return true;
    return false;
  });
}

export function assertReplanBlockedByReceiving(activity) {
  if (activity) {
    throw new ReceivingUnitError(
      "Receiving has already started for this ASN. Replacing labels is blocked.",
      409,
      "RU_RECEIVING_STARTED"
    );
  }
}

export function assertAsnCancelBlockedByReceiving({ hasSession, hasResults } = {}) {
  if (hasSession || hasResults) {
    throw new ReceivingInspectionError(
      "Receiving has already started for this ASN. Cancellation is blocked.",
      409,
      "ASN_RECEIVING_STARTED"
    );
  }
}

export function groupReceivingProgressByArticle(rows = []) {
  const byKey = new Map();
  for (const row of rows) {
    const article = String(row.article || "").toUpperCase() || "UNKNOWN";
    const uom = String(row.uom || "").toUpperCase() || "PCS";
    const key = `${article}|${uom}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        article,
        description: row.description || "",
        uom,
        ruTotal: 0,
        ruCompleted: 0,
        ruInProgress: 0,
        ruPending: 0,
        plannedQty: 0,
        countedQty: 0,
        acceptedQty: 0,
        damagedQty: 0,
        rejectedQty: 0,
        photos: 0,
      });
    }
    const g = byKey.get(key);
    g.ruTotal += 1;
    const status = String(row.status || "NOT_STARTED").toUpperCase();
    if (status === "COMPLETED") g.ruCompleted += 1;
    else if (status === "IN_PROGRESS") g.ruInProgress += 1;
    else g.ruPending += 1;
    g.plannedQty = roundAsnQty(g.plannedQty + Number(row.plannedQty || 0));
    if (row.actualQty != null && Number.isFinite(Number(row.actualQty))) {
      g.countedQty = roundAsnQty(g.countedQty + Number(row.actualQty));
    }
    g.acceptedQty = roundAsnQty(g.acceptedQty + (Number(row.acceptedQty) || 0));
    g.damagedQty = roundAsnQty(g.damagedQty + (Number(row.damagedQty) || 0));
    g.rejectedQty = roundAsnQty(g.rejectedQty + (Number(row.rejectedQty) || 0));
    g.photos += Number(row.photoCount || 0);
    if (!g.description && row.description) g.description = row.description;
  }
  return [...byKey.values()];
}

export function summarizeReceivingProgress(rows = []) {
  const articles = groupReceivingProgressByArticle(rows);
  const ruTotal = rows.length;
  const ruCompleted = rows.filter((r) => String(r.status || "").toUpperCase() === "COMPLETED").length;
  const ruInProgress = rows.filter((r) => String(r.status || "").toUpperCase() === "IN_PROGRESS").length;
  const ruPending = ruTotal - ruCompleted - ruInProgress;
  const photos = rows.reduce((sum, r) => sum + (Number(r.photoCount) || 0), 0);
  const uoms = new Set(articles.map((a) => a.uom));
  const compatibleQty = uoms.size === 1;
  const totals = compatibleQty ? aggregateAsnLineDisposition(rows) : null;
  return {
    ruTotal,
    ruCompleted,
    ruInProgress,
    ruPending,
    photos,
    articles,
    plannedQty: totals ? totals.plannedQty : null,
    countedQty: compatibleQty ? articles[0]?.countedQty ?? 0 : null,
    actualQty: totals ? totals.actualQty : null,
    acceptedQty: totals ? totals.acceptedQty : null,
    damagedQty: totals ? totals.damagedQty : null,
    rejectedQty: totals ? totals.rejectedQty : null,
    variance: totals ? totals.variance : null,
    shortQty: totals ? totals.shortQty : null,
    excessQty: totals ? totals.excessQty : null,
    mixedUom: !compatibleQty,
    ...computeDispositionReadiness(rows),
  };
}

export { ReceivingUnitError, roundAsnQty, ASN_QTY_EPS };
