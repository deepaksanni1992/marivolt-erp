/**
 * Phase 3A guards used by Phase 2 RU replan / ASN cancel.
 * Kept out of asnService so Phase 1 remains free of ReceivingUnit / barcode strings.
 */

import ReceivingSession from "../models/ReceivingSession.js";
import ReceivingSessionUnit from "../models/ReceivingSessionUnit.js";
import ReceivingUnitPhoto from "../models/ReceivingUnitPhoto.js";
import { ReceivingUnitError } from "../utils/receivingUnitRules.js";
import {
  ReceivingInspectionError,
  assertAsnCancelBlockedByReceiving,
  assertReplanBlockedByReceiving,
  classifyReplanReceivingFreeze,
  isEmptyDraftReceivingSession,
} from "../utils/receivingInspectionRules.js";

export async function asnHasReceivingSession(companyId, asnId) {
  const count = await ReceivingSession.countDocuments({
    companyId,
    asnId,
    status: { $in: ["DRAFT", "IN_PROGRESS", "COMPLETED"] },
  });
  return count > 0;
}

export async function asnHasReceivingResults(companyId, asnId) {
  const count = await ReceivingSessionUnit.countDocuments({ companyId, asnId });
  return count > 0;
}

export async function assertAsnCancelNotBlockedByReceiving(companyId, asnId) {
  const hasSession = await asnHasReceivingSession(companyId, asnId);
  const hasResults = hasSession ? true : await asnHasReceivingResults(companyId, asnId);
  try {
    assertAsnCancelBlockedByReceiving({ hasSession, hasResults });
  } catch (err) {
    if (err instanceof ReceivingInspectionError) throw err;
    throw err;
  }
}

const REPLAN_SESSION_STATUSES = ["DRAFT", "IN_PROGRESS", "COMPLETED"];

async function countReceivingEvidence(companyId, receivingUnitIds = [], asnId = null, mongoSession = null) {
  const opts = mongoSession ? { session: mongoSession } : {};
  const ids = (receivingUnitIds || []).filter(Boolean);
  const unitFilter = { companyId };
  if (asnId && ids.length) {
    unitFilter.$or = [{ asnId }, { receivingUnitId: { $in: ids } }];
  } else if (asnId) {
    unitFilter.asnId = asnId;
  } else if (ids.length) {
    unitFilter.receivingUnitId = { $in: ids };
  } else {
    return { unitCount: 0, photoCount: 0 };
  }
  const unitCount = await ReceivingSessionUnit.countDocuments(unitFilter, opts);
  const photoFilter = { companyId };
  if (asnId && ids.length) {
    photoFilter.$or = [{ asnId }, { receivingUnitId: { $in: ids } }];
  } else if (asnId) {
    photoFilter.asnId = asnId;
  } else {
    photoFilter.receivingUnitId = { $in: ids };
  }
  const photoCount = await ReceivingUnitPhoto.countDocuments(photoFilter, opts);
  return { unitCount, photoCount };
}

export async function inspectReplanReceivingBlockers(companyId, receivingUnitIds = [], asnId = null) {
  const empty = { blocked: false, reason: "", source: "", sessionStatus: "", grnNo: "" };
  let session = null;
  if (asnId) {
    session = await ReceivingSession.findOne({
      companyId,
      asnId,
      status: { $in: REPLAN_SESSION_STATUSES },
    })
      .select("status completedAt")
      .lean();
  }
  const { unitCount, photoCount } = await countReceivingEvidence(companyId, receivingUnitIds, asnId);
  const classified = classifyReplanReceivingFreeze({ session, unitCount, photoCount });
  if (!classified.blocked) return { ...empty, sessionStatus: classified.sessionStatus || "" };
  return { ...classified, grnNo: "" };
}

/**
 * After a successful RU replacement, drop a truly empty DRAFT session so it
 * cannot keep pointing at superseded identities. CANCELLED frees the
 * one-active-session-per-ASN unique index. Never cancel if units/photos exist.
 */
export async function invalidateEmptyDraftReceivingSession({
  companyId,
  asnId,
  actor = "",
  mongoSession = null,
} = {}) {
  const opts = mongoSession ? { session: mongoSession } : {};
  const draft = await ReceivingSession.findOne({ companyId, asnId, status: "DRAFT" }, null, opts);
  if (!draft) return { invalidated: false, reason: "NO_DRAFT" };

  const { unitCount, photoCount } = await countReceivingEvidence(companyId, [], asnId, mongoSession);
  if (!isEmptyDraftReceivingSession({ session: draft, unitCount, photoCount })) {
    return { invalidated: false, reason: "NOT_EMPTY" };
  }

  const updated = await ReceivingSession.findOneAndUpdate(
    { _id: draft._id, companyId, status: "DRAFT" },
    {
      $set: {
        status: "CANCELLED",
        lastActivityBy: actor || "system",
        lastActivityAt: new Date(),
      },
    },
    { new: true, ...opts }
  );
  if (!updated) {
    return { invalidated: false, reason: "NO_LONGER_DRAFT" };
  }

  const after = await countReceivingEvidence(companyId, [], asnId, mongoSession);
  if (after.unitCount > 0 || after.photoCount > 0) {
    if (mongoSession) {
      throw new ReceivingUnitError(
        "Receiving has started. RU structure can no longer be changed.",
        409,
        "RU_RECEIVING_STARTED",
        { source: "RECEIVING_SESSION_UNIT" }
      );
    }
    await ReceivingSession.updateOne(
      { _id: draft._id, companyId, status: "CANCELLED" },
      { $set: { status: "DRAFT" } }
    );
    return { invalidated: false, reason: "RACE_EVIDENCE" };
  }
  return { invalidated: true, sessionId: String(draft._id), sessionNo: draft.sessionNo };
}

export async function currentPlanHasReceivingActivity(companyId, receivingUnitIds = [], asnId = null) {
  const blockers = await inspectReplanReceivingBlockers(companyId, receivingUnitIds, asnId);
  return blockers.blocked;
}

export async function assertReplanNotBlockedByReceiving(companyId, receivingUnitIds = [], asnId = null) {
  const activity = await inspectReplanReceivingBlockers(companyId, receivingUnitIds, asnId);
  assertReplanBlockedByReceiving(activity);
}

export { ReceivingInspectionError };
