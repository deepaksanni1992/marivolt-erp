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
  buildPackingRawFacePayloads,
  measurePackingLabelGeometry,
} from "./tsplGenerator.js";
import { LABEL_PAYLOAD_MODE_RAW_FACE_BATCH } from "./labelPayloadModes.js";
import { formatPackingQtyDisplay } from "../../utils/labelTextFit.js";
import { derivePackingLineStock } from "../../utils/packingPhysicalStock.js";
import {
  buildAllocationDocumentReferences,
} from "../../utils/allocationDocumentReferences.js";
import { auditLabelEvent, recordLabelHistory } from "./labelAudit.js";

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

/**
 * Preview packing labels — same normalized lines used for RAW_FACE_BATCH.
 */
export async function previewPackingLabels(req, body = {}) {
  const settings = await getLabelSettings(req.companyId);
  if (!settings.enabled) {
    throw err("Label printing is disabled. Enable it in Label Settings.", 400, "LABEL_DISABLED");
  }
  const resolved = await resolvePackingLabelLines(req, body);
  await ensurePackingStandardTemplate();
  const rawFacePayloads = buildPackingRawFacePayloads(resolved.lines, {});
  const requestedLabels = rawFacePayloads.length;
  const descriptionTruncated = resolved.lines.some((ln) => ln.descriptionTruncated === true);
  return {
    mode: resolved.mode,
    sourceNo: resolved.sourceNo,
    packingId: resolved.packingId,
    allocationId: resolved.allocationId,
    templateCode: PACKING_STANDARD_TEMPLATE_CODE,
    payloadMode: LABEL_PAYLOAD_MODE_RAW_FACE_BATCH,
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

  // Official / pre print: selection-aware server hash. REPRINT always new.
  // Do not trust/truncate long client keys — hash the canonical fingerprint server-side.
  let idempotencyKey = null;
  const fingerprint = buildPackingSelectionFingerprint(resolved.lines);
  if (mode === "REPRINT") {
    idempotencyKey = null;
  } else if (resolved.sourceNo) {
    if (mode === "POSTED_PACKING") {
      idempotencyKey = buildInitialPackingLabelIdempotencyKey(resolved.sourceNo, resolved.lines);
    } else if (mode === "PRE_PACKING") {
      idempotencyKey = buildPrePackingLabelIdempotencyKey(resolved.sourceNo, resolved.lines);
    }
  }

  if (idempotencyKey) {
    const existing = await LabelPrintJob.findOne({ companyId, idempotencyKey });
    if (existing) return existing;
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

  const rawFacePayloads = buildPackingRawFacePayloads(resolved.lines, {});
  if (rawFacePayloads.length !== requestedLabels) {
    throw err(
      `RAW_FACE_BATCH face count ${rawFacePayloads.length} != requestedLabels ${requestedLabels}`,
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
      payloadMode: LABEL_PAYLOAD_MODE_RAW_FACE_BATCH,
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
      if (existing) return existing;
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
  return job;
}
