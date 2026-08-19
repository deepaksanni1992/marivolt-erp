/**
 * Phase 4B — generate one durable Draft GRN from a completed ReceivingSession.
 * Commercial authority: GRN → ASN → PO. Does not post stock, customs, PO receipt, or ASN status.
 * Draft quantity is a snapshot of ASN-line entitlement at generation; Phase 4C must revalidate.
 */
import mongoose from "mongoose";
import GRN from "../models/GRN.js";
import ReceivingSessionUnit from "../models/ReceivingSessionUnit.js";
import ReceivingUnit from "../models/ReceivingUnit.js";
import { actorName } from "../utils/asnRules.js";
import { RU_ACTIVE_STATUSES, RU_PLAN_ELIGIBLE_ASN_STATUSES, isCurrentPlanRu } from "../utils/receivingUnitRules.js";
import {
  assertPhase4CanConsumeReceivingUnits,
  computeDispositionDerived,
} from "../utils/receivingInspectionRules.js";
import {
  getOpenDraftAcceptedQtyByPoLineMap,
  getPostedAcceptedQtyByPoLineMap,
  GRN_ACTIVE_ASN_RECEIVING_STATUSES,
} from "../utils/grnReceiptQty.js";
import {
  EXCESS_PENDING_APPROVAL,
  GRN_SOURCE_ASN_RECEIVING,
  ReceivingDraftGrnError,
  assertCoherentReceivingSnapshot,
  assertDraftGrnEligibleResult,
  buildDraftGrnLinesFromReceiving,
  computeAsnDraftEntitlementReview,
  freezeReceivingBecauseDraftGrnExists,
  groupReceivingUnitsForDraftGrn,
} from "../utils/receivingDraftGrnRules.js";
import {
  assertAsnReceivingGrnSnapshots,
  resolveAsnReceivingSource,
} from "./asnReceivingSourceResolver.js";
import { nextGrnNo } from "./grnNumberService.js";
import { writeAudit } from "./auditService.js";

const DEFAULT_GRN_WAREHOUSE_CODE = "MAIN";

function oid(value) {
  const s = String(value || "").trim();
  if (!s || !mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

function isDupKey(err) {
  return Number(err?.code) === 11000;
}

export async function findActiveAsnReceivingGrn(companyId, receivingSessionId, session = null) {
  const sid = oid(receivingSessionId);
  if (!sid) return null;
  const q = GRN.findOne({
    companyId,
    receivingSessionId: sid,
    status: { $in: [...GRN_ACTIVE_ASN_RECEIVING_STATUSES] },
  });
  if (session) q.session(session);
  return q.lean();
}

export async function assertReceivingNotFrozenByDraftGrn(companyId, receivingSessionId) {
  const existing = await findActiveAsnReceivingGrn(companyId, receivingSessionId);
  if (existing) freezeReceivingBecauseDraftGrnExists();
}

function serializeDraftGrn(grn, extras = {}) {
  if (!grn) return null;
  return {
    _id: grn._id,
    grnNo: grn.grnNo,
    status: grn.status,
    sourceType: grn.sourceType || "",
    receivingSessionId: grn.receivingSessionId,
    receivingSessionNo: grn.receivingSessionNo,
    asnId: grn.asnId,
    asnNo: grn.asnNo,
    poId: grn.poId,
    poNo: grn.poNo,
    items: grn.items,
    ...extras,
  };
}

function assertAsnReceivable(asn) {
  const s = String(asn?.status || "").toUpperCase();
  if (!RU_PLAN_ELIGIBLE_ASN_STATUSES.includes(s)) {
    throw new ReceivingDraftGrnError(
      `Draft GRN can only be generated when the ASN is SHIPPED or ARRIVED (current: ${s || "UNKNOWN"})`,
      409,
      "RECEIVING_GRN_ASN_STATUS"
    );
  }
}

async function loadEntitlementMaps(companyId, poId, { excludeGrnId = null, mongoSession = null } = {}) {
  const postedByPoLine = await getPostedAcceptedQtyByPoLineMap(GRN, {
    companyId,
    poId,
    session: mongoSession,
  });
  const otherDraftByPoLine = await getOpenDraftAcceptedQtyByPoLineMap(GRN, {
    companyId,
    poId,
    excludeGrnId,
    session: mongoSession,
  });
  return { postedByPoLine, otherDraftByPoLine };
}

async function buildReceivingRows(companyId, source) {
  const { asn, po, receivingSession, asnLineById, poLineByAsnLineId, poLineIdByAsnLineId, poIdByAsnLineId } = source;
  const rus = await ReceivingUnit.find({
    companyId,
    asnId: asn._id,
    status: { $in: [...RU_ACTIVE_STATUSES] },
  }).lean();
  const currentRus = rus.filter((ru) => {
    const line = asnLineById.get(String(ru.asnLineId));
    return isCurrentPlanRu(ru, line?.ruActivePlanBatchId);
  });
  const units = await ReceivingSessionUnit.find({
    companyId,
    receivingSessionId: receivingSession._id,
  }).lean();
  const unitByRu = new Map(units.map((u) => [String(u.receivingUnitId), u]));

  const rows = [];
  for (const ru of currentRus) {
    const unit = unitByRu.get(String(ru._id));
    const asnLine = asnLineById.get(String(ru.asnLineId));
    if (!asnLine) {
      throw new ReceivingDraftGrnError(
        `Receiving Unit ${ru.ruNo} has no matching ASN line`,
        409,
        "ASN_GRN_SOURCE_MISMATCH"
      );
    }
    const poLine = poLineByAsnLineId.get(String(ru.asnLineId));
    if (!poLine) {
      throw new ReceivingDraftGrnError(
        `ASN line for ${ru.ruNo} has no source PO line`,
        409,
        "ASN_GRN_SOURCE_MISMATCH"
      );
    }
    const ruUom = String(ru.uom || asnLine.uom || poLine.uom || "PCS").trim().toUpperCase() || "PCS";
    const poUom = String(poLine.uom || "PCS").trim().toUpperCase() || "PCS";
    if (ruUom !== poUom) {
      throw new ReceivingDraftGrnError(
        `UOM mismatch for ${ru.ruNo}: receiving ${ruUom} vs PO ${poUom}`,
        409,
        "ASN_GRN_SOURCE_MISMATCH"
      );
    }
    const derived = computeDispositionDerived({
      plannedQty: ru.plannedQty,
      actualQty: unit?.actualQty,
      acceptedQty: unit?.acceptedQty,
      damagedQty: unit?.damagedQty,
      rejectedQty: unit?.rejectedQty,
    });
    rows.push({
      receivingUnitId: ru._id,
      receivingSessionUnitId: unit?._id,
      ruNo: ru.ruNo,
      status: unit?.status || "NOT_STARTED",
      version: Number(unit?.version) || 0,
      poId: poIdByAsnLineId.get(String(ru.asnLineId)),
      poNo: po.poNo || po.poNumber || "",
      poLineId: poLineIdByAsnLineId.get(String(ru.asnLineId)),
      asnLineId: ru.asnLineId,
      uom: ruUom,
      currency: poLine.currency || po.currency || "USD",
      warehouse: DEFAULT_GRN_WAREHOUSE_CODE,
      plannedQty: ru.plannedQty,
      actualQty: unit?.actualQty ?? null,
      acceptedQty: derived.acceptedQty,
      damagedQty: derived.damagedQty,
      rejectedQty: derived.rejectedQty,
      shortQty: derived.shortQty,
      excessQty: derived.excessQty,
    });
  }
  return { currentRus, units, rows };
}

function assertSessionReadyForDraft(receivingSession, rows) {
  if (String(receivingSession.status || "").toUpperCase() !== "COMPLETED") {
    throw new ReceivingDraftGrnError(
      "Receiving must be completed before generating a Draft GRN",
      409,
      "RECEIVING_SESSION_NOT_COMPLETE"
    );
  }
  const incomplete = (rows || []).filter((r) => String(r.status || "").toUpperCase() !== "COMPLETED");
  if (incomplete.length) {
    throw new ReceivingDraftGrnError(
      "All current Receiving Units must be completed before generating a Draft GRN",
      409,
      "RECEIVING_SESSION_INCOMPLETE"
    );
  }
  assertPhase4CanConsumeReceivingUnits(rows);
}

export async function reviewAsnReceivingDraftGrn(req, grn, { mongoSession = null } = {}) {
  const source = await resolveAsnReceivingSource({
    companyId: req.companyId,
    receivingSessionId: grn.receivingSessionId,
    mongoSession,
  });
  assertAsnReceivingGrnSnapshots(grn, source);
  const maps = await loadEntitlementMaps(req.companyId, source.po._id, {
    excludeGrnId: grn._id,
    mongoSession,
  });
  const review = computeAsnDraftEntitlementReview(grn, {
    poLineByAsnLineId: source.poLineByAsnLineId,
    poLineIdByAsnLineId: source.poLineIdByAsnLineId,
    ...maps,
  });
  return { source, review };
}

export async function getDraftGrnForReceivingSession(req, sessionId) {
  const source = await resolveAsnReceivingSource({
    companyId: req.companyId,
    receivingSessionId: sessionId,
  });
  const grn = await findActiveAsnReceivingGrn(req.companyId, source.receivingSession._id);
  let extras = {};
  if (grn) {
    assertAsnReceivingGrnSnapshots(grn, source);
    extras = { entitlementReview: (await reviewAsnReceivingDraftGrn(req, grn)).review };
  }
  return {
    session: {
      _id: source.receivingSession._id,
      sessionNo: source.receivingSession.sessionNo,
      status: source.receivingSession.status,
    },
    grn: serializeDraftGrn(grn, extras),
  };
}

export async function generateDraftGrnFromReceivingSession(req, sessionId) {
  const companyId = req.companyId;
  const source = await resolveAsnReceivingSource({ companyId, receivingSessionId: sessionId });
  assertAsnReceivable(source.asn);

  const existing = await findActiveAsnReceivingGrn(companyId, source.receivingSession._id);
  if (existing) {
    assertAsnReceivingGrnSnapshots(existing, source);
    const { review } = await reviewAsnReceivingDraftGrn(req, existing);
    return {
      created: false,
      reused: true,
      grn: serializeDraftGrn(existing, { entitlementReview: review }),
      totals: summarizeGrnSources(existing),
      entitlementReview: review,
    };
  }

  const { units, rows } = await buildReceivingRows(companyId, source);
  assertSessionReadyForDraft(source.receivingSession, rows);
  const snapshotBefore = units;

  const maps = await loadEntitlementMaps(companyId, source.po._id);
  const groups = groupReceivingUnitsForDraftGrn(rows);
  const built = assertDraftGrnEligibleResult(
    buildDraftGrnLinesFromReceiving({
      groups,
      poLineByAsnLineId: source.poLineByAsnLineId,
      poLineIdByAsnLineId: source.poLineIdByAsnLineId,
      poIdByAsnLineId: source.poIdByAsnLineId,
      postedByPoLine: maps.postedByPoLine,
      otherDraftByPoLine: maps.otherDraftByPoLine,
      poNo: source.po.poNo || source.po.poNumber || "",
    })
  );

  const mongoSession = await mongoose.startSession();
  let createdDoc = null;
  let reused = false;
  try {
    await mongoSession.withTransaction(async () => {
      const raced = await findActiveAsnReceivingGrn(companyId, source.receivingSession._id, mongoSession);
      if (raced) {
        createdDoc = raced;
        reused = true;
        return;
      }

      const freshUnits = await ReceivingSessionUnit.find({
        companyId,
        receivingSessionId: source.receivingSession._id,
      })
        .session(mongoSession)
        .lean();
      assertCoherentReceivingSnapshot(snapshotBefore, freshUnits);

      const grnNo = await nextGrnNo({ companyId, companyCode: req.companyCode });
      const payload = {
        companyId,
        grnNo,
        grnDate: new Date(),
        status: "DRAFT",
        sourceType: GRN_SOURCE_ASN_RECEIVING,
        receivingSessionId: source.receivingSession._id,
        receivingSessionNo: source.receivingSession.sessionNo,
        asnId: source.asn._id,
        asnNo: source.asn.asnNo,
        poId: source.po._id,
        poNo: source.po.poNo || source.po.poNumber || "",
        supplierId: source.po.supplierId || null,
        supplierName: source.po.supplierName || source.po.supplier || "",
        currency: source.po.currency || "USD",
        exchangeRate: Number(source.po.exchangeRate) || 1,
        remarks: "",
        createdBy: actorName(req),
        updatedBy: actorName(req),
        items: built.items,
      };

      try {
        const inserted = await GRN.create([payload], { session: mongoSession });
        createdDoc = inserted[0].toObject();
        reused = false;
      } catch (err) {
        if (!isDupKey(err)) throw err;
        const afterDup = await findActiveAsnReceivingGrn(companyId, source.receivingSession._id, mongoSession);
        if (!afterDup) throw err;
        createdDoc = afterDup;
        reused = true;
      }
    });
  } finally {
    await mongoSession.endSession();
  }

  if (!reused) {
    await writeAudit(req, {
      action: "ASN_RECEIVING_GRN_DRAFT_CREATED",
      module: "STORE",
      entityType: "GRN",
      entityId: createdDoc._id,
      documentNo: createdDoc.grnNo,
      description: `ASN receiving Draft GRN ${createdDoc.grnNo} created from ${source.receivingSession.sessionNo}`,
      metadata: {
        receivingSessionId: String(source.receivingSession._id),
        sessionNo: source.receivingSession.sessionNo,
        asnId: String(source.asn._id),
        asnNo: source.asn.asnNo,
        poId: String(source.po._id),
        poNo: createdDoc.poNo,
        grnEligibleQty: built.totals.grnEligibleQty,
        excessPendingQty: built.totals.excessPendingQty,
      },
    });
  }

  const totals = reused ? summarizeGrnSources(createdDoc) : built.totals;
  const excessPendingQty = Number(totals.excessPendingQty) || 0;
  let entitlementReview;
  try {
    entitlementReview = (await reviewAsnReceivingDraftGrn(req, createdDoc)).review;
  } catch {
    entitlementReview = undefined;
  }
  return {
    created: !reused,
    reused,
    grn: serializeDraftGrn(createdDoc, { entitlementReview }),
    totals,
    excessPendingApproval: excessPendingQty > 0,
    code: excessPendingQty > 0 ? EXCESS_PENDING_APPROVAL : undefined,
    entitlementReview,
  };
}

function summarizeGrnSources(grn) {
  let grnEligibleQty = 0;
  let excessPendingQty = 0;
  let acceptedQty = 0;
  for (const item of grn?.items || []) {
    grnEligibleQty += Number(item.acceptedQty) || 0;
    for (const src of item.receivingSources || []) {
      acceptedQty += Number(src.acceptedQty) || 0;
      excessPendingQty += Number(src.excessPendingQty) || 0;
    }
  }
  return {
    acceptedQty,
    grnEligibleQty,
    excessPendingQty,
    damagedQty: null,
    rejectedQty: null,
    shortQty: null,
  };
}

export async function attachDraftGrnToReceivingProgress(companyId, sessionDoc, progressPayload) {
  if (!sessionDoc?._id) return progressPayload;
  const grn = await findActiveAsnReceivingGrn(companyId, sessionDoc._id);
  if (!grn) return { ...progressPayload, draftGrn: null };
  let extras = { totals: summarizeGrnSources(grn) };
  try {
    const { review } = await reviewAsnReceivingDraftGrn({ companyId }, grn);
    extras.entitlementReview = review;
  } catch {
    /* review is additive; freeze/progress still returns the draft */
  }
  return {
    ...progressPayload,
    draftGrn: serializeDraftGrn(grn, extras),
  };
}
