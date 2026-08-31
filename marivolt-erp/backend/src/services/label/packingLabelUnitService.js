/**
 * PackingLabelUnit minting, originKey idempotency, and print-lifecycle mapping.
 * Reprint never calls mint. Scan-to-pack / split are not implemented.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import PackingLabelUnit from "../../models/PackingLabelUnit.js";
import { writeAudit } from "../auditService.js";
import { nextPackingLabelNo } from "./packingLabelNumberService.js";
import { isPackingQrLandscapeV1 } from "./packingQrLandscapeV1.js";

export const PACKING_LABEL_ORIGIN_VERSION = "plu:v1";

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function oid(value) {
  const s = String(value || "").trim();
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function sourceIdString(resolved = {}) {
  if (resolved.sourceType === "POSTED_PACKING" || resolved.packingId) {
    return String(resolved.packingId || resolved.sourceId || "");
  }
  return String(resolved.allocationId || resolved.sourceId || "");
}

/**
 * Deterministic immutable origin key. No timestamp.
 * company + source type + source allocation/packing + selection fingerprint +
 * allocation line ID + physical face index + label quantity.
 */
export function buildPackingLabelOriginKey({
  companyId,
  sourceType,
  sourceId,
  fingerprint,
  allocationLineId,
  faceIndex,
  labelQty,
} = {}) {
  const canonical = [
    PACKING_LABEL_ORIGIN_VERSION,
    String(companyId || ""),
    upper(sourceType || "PRE_PACKING"),
    String(sourceId || ""),
    String(fingerprint || ""),
    String(allocationLineId || ""),
    String(Math.max(0, Math.floor(Number(faceIndex) || 0))),
    String(Math.max(0, Math.floor(Number(labelQty) || 0))),
  ].join(":");
  const digest = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
  return `${PACKING_LABEL_ORIGIN_VERSION}:${digest}`;
}

/**
 * Landscape job fingerprint includes copies so copies=3 is a different first-print
 * distribution than copies=1. 100×50 packing fingerprint is unchanged.
 */
export function buildPackingQrLandscapeSelectionFingerprint(lines = []) {
  const parts = (lines || [])
    .map((ln) => {
      const lineId = t(ln.packingLineId || ln.allocationLineId || ln.lineId);
      const packageId = t(ln.packageId);
      const qty = Math.max(0, Math.floor(Number(ln.labelQty) || 0));
      const copies = Math.max(1, Math.floor(Number(ln.lineCopies || ln.copies) || 1));
      if (packageId) return `package:${packageId}:line:${lineId}:qty:${qty}:copies:${copies}`;
      return `line:${lineId}:qty:${qty}:copies:${copies}`;
    })
    .filter(Boolean)
    .sort();
  return parts.join("|");
}

/**
 * One resolved packing line with lineCopies=N expands to N physical faces.
 * Face order is stable: line order, then copy index 0..N-1.
 */
export function expandPackingLabelPhysicalFaces(lines = [], resolved = {}) {
  const fingerprint = buildPackingQrLandscapeSelectionFingerprint(lines);
  const sourceType = upper(resolved.sourceType || resolved.mode || "PRE_PACKING");
  const sourceId = sourceIdString({ ...resolved, sourceType });
  const totalFaces = (lines || []).reduce(
    (s, ln) => s + Math.max(1, Math.floor(Number(ln.lineCopies || ln.copies) || 1)),
    0
  );
  const faces = [];
  let sequence = 0;
  for (const ln of lines || []) {
    const copies = Math.max(1, Math.floor(Number(ln.lineCopies || ln.copies) || 1));
    const labelQty = Math.max(0, Math.floor(Number(ln.labelQty) || 0));
    const allocationLineId = t(ln.allocationLineId || ln.packingLineId || ln.lineId);
    for (let faceIndex = 0; faceIndex < copies; faceIndex += 1) {
      sequence += 1;
      faces.push({
        line: ln,
        faceIndex,
        sequence,
        sequenceTotal: Math.max(1, totalFaces),
        labelQty,
        allocationLineId,
        originKey: buildPackingLabelOriginKey({
          companyId: resolved.companyId,
          sourceType,
          sourceId,
          fingerprint,
          allocationLineId,
          faceIndex,
          labelQty,
        }),
      });
    }
  }
  return { faces, fingerprint, sourceType, sourceId, totalFaces };
}

export function snapshotFromPackingFace(face, resolved = {}, signingKeyId) {
  const ln = face.line || {};
  return {
    warehouse: upper(resolved.warehouse || ""),
    signingKeyId: upper(signingKeyId),
    qrVersion: "MAR1",
    sourceType: face.sourceType || upper(resolved.sourceType || resolved.mode || "PRE_PACKING"),
    allocationId: oid(resolved.allocationId),
    allocationLineId: face.allocationLineId,
    packingId: oid(resolved.packingId),
    packageId: t(ln.packageId),
    article: upper(ln.article),
    labelQty: face.labelQty,
    orderQtySnapshot: Math.max(0, Math.floor(Number(ln.totalQty ?? ln.qty) || 0)),
    sequence: face.sequence,
    sequenceTotal: face.sequenceTotal,
    customerNameSnapshot: t(ln.customerName),
    customerPoSnapshot: t(ln.customerRef),
    mvRefSnapshot: t(resolved.sourceNo || ln.sourceNo),
    vesselPlantSnapshot: "",
    brandSnapshot: t(ln.brand),
    modelSnapshot: t(ln.modelName),
    descriptionSnapshot: t(ln.description),
    partNoSnapshot: t(ln.partNo || ln.spn),
    originKey: face.originKey,
  };
}

export function faceDataFromPackingLabelUnit(unit = {}, extra = {}) {
  return {
    customerName: unit.customerNameSnapshot || "",
    mvRef: unit.mvRefSnapshot || "",
    customerPo: unit.customerPoSnapshot || "",
    vesselPlant: unit.vesselPlantSnapshot || "",
    brand: unit.brandSnapshot || "",
    modelName: unit.modelSnapshot || "",
    article: unit.article || "",
    description: unit.descriptionSnapshot || "",
    partNo: unit.partNoSnapshot || "",
    labelQty: unit.labelQty,
    orderQty: unit.orderQtySnapshot,
    sequenceIndex: unit.sequence,
    sequenceTotal: unit.sequenceTotal,
    labelNo: unit.labelNo || "",
    previewLabelId: extra.previewLabelId || "",
    previewMode: extra.previewMode === true,
    mar1QrToken: extra.mar1QrToken || "",
    mar1LabelNo: unit.labelNo || extra.mar1LabelNo || "",
    mar1KeyId: unit.signingKeyId || extra.mar1KeyId || "",
    printAuthorized: extra.printAuthorized === true,
  };
}

function auditSafeMetadata(extra = {}) {
  const out = { ...extra };
  delete out.secret;
  delete out.encryptedSecret;
  delete out.secretRef;
  delete out.hmac;
  delete out.canonicalBytes;
  delete out.rawSignature;
  delete out.digest;
  delete out.nonce;
  delete out.iv;
  delete out.tag;
  delete out.ciphertext;
  delete out.envelope;
  delete out.encryptionKey;
  return out;
}

export async function auditPackingLabelUnit(req, { action, unit, description, metadata = {} }) {
  try {
    await writeAudit(req, {
      action: action || "OTHER",
      module: "LABELS",
      entityType: "PackingLabelUnit",
      entityId: unit?._id,
      documentNo: unit?.labelNo || "",
      description: description || `Packing label ${unit?.labelNo || ""}`,
      fromStatus: metadata.fromStatus || "",
      toStatus: metadata.toStatus || unit?.status || "",
      metadata: auditSafeMetadata({
        companyId: String(unit?.companyId || req?.companyId || ""),
        labelNo: unit?.labelNo || "",
        sourceType: unit?.sourceType || "",
        allocationId: unit?.allocationId ? String(unit.allocationId) : "",
        packingId: unit?.packingId ? String(unit.packingId) : "",
        originKey: unit?.originKey || "",
        keyId: unit?.signingKeyId || "",
        qrVersion: unit?.qrVersion || "MAR1",
        jobId: metadata.jobId ? String(metadata.jobId) : "",
        reprintReason: metadata.reprintReason || "",
        ...metadata,
      }),
    });
  } catch {
    // audit must never block printing
  }
}

async function mintOneUnit({ companyId, originKey, snapshot, createdBy, createdByUserId }) {
  const existing = await PackingLabelUnit.findOne({ companyId, originKey });
  if (existing) return { unit: existing, created: false };
  const labelNo = await nextPackingLabelNo(companyId);
  try {
    const unit = await PackingLabelUnit.create({
      companyId,
      ...snapshot,
      originKey,
      labelNo,
      barcodeValue: labelNo,
      status: "PLANNED",
      createdBy,
      createdByUserId,
    });
    return { unit, created: true };
  } catch (e) {
    if (e?.code === 11000) {
      const raced = await PackingLabelUnit.findOne({ companyId, originKey });
      if (raced) return { unit: raced, created: false };
    }
    throw e;
  }
}

/**
 * Idempotent mint: one PackingLabelUnit per physical face.
 * Retry / double-click / FAILED job retry reuses originKey matches.
 */
export async function mintPackingLabelUnits({
  req,
  resolved,
  lines,
  signingKeyId,
} = {}) {
  const companyId = oid(req?.companyId || resolved?.companyId);
  if (!companyId) {
    const err = new Error("companyId is required");
    err.statusCode = 400;
    err.code = "LABEL_COMPANY_REQUIRED";
    throw err;
  }
  const expanded = expandPackingLabelPhysicalFaces(lines || resolved?.lines || [], {
    ...resolved,
    companyId,
  });
  const createdBy = t(req?.user?.name || req?.user?.email || "");
  const createdByUserId = oid(req?.user?.id || req?.user?._id);
  const units = [];
  for (const face of expanded.faces) {
    const snapshot = snapshotFromPackingFace(face, { ...resolved, companyId }, signingKeyId);
    const { unit, created } = await mintOneUnit({
      companyId,
      originKey: face.originKey,
      snapshot,
      createdBy,
      createdByUserId,
    });
    if (created) {
      await auditPackingLabelUnit(req, {
        action: "CREATE",
        unit,
        description: `Packing label unit ${unit.labelNo} created`,
        metadata: { sourceType: unit.sourceType, keyId: unit.signingKeyId },
      });
    }
    units.push(unit);
  }
  return { ...expanded, units };
}

export async function findPackingLabelUnitsByOriginKeys(companyId, originKeys = []) {
  const cid = oid(companyId);
  const keys = [...new Set((originKeys || []).map((k) => String(k || "")).filter(Boolean))];
  if (!cid || !keys.length) return [];
  const rows = await PackingLabelUnit.find({ companyId: cid, originKey: { $in: keys } }).lean();
  const byKey = new Map(rows.map((u) => [u.originKey, u]));
  return keys.map((k) => byKey.get(k) || null);
}

export async function linkPackingLabelUnitsToJob(units = [], jobId, { firstPrint = true } = {}) {
  const id = oid(jobId);
  if (!id) return 0;
  let n = 0;
  for (const unit of units) {
    const $set = {};
    const $addToSet = { printJobIds: id };
    if (firstPrint && !unit.firstPrintJobId) $set.firstPrintJobId = id;
    const update = Object.keys($set).length ? { $set, $addToSet } : { $addToSet };
    const res = await PackingLabelUnit.updateOne({ _id: unit._id, companyId: unit.companyId }, update);
    n += res.modifiedCount || 0;
  }
  return n;
}

/**
 * Map conservative job delivery onto exact units using deterministic face order
 * (job.lines order = physical face order).
 *
 * COMPLETED + remaining 0 → all associated units PRINTED (PLANNED → PRINTED only).
 * PARTIAL → first printedLabels units.
 * UNCERTAIN / FAILED / CANCELLED / in-flight → none.
 * Reprint of already-PRINTED units does not change status.
 */
export function packingLabelUnitsToMarkPrinted(job = {}) {
  const status = String(job.status || "").toUpperCase();
  const ids = (job.lines || [])
    .map((ln) => ln.packingLabelUnitId)
    .filter(Boolean)
    .map((id) => String(id));
  if (!ids.length) return [];
  const remaining = Math.max(0, Number(job.remainingLabels) || 0);
  const printed = Math.max(0, Math.floor(Number(job.printedLabels) || 0));
  if (status === "COMPLETED" && remaining === 0) return ids;
  if (status === "PARTIAL" && printed > 0) return ids.slice(0, Math.min(printed, ids.length));
  return [];
}

export async function applyPackingLabelUnitPrintResult(job) {
  if (!job || String(job.sourceType || "").toUpperCase() !== "PACKING") {
    return { updated: 0 };
  }
  if (!isPackingQrLandscapeV1(job.templateCode)) {
    return { updated: 0 };
  }
  const ids = packingLabelUnitsToMarkPrinted(job);
  if (!ids.length) return { updated: 0, conservative: true };
  const companyId = job.companyId;
  const printedAt = new Date();
  let updated = 0;
  for (const id of ids) {
    const res = await PackingLabelUnit.updateOne(
      { companyId, _id: id, status: "PLANNED" },
      {
        $set: {
          status: "PRINTED",
          printedAt,
        },
        $addToSet: { printJobIds: job._id },
      }
    );
    updated += res.modifiedCount || 0;
  }
  return { updated, unitIds: ids };
}

export default {
  buildPackingLabelOriginKey,
  expandPackingLabelPhysicalFaces,
  mintPackingLabelUnits,
  applyPackingLabelUnitPrintResult,
  packingLabelUnitsToMarkPrinted,
};
