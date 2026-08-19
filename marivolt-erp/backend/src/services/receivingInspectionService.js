/**
 * ASN Phase 3A — receiving inspection (session, drafts, photos).
 * Does not post stock, create a GRN, touch customs, or post accounting.
 */

import mongoose from "mongoose";
import AdvanceShipmentNotice from "../models/AdvanceShipmentNotice.js";
import ReceivingSession from "../models/ReceivingSession.js";
import ReceivingSessionUnit from "../models/ReceivingSessionUnit.js";
import ReceivingUnit from "../models/ReceivingUnit.js";
import ReceivingUnitPhoto from "../models/ReceivingUnitPhoto.js";
import { actorName, sameCompanyId } from "../utils/asnRules.js";
import {
  RU_ACTIVE_STATUSES,
  RU_PLAN_ELIGIBLE_ASN_STATUSES,
  ReceivingUnitError,
  isCurrentPlanRu,
} from "../utils/receivingUnitRules.js";
import {
  ReceivingInspectionError,
  assertOptimisticVersion,
  assertReceivingActualQty,
  assertReceivingCondition,
  assertReceivingPhotoUpload,
  assertUnitCompletable,
  evaluateReceivingScanEligibility,
  evaluateCompletePhotoInvariant,
  evaluatePhotoDeleteAgainstUnitStatus,
  isActiveReceivingSessionStatus,
  isCompletedReceivingUnitResult,
  normalizePhotoCategory,
  receivingPhotoSettingsFromEnv,
  summarizeReceivingProgress,
  varianceQty,
} from "../utils/receivingInspectionRules.js";
import { getReceivingUnitByBarcode, getReceivingUnitById } from "./receivingUnitService.js";
import { nextReceivingSessionNo } from "./receivingSessionNumberService.js";
import { writeAudit } from "./auditService.js";
import {
  buildReceivingPhotoObjectKey,
  deleteFileFromS3,
  getSignedFileUrl,
  uploadFileToS3,
} from "./s3UploadService.js";

function t(v) {
  return String(v ?? "").trim();
}

function oid(value) {
  const s = String(value || "").trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function isDupKey(err) {
  return Number(err?.code) === 11000;
}

function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  return "jpg";
}

function snapshotFromRu(ru) {
  return {
    ruNo: ru.ruNo,
    article: ru.article || "",
    partNo: ru.partNo || "",
    description: ru.description || "",
    uom: ru.uom || "PCS",
    plannedQty: ru.plannedQty,
  };
}

function serializeSession(session) {
  if (!session) return null;
  return {
    _id: session._id,
    companyId: session.companyId,
    sessionNo: session.sessionNo,
    asnId: session.asnId,
    asnNo: session.asnNo,
    status: session.status,
    startedBy: session.startedBy,
    startedAt: session.startedAt,
    lastActivityBy: session.lastActivityBy,
    lastActivityAt: session.lastActivityAt,
    completedBy: session.completedBy,
    completedAt: session.completedAt,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function serializeUnit(unit, extras = {}) {
  if (!unit) return null;
  const planned = Number(unit.plannedQty) || 0;
  const actual = unit.actualQty == null ? null : Number(unit.actualQty);
  return {
    _id: unit._id,
    companyId: unit.companyId,
    receivingSessionId: unit.receivingSessionId,
    asnId: unit.asnId,
    asnLineId: unit.asnLineId,
    receivingUnitId: unit.receivingUnitId,
    ruNo: unit.ruNo,
    article: unit.article,
    partNo: unit.partNo,
    description: unit.description,
    uom: unit.uom,
    plannedQty: planned,
    actualQty: actual,
    variance: varianceQty(planned, actual),
    condition: unit.condition || "",
    remarks: unit.remarks || "",
    qtyConfirmed: unit.qtyConfirmed === true,
    status: unit.status,
    version: Number(unit.version) || 0,
    photoCount: extras.photoCount != null ? extras.photoCount : Number(unit.photoCount) || 0,
    photos: extras.photos || undefined,
    startedBy: unit.startedBy,
    startedAt: unit.startedAt,
    completedBy: unit.completedBy,
    completedAt: unit.completedAt,
    lastSavedBy: unit.lastSavedBy,
    lastSavedAt: unit.lastSavedAt,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
  };
}

function serializePhoto(photo) {
  if (!photo) return null;
  return {
    _id: photo._id,
    receivingSessionId: photo.receivingSessionId,
    receivingSessionUnitId: photo.receivingSessionUnitId,
    receivingUnitId: photo.receivingUnitId,
    category: photo.category || "",
    remarks: photo.remarks || "",
    mimeType: photo.mimeType,
    sizeBytes: photo.sizeBytes,
    width: photo.width,
    height: photo.height,
    originalFilename: photo.originalFilename,
    clientUploadId: photo.clientUploadId || "",
    capturedBy: photo.capturedBy,
    capturedAt: photo.capturedAt,
    uploadedAt: photo.uploadedAt,
    sequence: photo.sequence,
    status: photo.status,
  };
}

async function loadAsn(companyId, asnId) {
  const id = oid(asnId);
  if (!id) throw new ReceivingInspectionError("ASN id is required", 400, "RECEIVING_ASN_REQUIRED");
  const asn = await AdvanceShipmentNotice.findOne({ _id: id, companyId }).lean();
  if (!asn) throw new ReceivingInspectionError("ASN not found", 404, "RECEIVING_ASN_NOT_FOUND");
  if (!sameCompanyId(asn.companyId, companyId)) {
    throw new ReceivingInspectionError("ASN does not belong to this company", 403, "RECEIVING_COMPANY_MISMATCH");
  }
  return asn;
}

function assertAsnReceivable(asn) {
  const status = String(asn?.status || "").toUpperCase();
  if (status === "CANCELLED") {
    throw new ReceivingInspectionError("Cannot receive a cancelled ASN", 409, "ASN_CANCELLED");
  }
  if (!RU_PLAN_ELIGIBLE_ASN_STATUSES.includes(status)) {
    throw new ReceivingInspectionError(
      "Receiving is only available for shipped or arrived ASNs",
      409,
      "ASN_NOT_RECEIVABLE"
    );
  }
}

async function loadSession(companyId, sessionId) {
  const id = oid(sessionId);
  if (!id) throw new ReceivingInspectionError("Receiving session id is required", 400, "RECEIVING_SESSION_REQUIRED");
  const session = await ReceivingSession.findOne({ _id: id, companyId });
  if (!session) throw new ReceivingInspectionError("Receiving session not found", 404, "RECEIVING_SESSION_NOT_FOUND");
  return session;
}

async function findActiveSession(companyId, asnId) {
  return ReceivingSession.findOne({
    companyId,
    asnId,
    status: { $in: ["DRAFT", "IN_PROGRESS"] },
  });
}

async function loadCurrentRus(companyId, asn) {
  const rus = await ReceivingUnit.find({
      companyId,
      asnId: asn._id,
      status: { $in: [...RU_ACTIVE_STATUSES] },
    })
    .sort({ article: 1, ruNo: 1 })
    .lean();
  const current = [];
  for (const ru of rus) {
    const line = (asn.lines || []).find((ln) => String(ln._id) === String(ru.asnLineId));
    if (isCurrentPlanRu(ru, line?.ruActivePlanBatchId)) current.push(ru);
  }
  return current;
}

async function photoCountForUnit(companyId, receivingSessionUnitId) {
  return ReceivingUnitPhoto.countDocuments({
    companyId,
    receivingSessionUnitId,
    status: "ACTIVE",
  });
}

async function listActivePhotos(companyId, receivingSessionUnitId) {
  const rows = await ReceivingUnitPhoto.find({
    companyId,
    receivingSessionUnitId,
    status: "ACTIVE",
  })
    .sort({ sequence: 1, createdAt: 1 })
    .lean();
  return rows.map(serializePhoto);
}

async function touchSession(session, actor) {
  session.lastActivityBy = actor;
  session.lastActivityAt = new Date();
  if (session.status === "DRAFT") session.status = "IN_PROGRESS";
  await session.save();
}

export function getReceivingClientSettings() {
  return receivingPhotoSettingsFromEnv();
}

export async function startOrResumeReceivingSession(req, body = {}) {
  const companyId = req.companyId;
  const asn = await loadAsn(companyId, body.asnId);
  assertAsnReceivable(asn);
  const currentRus = await loadCurrentRus(companyId, asn);
  if (!currentRus.length) {
    throw new ReceivingInspectionError(
      "No current Receiving Units exist for this ASN. Prepare and print labels first.",
      409,
      "RECEIVING_NO_CURRENT_RUS"
    );
  }

  const existing = await findActiveSession(companyId, asn._id);
  if (existing) {
    return { created: false, resumed: true, session: serializeSession(existing) };
  }

  const sessionNo = await nextReceivingSessionNo({
    companyId,
    companyCode: req.companyCode || req.company?.code || "",
  });
  const actor = actorName(req);
  try {
    const created = await ReceivingSession.create({
      companyId,
      sessionNo,
      asnId: asn._id,
      asnNo: asn.asnNo,
      status: "DRAFT",
      startedBy: actor,
      startedAt: new Date(),
      lastActivityBy: actor,
      lastActivityAt: new Date(),
    });
    await writeAudit(req, {
      action: "RECEIVING_SESSION_STARTED",
      module: "STORE",
      entityType: "RECEIVING_SESSION",
      entityId: created._id,
      documentNo: created.sessionNo,
      description: `Receiving session ${created.sessionNo} started for ${asn.asnNo}`,
      toStatus: "DRAFT",
      metadata: { asnId: String(asn._id), asnNo: asn.asnNo },
    });
    return { created: true, resumed: false, session: serializeSession(created) };
  } catch (err) {
    if (!isDupKey(err)) throw err;
    const raced = await findActiveSession(companyId, asn._id);
    if (!raced) throw err;
    return { created: false, resumed: true, session: serializeSession(raced) };
  }
}

export async function getReceivingSession(req, sessionId) {
  const session = await loadSession(req.companyId, sessionId);
  return serializeSession(session);
}

export async function getActiveSessionForAsn(req, asnId) {
  const asn = await loadAsn(req.companyId, asnId);
  const session = await findActiveSession(req.companyId, asn._id);
  if (session) return { session: serializeSession(session), asnNo: asn.asnNo };
  const completed = await ReceivingSession.findOne({
    companyId: req.companyId,
    asnId: asn._id,
    status: "COMPLETED",
  })
    .sort({ completedAt: -1 })
    .lean();
  return { session: serializeSession(completed), asnNo: asn.asnNo, completed: Boolean(completed) };
}

export async function scanReceivingBarcode(req, barcode) {
  const companyId = req.companyId;
  let ruPayload;
  try {
    ruPayload = await getReceivingUnitByBarcode(companyId, barcode);
  } catch (err) {
    if (err instanceof ReceivingUnitError && (err.status === 404 || err.code === "RU_NOT_FOUND")) {
      throw new ReceivingInspectionError("Barcode not found", 404, "BARCODE_NOT_FOUND");
    }
    throw err;
  }

  const eligibility = evaluateReceivingScanEligibility(ruPayload, { current: ruPayload.current === true });
  const asn = await loadAsn(companyId, ruPayload.asnId);
  const session = await findActiveSession(companyId, ruPayload.asnId);
  let unit = null;
  let photos = [];
  let photoCount = 0;
  if (session) {
    const existing = await ReceivingSessionUnit.findOne({
      companyId,
      receivingSessionId: session._id,
      receivingUnitId: ruPayload._id,
    }).lean();
    if (existing) {
      photos = await listActivePhotos(companyId, existing._id);
      photoCount = photos.length;
      unit = serializeUnit(existing, { photos, photoCount });
    }
  }

  return {
    canReceive: eligibility.canReceive,
    code: eligibility.code,
    message: eligibility.userMessage || eligibility.message,
    ru: ruPayload,
    sourcePoNo: asn.sourcePoNo || "",
    eligibility,
    session: serializeSession(session),
    result: unit,
    photoCount,
    photos,
  };
}

async function ensureSessionUnit(req, session, ru) {
  const companyId = req.companyId;
  const existing = await ReceivingSessionUnit.findOne({
    companyId,
    receivingSessionId: session._id,
    receivingUnitId: ru._id,
  });
  if (existing) return existing;
  const actor = actorName(req);
  const snap = snapshotFromRu(ru);
  try {
    const created = await ReceivingSessionUnit.create({
      companyId,
      receivingSessionId: session._id,
      asnId: session.asnId,
      asnLineId: ru.asnLineId,
      receivingUnitId: ru._id,
      ...snap,
      status: "NOT_STARTED",
      version: 0,
      startedBy: actor,
      startedAt: new Date(),
    });
    await writeAudit(req, {
      action: "RECEIVING_UNIT_STARTED",
      module: "STORE",
      entityType: "RECEIVING_SESSION_UNIT",
      entityId: created._id,
      documentNo: ru.ruNo,
      description: `Receiving started for ${ru.ruNo}`,
      toStatus: "NOT_STARTED",
      metadata: {
        receivingSessionId: String(session._id),
        receivingUnitId: String(ru._id),
        asnId: String(session.asnId),
      },
    });
    return created;
  } catch (err) {
    if (!isDupKey(err)) throw err;
    const raced = await ReceivingSessionUnit.findOne({
      companyId,
      receivingSessionId: session._id,
      receivingUnitId: ru._id,
    });
    if (!raced) throw err;
    return raced;
  }
}

async function loadAuthorizedRuForSession(req, session, ruId) {
  const ru = await getReceivingUnitById(req.companyId, ruId);
  if (String(ru.asnId) !== String(session.asnId)) {
    throw new ReceivingInspectionError("Receiving Unit does not belong to this session", 409, "RECEIVING_RU_SESSION_MISMATCH");
  }
  const lookup = await getReceivingUnitByBarcode(req.companyId, ru.barcodeValue || ru.ruNo);
  const eligibility = evaluateReceivingScanEligibility(lookup, { current: lookup.current === true });
  if (!eligibility.canReceive && !isCompletedReceivingUnitResult(
    (await ReceivingSessionUnit.findOne({
      companyId: req.companyId,
      receivingSessionId: session._id,
      receivingUnitId: ru._id,
    }).select("status").lean())?.status
  )) {
    throw new ReceivingInspectionError(eligibility.userMessage || eligibility.message, 409, eligibility.code);
  }
  return lookup;
}

export async function saveReceivingDraft(req, sessionId, ruId, body = {}) {
  const session = await loadSession(req.companyId, sessionId);
  if (!isActiveReceivingSessionStatus(session.status)) {
    throw new ReceivingInspectionError("Receiving session is not active", 409, "RECEIVING_SESSION_NOT_ACTIVE");
  }
  const ru = await loadAuthorizedRuForSession(req, session, ruId);
  const unit = await ensureSessionUnit(req, session, ru);
  if (isCompletedReceivingUnitResult(unit.status)) {
    throw new ReceivingInspectionError(
      "This Receiving Unit inspection is already completed",
      409,
      "RECEIVING_UNIT_ALREADY_COMPLETED"
    );
  }

  const isNew = Number(unit.version) === 0 && unit.status === "NOT_STARTED";
  const expectedVersion = isNew
    ? body.version == null
      ? Number(unit.version) || 0
      : Number(body.version)
    : Number(body.version);
  if (!isNew || body.version != null) {
    assertOptimisticVersion(unit.version, expectedVersion);
  }

  const set = {
    lastSavedBy: actorName(req),
    lastSavedAt: new Date(),
    status: "IN_PROGRESS",
  };
  if (Object.prototype.hasOwnProperty.call(body, "actualQty")) {
    set.actualQty = assertReceivingActualQty(body.actualQty);
  }
  if (Object.prototype.hasOwnProperty.call(body, "condition")) {
    set.condition = assertReceivingCondition(body.condition, { required: false });
  }
  if (Object.prototype.hasOwnProperty.call(body, "remarks")) {
    set.remarks = t(body.remarks).slice(0, 2000);
  }
  if (body.qtyConfirmed === true) set.qtyConfirmed = true;

  const updated = await ReceivingSessionUnit.findOneAndUpdate(
    {
      _id: unit._id,
      companyId: req.companyId,
      status: { $ne: "COMPLETED" },
      version: Number(unit.version) || 0,
    },
    { $set: set, $inc: { version: 1 } },
    { new: true }
  );
  if (!updated) {
    const current = await ReceivingSessionUnit.findOne({ _id: unit._id, companyId: req.companyId }).lean();
    if (isCompletedReceivingUnitResult(current?.status)) {
      throw new ReceivingInspectionError(
        "This Receiving Unit inspection is already completed",
        409,
        "RECEIVING_UNIT_ALREADY_COMPLETED"
      );
    }
    throw new ReceivingInspectionError(
      "This item was updated on another device. Reload the current count and try again.",
      409,
      "RECEIVING_CONFLICT"
    );
  }

  const actor = actorName(req);
  await touchSession(session, actor);

  if (body.explicit === true) {
    await writeAudit(req, {
      action: "RECEIVING_DRAFT_SAVED",
      module: "STORE",
      entityType: "RECEIVING_SESSION_UNIT",
      entityId: updated._id,
      documentNo: updated.ruNo,
      description: `Receiving draft saved for ${updated.ruNo}`,
      metadata: { version: updated.version, receivingSessionId: String(session._id) },
    });
  }

  const photos = await listActivePhotos(req.companyId, updated._id);
  return serializeUnit(updated, { photos, photoCount: photos.length });
}

export async function completeReceivingUnit(req, sessionId, ruId, body = {}) {
  const settings = receivingPhotoSettingsFromEnv();
  const session = await loadSession(req.companyId, sessionId);
  if (!isActiveReceivingSessionStatus(session.status)) {
    throw new ReceivingInspectionError("Receiving session is not active", 409, "RECEIVING_SESSION_NOT_ACTIVE");
  }
  const ru = await loadAuthorizedRuForSession(req, session, ruId);
  const unit = await ensureSessionUnit(req, session, ru);

  if (isCompletedReceivingUnitResult(unit.status)) {
    const photos = await listActivePhotos(req.companyId, unit._id);
    return { alreadyCompleted: true, result: serializeUnit(unit, { photos, photoCount: photos.length }) };
  }

  assertOptimisticVersion(unit.version, body.version);
  const set = {};
  if (Object.prototype.hasOwnProperty.call(body, "actualQty")) {
    set.actualQty = assertReceivingActualQty(body.actualQty);
  }
  if (Object.prototype.hasOwnProperty.call(body, "condition")) {
    set.condition = assertReceivingCondition(body.condition, { required: true });
  }
  if (Object.prototype.hasOwnProperty.call(body, "remarks")) {
    set.remarks = t(body.remarks).slice(0, 2000);
  }
  if (body.qtyConfirmed === true) set.qtyConfirmed = true;

  const merged = {
    actualQty: Object.prototype.hasOwnProperty.call(set, "actualQty") ? set.actualQty : unit.actualQty,
    condition: Object.prototype.hasOwnProperty.call(set, "condition") ? set.condition : unit.condition,
    remarks: Object.prototype.hasOwnProperty.call(set, "remarks") ? set.remarks : unit.remarks,
    qtyConfirmed: set.qtyConfirmed === true ? true : unit.qtyConfirmed,
  };
  const photosBefore = await listActivePhotos(req.companyId, unit._id);
  assertUnitCompletable({
    actualQty: merged.actualQty,
    condition: merged.condition,
    remarks: merged.remarks,
    photoCount: photosBefore.length,
    minPhotosPerRU: settings.minPhotosPerRU,
    qtyConfirmed: merged.qtyConfirmed,
  });

  const actor = actorName(req);
  const now = new Date();
  const completed = await ReceivingSessionUnit.findOneAndUpdate(
    {
      _id: unit._id,
      companyId: req.companyId,
      status: { $ne: "COMPLETED" },
      version: Number(unit.version) || 0,
    },
    {
      $set: {
        ...set,
        qtyConfirmed: merged.qtyConfirmed,
        status: "COMPLETED",
        completedBy: actor,
        completedAt: now,
        lastSavedBy: actor,
        lastSavedAt: now,
      },
      $inc: { version: 1 },
    },
    { new: true }
  );

  if (!completed) {
    const current = await ReceivingSessionUnit.findOne({ _id: unit._id, companyId: req.companyId });
    if (isCompletedReceivingUnitResult(current?.status)) {
      const photos = await listActivePhotos(req.companyId, current._id);
      return { alreadyCompleted: true, result: serializeUnit(current, { photos, photoCount: photos.length }) };
    }
    throw new ReceivingInspectionError(
      "This item was updated on another device. Reload the current count and try again.",
      409,
      "RECEIVING_CONFLICT"
    );
  }

  const photosAfter = await listActivePhotos(req.companyId, completed._id);
  const invariant = evaluateCompletePhotoInvariant({
    status: completed.status,
    photoCount: photosAfter.length,
    minPhotosPerRU: settings.minPhotosPerRU,
  });
  if (invariant.revert) {
    await ReceivingSessionUnit.findOneAndUpdate(
      { _id: completed._id, companyId: req.companyId, status: "COMPLETED", version: completed.version },
      {
        $set: {
          status: "IN_PROGRESS",
          completedBy: "",
          completedAt: null,
        },
        $inc: { version: 1 },
      }
    );
    throw new ReceivingInspectionError(
      "At least one photo is required before completing this item",
      400,
      "RECEIVING_PHOTO_REQUIRED"
    );
  }

  await touchSession(session, actor);
  await writeAudit(req, {
    action: "RECEIVING_UNIT_COMPLETED",
    module: "STORE",
    entityType: "RECEIVING_SESSION_UNIT",
    entityId: completed._id,
    documentNo: completed.ruNo,
    description: `Receiving completed for ${completed.ruNo}`,
    toStatus: "COMPLETED",
    metadata: {
      actualQty: completed.actualQty,
      condition: completed.condition,
      photoCount: photosAfter.length,
      receivingSessionId: String(session._id),
    },
  });
  return { alreadyCompleted: false, result: serializeUnit(completed, { photos: photosAfter, photoCount: photosAfter.length }) };
}

export async function uploadReceivingPhoto(req, sessionId, ruId, file, body = {}) {
  const settings = receivingPhotoSettingsFromEnv();
  const session = await loadSession(req.companyId, sessionId);
  if (!isActiveReceivingSessionStatus(session.status)) {
    throw new ReceivingInspectionError("Receiving session is not active", 409, "RECEIVING_SESSION_NOT_ACTIVE");
  }
  const ru = await loadAuthorizedRuForSession(req, session, ruId);
  const unit = await ensureSessionUnit(req, session, ru);
  const clientUploadId = t(body.clientUploadId);

  if (clientUploadId) {
    const existing = await ReceivingUnitPhoto.findOne({
      companyId: req.companyId,
      receivingSessionUnitId: unit._id,
      clientUploadId,
    }).lean();
    if (existing && existing.status === "ACTIVE") {
      const photos = await listActivePhotos(req.companyId, unit._id);
      return {
        photo: serializePhoto(existing),
        duplicate: true,
        result: serializeUnit(unit, { photos, photoCount: photos.length }),
      };
    }
    if (existing && existing.status === "DELETED") {
      throw new ReceivingInspectionError(
        "That capture was removed. Take a new photo.",
        409,
        "RECEIVING_PHOTO_RETRY_STALE"
      );
    }
  }

  const authorizedOpen = !isCompletedReceivingUnitResult(unit.status);
  if (!authorizedOpen) {
    throw new ReceivingInspectionError(
      "Cannot add photos after this item is completed",
      409,
      "RECEIVING_UNIT_ALREADY_COMPLETED"
    );
  }

  const checked = assertReceivingPhotoUpload({
    mimeType: file?.mimetype,
    sizeBytes: file?.size || file?.buffer?.length,
    maxBytes: settings.maxBytes,
    buffer: file?.buffer,
  });
  const category = normalizePhotoCategory(body.category);
  const actor = actorName(req);
  const key = buildReceivingPhotoObjectKey({
    companyId: req.companyId,
    companyCode: req.companyCode || req.company?.code || "",
    sessionId: session._id,
    ruNo: ru.ruNo,
    ext: extFromMime(checked.mimeType),
  });

  const uploaded = await uploadFileToS3(file, "receiving", {
    key,
    contentType: checked.mimeType,
    companyCode: req.companyCode || req.company?.code || "",
  });

  const last = await ReceivingUnitPhoto.findOne({
    companyId: req.companyId,
    receivingSessionUnitId: unit._id,
  })
    .sort({ sequence: -1 })
    .select("sequence")
    .lean();
  const sequence = (Number(last?.sequence) || 0) + 1;
  const width = Number(body.width);
  const height = Number(body.height);

  try {
    const photo = await ReceivingUnitPhoto.create({
      companyId: req.companyId,
      receivingSessionId: session._id,
      receivingSessionUnitId: unit._id,
      receivingUnitId: ru._id,
      asnId: session.asnId,
      asnLineId: ru.asnLineId,
      category,
      remarks: t(body.remarks).slice(0, 500),
      storageKey: uploaded.key,
      storageBucket: uploaded.bucket,
      storageProvider: uploaded.provider || "AWS_S3",
      mimeType: checked.mimeType,
      sizeBytes: checked.sizeBytes,
      width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
      height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
      originalFilename: t(file.originalname).slice(0, 180),
      clientUploadId,
      capturedBy: actor,
      capturedAt: body.capturedAt ? new Date(body.capturedAt) : new Date(),
      uploadedAt: new Date(),
      sequence,
      status: "ACTIVE",
    });
    await touchSession(session, actor);
    await writeAudit(req, {
      action: "RECEIVING_PHOTO_ADDED",
      module: "STORE",
      entityType: "RECEIVING_UNIT_PHOTO",
      entityId: photo._id,
      documentNo: ru.ruNo,
      description: `Receiving photo added for ${ru.ruNo}`,
      metadata: {
        receivingSessionId: String(session._id),
        receivingUnitId: String(ru._id),
        category,
        sizeBytes: checked.sizeBytes,
      },
    });
    const latestUnit = await ReceivingSessionUnit.findOne({ _id: unit._id, companyId: req.companyId });
    const photos = await listActivePhotos(req.companyId, unit._id);
    return {
      photo: serializePhoto(photo),
      duplicate: false,
      result: serializeUnit(latestUnit || unit, { photos, photoCount: photos.length }),
    };
  } catch (err) {
    if (isDupKey(err) && clientUploadId) {
      try {
        await deleteFileFromS3(uploaded.key, uploaded.bucket);
      } catch (cleanupErr) {
        console.warn("[receiving] S3 cleanup after duplicate photo retry:", cleanupErr?.message || cleanupErr);
      }
      const existing = await ReceivingUnitPhoto.findOne({
        companyId: req.companyId,
        receivingSessionUnitId: unit._id,
        clientUploadId,
      }).lean();
      if (existing && existing.status === "ACTIVE") {
        const photos = await listActivePhotos(req.companyId, unit._id);
        return {
          photo: serializePhoto(existing),
          duplicate: true,
          result: serializeUnit(unit, { photos, photoCount: photos.length }),
        };
      }
    }
    try {
      await deleteFileFromS3(uploaded.key, uploaded.bucket);
    } catch (cleanupErr) {
      console.warn("[receiving] S3 cleanup after photo metadata failure:", cleanupErr?.message || cleanupErr);
    }
    throw new ReceivingInspectionError(
      "Photo uploaded but could not be saved. Please retry.",
      500,
      "RECEIVING_PHOTO_METADATA_FAILED"
    );
  }
}

export async function deleteReceivingPhoto(req, sessionId, photoId) {
  const session = await loadSession(req.companyId, sessionId);
  const photo = await ReceivingUnitPhoto.findOne({
    _id: oid(photoId),
    companyId: req.companyId,
    receivingSessionId: session._id,
  });
  if (!photo) throw new ReceivingInspectionError("Photo not found", 404, "RECEIVING_PHOTO_NOT_FOUND");
  const unit = await ReceivingSessionUnit.findOne({
    _id: photo.receivingSessionUnitId,
    companyId: req.companyId,
  });
  if (!unit) throw new ReceivingInspectionError("Receiving result not found", 404, "RECEIVING_UNIT_NOT_FOUND");
  const against = evaluatePhotoDeleteAgainstUnitStatus(unit.status);
  if (!against.allow || !isActiveReceivingSessionStatus(session.status)) {
    throw new ReceivingInspectionError(
      "Photos cannot be deleted after receiving is completed",
      409,
      "RECEIVING_PHOTO_LOCKED"
    );
  }
  if (photo.status === "DELETED") {
    const photos = await listActivePhotos(req.companyId, unit._id);
    return { ok: true, alreadyDeleted: true, result: serializeUnit(unit, { photos, photoCount: photos.length }) };
  }

  const actor = actorName(req);
  const deleted = await ReceivingUnitPhoto.findOneAndUpdate(
    { _id: photo._id, companyId: req.companyId, status: "ACTIVE" },
    { $set: { status: "DELETED", deletedBy: actor, deletedAt: new Date() } },
    { new: true }
  );
  if (!deleted) {
    const photos = await listActivePhotos(req.companyId, unit._id);
    return { ok: true, alreadyDeleted: true, result: serializeUnit(unit, { photos, photoCount: photos.length }) };
  }

  const unitAfter = await ReceivingSessionUnit.findOne({ _id: unit._id, companyId: req.companyId });
  if (evaluatePhotoDeleteAgainstUnitStatus(unitAfter?.status).restore) {
    await ReceivingUnitPhoto.findOneAndUpdate(
      { _id: photo._id, companyId: req.companyId },
      { $set: { status: "ACTIVE", deletedBy: "", deletedAt: null } }
    );
    throw new ReceivingInspectionError(
      "Photos cannot be deleted after receiving is completed",
      409,
      "RECEIVING_PHOTO_LOCKED"
    );
  }

  try {
    await deleteFileFromS3(deleted.storageKey, deleted.storageBucket);
  } catch (cleanupErr) {
    console.warn("[receiving] S3 delete after mistaken draft photo:", cleanupErr?.message || cleanupErr);
  }

  await touchSession(session, actor);
  await writeAudit(req, {
    action: "RECEIVING_PHOTO_REMOVED",
    module: "STORE",
    entityType: "RECEIVING_UNIT_PHOTO",
    entityId: photo._id,
    documentNo: unit.ruNo,
    description: `Receiving photo removed for ${unit.ruNo}`,
    metadata: { receivingSessionId: String(session._id), receivingUnitId: String(unit.receivingUnitId) },
  });
  const photos = await listActivePhotos(req.companyId, unit._id);
  return { ok: true, alreadyDeleted: false, result: serializeUnit(unitAfter || unit, { photos, photoCount: photos.length }) };
}

export async function getReceivingPhotoUrl(req, photoId) {
  const id = oid(photoId);
  if (!id) throw new ReceivingInspectionError("Photo not found", 404, "RECEIVING_PHOTO_NOT_FOUND");
  const photo = await ReceivingUnitPhoto.findOne({
    _id: id,
    companyId: req.companyId,
    status: "ACTIVE",
  }).lean();
  if (!photo) throw new ReceivingInspectionError("Photo not found", 404, "RECEIVING_PHOTO_NOT_FOUND");
  const session = await ReceivingSession.findOne({
    _id: photo.receivingSessionId,
    companyId: req.companyId,
  })
    .select("_id companyId")
    .lean();
  if (!session) throw new ReceivingInspectionError("Photo not found", 404, "RECEIVING_PHOTO_NOT_FOUND");
  const signed = await getSignedFileUrl(photo.storageKey, {
    bucket: photo.storageBucket,
    expiresIn: 120,
  });
  return { url: signed.url, expiresIn: signed.expiresIn, mimeType: photo.mimeType };
}

async function buildProgressRows(companyId, asn, session) {
  const currentRus = await loadCurrentRus(companyId, asn);
  const units = session
    ? await ReceivingSessionUnit.find({
        companyId,
        receivingSessionId: session._id,
      }).lean()
    : [];
  const unitByRu = new Map(units.map((u) => [String(u.receivingUnitId), u]));
  const photoCounts = new Map();
  if (units.length) {
    const grouped = await ReceivingUnitPhoto.aggregate([
      {
        $match: {
          companyId,
          receivingSessionId: session._id,
          status: "ACTIVE",
        },
      },
      { $group: { _id: "$receivingSessionUnitId", n: { $sum: 1 } } },
    ]);
    for (const row of grouped) photoCounts.set(String(row._id), row.n);
  }

  return currentRus.map((ru) => {
    const unit = unitByRu.get(String(ru._id));
    const photoCount = unit ? photoCounts.get(String(unit._id)) || 0 : 0;
    return {
      receivingUnitId: ru._id,
      ruNo: ru.ruNo,
      article: ru.article,
      asnLineId: ru.asnLineId,
      partNo: ru.partNo,
      description: ru.description,
      uom: ru.uom,
      plannedQty: ru.plannedQty,
      actualQty: unit?.actualQty ?? null,
      variance: varianceQty(ru.plannedQty, unit?.actualQty),
      condition: unit?.condition || "",
      status: unit?.status || "NOT_STARTED",
      photoCount,
      version: unit?.version || 0,
    };
  });
}

export async function getReceivingSummary(req, sessionId) {
  const session = await loadSession(req.companyId, sessionId);
  const asn = await loadAsn(req.companyId, session.asnId);
  const rus = await buildProgressRows(req.companyId, asn, session);
  const progress = summarizeReceivingProgress(rus);
  const lines = (asn.lines || []).map((line) => {
    const lineRus = rus.filter((r) => String(r.asnLineId) === String(line._id));
    const counted = lineRus.reduce(
      (sum, r) => sum + (r.actualQty == null ? 0 : Number(r.actualQty) || 0),
      0
    );
    return {
      asnLineId: line._id,
      article: line.article,
      description: line.description || line.itemName || "",
      uom: line.uom,
      asnQty: line.asnQty,
      countedQty: counted,
      variance: varianceQty(line.asnQty, counted),
      ruTotal: lineRus.length,
      ruCompleted: lineRus.filter((r) => r.status === "COMPLETED").length,
      photos: lineRus.reduce((sum, r) => sum + (Number(r.photoCount) || 0), 0),
    };
  });
  return {
    session: serializeSession(session),
    asnNo: asn.asnNo,
    sourcePoNo: asn.sourcePoNo || "",
    progress,
    receivingUnits: rus,
    lines,
  };
}

export async function getAsnReceivingProgress(req, asnId) {
  const asn = await loadAsn(req.companyId, asnId);
  const session = await findActiveSession(req.companyId, asn._id);
  const completed = session
    ? null
    : await ReceivingSession.findOne({
        companyId: req.companyId,
        asnId: asn._id,
        status: "COMPLETED",
      })
        .sort({ completedAt: -1 })
        .lean();
  const use = session || completed;
  const rus = await buildProgressRows(req.companyId, asn, use);
  return {
    session: serializeSession(use),
    progress: summarizeReceivingProgress(rus),
    receivingUnits: rus,
  };
}

export async function completeReceivingSession(req, sessionId) {
  const session = await loadSession(req.companyId, sessionId);
  if (session.status === "COMPLETED") {
    const summary = await getReceivingSummary(req, sessionId);
    return { alreadyCompleted: true, ...summary };
  }
  if (!isActiveReceivingSessionStatus(session.status)) {
    throw new ReceivingInspectionError("Receiving session is not active", 409, "RECEIVING_SESSION_NOT_ACTIVE");
  }
  const summary = await getReceivingSummary(req, sessionId);
  const incomplete = (summary.receivingUnits || []).filter((r) => r.status !== "COMPLETED");
  if (incomplete.length) {
    throw new ReceivingInspectionError(
      `Cannot complete receiving while ${incomplete.length} Receiving Unit(s) are unfinished`,
      409,
      "RECEIVING_SESSION_INCOMPLETE"
    );
  }
  const actor = actorName(req);
  const now = new Date();
  const completed = await ReceivingSession.findOneAndUpdate(
    {
      _id: session._id,
      companyId: req.companyId,
      status: { $in: ["DRAFT", "IN_PROGRESS"] },
    },
    {
      $set: {
        status: "COMPLETED",
        completedBy: actor,
        completedAt: now,
        lastActivityBy: actor,
        lastActivityAt: now,
      },
    },
    { new: true }
  );
  if (!completed) {
    const current = await loadSession(req.companyId, sessionId);
    if (String(current.status || "").toUpperCase() === "COMPLETED") {
      return { alreadyCompleted: true, ...(await getReceivingSummary(req, sessionId)) };
    }
    throw new ReceivingInspectionError("Receiving session is not active", 409, "RECEIVING_SESSION_NOT_ACTIVE");
  }
  await writeAudit(req, {
    action: "RECEIVING_SESSION_COMPLETED",
    module: "STORE",
    entityType: "RECEIVING_SESSION",
    entityId: completed._id,
    documentNo: completed.sessionNo,
    description: `Receiving session ${completed.sessionNo} completed`,
    toStatus: "COMPLETED",
    metadata: { asnId: String(completed.asnId), asnNo: completed.asnNo },
  });
  return { alreadyCompleted: false, ...(await getReceivingSummary(req, sessionId)) };
}

export { photoCountForUnit };
