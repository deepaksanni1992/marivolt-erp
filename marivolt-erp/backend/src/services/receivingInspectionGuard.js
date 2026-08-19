/**
 * Phase 3A guards used by Phase 2 RU replan / ASN cancel.
 * Kept out of asnService so Phase 1 remains free of ReceivingUnit / barcode strings.
 */

import ReceivingSession from "../models/ReceivingSession.js";
import ReceivingSessionUnit from "../models/ReceivingSessionUnit.js";
import ReceivingUnitPhoto from "../models/ReceivingUnitPhoto.js";
import {
  ReceivingInspectionError,
  assertAsnCancelBlockedByReceiving,
  assertReplanBlockedByReceiving,
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

export async function currentPlanHasReceivingActivity(companyId, receivingUnitIds = [], asnId = null) {
  if (asnId) {
    const sessions = await ReceivingSession.countDocuments({
      companyId,
      asnId,
      status: { $in: ["DRAFT", "IN_PROGRESS", "COMPLETED"] },
    });
    if (sessions > 0) return true;
  }
  const ids = (receivingUnitIds || []).filter(Boolean);
  if (!ids.length && !asnId) return false;
  if (ids.length) {
    const unitCount = await ReceivingSessionUnit.countDocuments({
      companyId,
      receivingUnitId: { $in: ids },
    });
    if (unitCount > 0) return true;
    const photoCount = await ReceivingUnitPhoto.countDocuments({
      companyId,
      receivingUnitId: { $in: ids },
    });
    if (photoCount > 0) return true;
  }
  return false;
}

export async function assertReplanNotBlockedByReceiving(companyId, receivingUnitIds = [], asnId = null) {
  const activity = await currentPlanHasReceivingActivity(companyId, receivingUnitIds, asnId);
  assertReplanBlockedByReceiving(activity);
}

export { ReceivingInspectionError };
