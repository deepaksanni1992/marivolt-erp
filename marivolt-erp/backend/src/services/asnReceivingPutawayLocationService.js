/**
 * Receiving-scoped physical putaway StockLocation quick-create for ASN_RECEIVING Draft GRNs.
 * STORE_OPERATOR may use this path; general POST /stock/locations remains restricted.
 */
import mongoose from "mongoose";
import ReceivingSession from "../models/ReceivingSession.js";
import { findDraftAsnReceivingGrn } from "./asnReceivingDraftService.js";
import { isAsnReceivingGrn } from "../utils/receivingDraftGrnRules.js";
import { ReceivingInspectionError } from "../utils/receivingInspectionRules.js";
import { createPhysicalPutawayStockLocation, StockLocationError } from "./stockLocationService.js";
import { writeAudit } from "./auditService.js";

export const RECEIVING_PUTAWAY_NOT_ELIGIBLE = "RECEIVING_PUTAWAY_NOT_ELIGIBLE";

function oid(id) {
  if (!id) return null;
  if (id instanceof mongoose.Types.ObjectId) return id;
  const s = String(id);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function actorName(req) {
  return String(req?.user?.email || req?.user?.name || req?.user?.username || "system").trim();
}

/** Server authority — warehouse from GRN lines, never client-supplied alternate warehouse. */
export function resolveAsnReceivingPutawayWarehouse(grn) {
  for (const ln of grn?.items || []) {
    const wh = String(ln.warehouse || "").trim().toUpperCase();
    if (wh) return wh;
  }
  return "MAIN";
}

export async function createReceivingSessionPutawayLocation(req, sessionId, { rack, bin } = {}) {
  const companyId = req.companyId;
  const sid = oid(sessionId);
  if (!sid) {
    throw new ReceivingInspectionError("Invalid receiving session", 400, RECEIVING_PUTAWAY_NOT_ELIGIBLE);
  }

  const session = await ReceivingSession.findOne({ _id: sid, companyId }).lean();
  if (!session) {
    throw new ReceivingInspectionError("Receiving session not found", 404, RECEIVING_PUTAWAY_NOT_ELIGIBLE);
  }

  const grn = await findDraftAsnReceivingGrn(companyId, sid);
  if (!grn || !isAsnReceivingGrn(grn)) {
    throw new ReceivingInspectionError(
      "Draft ASN receiving GRN is required for putaway quick-create",
      409,
      RECEIVING_PUTAWAY_NOT_ELIGIBLE,
    );
  }
  if (String(grn.status || "").toUpperCase() !== "DRAFT") {
    throw new ReceivingInspectionError(
      "Putaway quick-create requires a Draft GRN",
      409,
      RECEIVING_PUTAWAY_NOT_ELIGIBLE,
    );
  }

  const warehouse = resolveAsnReceivingPutawayWarehouse(grn);

  let result;
  try {
    result = await createPhysicalPutawayStockLocation({
      companyId,
      warehouse,
      rack,
      bin,
    });
  } catch (err) {
    if (err instanceof StockLocationError) {
      throw new ReceivingInspectionError(err.message, err.status || 400, err.code);
    }
    throw err;
  }

  const { row, created, reused } = result;
  const actor = actorName(req);
  const now = new Date();

  await writeAudit(req, {
    action: created ? "CREATE" : "REUSE",
    module: "STORE",
    entityType: "StockLocation",
    entityId: row._id,
    documentNo: row.locationCode,
    description: `${created ? "Created" : "Reused"} putaway location ${row.locationCode} for ASN receiving`,
    metadata: {
      source: "ASN_RECEIVING_PUTAWAY",
      companyId: String(companyId),
      locationCode: row.locationCode,
      warehouse: row.warehouse,
      rack: row.rack,
      bin: row.bin,
      asnId: String(session.asnId || grn.asnId || ""),
      asnNo: session.asnNo || grn.asnNo || "",
      grnId: String(grn._id),
      grnNo: grn.grnNo,
      receivingSessionId: String(session._id),
      receivingSessionNo: session.sessionNo,
      actor,
      timestamp: now.toISOString(),
      reused: reused === true,
    },
  });

  return {
    location: row,
    created: created === true,
    reused: reused === true,
    warehouse,
    receivingSessionId: String(session._id),
    grnNo: grn.grnNo,
  };
}
