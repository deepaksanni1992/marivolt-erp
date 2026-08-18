import mongoose from "mongoose";
import AdvanceShipmentNotice from "../models/AdvanceShipmentNotice.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import ReceivingUnit from "../models/ReceivingUnit.js";
import LabelPrintJob from "../models/LabelPrintJob.js";
import { actorName, sameCompanyId, AsnError } from "../utils/asnRules.js";
import {
  RU_ACTIVE_STATUSES,
  RU_BLOCKING_PRINT_JOB_STATUSES,
  RU_PLAN_ELIGIBLE_ASN_STATUSES,
  ReceivingUnitError,
  activeRusForCurrentPlan,
  assertAsnEligibleForRuPlan,
  assertCompletedPlanQtyInvariant,
  assertPrintedIdentityUnchanged,
  assertReplanAllowedForPrintJobs,
  buildReceivingUnitLabelFingerprint,
  currentRuPlanVersion,
  distributionsMatch,
  formatAsnPartNo,
  isActiveRuStatus,
  isCurrentPlanRu,
  isPrintedRuStatus,
  plannedQtyList,
  retireStatusForRu,
  roundAsnQty,
  sumPlannedQty,
} from "../utils/receivingUnitRules.js";
import { nextRuNo } from "./receivingUnitNumberService.js";
import { cancelAsn as executeAsnCancel } from "./asnService.js";
import {
  isSuccessfulLabelJobStatus,
  validateGrnLabelLinePrintConfig,
} from "../utils/grnLabelDistribution.js";

function t(v) {
  return String(v ?? "").trim();
}

function oid(value) {
  const s = String(value || "").trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function asAsnDistributionMessage(message = "") {
  return String(message || "").replaceAll("GRN Qty", "ASN Qty");
}

export function validateAsnLineDistribution(asnQty, config = {}) {
  const validated = validateGrnLabelLinePrintConfig({
    print: true,
    article: config.article,
    receivedQty: asnQty,
    qtyPerLabel: config.qtyPerLabel,
    labelCount: config.labelCount,
    labelDistribution: config.labelDistribution,
  });
  if (!validated.ok) {
    throw new ReceivingUnitError(
      asAsnDistributionMessage(validated.message || "Invalid Receiving Unit distribution"),
      400,
      "RU_DISTRIBUTION_INVALID"
    );
  }
  return validated;
}

async function loadAsnForCompany(companyId, asnId) {
  const id = oid(asnId);
  if (!id) {
    throw new ReceivingUnitError("ASN id is required", 400, "RU_ASN_REQUIRED");
  }
  const asn = await AdvanceShipmentNotice.findOne({ _id: id, companyId }).lean();
  if (!asn) {
    throw new ReceivingUnitError("ASN not found", 404, "RU_ASN_NOT_FOUND");
  }
  if (!sameCompanyId(asn.companyId, companyId)) {
    throw new ReceivingUnitError("ASN does not belong to this company", 403, "RU_COMPANY_MISMATCH");
  }
  return asn;
}

async function assertPoCompany(companyId, sourcePoId) {
  if (!sourcePoId) return null;
  const po = await PurchaseOrder.findOne({ _id: sourcePoId, companyId })
    .select("_id companyId")
    .lean();
  if (!po) {
    throw new ReceivingUnitError("Purchase order not found for this company", 404, "RU_PO_COMPANY");
  }
  return po;
}

function findAsnLine(asn, asnLineId) {
  const id = String(asnLineId || "").trim();
  const line = (asn.lines || []).find((ln) => String(ln._id) === id);
  if (!line) {
    throw new ReceivingUnitError("ASN line not found", 404, "RU_ASN_LINE_NOT_FOUND");
  }
  return line;
}

function serializeRu(ru, extras = {}) {
  if (!ru) return null;
  const status = String(ru.status || "").toUpperCase();
  const current = extras.current === true;
  const active = current && isActiveRuStatus(status);
  return {
    _id: ru._id,
    companyId: ru.companyId,
    ruNo: ru.ruNo,
    barcodeValue: ru.barcodeValue,
    asnId: ru.asnId,
    asnNo: ru.asnNo,
    asnLineId: ru.asnLineId,
    sourcePoId: ru.sourcePoId,
    sourcePoLineId: ru.sourcePoLineId,
    article: ru.article,
    description: ru.description,
    partNo: ru.partNo,
    spn: ru.spn,
    uom: ru.uom,
    plannedQty: ru.plannedQty,
    status,
    active,
    current,
    inactiveReason: active ? "" : status,
    planBatchId: ru.planBatchId,
    labelPrintedAt: ru.labelPrintedAt,
    labelPrintedBy: ru.labelPrintedBy,
    lastLabelJobId: ru.lastLabelJobId,
    staleLabelJobId: ru.staleLabelJobId,
    staleLabelPrintedAt: ru.staleLabelPrintedAt,
    staleLabelPrintedBy: ru.staleLabelPrintedBy,
    cancelledAt: ru.cancelledAt,
    cancelledBy: ru.cancelledBy,
    cancelReason: ru.cancelReason,
    supersededAt: ru.supersededAt,
    supersededByPlanBatchId: ru.supersededByPlanBatchId,
    replacementRuNos: extras.replacementRuNos || [],
    createdBy: ru.createdBy,
    createdAt: ru.createdAt,
    updatedAt: ru.updatedAt,
  };
}

export async function listReceivingUnitsForAsn(companyId, asnId) {
  const asn = await loadAsnForCompany(companyId, asnId);
  const rus = await ReceivingUnit.find({ companyId, asnId: asn._id })
    .sort({ createdAt: 1, ruNo: 1 })
    .lean();
  const lines = (asn.lines || []).map((line) => {
    const currentPlanBatchId = line.ruActivePlanBatchId || null;
    const lineRus = currentPlanBatchId
      ? activeRusForCurrentPlan(rus, currentPlanBatchId)
      : rus.filter(
          (ru) => String(ru.asnLineId) === String(line._id) && isActiveRuStatus(ru.status)
        );
    return {
      asnLineId: line._id,
      article: line.article,
      partNo: formatAsnPartNo(line),
      description: line.description || line.itemName || "",
      asnQty: roundAsnQty(line.asnQty),
      uom: line.uom || "PCS",
      ruPlanVersion: currentRuPlanVersion(line),
      currentPlanBatchId,
      activeRuCount: lineRus.length,
      activePlannedQty: sumPlannedQty(lineRus),
      printedRuCount: lineRus.filter((ru) => isPrintedRuStatus(ru.status)).length,
      receivingUnits: lineRus.map((ru) => serializeRu(ru, { current: true })),
    };
  });
  const active = lines.flatMap((ln) => ln.receivingUnits);
  return {
    asnId: asn._id,
    asnNo: asn.asnNo,
    status: asn.status,
    eligible: RU_PLAN_ELIGIBLE_ASN_STATUSES.includes(String(asn.status || "").toUpperCase()),
    lines,
    receivingUnits: active,
    fingerprint: buildReceivingUnitLabelFingerprint(active),
  };
}

function versionElemMatch(lineId, expectedVersion) {
  const v = Number(expectedVersion) || 0;
  if (v === 0) {
    return {
      _id: lineId,
      $or: [{ ruPlanVersion: 0 }, { ruPlanVersion: { $exists: false } }, { ruPlanVersion: null }],
    };
  }
  return { _id: lineId, ruPlanVersion: v };
}

function sessionOpts(session) {
  return session ? { session } : {};
}

function isTransactionUnsupported(err) {
  const msg = String(err?.message || "");
  const code = err?.code;
  return (
    msg.includes("Transaction numbers are only allowed") ||
    msg.includes("replica set") ||
    msg.includes("Transaction numbers are not allowed") ||
    code === 20 ||
    code === 263
  );
}

/**
 * Claim the next ruPlanVersion for one ASN line. First writer wins.
 * Must run in the same Mongo session as retire + insert so a crash cannot
 * publish B2 without its Receiving Units.
 */
export async function claimAsnLinePlanVersion({
  companyId,
  asnId,
  lineId,
  expectedVersion,
  planBatchId,
  session = null,
}) {
  const updated = await AdvanceShipmentNotice.findOneAndUpdate(
    {
      _id: asnId,
      companyId,
      lines: { $elemMatch: versionElemMatch(oid(lineId) || lineId, expectedVersion) },
    },
    {
      $set: {
        "lines.$.ruPlanVersion": (Number(expectedVersion) || 0) + 1,
        "lines.$.ruActivePlanBatchId": planBatchId,
      },
    },
    { new: true, ...sessionOpts(session) }
  );
  if (!updated) {
    throw new ReceivingUnitError(
      "Another user updated this ASN line label plan. Refresh and try again.",
      409,
      "RU_PLAN_CONFLICT"
    );
  }
  return updated;
}

async function retireRusForReplacedPlan({
  companyId,
  rus,
  actor,
  reason,
  supersededByPlanBatchId,
  session = null,
}) {
  if (!rus.length) return 0;
  let modified = 0;
  const now = new Date();
  for (const ru of rus) {
    const nextStatus = retireStatusForRu(ru);
    const $set = {
      status: nextStatus,
      cancelReason: reason,
      supersededByPlanBatchId: supersededByPlanBatchId || null,
    };
    if (nextStatus === "SUPERSEDED") {
      $set.supersededAt = now;
    } else {
      $set.cancelledAt = now;
      $set.cancelledBy = actor;
    }
    const res = await ReceivingUnit.updateOne(
      { companyId, _id: ru._id, status: { $in: [...RU_ACTIVE_STATUSES] } },
      { $set },
      sessionOpts(session)
    );
    modified += res.modifiedCount || 0;
  }
  return modified;
}

function currentLineRus(line, lineRus) {
  const currentPlanBatchId = line.ruActivePlanBatchId || null;
  if (currentPlanBatchId) return activeRusForCurrentPlan(lineRus, currentPlanBatchId);
  return (lineRus || []).filter((ru) => isActiveRuStatus(ru.status));
}

async function findBlockingPrintJobs(companyId, ruIds) {
  const ids = (ruIds || []).map((id) => oid(id) || id).filter(Boolean);
  if (!ids.length) return [];
  return LabelPrintJob.find({
    companyId,
    sourceType: "ASN",
    "lines.receivingUnitId": { $in: ids },
    status: { $in: [...RU_BLOCKING_PRINT_JOB_STATUSES] },
  })
    .select("status lines.receivingUnitId")
    .lean();
}

function buildRuInsertDocs({
  req,
  companyId,
  asn,
  line,
  distribution,
  planBatchId,
  actor,
  ruNos,
}) {
  return distribution.map((plannedQty, idx) => ({
    companyId,
    ruNo: ruNos[idx],
    barcodeValue: ruNos[idx],
    asnId: asn._id,
    asnNo: asn.asnNo,
    asnLineId: line._id,
    sourcePoId: line.poId || asn.sourcePoId || null,
    sourcePoLineId: line.poLineId || null,
    article: t(line.article).toUpperCase(),
    description: t(line.description || line.itemName),
    partNo: formatAsnPartNo(line),
    spn: t(line.supplierPartNumber),
    uom: t(line.uom) || "PCS",
    plannedQty,
    status: "PLANNED",
    planBatchId,
    createdBy: actor,
    createdByUserId: req.user?.id || req.user?._id || null,
  }));
}

async function persistReplacementPlanReplicaSet({
  session,
  req,
  companyId,
  asn,
  line,
  existing,
  distribution,
  planBatchId,
  expectedVersion,
  actor,
  reason,
  ruNos,
}) {
  await claimAsnLinePlanVersion({
    companyId,
    asnId: asn._id,
    lineId: line._id,
    expectedVersion,
    planBatchId,
    session,
  });
  await retireRusForReplacedPlan({
    companyId,
    rus: existing,
    actor,
    reason,
    supersededByPlanBatchId: planBatchId,
    session,
  });
  const docs = buildRuInsertDocs({
    req,
    companyId,
    asn,
    line,
    distribution,
    planBatchId,
    actor,
    ruNos,
  });
  const inserted = await ReceivingUnit.insertMany(docs, { session, ordered: true });
  const nextLine = {
    ...line,
    ruPlanVersion: expectedVersion + 1,
    ruActivePlanBatchId: planBatchId,
  };
  assertCompletedPlanQtyInvariant(nextLine, inserted);
  return inserted;
}

/**
 * Standalone Mongo: never CAS the current pointer until the full replacement
 * batch exists. Incomplete B2 RUs are cancelled and are never current.
 * This is not equal to replica-set crash atomicity for retiring the old batch.
 */
async function persistReplacementPlanStandalone({
  req,
  companyId,
  asn,
  line,
  existing,
  distribution,
  planBatchId,
  expectedVersion,
  actor,
  reason,
  ruNos,
}) {
  const docs = buildRuInsertDocs({
    req,
    companyId,
    asn,
    line,
    distribution,
    planBatchId,
    actor,
    ruNos,
  });
  let inserted = [];
  try {
    inserted = await ReceivingUnit.insertMany(docs, { ordered: true });
    await claimAsnLinePlanVersion({
      companyId,
      asnId: asn._id,
      lineId: line._id,
      expectedVersion,
      planBatchId,
    });
  } catch (err) {
    if (inserted.length) {
      await ReceivingUnit.updateMany(
        { companyId, _id: { $in: inserted.map((row) => row._id) }, status: "PLANNED" },
        {
          $set: {
            status: "CANCELLED",
            cancelledAt: new Date(),
            cancelledBy: actor,
            cancelReason: "Incomplete plan was not published as current",
          },
        }
      );
    }
    throw err;
  }
  await retireRusForReplacedPlan({
    companyId,
    rus: existing,
    actor,
    reason,
    supersededByPlanBatchId: planBatchId,
  });
  const nextLine = {
    ...line,
    ruPlanVersion: expectedVersion + 1,
    ruActivePlanBatchId: planBatchId,
  };
  assertCompletedPlanQtyInvariant(nextLine, inserted);
  return inserted;
}

async function persistReplacementPlan(args) {
  const session = await mongoose.startSession();
  try {
    let inserted;
    await session.withTransaction(async () => {
      inserted = await persistReplacementPlanReplicaSet({ ...args, session });
    });
    return inserted;
  } catch (err) {
    if (err instanceof ReceivingUnitError || err instanceof AsnError) throw err;
    if (isTransactionUnsupported(err)) {
      return persistReplacementPlanStandalone(args);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function planReceivingUnits(req, asnId, body = {}) {
  const companyId = req.companyId;
  const asn = await loadAsnForCompany(companyId, asnId);
  assertAsnEligibleForRuPlan(asn.status);
  await assertPoCompany(companyId, asn.sourcePoId);

  const linesIn = Array.isArray(body.lines) ? body.lines : [];
  if (!linesIn.length) {
    throw new ReceivingUnitError("At least one ASN line plan is required", 400, "RU_PLAN_EMPTY");
  }

  const replacePrinted = body.replacePrinted === true || body.supersedePrinted === true;
  const actor = actorName(req);
  const created = [];
  const reused = [];
  const cancelled = [];
  let lastPlanBatchId = null;

  for (const row of linesIn) {
    const line = findAsnLine(asn, row.asnLineId);
    const asnQty = roundAsnQty(line.asnQty);
    const validated = validateAsnLineDistribution(asnQty, {
      article: line.article,
      qtyPerLabel: row.qtyPerLabel,
      labelCount: row.labelCount,
      labelDistribution: row.labelDistribution,
    });
    const distribution = validated.distribution;

    const lineRus = await ReceivingUnit.find({
      companyId,
      asnId: asn._id,
      asnLineId: line._id,
      status: { $in: [...RU_ACTIVE_STATUSES] },
    })
      .sort({ createdAt: 1, ruNo: 1 })
      .lean();
    const existing = currentLineRus(line, lineRus);

    if (distributionsMatch(plannedQtyList(existing), distribution)) {
      reused.push(...existing);
      continue;
    }

    const printed = existing.filter((ru) => isPrintedRuStatus(ru.status));
    if (printed.length && !replacePrinted) {
      throw new ReceivingUnitError(
        `Article ${line.article} already has printed Receiving Units. Confirm replace to supersede them and issue new RU numbers.`,
        409,
        "RU_PRINTED_PLAN_LOCKED"
      );
    }

    for (const ru of printed) {
      assertPrintedIdentityUnchanged(ru, {});
    }

    const inflightJobs = await findBlockingPrintJobs(
      companyId,
      existing.map((ru) => ru._id)
    );
    assertReplanAllowedForPrintJobs(inflightJobs);

    const planBatchId = new mongoose.Types.ObjectId();
    const expectedVersion =
      row.expectedRuPlanVersion != null
        ? Number(row.expectedRuPlanVersion)
        : body.expectedRuPlanVersion != null
          ? Number(body.expectedRuPlanVersion)
          : currentRuPlanVersion(line);

    const reason = printed.length
      ? "Superseded after successful print"
      : "Replaced before successful print";

    const ruNos = [];
    for (let i = 0; i < distribution.length; i += 1) {
      ruNos.push(
        await nextRuNo({ companyId, companyCode: req.companyCode || req.company?.code || "" })
      );
    }

    const inserted = await persistReplacementPlan({
      req,
      companyId,
      asn,
      line,
      existing,
      distribution,
      planBatchId,
      expectedVersion,
      actor,
      reason,
      ruNos,
    });
    line.ruPlanVersion = expectedVersion + 1;
    line.ruActivePlanBatchId = planBatchId;
    lastPlanBatchId = planBatchId;
    cancelled.push(...existing.map((ru) => ru.ruNo));
    created.push(...inserted.map((doc) => (doc.toObject ? doc.toObject() : doc)));
  }

  const listing = await listReceivingUnitsForAsn(companyId, asn._id);
  return {
    ...listing,
    createdCount: created.length,
    reusedCount: reused.length,
    cancelledRuNos: cancelled,
    planBatchId: lastPlanBatchId,
  };
}

export async function getReceivingUnitByBarcode(companyId, barcode) {
  const value = t(barcode).toUpperCase();
  if (!value) {
    throw new ReceivingUnitError("barcode is required", 400, "RU_BARCODE_REQUIRED");
  }
  const ru = await ReceivingUnit.findOne({ companyId, barcodeValue: value }).lean();
  if (!ru) {
    throw new ReceivingUnitError("Receiving Unit not found", 404, "RU_NOT_FOUND");
  }
  const asn = await AdvanceShipmentNotice.findOne({ _id: ru.asnId, companyId })
    .select("lines._id lines.ruActivePlanBatchId")
    .lean();
  const line = (asn?.lines || []).find((ln) => String(ln._id) === String(ru.asnLineId));
  const currentBatchId = line?.ruActivePlanBatchId || null;
  const current = isCurrentPlanRu(ru, currentBatchId);
  let replacementRuNos = [];
  if (!current && currentBatchId) {
    const replacements = await ReceivingUnit.find({
      companyId,
      asnId: ru.asnId,
      asnLineId: ru.asnLineId,
      planBatchId: currentBatchId,
      status: { $in: [...RU_ACTIVE_STATUSES] },
    })
      .select("ruNo")
      .sort({ ruNo: 1 })
      .lean();
    replacementRuNos = replacements.map((row) => row.ruNo).filter(Boolean);
  }
  return serializeRu(ru, { current, replacementRuNos });
}

/**
 * Reload persisted RUs for print/preview. Client ids select rows; barcode/qty come from DB.
 */
export async function loadPersistedRusForPrint(companyId, asnId, receivingUnitIds = []) {
  const asn = await loadAsnForCompany(companyId, asnId);
  const listing = await listReceivingUnitsForAsn(companyId, asn._id);
  const currentById = new Map((listing.receivingUnits || []).map((ru) => [String(ru._id), ru]));
  const requested = Array.isArray(receivingUnitIds)
    ? receivingUnitIds.map(String).filter(Boolean)
    : [];
  const ids = requested.length ? requested : [...currentById.keys()];
  const oids = ids.map(oid).filter(Boolean);
  if (!oids.length) return [];
  const docs = await ReceivingUnit.find({
    companyId,
    asnId: asn._id,
    _id: { $in: oids },
  })
    .sort({ createdAt: 1, ruNo: 1 })
    .lean();
  return docs.filter((ru) => currentById.has(String(ru._id)));
}

export async function cancelAsn(req, id, body = {}) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await cancelAsnWithRuPolicy(req, id, body, session);
    });
    return result;
  } catch (err) {
    if (err instanceof ReceivingUnitError || err instanceof AsnError) throw err;
    if (isTransactionUnsupported(err)) {
      return cancelAsnStandalone(req, id, body);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

async function assertNoPrintedReceivingUnits(companyId, asnId, session = null) {
  const printed = await ReceivingUnit.countDocuments(
    { companyId, asnId, status: "PRINTED" },
    sessionOpts(session)
  );
  if (printed > 0) {
    throw new ReceivingUnitError(
      "Cannot cancel ASN while printed Receiving Unit labels exist. Replace or supersede those labels first.",
      409,
      "RU_PRINTED_BLOCKS_ASN_CANCEL"
    );
  }
}

async function cancelAsnWithRuPolicy(req, id, body, session) {
  const companyId = req.companyId;
  const asn = await loadAsnForCompany(companyId, id);
  await assertNoPrintedReceivingUnits(companyId, asn._id, session);
  await ReceivingUnit.updateMany(
    { companyId, asnId: asn._id, status: "PLANNED" },
    {
      $set: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledBy: actorName(req),
        cancelReason: "ASN cancelled — unprinted Receiving Units cancelled",
      },
    },
    sessionOpts(session)
  );
  await assertNoPrintedReceivingUnits(companyId, asn._id, session);
  const stillActive = await ReceivingUnit.countDocuments(
    { companyId, asnId: asn._id, status: { $in: [...RU_ACTIVE_STATUSES] } },
    sessionOpts(session)
  );
  if (stillActive > 0) {
    throw new ReceivingUnitError(
      "Cannot cancel ASN while active Receiving Units remain",
      409,
      "RU_ACTIVE_BLOCKS_ASN_CANCEL"
    );
  }
  return executeAsnCancel(req, id, body, { guard: "ASN_CANCEL_POLICY", session });
}

/**
 * Standalone Mongo cannot atomically cancel planned RUs + ASN.
 * If any RUs exist, fail clearly instead of destroying a live plan.
 */
async function cancelAsnStandalone(req, id, body) {
  const companyId = req.companyId;
  const asn = await loadAsnForCompany(companyId, id);
  await assertNoPrintedReceivingUnits(companyId, asn._id);
  const ruCount = await ReceivingUnit.countDocuments({
    companyId,
    asnId: asn._id,
    status: { $in: [...RU_ACTIVE_STATUSES] },
  });
  if (ruCount > 0) {
    throw new ReceivingUnitError(
      "Cancelling an ASN with Receiving Units requires a replica-set MongoDB transaction",
      503,
      "ASN_CANCEL_TXN_REQUIRED"
    );
  }
  return executeAsnCancel(req, id, body, { guard: "ASN_CANCEL_POLICY" });
}

export async function getReceivingUnitById(companyId, ruId) {
  const id = oid(ruId);
  if (!id) {
    throw new ReceivingUnitError("Receiving Unit id is required", 400, "RU_ID_REQUIRED");
  }
  const ru = await ReceivingUnit.findOne({ _id: id, companyId }).lean();
  if (!ru) {
    throw new ReceivingUnitError("Receiving Unit not found", 404, "RU_NOT_FOUND");
  }
  return ru;
}

/**
 * Map LabelPrintJob result onto RU printed state.
 *
 * The Windows agent reports a printedQty count, not per-face identity.
 * Phase 2 therefore enqueues one job per RU (requestedLabels = 1).
 * Only COMPLETED (remainingLabels = 0) marks that RU PRINTED.
 * PARTIAL / FAILED / UNCERTAIN never mark an RU as printed.
 */
export async function applyReceivingUnitPrintResult(job) {
  if (!job || String(job.sourceType || "").toUpperCase() !== "ASN") {
    return { updated: 0 };
  }
  const companyId = job.companyId;
  const ids = (job.lines || [])
    .map((ln) => ln.receivingUnitId)
    .filter(Boolean);
  if (!ids.length) return { updated: 0 };

  if (!isSuccessfulLabelJobStatus(job.status) || Number(job.remainingLabels) > 0) {
    return { updated: 0, conservative: true };
  }

  const actor = t(job.createdByName);
  const printedAt = new Date();
  let firstPrints = 0;
  const rus = await ReceivingUnit.find({ companyId, _id: { $in: ids } }).lean();
  const asnIds = [...new Set(rus.map((ru) => String(ru.asnId)).filter(Boolean))];
  const asns = await AdvanceShipmentNotice.find({
    companyId,
    _id: { $in: asnIds.map((id) => oid(id)).filter(Boolean) },
  })
    .select("lines._id lines.ruActivePlanBatchId")
    .lean();
  const currentBatchByLine = new Map();
  for (const asn of asns) {
    for (const line of asn.lines || []) {
      currentBatchByLine.set(String(line._id), line.ruActivePlanBatchId || null);
    }
  }

  for (const ru of rus) {
    const currentBatchId = currentBatchByLine.get(String(ru.asnLineId)) || null;
    const current = isCurrentPlanRu(ru, currentBatchId);
    if (ru.status === "PLANNED" && current) {
      const res = await ReceivingUnit.updateOne(
        { companyId, _id: ru._id, status: "PLANNED" },
        {
          $set: {
            status: "PRINTED",
            labelPrintedAt: ru.labelPrintedAt || printedAt,
            labelPrintedBy: ru.labelPrintedBy || actor,
            lastLabelJobId: job._id,
          },
        }
      );
      firstPrints += res.modifiedCount || 0;
      continue;
    }
    if (ru.status === "PRINTED" && current) {
      await ReceivingUnit.updateOne(
        { companyId, _id: ru._id, status: "PRINTED" },
        { $set: { lastLabelJobId: job._id } }
      );
      continue;
    }
    await ReceivingUnit.updateOne(
      { companyId, _id: ru._id, status: { $in: ["CANCELLED", "SUPERSEDED", "PLANNED", "PRINTED"] } },
      {
        $set: {
          staleLabelJobId: job._id,
          staleLabelPrintedAt: printedAt,
          staleLabelPrintedBy: actor,
        },
      }
    );
  }
  return { updated: firstPrints, stale: rus.length - firstPrints };
}

export function previewPayloadFromReceivingUnits(rus = [], asn = {}) {
  return (rus || []).map((ru, idx) => ({
    index: idx + 1,
    total: rus.length,
    receivingUnitId: ru._id,
    ruNo: ru.ruNo,
    barcodeValue: ru.barcodeValue,
    asnLineId: ru.asnLineId,
    article: ru.article,
    partNo: ru.partNo,
    description: ru.description,
    plannedQty: ru.plannedQty,
    uom: ru.uom,
    asnNo: ru.asnNo || asn.asnNo,
    status: ru.status,
    lastLabelJobId: ru.lastLabelJobId,
  }));
}

export {
  loadAsnForCompany,
  serializeRu,
  findAsnLine,
  assertPoCompany,
  currentLineRus,
};
