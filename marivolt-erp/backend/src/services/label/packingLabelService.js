/**
 * Packing customer sticker jobs (100×50) — reuses printer/queue infrastructure.
 * Does not mutate allocation, reservation, packing qty, or stock ledger.
 */
import mongoose from "mongoose";
import crypto from "crypto";
import StorePacking from "../../models/StorePacking.js";
import OrderAllocation from "../../models/OrderAllocation.js";
import StockBalance from "../../models/StockBalance.js";
import Item from "../../models/itemModel.js";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import { getLabelSettings } from "./labelSettingsService.js";
import { resolvePrinterForJob } from "./printerManager.js";
import {
  PACKING_STANDARD_TEMPLATE_CODE,
  ensurePackingStandardTemplate,
} from "./labelTemplateService.js";
import {
  packingLabelPreviewRows,
  packingLabelDescriptionMeta,
  buildPackingLabelBatchPayloads,
  measurePackingLabelGeometry,
} from "./tsplGenerator.js";
import {
  PACKING_QR_LANDSCAPE_V1_CODE,
  PACKING_QR_LANDSCAPE_V1_PRINT_HINT,
  faceDataFromPackingLine,
  isPackingQrLandscapeV1,
  layoutPackingQrLandscapeV1,
  layoutToSvg,
} from "./packingQrLandscapeV1.js";
import { LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH } from "./labelPayloadModes.js";
import {
  getActivePackingLabelSigningKey,
  loadPackingLabelSigningKey,
  requireActivePackingLabelSigningKey,
  signMar1TokenWithKeyDoc,
  assertPackingLabelSigningSecretReady,
  LABEL_SIGNING_KEY_REQUIRED,
} from "./packingLabelSigningService.js";
import {
  buildPackingQrLandscapeSelectionFingerprint,
  expandPackingLabelPhysicalFaces,
  faceDataFromPackingLabelUnit,
  findPackingLabelUnitsByOriginKeys,
  linkPackingLabelUnitsToJob,
  mintPackingLabelUnits,
} from "./packingLabelUnitService.js";
import { buildPackingQrLandscapeV1BatchPayloads } from "./packingQrLandscapeV1Tspl.js";
import { formatPackingQtyDisplay } from "../../utils/labelTextFit.js";
import { derivePackingLineStock } from "../../utils/packingPhysicalStock.js";
import {
  buildAllocationDocumentReferences,
} from "../../utils/allocationDocumentReferences.js";
import { auditLabelEvent, recordLabelHistory } from "./labelAudit.js";
import {
  buildPackingLabelEnqueueResponse,
  isActivePackingLabelQueueStatus,
  resolvePackingLabelIdempotencyAction,
} from "./packingLabelIdempotency.js";

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function jobNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `LBL${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function err(message, statusCode = 400, code) {
  const e = new Error(message);
  e.statusCode = statusCode;
  if (code) e.code = code;
  return e;
}

const POSTED_PACKING = new Set(["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED"]);
const MAX_COPIES = 50;

export function resolveRequestedPackingTemplateCode(body = {}) {
  const raw = String(body.templateCode ?? PACKING_STANDARD_TEMPLATE_CODE)
    .trim()
    .toUpperCase();
  if (!raw || raw === PACKING_STANDARD_TEMPLATE_CODE) return PACKING_STANDARD_TEMPLATE_CODE;
  if (isPackingQrLandscapeV1(raw) || raw === PACKING_QR_LANDSCAPE_V1_CODE) {
    return PACKING_QR_LANDSCAPE_V1_CODE;
  }
  throw err(`Unknown packing label template: ${raw}`, 400, "LABEL_TEMPLATE_UNKNOWN");
}

export async function buildPackingQrLandscapeV1PreviewFromResolved(resolved = {}, req = {}) {
  const lines = resolved.lines || [];
  const companyId = req.companyId || resolved.companyId;
  const expanded = expandPackingLabelPhysicalFaces(lines, { ...resolved, companyId });
  let existingUnits = expanded.faces.map(() => null);
  let activeKey = null;
  if (companyId) {
    try {
      existingUnits = await findPackingLabelUnitsByOriginKeys(
        companyId,
        expanded.faces.map((f) => f.originKey)
      );
    } catch {
      existingUnits = expanded.faces.map(() => null);
    }
    try {
      activeKey = await getActivePackingLabelSigningKey(companyId);
    } catch {
      activeKey = null;
    }
  }
  const labels = [];
  let allUnitsPresent = existingUnits.length > 0 && existingUnits.every(Boolean);
  let tokensReady = true;
  let overflow = false;
  const overflowCodes = [];
  let signingConfigError = null;
  if (activeKey) {
    try {
      assertPackingLabelSigningSecretReady(activeKey);
    } catch (e) {
      signingConfigError = e;
    }
  }

  for (let i = 0; i < expanded.faces.length; i += 1) {
    const face = expanded.faces[i];
    const unit = existingUnits[i];
    let data;
    let token = "";
    let printAuthorized = false;
    if (unit) {
      const key =
        (await loadPackingLabelSigningKey(companyId, unit.signingKeyId)) || activeKey;
      try {
        if (key && String(key.status || "").toUpperCase() !== "REVOKED") {
          const signed = signMar1TokenWithKeyDoc(key, unit.labelNo, { newLabel: false });
          token = signed.token;
          printAuthorized = String(key.status || "").toUpperCase() === "ACTIVE" && Boolean(token);
        } else {
          tokensReady = false;
        }
      } catch {
        tokensReady = false;
      }
      data = faceDataFromPackingLabelUnit(unit, {
        mar1QrToken: token,
        printAuthorized,
        previewMode: !token,
      });
    } else {
      allUnitsPresent = false;
      data = faceDataFromPackingLine(face.line, resolved, {
        sequenceIndex: face.sequence,
        sequenceTotal: face.sequenceTotal,
      });
      data.previewLabelId = "PREVIEW";
      data.previewMode = true;
      data.printAuthorized = false;
    }
    const layout = layoutPackingQrLandscapeV1(data);
    if (layout.ok !== true) {
      overflow = true;
      overflowCodes.push(...(layout.errorCodes || []));
    }
    labels.push({
      ...face.line,
      packingLabelUnitId: unit?._id || null,
      labelNo: unit?.labelNo || "",
      barcodeValue: unit?.barcodeValue || "",
      sequenceIndex: face.sequence,
      sequenceTotal: face.sequenceTotal,
      layout,
      svg: layoutToSvg(layout),
      previewEnabled: true,
      printEnabled: layout.printEnabled === true,
      requiresPersistentIdentity: true,
      overflow: layout.ok !== true,
      overflowCodes: layout.errorCodes || [],
      previewMode: !unit,
      vesselPlantSourceMissing: layout.fields?.vesselPlantSourceMissing === true,
    });
  }

  const signingReady = Boolean(activeKey) && !signingConfigError;
  const canQueueFirstPrint =
    signingReady && !overflow && labels.length > 0 && (!allUnitsPresent || tokensReady);
  const printEnabled =
    signingReady && !overflow && allUnitsPresent && tokensReady && labels.every((ln) => ln.layout?.ok);
  let printBlockedCode = "";
  let printBlockedMessage = "";
  if (overflow) {
    printBlockedCode = [...new Set(overflowCodes)][0] || "LABEL_GEOMETRY";
    printBlockedMessage = "Label content cannot fit. Printing is blocked.";
  } else if (!activeKey) {
    printBlockedCode = LABEL_SIGNING_KEY_REQUIRED;
    printBlockedMessage =
      "An ACTIVE packing-label signing key is required before identity creation or printing.";
  } else if (signingConfigError) {
    printBlockedCode = signingConfigError.code || LABEL_SIGNING_KEY_REQUIRED;
    printBlockedMessage =
      signingConfigError.message ||
      "An ACTIVE packing-label signing key is required before identity creation or printing.";
  } else if (!printEnabled && !canQueueFirstPrint) {
    printBlockedCode = "LABEL_IDENTITY_REQUIRED";
    printBlockedMessage = PACKING_QR_LANDSCAPE_V1_PRINT_HINT;
  }

  return {
    mode: resolved.mode,
    sourceNo: resolved.sourceNo,
    packingId: resolved.packingId,
    allocationId: resolved.allocationId,
    templateCode: PACKING_QR_LANDSCAPE_V1_CODE,
    payloadMode: printEnabled || canQueueFirstPrint ? LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH : "",
    requestedLabels: labels.length,
    descriptionTruncated: false,
    requiresTruncationConfirmation: false,
    overflowWarning: overflow ? "Label content cannot fit. Printing is blocked." : "",
    overflowDetail: overflow ? [...new Set(overflowCodes)].join(", ") : "",
    packingSelectionFingerprint: expanded.fingerprint,
    previewEnabled: true,
    printEnabled,
    canQueueFirstPrint,
    requiresPersistentIdentity: true,
    printBlockedCode,
    printBlockedMessage,
    signingKeyId: activeKey?.keyId || "",
    labels,
    tsplPayload: "",
    faceCount: labels.length,
    vesselPlantSourceMissing: labels.some((ln) => ln.vesselPlantSourceMissing),
  };
}

async function loadItemBrandModel(companyId, articles) {
  const list = [...new Set((articles || []).map((a) => upper(a)).filter(Boolean))];
  if (!list.length) return new Map();
  const items = await Item.find({ companyId, article: { $in: list } })
    .select("article brand model engine partNumber description")
    .lean();
  return new Map(items.map((it) => [upper(it.article), it]));
}

async function loadPhysicalByArticle(companyId, warehouse, articles) {
  const wh = upper(warehouse) || "MAIN";
  const list = [...new Set((articles || []).map((a) => upper(a)).filter(Boolean))];
  const stockByArticle = new Map();
  if (!list.length) return stockByArticle;
  const balances = await StockBalance.find({
    companyId,
    article: { $in: list },
    $or: [{ warehouse: wh }, { location: wh }],
  })
    .select("article warehouse location onHandQty quantity reservedQty allocatedQty packedQty")
    .lean();
  for (const b of balances) {
    const art = upper(b.article);
    const bWh = upper(b.warehouse || b.location) || "MAIN";
    if (bWh !== wh) continue;
    const prev = stockByArticle.get(art) || {
      onHandQty: 0,
      reservedQty: 0,
      allocatedQty: 0,
      packedQty: 0,
    };
    prev.onHandQty += Number(b.onHandQty ?? b.quantity) || 0;
    prev.reservedQty += Number(b.reservedQty) || 0;
    prev.allocatedQty += Number(b.allocatedQty) || 0;
    prev.packedQty += Number(b.packedQty) || 0;
    stockByArticle.set(art, prev);
  }
  return stockByArticle;
}

function normalizeMode(raw) {
  const m = upper(raw);
  if (m === "PRE_PACKING" || m === "POSTED_PACKING" || m === "REPRINT") return m;
  return "";
}

export const LABEL_REPRINT_ENDPOINT_REQUIRED = "LABEL_REPRINT_ENDPOINT_REQUIRED";

const LANDSCAPE_REPRINT_INTENT_FIELDS = ["mode", "packingMode", "action", "type", "intent", "requestType"];

function isReprintToken(raw) {
  const v = upper(raw);
  return v === "REPRINT" || v === "REPRINT_PACKING" || v === "PACKING_REPRINT";
}

/** True when a from-packing body declares reprint intent through any accepted field. */
export function packingRequestDeclaresReprintIntent(body = {}) {
  for (const field of LANDSCAPE_REPRINT_INTENT_FIELDS) {
    if (isReprintToken(body[field])) return true;
  }
  const flag = body.isReprint;
  if (flag === true || flag === 1 || upper(flag) === "TRUE" || flag === "1") return true;
  return false;
}

/**
 * Landscape enqueue via POST /labels/jobs/from-packing is first-print only.
 * True reprint must use POST /labels/jobs/:id/reprint.
 */
export function assertLandscapeFromPackingFirstPrintOnly(body = {}, templateCode) {
  const code = templateCode || resolveRequestedPackingTemplateCode(body);
  if (!isPackingQrLandscapeV1(code)) return false;
  if (!packingRequestDeclaresReprintIntent(body)) return false;
  throw err(
    "Landscape packing reprint must use POST /labels/jobs/:id/reprint on a completed job.",
    409,
    LABEL_REPRINT_ENDPOINT_REQUIRED
  );
}

/**
 * Resolve trusted packing label lines from packing and/or allocation.
 * Frontend may only supply lineId / labelQty / copies.
 */
export async function resolvePackingLabelLines(req, body = {}) {
  const companyId = req.companyId;
  const mode = normalizeMode(body.mode) || (body.packingId ? "POSTED_PACKING" : "PRE_PACKING");
  const selections = Array.isArray(body.selections) ? body.selections : [];
  if (!selections.length) throw err("Select at least one line to print", 400, "LABEL_NO_LINES");

  let packing = null;
  let allocation = null;
  let customerRef = "";
  let customerName = "";
  let headerModel = "";
  let warehouse = "MAIN";

  if (body.packingId) {
    if (!mongoose.Types.ObjectId.isValid(String(body.packingId))) {
      throw err("Invalid packing id", 400);
    }
    packing = await StorePacking.findOne({ companyId, _id: body.packingId }).lean();
    if (!packing) throw err("Packing not found", 404);
    if (mode !== "PRE_PACKING" && !POSTED_PACKING.has(upper(packing.status))) {
      throw err("Packing must be posted before official packing labels", 400, "PACKING_NOT_POSTED");
    }
    customerName = t(packing.customerName);
    customerRef = t(packing.customerReference);
    headerModel = t(packing.model) || t(packing.engine);
    warehouse = upper(packing.warehouse) || "MAIN";
    if (packing.allocationId) {
      allocation = await OrderAllocation.findOne({ companyId, _id: packing.allocationId }).lean();
    }
  } else if (body.allocationId) {
    if (!mongoose.Types.ObjectId.isValid(String(body.allocationId))) {
      throw err("Invalid allocation id", 400);
    }
    allocation = await OrderAllocation.findOne({ companyId, _id: body.allocationId }).lean();
    if (!allocation) throw err("Allocation not found", 404);
    customerName = t(allocation.customerName);
    headerModel = t(allocation.model) || t(allocation.engine);
    warehouse = upper(allocation.warehouse) || "MAIN";
    // Resolve customer ref from lineage helpers when packing snapshot absent
    try {
      const { default: OrderAcknowledgement } = await import("../../models/OrderAcknowledgement.js");
      const { default: ProformaInvoice } = await import("../../models/ProformaInvoice.js");
      const { default: Quotation } = await import("../../models/Quotation.js");
      const oa = allocation.linkedOAId
        ? await OrderAcknowledgement.findOne({ companyId, _id: allocation.linkedOAId }).lean()
        : null;
      const pi = allocation.linkedProformaId
        ? await ProformaInvoice.findOne({ companyId, _id: allocation.linkedProformaId }).lean()
        : null;
      const qtn = allocation.linkedQuotationId
        ? await Quotation.findOne({ companyId, _id: allocation.linkedQuotationId }).lean()
        : null;
      customerRef = t(
        buildAllocationDocumentReferences({ allocation, oa, pi, quotation: qtn }).customerReference
      );
    } catch {
      customerRef = t(allocation.linkedOANo ? "" : "");
    }
  } else {
    throw err("packingId or allocationId is required", 400);
  }

  const articles = [];
  if (packing) articles.push(...(packing.lines || []).map((l) => l.article));
  if (allocation) articles.push(...(allocation.lines || []).map((l) => l.article));
  const itemMap = await loadItemBrandModel(companyId, articles);
  const stockByArticle =
    mode === "PRE_PACKING" ? await loadPhysicalByArticle(companyId, warehouse, articles) : new Map();

  const allocLineById = new Map(
    (allocation?.lines || []).map((ln) => [String(ln._id), ln])
  );
  const packLineById = new Map((packing?.lines || []).map((ln) => [String(ln._id), ln]));

  const normalized = [];
  let serial = 0;
  for (const sel of selections) {
    const packingLineId = sel.packingLineId != null ? String(sel.packingLineId) : "";
    const allocationLineId = sel.allocationLineId != null ? String(sel.allocationLineId) : "";
    let packLine = packingLineId ? packLineById.get(packingLineId) : null;
    let allocLine = allocationLineId ? allocLineById.get(allocationLineId) : null;
    if (!packLine && packing && allocationLineId) {
      packLine = (packing.lines || []).find(
        (ln) => String(ln.allocationLineId) === allocationLineId
      );
    }
    if (!allocLine && packLine?.allocationLineId) {
      allocLine = allocLineById.get(String(packLine.allocationLineId));
    }
    if (!packLine && !allocLine) {
      throw err("Selection line not found on packing/allocation", 400, "LABEL_LINE_NOT_FOUND");
    }

    const article = upper(packLine?.article || allocLine?.article);
    const item = itemMap.get(article) || {};
    const totalQty = Math.max(
      0,
      Math.floor(Number(allocLine?.qty ?? packLine?.allocatedQty) || 0)
    );
    const packedQty = Math.max(0, Math.floor(Number(packLine?.packQty) || 0));
    const stock = stockByArticle.get(article) || {
      onHandQty: 0,
      reservedQty: 0,
      allocatedQty: 0,
      packedQty: 0,
    };
    const derived =
      mode === "PRE_PACKING"
        ? derivePackingLineStock(stock, {
            allocatedQty: totalQty,
            alreadyPacked: packedQty,
            isNegativeAllocation: Boolean(allocLine?.isNegativeAllocation),
          })
        : null;
    const packableCap =
      mode === "PRE_PACKING"
        ? Math.max(0, Math.floor(Number(derived?.physicalPackableQty) || 0))
        : packedQty;

    let labelQty = Number(sel.labelQty);
    if (!Number.isFinite(labelQty)) {
      labelQty = mode === "PRE_PACKING" ? packableCap : packedQty;
    }
    labelQty = Math.floor(labelQty);
    if (labelQty <= 0) {
      throw err(`Label Qty must be > 0 for ${article}`, 400, "LABEL_QTY_INVALID");
    }

    // Hard cap for all modes (PRE packable / POSTED+REPRINT packed).
    // Client allowQtyOverride is ignored — no Store-level packed-qty bypass.
    if (labelQty > packableCap + 1e-9) {
      throw err(
        mode === "PRE_PACKING"
          ? `Label Qty (${labelQty}) cannot exceed packable qty (${packableCap}) for ${article}`
          : `Label Qty (${labelQty}) cannot exceed packed qty (${packableCap}) for ${article}`,
        400,
        "LABEL_QTY_EXCEEDS_CAP"
      );
    }

    let lineCopies = Math.floor(Number(sel.copies) || 1);
    if (!Number.isFinite(lineCopies) || lineCopies < 1) {
      throw err(`Copies must be an integer >= 1 for ${article}`, 400, "LABEL_COPIES_INVALID");
    }
    if (lineCopies > MAX_COPIES) {
      throw err(`Copies cannot exceed ${MAX_COPIES} for ${article}`, 400, "LABEL_COPIES_MAX");
    }

    serial += 1;
    const description = t(packLine?.description || allocLine?.description || item.description);
    const partNo = t(packLine?.spn || allocLine?.partNumber || item.partNumber);
    const brand = t(item.brand);
    const modelName = t(item.model) || t(item.engine) || headerModel;
    const qtyDisplay = formatPackingQtyDisplay(labelQty, totalQty);
    const packageId = t(sel.packageId || packLine?.packageId || "");
    const descMeta = packingLabelDescriptionMeta({ description });

    normalized.push({
      article,
      description,
      spn: partNo,
      partNo,
      materialCode: t(packLine?.materialCode || allocLine?.materialCode || ""),
      qty: totalQty,
      totalQty,
      labelQty,
      qtyDisplay,
      uom: t(packLine?.uom || allocLine?.uom) || "PCS",
      customerName,
      customerRef,
      brand,
      modelName,
      serialNo: serial,
      lineCopies,
      packingLineId: packLine?._id ? String(packLine._id) : packingLineId,
      allocationLineId: allocLine?._id
        ? String(allocLine._id)
        : packLine?.allocationLineId
          ? String(packLine.allocationLineId)
          : allocationLineId,
      packageId,
      physicalPackableQty: packableCap,
      packedQty,
      descriptionTruncated: descMeta.descriptionTruncated,
    });
  }

  return {
    mode,
    packing,
    allocation,
    customerName,
    customerRef,
    warehouse,
    lines: normalized,
    sourceNo: packing?.packingNo || allocation?.allocationNo || "",
    sourceId: packing?._id || allocation?._id || null,
    packingId: packing?._id || null,
    allocationId: allocation?._id || packing?.allocationId || null,
  };
}

export function buildPackingSelectionFingerprint(lines = []) {
  const parts = (lines || [])
    .map((ln) => {
      const lineId = t(ln.packingLineId || ln.allocationLineId || ln.lineId);
      const packageId = t(ln.packageId);
      const qty = Math.max(0, Math.floor(Number(ln.labelQty) || 0));
      // Copies intentionally excluded — same selection + qty remains idempotent across copy retries.
      if (packageId) return `package:${packageId}:line:${lineId}:qty:${qty}`;
      return `line:${lineId}:qty:${qty}`;
    })
    .filter(Boolean)
    .sort();
  return parts.join("|");
}

export function hashPackingSelectionFingerprint(fingerprint) {
  return crypto.createHash("sha256").update(String(fingerprint || "")).digest("hex").slice(0, 16);
}

/**
 * Selection-aware official packing print key.
 * packing:{packingNo}:initial:{stableHash(sorted lineId+qty[+packageId])}
 */
export function buildInitialPackingLabelIdempotencyKey(packingNo, lines = []) {
  const no = t(packingNo);
  if (!no) return "";
  const fingerprint = buildPackingSelectionFingerprint(lines);
  const hash = hashPackingSelectionFingerprint(fingerprint);
  return `packing:${no}:initial:${hash}`;
}

/**
 * Selection-aware PRE_PACKING print key (same fingerprint hash, :pre: namespace).
 * packing:{sourceNo}:pre:{stableHash(...)}
 */
export function buildPrePackingLabelIdempotencyKey(sourceNo, lines = []) {
  const no = t(sourceNo);
  if (!no) return "";
  const fingerprint = buildPackingSelectionFingerprint(lines);
  const hash = hashPackingSelectionFingerprint(fingerprint);
  return `packing:${no}:pre:${hash}`;
}

/** Rebuild idempotency key when a packing job is requeued (Retry after cancel/fail). */
export function rebuildPackingLabelIdempotencyKey(job = {}) {
  const mode = normalizeMode(job.packingMode);
  const sourceNo = t(job.sourceNo);
  const lines = job.lines || [];
  if (!sourceNo || mode === "REPRINT") return null;
  if (isPackingQrLandscapeV1(job.templateCode) && t(job.packingSelectionFingerprint)) {
    const hash = hashPackingSelectionFingerprint(job.packingSelectionFingerprint);
    if (mode === "PRE_PACKING") return `packing:${sourceNo}:pre:${hash}`;
    if (mode === "POSTED_PACKING") return `packing:${sourceNo}:initial:${hash}`;
  }
  if (mode === "PRE_PACKING") return buildPrePackingLabelIdempotencyKey(sourceNo, lines);
  if (mode === "POSTED_PACKING") return buildInitialPackingLabelIdempotencyKey(sourceNo, lines);
  return null;
}

/**
 * Preview packing labels — same normalized lines used for TSPL_LABEL_BATCH.
 */
export async function previewPackingLabels(req, body = {}) {
  const settings = await getLabelSettings(req.companyId);
  if (!settings.enabled) {
    throw err("Label printing is disabled. Enable it in Label Settings.", 400, "LABEL_DISABLED");
  }
  const templateCode = resolveRequestedPackingTemplateCode(body);
  const resolved = await resolvePackingLabelLines(req, body);
  if (isPackingQrLandscapeV1(templateCode)) {
    return buildPackingQrLandscapeV1PreviewFromResolved(resolved, req);
  }
  await ensurePackingStandardTemplate();
  const rawFacePayloads = buildPackingLabelBatchPayloads(resolved.lines, {});
  const requestedLabels = rawFacePayloads.length;
  const descriptionTruncated = resolved.lines.some((ln) => ln.descriptionTruncated === true);
  return {
    mode: resolved.mode,
    sourceNo: resolved.sourceNo,
    packingId: resolved.packingId,
    allocationId: resolved.allocationId,
    templateCode: PACKING_STANDARD_TEMPLATE_CODE,
    payloadMode: LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH,
    requestedLabels,
    descriptionTruncated,
    requiresTruncationConfirmation: descriptionTruncated,
    overflowWarning: descriptionTruncated
      ? "Description exceeds printable area. Review label before printing."
      : "",
    overflowDetail: descriptionTruncated ? "Printed text will be truncated." : "",
    packingSelectionFingerprint: buildPackingSelectionFingerprint(resolved.lines),
    labels: resolved.lines.map((ln) => ({
      ...ln,
      previewRows: packingLabelPreviewRows(ln),
      descriptionTruncated: ln.descriptionTruncated === true,
    })),
    tsplPayload: "",
    faceCount: rawFacePayloads.length,
  };
}

/**
 * Create packing label print job. No stock / allocation / packing qty mutation.
 */
export async function createJobsFromPacking(req, body = {}) {
  const templateCode = resolveRequestedPackingTemplateCode(body);
  assertLandscapeFromPackingFirstPrintOnly(body, templateCode);

  const companyId = req.companyId;
  const settings = await getLabelSettings(companyId);
  if (!settings.enabled) {
    throw err("Label printing is disabled. Enable it in Label Settings.", 400, "LABEL_DISABLED");
  }

  const mode = normalizeMode(body.mode) || (body.packingId ? "POSTED_PACKING" : "PRE_PACKING");
  const resolved = await resolvePackingLabelLines(req, { ...body, mode });

  const descriptionTruncated = resolved.lines.some((ln) => ln.descriptionTruncated === true);
  const confirmTruncation =
    body.confirmDescriptionTruncation === true || body.confirmTruncatedDescription === true;
  if (descriptionTruncated && !confirmTruncation) {
    throw err(
      "Description exceeds printable area. Confirm truncation before printing.",
      400,
      "LABEL_DESCRIPTION_OVERFLOW"
    );
  }

  const landscape = isPackingQrLandscapeV1(templateCode);
  const fingerprint = landscape
    ? buildPackingQrLandscapeSelectionFingerprint(resolved.lines)
    : buildPackingSelectionFingerprint(resolved.lines);

  // Official / pre print: selection-aware server hash. REPRINT always new.
  // Do not trust/truncate long client keys — hash the canonical fingerprint server-side.
  let idempotencyKey = null;
  if (mode === "REPRINT") {
    idempotencyKey = null;
  } else if (resolved.sourceNo) {
    const hash = hashPackingSelectionFingerprint(fingerprint);
    if (mode === "POSTED_PACKING") {
      idempotencyKey = `packing:${t(resolved.sourceNo)}:initial:${hash}`;
    } else if (mode === "PRE_PACKING") {
      idempotencyKey = `packing:${t(resolved.sourceNo)}:pre:${hash}`;
    }
  }

  if (idempotencyKey) {
    const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
    if (existing) {
      const resolution = resolvePackingLabelIdempotencyAction(existing.status);
      if (resolution.action === "reuse" || resolution.action === "dedupe") {
        return buildPackingLabelEnqueueResponse(existing, { created: false, reused: true });
      }
      if (resolution.action === "block") {
        throw err(resolution.message, 409, resolution.code);
      }
      // CANCELLED / FAILED — release stale active claim so a new job can be inserted.
      await LabelPrintJob.updateOne(
        { _id: existing._id, companyId },
        { $unset: { idempotencyKey: "" } }
      );
    }
  }

  if (landscape) {
    return createLandscapePackingLabelJobs(req, body, {
      settings,
      mode,
      resolved,
      fingerprint,
      idempotencyKey,
      descriptionTruncated,
    });
  }

  await ensurePackingStandardTemplate();
  const printer = await resolvePrinterForJob(companyId, body.printerCode, {
    warehouseCode: resolved.warehouse,
  });

  const requestedLabels = resolved.lines.reduce(
    (s, ln) => s + Math.max(1, Number(ln.lineCopies) || 1),
    0
  );
  if (requestedLabels > settings.maxPerJob) {
    throw err(
      `Requested labels (${requestedLabels}) exceed max per job (${settings.maxPerJob})`,
      400,
      "LABEL_MAX_EXCEEDED"
    );
  }

  const rawFacePayloads = buildPackingLabelBatchPayloads(resolved.lines, {});
  if (rawFacePayloads.length !== requestedLabels) {
    throw err(
      `TSPL_LABEL_BATCH face count ${rawFacePayloads.length} != requestedLabels ${requestedLabels}`,
      400,
      "LABEL_FACE_COUNT"
    );
  }
  for (const ln of resolved.lines) {
    const g = measurePackingLabelGeometry(ln, {});
    if (!g.withinLabel || !g.qtyWithinLabel) {
      throw err("Packing label geometry exceeds 100×50 page bounds", 400, "LABEL_GEOMETRY");
    }
  }
  const jobLines = resolved.lines.map((ln) => ({
    article: ln.article,
    description: ln.description,
    spn: ln.partNo,
    partNo: ln.partNo,
    materialCode: ln.materialCode,
    qty: ln.totalQty,
    totalQty: ln.totalQty,
    labelQty: ln.labelQty,
    qtyDisplay: ln.qtyDisplay,
    uom: ln.uom,
    customerName: ln.customerName,
    customerRef: ln.customerRef,
    brand: ln.brand,
    modelName: ln.modelName,
    serialNo: ln.serialNo,
    lineCopies: ln.lineCopies,
    packingLineId: ln.packingLineId,
    allocationLineId: ln.allocationLineId,
    packageId: ln.packageId || "",
    descriptionTruncated: ln.descriptionTruncated === true,
  }));

  let job;
  try {
    job = await LabelPrintJob.create({
      companyId,
      jobNo: jobNo(),
      sourceType: "PACKING",
      sourceId: resolved.sourceId,
      sourceNo: upper(resolved.sourceNo),
      warehouseCode: t(printer.warehouseCode),
      printerConfigId: printer._id,
      agentId: upper(printer.agentId),
      windowsPrinterName: t(printer.windowsPrinterName),
      templateCode: PACKING_STANDARD_TEMPLATE_CODE,
      copies: 1,
      requestedLabels,
      printedLabels: 0,
      remainingLabels: requestedLabels,
      lines: jobLines,
      tsplPayload: "",
      payloadMode: LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH,
      rawFacePayloads,
      status: "PENDING",
      createdByUserId: req.user?.id || req.user?._id || null,
      createdByName: t(req.user?.name || req.user?.email || ""),
      idempotencyKey: mode === "REPRINT" ? null : idempotencyKey,
      isReprint: mode === "REPRINT",
      reprintReason: mode === "REPRINT" ? t(body.reason || "Packing label reprint") : "",
      packingMode: mode,
      allocationId: resolved.allocationId,
      packingId: resolved.packingId,
      descriptionTruncated,
      packingSelectionFingerprint: fingerprint,
    });
  } catch (e) {
    if (idempotencyKey && (e?.code === 11000 || String(e?.message || "").includes("duplicate"))) {
      const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
      if (existing) {
        if (isActivePackingLabelQueueStatus(existing.status)) {
          return buildPackingLabelEnqueueResponse(existing, { created: false, reused: true });
        }
        const resolution = resolvePackingLabelIdempotencyAction(existing.status);
        if (resolution.action === "reuse" || resolution.action === "dedupe") {
          return buildPackingLabelEnqueueResponse(existing, { created: false, reused: true });
        }
      }
    }
    throw e;
  }

  await recordLabelHistory({
    jobId: job._id,
    companyId,
    agentId: job.agentId,
    windowsPrinterName: job.windowsPrinterName,
    requestedQty: requestedLabels,
    printedQty: 0,
    status: "PENDING",
    templateCode: job.templateCode,
    userId: job.createdByUserId,
    userName: job.createdByName,
    event: mode === "REPRINT" ? "REPRINT:PACKING" : "ENQUEUE",
  });
  await auditLabelEvent(req, {
    action: "CREATE",
    job,
    description: `Packing label job ${job.jobNo} queued for ${resolved.sourceNo} (${mode})`,
  });
  return buildPackingLabelEnqueueResponse(job, { created: true, reused: false });
}

async function createLandscapePackingLabelJobs(
  req,
  body,
  { settings, mode, resolved, fingerprint, idempotencyKey, descriptionTruncated }
) {
  assertLandscapeFromPackingFirstPrintOnly(
    { ...body, mode, packingMode: body?.packingMode || mode },
    PACKING_QR_LANDSCAPE_V1_CODE
  );
  const companyId = req.companyId;
  const activeKey = await requireActivePackingLabelSigningKey(companyId);
  assertPackingLabelSigningSecretReady(activeKey);
  const printer = await resolvePrinterForJob(companyId, body.printerCode, {
    warehouseCode: resolved.warehouse,
  });

  const minted = await mintPackingLabelUnits({
    req,
    resolved: {
      ...resolved,
      companyId,
      sourceType: mode === "POSTED_PACKING" ? "POSTED_PACKING" : "PRE_PACKING",
      mode,
    },
    lines: resolved.lines,
    signingKeyId: activeKey.keyId,
  });

  const requestedLabels = minted.units.length;
  if (requestedLabels > settings.maxPerJob) {
    throw err(
      `Requested labels (${requestedLabels}) exceed max per job (${settings.maxPerJob})`,
      400,
      "LABEL_MAX_EXCEEDED"
    );
  }

  const faceInputs = [];
  const jobLines = [];
  for (let i = 0; i < minted.units.length; i += 1) {
    const unit = minted.units[i];
    const signed = signMar1TokenWithKeyDoc(activeKey, unit.labelNo, { newLabel: true });
    const data = faceDataFromPackingLabelUnit(unit, {
      mar1QrToken: signed.token,
      printAuthorized: true,
    });
    const layout = layoutPackingQrLandscapeV1(data);
    if (layout.ok !== true) {
      throw err(
        layout.printBlockedMessage || "Label content cannot fit. Printing is blocked.",
        409,
        layout.printBlockedCode || layout.errorCodes?.[0] || "LABEL_GEOMETRY"
      );
    }
    if (!layout.qr?.token) {
      throw err("Persisted MAR1 token is required before printing.", 409, "LABEL_IDENTITY_REQUIRED");
    }
    faceInputs.push({ layout, token: signed.token, data });
    const ln = minted.faces[i].line || {};
    jobLines.push({
      article: unit.article,
      description: unit.descriptionSnapshot,
      spn: unit.partNoSnapshot,
      partNo: unit.partNoSnapshot,
      materialCode: ln.materialCode || "",
      qty: unit.orderQtySnapshot,
      totalQty: unit.orderQtySnapshot,
      labelQty: unit.labelQty,
      qtyDisplay: formatPackingQtyDisplay(unit.labelQty, unit.orderQtySnapshot),
      uom: ln.uom || "PCS",
      customerName: unit.customerNameSnapshot,
      customerRef: unit.customerPoSnapshot,
      brand: unit.brandSnapshot,
      modelName: unit.modelSnapshot,
      serialNo: ln.serialNo || "",
      lineCopies: 1,
      packingLineId: ln.packingLineId || "",
      allocationLineId: unit.allocationLineId,
      packageId: unit.packageId || "",
      packingLabelUnitId: unit._id,
      labelId: unit.labelNo,
      barcodeValue: unit.barcodeValue,
      sequence: unit.sequence,
      sequenceTotal: unit.sequenceTotal,
      descriptionTruncated: false,
    });
  }

  let rawFacePayloads;
  try {
    rawFacePayloads = buildPackingQrLandscapeV1BatchPayloads(faceInputs).payloads;
  } catch (e) {
    throw err(e.message || "TSPL generation failed", e.statusCode || 409, e.code || "LABEL_GEOMETRY");
  }
  if (rawFacePayloads.length !== requestedLabels) {
    throw err(
      `TSPL_LABEL_BATCH face count ${rawFacePayloads.length} != requestedLabels ${requestedLabels}`,
      400,
      "LABEL_FACE_COUNT"
    );
  }

  let job;
  try {
    job = await LabelPrintJob.create({
      companyId,
      jobNo: jobNo(),
      sourceType: "PACKING",
      sourceId: resolved.sourceId,
      sourceNo: upper(resolved.sourceNo),
      warehouseCode: t(printer.warehouseCode),
      printerConfigId: printer._id,
      agentId: upper(printer.agentId),
      windowsPrinterName: t(printer.windowsPrinterName),
      templateCode: PACKING_QR_LANDSCAPE_V1_CODE,
      copies: 1,
      requestedLabels,
      printedLabels: 0,
      remainingLabels: requestedLabels,
      lines: jobLines,
      tsplPayload: "",
      payloadMode: LABEL_PAYLOAD_MODE_TSPL_LABEL_BATCH,
      rawFacePayloads,
      status: "PENDING",
      createdByUserId: req.user?.id || req.user?._id || null,
      createdByName: t(req.user?.name || req.user?.email || ""),
      idempotencyKey: mode === "REPRINT" ? null : idempotencyKey,
      isReprint: mode === "REPRINT",
      reprintReason: mode === "REPRINT" ? t(body.reason || "Packing label reprint") : "",
      packingMode: mode,
      allocationId: resolved.allocationId,
      packingId: resolved.packingId,
      descriptionTruncated,
      packingSelectionFingerprint: fingerprint,
    });
  } catch (e) {
    if (idempotencyKey && (e?.code === 11000 || String(e?.message || "").includes("duplicate"))) {
      const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
      if (existing) {
        if (isActivePackingLabelQueueStatus(existing.status)) {
          return buildPackingLabelEnqueueResponse(existing, { created: false, reused: true });
        }
        const resolution = resolvePackingLabelIdempotencyAction(existing.status);
        if (resolution.action === "reuse" || resolution.action === "dedupe") {
          return buildPackingLabelEnqueueResponse(existing, { created: false, reused: true });
        }
      }
    }
    throw e;
  }

  await linkPackingLabelUnitsToJob(minted.units, job._id, { firstPrint: true });
  await recordLabelHistory({
    jobId: job._id,
    companyId,
    agentId: job.agentId,
    windowsPrinterName: job.windowsPrinterName,
    requestedQty: requestedLabels,
    printedQty: 0,
    status: "PENDING",
    templateCode: job.templateCode,
    userId: job.createdByUserId,
    userName: job.createdByName,
    event: "ENQUEUE",
  });
  await auditLabelEvent(req, {
    action: "CREATE",
    job,
    description: `Packing QR landscape job ${job.jobNo} queued for ${resolved.sourceNo} (${mode})`,
  });
  return buildPackingLabelEnqueueResponse(job, { created: true, reused: false });
}
