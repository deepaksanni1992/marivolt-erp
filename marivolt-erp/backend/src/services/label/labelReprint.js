/**
 * Shared reprint rules for POST /labels/jobs/:id/reprint.
 * Packing Builder reuses this path; Custom Packing / Label Queue remain compatible
 * when they reprint a COMPLETED parent without clientRequestId.
 */
import { isMultiLabelFaceBatchMode } from "./labelPayloadModes.js";

const PARENT_REPRINT_MESSAGES = Object.freeze({
  PENDING: "Cannot reprint a job that is still pending.",
  LEASED: "Cannot reprint a job that is currently leased to a printer.",
  PRINTING: "Cannot reprint a job that is currently printing.",
  FAILED: "Cannot reprint a failed job. Use Retry on the failed job instead.",
  CANCELLED: "Cannot reprint a cancelled job. Use Print for a new first print.",
  UNCERTAIN: "Cannot reprint an uncertain job. Confirm the printed quantity first.",
  PARTIAL: "Cannot reprint a partial job. Use Retry or Confirm qty first.",
});

export function normalizeReprintStatus(status) {
  return String(status || "").trim().toUpperCase();
}

export function isCompletedLabelJobStatus(status) {
  return normalizeReprintStatus(status) === "COMPLETED";
}

/**
 * @returns {{ ok: true } | { ok: false, status: string, code: string, message: string, statusCode: number }}
 */
export function parentReprintRejection(status) {
  const st = normalizeReprintStatus(status);
  if (st === "COMPLETED") return { ok: true };
  const message =
    PARENT_REPRINT_MESSAGES[st] || `Cannot reprint a job in status ${st || "UNKNOWN"}.`;
  return {
    ok: false,
    status: st,
    code: "LABEL_REPRINT_PARENT_NOT_COMPLETED",
    message,
    statusCode: 409,
  };
}

export function buildReprintIdempotencyKey({ parentJobId, userId, clientRequestId }) {
  const parent = String(parentJobId || "").trim();
  const user = String(userId || "anonymous").trim() || "anonymous";
  const reqId = String(clientRequestId || "").trim();
  if (!parent || !reqId) return "";
  return `reprint:${parent}:${user}:${reqId}`.slice(0, 180);
}

export function packingPhysicalLabelCount(parent = {}, lines = [], copies = 1) {
  const stored = Math.max(0, Math.floor(Number(parent.requestedLabels) || 0));
  if (stored > 0) return stored;
  const c = Math.max(1, Math.floor(Number(copies) || 1));
  return (lines || []).reduce((s, ln) => s + Math.max(1, Number(ln.lineCopies || c) || 1), 0);
}

/**
 * True when the parent stores a complete face batch that can be reprinted as-is.
 */
export function canCopyFrozenPackingFaces(parent = {}, requestedLabels = 0) {
  const n = Math.max(0, Math.floor(Number(requestedLabels) || 0));
  if (n <= 0) return false;
  if (!isMultiLabelFaceBatchMode(parent.payloadMode)) return false;
  const faces = parent.rawFacePayloads;
  if (!Array.isArray(faces) || faces.length !== n) return false;
  return faces.every((f) => typeof f === "string" && f.trim().length > 0);
}

export function cloneFrozenFacePayloads(parent = {}) {
  return (Array.isArray(parent.rawFacePayloads) ? parent.rawFacePayloads : []).map((s) =>
    String(s)
  );
}

function sameId(a, b) {
  return String(a || "") === String(b || "");
}

export function packingPrinterWarehouseOk(printer, parentWarehouse) {
  const pw = String(parentWarehouse || "").trim().toUpperCase();
  const ww = String(printer?.warehouseCode || "").trim().toUpperCase();
  if (!pw || !ww) return true;
  return pw === ww;
}

export function packingReprintPrinterWarehouseError(printer, parentWarehouse) {
  if (packingPrinterWarehouseOk(printer, parentWarehouse)) return null;
  const pw = String(parentWarehouse || "").trim().toUpperCase();
  return {
    ok: false,
    code: "LABEL_REPRINT_PRINTER_WAREHOUSE",
    message: `Printer is not eligible for warehouse ${pw}.`,
    statusCode: 400,
  };
}

export function packingReprintPrinterCompanyError(printer, companyId) {
  if (!printer || !sameId(printer.companyId, companyId)) {
    return {
      ok: false,
      code: "LABEL_REPRINT_PRINTER_NOT_FOUND",
      message: "Printer code not found or inactive",
      statusCode: 400,
    };
  }
  return null;
}

export function isOriginalPackingPrinterEligible({
  printer,
  agent,
  companyId,
  parentWarehouse,
} = {}) {
  if (!printer) return false;
  if (!sameId(printer.companyId, companyId)) return false;
  if (printer.isActive === false) return false;
  if (!String(printer.windowsPrinterName || "").trim()) return false;
  if (!agent || agent.isActive === false) return false;
  if (!packingPrinterWarehouseOk(printer, parentWarehouse)) return false;
  return true;
}

export function choosePackingReprintPrinter({
  originalEligible,
  originalPrinter,
  replacementPrinter,
} = {}) {
  if (originalEligible && originalPrinter) {
    return { printer: originalPrinter, originalUnavailable: false };
  }
  return { printer: replacementPrinter || null, originalUnavailable: true };
}

export function packingReprintShownPrinterConflict(expectedId, resolvedId) {
  const a = String(expectedId || "").trim();
  if (!a) return false;
  return a !== String(resolvedId || "").trim();
}

export function serializePackingReprintTarget(
  printer,
  { originalUnavailable = false, originalWindowsPrinterName = "" } = {}
) {
  const name = String(printer?.windowsPrinterName || printer?.code || "").trim();
  return {
    printerConfigId: printer?._id ? String(printer._id) : "",
    printerCode: printer?.code || "",
    windowsPrinterName: printer?.windowsPrinterName || "",
    warehouseCode: printer?.warehouseCode || "",
    originalUnavailable: Boolean(originalUnavailable),
    originalWindowsPrinterName: originalWindowsPrinterName || "",
    warning: originalUnavailable
      ? `The original printer is unavailable. This reprint will be sent to ${name || "the routed printer"}.`
      : "",
  };
}
