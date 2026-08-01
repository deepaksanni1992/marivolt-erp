/**
 * P0.1 RTS protection helpers (pure / injectable).
 * Blocks generic status bypass and classifies already-APPROVED re-approval.
 */

export const RTS_EDITABLE_UPDATE_FIELDS = Object.freeze(["rtsDate", "packingDetails", "lines"]);

/** Workflow / posting fields that must never be set via generic updateRts. */
export const RTS_PROTECTED_UPDATE_FIELDS = Object.freeze([
  "status",
  "approvedAt",
  "approvedBy",
  "postedAt",
  "postedBy",
  "stockPostedAt",
  "stockPostingKey",
  "cancelledAt",
  "cancelledBy",
  "cancellationReason",
  "linkedSalesInvoiceId",
  "linkedSalesInvoiceNo",
  "convertedToInvoiceAt",
  "convertedToInvoiceBy",
]);

export const RTS_APPROVED_WITHOUT_STOCK_POST = "RTS_APPROVED_WITHOUT_STOCK_POST";
export const RTS_APPROVAL_IN_PROGRESS = "RTS_APPROVAL_IN_PROGRESS";

/**
 * Returns body keys that are not on the editable whitelist.
 * Any non-whitelist field is rejected (400) rather than silently ignored.
 */
export function getDisallowedRtsUpdateFields(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body).filter((key) => !RTS_EDITABLE_UPDATE_FIELDS.includes(key));
}

/** @returns {"HEALTHY_APPROVED"|"ORPHAN_APPROVED"} */
export function classifyApprovedRtsForReapproval(hasRtsTransferEvidence) {
  return hasRtsTransferEvidence ? "HEALTHY_APPROVED" : "ORPHAN_APPROVED";
}

export function buildRtsDraftApprovalClaimFilter({ id, companyId }) {
  return { _id: id, companyId, status: "DRAFT" };
}

export function buildRtsDraftApprovalClaimUpdate({ updatedBy = "" } = {}) {
  return { $set: { status: "APPROVING", updatedBy: String(updatedBy || "") } };
}

/**
 * In-memory atomic DRAFT→APPROVING claim used by focused concurrency tests.
 * Mirrors the Mongo findOneAndUpdate({ status: "DRAFT" }, { status: "APPROVING" }) pattern.
 */
export function claimDraftRtsInMemory(store, { id, companyId, updatedBy = "" }) {
  const doc = store.get(String(id));
  if (!doc) return null;
  if (String(doc.companyId) !== String(companyId)) return null;
  if (String(doc.status || "").toUpperCase() !== "DRAFT") return null;
  const claimed = { ...doc, status: "APPROVING", updatedBy };
  store.set(String(id), claimed);
  return claimed;
}

/**
 * Simulated approve path for tests (no Mongo): claim → stock → APPROVED, or abort to DRAFT.
 */
export async function simulateApproveRtsClaim({
  store,
  id,
  companyId,
  updatedBy = "",
  hasRtsTransferEvidence,
  stockWork,
}) {
  const current = store.get(String(id));
  if (!current) {
    const err = new Error("Not found");
    err.statusCode = 404;
    throw err;
  }
  const st = String(current.status || "").toUpperCase();
  if (st === "APPROVED") {
    const kind = classifyApprovedRtsForReapproval(Boolean(hasRtsTransferEvidence(current)));
    if (kind === "ORPHAN_APPROVED") {
      const err = new Error("RTS is APPROVED but has no RTS stock-posting evidence");
      err.statusCode = 409;
      err.code = RTS_APPROVED_WITHOUT_STOCK_POST;
      throw err;
    }
    return { outcome: "idempotent", doc: current, stockMoves: 0 };
  }
  if (st === "APPROVING") {
    const err = new Error("RTS approval already in progress");
    err.statusCode = 409;
    err.code = RTS_APPROVAL_IN_PROGRESS;
    throw err;
  }
  if (st === "CANCELLED" || st === "CONVERTED_TO_INVOICE") {
    const err = new Error(`Cannot approve RTS in status ${st}`);
    err.statusCode = 400;
    throw err;
  }

  const claimed = claimDraftRtsInMemory(store, { id, companyId, updatedBy });
  if (!claimed) {
    const latest = store.get(String(id));
    const latestSt = String(latest?.status || "").toUpperCase();
    if (latestSt === "APPROVED") {
      const kind = classifyApprovedRtsForReapproval(Boolean(hasRtsTransferEvidence(latest)));
      if (kind === "ORPHAN_APPROVED") {
        const err = new Error("RTS is APPROVED but has no RTS stock-posting evidence");
        err.statusCode = 409;
        err.code = RTS_APPROVED_WITHOUT_STOCK_POST;
        throw err;
      }
      return { outcome: "idempotent", doc: latest, stockMoves: 0 };
    }
    if (latestSt === "APPROVING") {
      const err = new Error("RTS approval already in progress");
      err.statusCode = 409;
      err.code = RTS_APPROVAL_IN_PROGRESS;
      throw err;
    }
    const err = new Error(`Cannot approve RTS in status ${latestSt || "UNKNOWN"}`);
    err.statusCode = 409;
    throw err;
  }

  try {
    await stockWork(claimed);
    const approved = { ...claimed, status: "APPROVED", updatedBy, hasEvidence: true };
    store.set(String(id), approved);
    return { outcome: "approved", doc: approved, stockMoves: 1 };
  } catch (e) {
    // Transaction abort equivalent: never leave APPROVING / APPROVED after stock failure.
    store.set(String(id), { ...claimed, status: "DRAFT", updatedBy: claimed.updatedBy || "" });
    throw e;
  }
}
