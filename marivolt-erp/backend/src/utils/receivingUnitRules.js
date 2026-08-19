/**
 * Receiving Unit Phase 2 domain rules (pure).
 * RUs subdivide ASN qty into physical labels. They never post stock or change PO asnActiveQty.
 */

import { ASN_QTY_EPS, roundAsnQty } from "./asnRules.js";

export const RU_STATUSES = Object.freeze(["PLANNED", "PRINTED", "SUPERSEDED", "CANCELLED"]);
/** Current warehouse identities for an ASN line. */
export const RU_ACTIVE_STATUSES = Object.freeze(["PLANNED", "PRINTED"]);
export const RU_INACTIVE_STATUSES = Object.freeze(["SUPERSEDED", "CANCELLED"]);
export const RU_PLAN_ELIGIBLE_ASN_STATUSES = Object.freeze(["SHIPPED", "ARRIVED"]);

export const RU_NUMBER_WIDTH = 6;

export class ReceivingUnitError extends Error {
  constructor(message, status = 400, code = "RU_ERROR", details = null) {
    super(message);
    this.name = "ReceivingUnitError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    if (details && typeof details === "object") this.details = details;
  }
}

export function isActiveRuStatus(status) {
  return RU_ACTIVE_STATUSES.includes(String(status || "").toUpperCase());
}

export function isPrintedRuStatus(status) {
  return String(status || "").trim().toUpperCase() === "PRINTED";
}

export function isPlannedRuStatus(status) {
  return String(status || "").trim().toUpperCase() === "PLANNED";
}

export function isSupersededRuStatus(status) {
  return String(status || "").trim().toUpperCase() === "SUPERSEDED";
}

export function isCancelledRuStatus(status) {
  return String(status || "").trim().toUpperCase() === "CANCELLED";
}

export function retireStatusForRu(ru) {
  return isPrintedRuStatus(ru?.status) ? "SUPERSEDED" : "CANCELLED";
}

export function currentRuPlanVersion(line = {}) {
  const n = Number(line.ruPlanVersion);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Atomic claim of the next plan revision for one ASN line.
 * Exactly one concurrent caller can succeed for a given expectedVersion.
 */
export function tryClaimRuPlanVersion(line, expectedVersion, nextBatchId) {
  const cur = currentRuPlanVersion(line);
  const expected = Number(expectedVersion) || 0;
  if (cur !== expected) {
    return { ok: false, reason: "RU_PLAN_CONFLICT", current: cur };
  }
  line.ruPlanVersion = cur + 1;
  line.ruActivePlanBatchId = nextBatchId;
  return { ok: true, version: line.ruPlanVersion, planBatchId: nextBatchId };
}

export function isCurrentPlanRu(ru, currentBatchId) {
  if (!currentBatchId || !ru?.planBatchId) return false;
  return String(ru.planBatchId) === String(currentBatchId) && isActiveRuStatus(ru.status);
}

export function activeRusForCurrentPlan(rus = [], currentBatchId) {
  return (rus || []).filter((ru) => isCurrentPlanRu(ru, currentBatchId));
}

/**
 * In-memory planner used to prove concurrent first-plan / replan.
 * Mirrors server claim-first-then-write order. Does not touch PO qty.
 */
export function applyMemoryRuPlan({
  line,
  rus,
  distribution,
  replacePrinted = false,
  batchId,
  expectedVersion,
  inflightJobs = [],
} = {}) {
  assertReplanAllowedForPrintJobs(inflightJobs);
  const currentBatchId = line.ruActivePlanBatchId;
  const active = currentBatchId
    ? activeRusForCurrentPlan(rus, currentBatchId)
    : (rus || []).filter((ru) => isActiveRuStatus(ru.status));
  if (distributionsMatch(plannedQtyList(active), distribution)) {
    return { ok: true, reused: true, line, rus };
  }
  const printed = active.filter((ru) => isPrintedRuStatus(ru.status));
  if (printed.length && !replacePrinted) {
    throw new ReceivingUnitError(
      "Printed Receiving Units must be explicitly replaced",
      409,
      "RU_PRINTED_PLAN_LOCKED"
    );
  }
  const expected = expectedVersion != null ? Number(expectedVersion) : currentRuPlanVersion(line);
  const claim = tryClaimRuPlanVersion(line, expected, batchId);
  if (!claim.ok) {
    throw new ReceivingUnitError(
      "Another user updated this ASN line label plan. Refresh and try again.",
      409,
      "RU_PLAN_CONFLICT"
    );
  }
  for (const ru of active) {
    ru.status = retireStatusForRu(ru);
    ru.supersededByPlanBatchId = batchId;
    if (ru.status === "SUPERSEDED") ru.supersededAt = ru.supersededAt || new Date(0);
  }
  for (const qty of distribution || []) {
    rus.push({
      status: "PLANNED",
      plannedQty: qty,
      planBatchId: batchId,
      barcodeValue: `RU-${batchId}-${rus.length}`,
      ruNo: `RU-${batchId}-${rus.length}`,
    });
  }
  return { ok: true, reused: false, line, rus };
}

export function sumActivePlannedQty(rus, currentBatchId) {
  return sumPlannedQty(activeRusForCurrentPlan(rus, currentBatchId));
}

export const RU_IN_FLIGHT_PRINT_JOB_STATUSES = Object.freeze(["PENDING", "LEASED", "PRINTING"]);
export const RU_BLOCKING_PRINT_JOB_STATUSES = Object.freeze([
  "PENDING",
  "LEASED",
  "PRINTING",
  "UNCERTAIN",
]);

export function assertReplanAllowedForPrintJobs(jobs = []) {
  const statuses = (jobs || []).map((job) => String(job?.status || "").trim().toUpperCase());
  if (statuses.includes("UNCERTAIN")) {
    throw new ReceivingUnitError(
      "Resolve the UNCERTAIN print job before replacing this Receiving Unit plan.",
      409,
      "RU_PRINT_UNCERTAIN"
    );
  }
  if (statuses.some((status) => RU_IN_FLIGHT_PRINT_JOB_STATUSES.includes(status))) {
    throw new ReceivingUnitError(
      "A Receiving Unit label is still printing. Wait for the job to finish or fail before replacing the plan.",
      409,
      "RU_PRINT_IN_PROGRESS"
    );
  }
  return true;
}

/**
 * Completed Phase 2 plans: current-batch active qty must equal ASN line qty.
 * No current pointer + no active RUs is a valid empty state.
 */
export function assertCompletedPlanQtyInvariant(line = {}, rus = []) {
  const asnQty = roundAsnQty(line.asnQty);
  const batchId = line.ruActivePlanBatchId || null;
  const active = batchId
    ? activeRusForCurrentPlan(rus, batchId)
    : (rus || []).filter((ru) => isActiveRuStatus(ru.status));
  if (!batchId && !active.length) return true;
  if (batchId && !active.length) {
    throw new ReceivingUnitError(
      "Current plan batch has no Receiving Units",
      409,
      "RU_PLAN_INCOMPLETE"
    );
  }
  const sum = sumPlannedQty(active);
  if (Math.abs(sum - asnQty) > ASN_QTY_EPS) {
    throw new ReceivingUnitError(
      `Current plan qty ${sum} does not match ASN line qty ${asnQty}`,
      409,
      "RU_PLAN_QTY_MISMATCH"
    );
  }
  return true;
}

function snapshotPlanState(line, rus) {
  return {
    line: {
      ruPlanVersion: line.ruPlanVersion,
      ruActivePlanBatchId: line.ruActivePlanBatchId,
    },
    rus: (rus || []).map((ru) => ({ ...ru })),
  };
}

function restorePlanState(line, rus, snap) {
  line.ruPlanVersion = snap.line.ruPlanVersion;
  line.ruActivePlanBatchId = snap.line.ruActivePlanBatchId;
  rus.length = 0;
  rus.push(...snap.rus);
}

/**
 * Production replica-set behaviour: claim + retire + mint are one unit.
 * Abort after a successful claim restores the previous current plan.
 */
export function applyTransactionalRuPlan(args = {}) {
  const { line, rus } = args;
  const snap = snapshotPlanState(line, rus);
  try {
    if (args.failAfter === "claim") {
      assertReplanAllowedForPrintJobs(args.inflightJobs);
      const currentBatchId = line.ruActivePlanBatchId;
      const active = currentBatchId
        ? activeRusForCurrentPlan(rus, currentBatchId)
        : (rus || []).filter((ru) => isActiveRuStatus(ru.status));
      if (distributionsMatch(plannedQtyList(active), args.distribution)) {
        return { ok: true, reused: true, line, rus };
      }
      const expected =
        args.expectedVersion != null ? Number(args.expectedVersion) : currentRuPlanVersion(line);
      const claim = tryClaimRuPlanVersion(line, expected, args.batchId);
      if (!claim.ok) {
        throw new ReceivingUnitError(
          "Another user updated this ASN line label plan. Refresh and try again.",
          409,
          "RU_PLAN_CONFLICT"
        );
      }
      const err = new Error("PLAN_TXN_ABORTED");
      err.code = "PLAN_TXN_ABORTED";
      throw err;
    }
    assertReplanAllowedForPrintJobs(args.inflightJobs);
    const result = applyMemoryRuPlan(args);
    if (!result.reused) assertCompletedPlanQtyInvariant(line, rus);
    return result;
  } catch (err) {
    restorePlanState(line, rus, snap);
    if (err?.code === "PLAN_TXN_ABORTED") {
      return { ok: false, rolledBack: true, line, rus };
    }
    throw err;
  }
}

/**
 * Standalone Mongo fallback: never publish an incomplete batch as current.
 * Numbers may be minted first; the CAS pointer is applied only after the full batch exists.
 */
export function applyMintThenPublishRuPlan(args = {}) {
  const {
    line,
    rus,
    distribution,
    replacePrinted = false,
    batchId,
    expectedVersion,
    failAfter,
    inflightJobs,
  } = args;
  assertReplanAllowedForPrintJobs(inflightJobs);
  const currentBatchId = line.ruActivePlanBatchId;
  const active = currentBatchId
    ? activeRusForCurrentPlan(rus, currentBatchId)
    : (rus || []).filter((ru) => isActiveRuStatus(ru.status));
  if (distributionsMatch(plannedQtyList(active), distribution)) {
    return { ok: true, reused: true, published: true, line, rus };
  }
  const printed = active.filter((ru) => isPrintedRuStatus(ru.status));
  if (printed.length && !replacePrinted) {
    throw new ReceivingUnitError(
      "Printed Receiving Units must be explicitly replaced",
      409,
      "RU_PRINTED_PLAN_LOCKED"
    );
  }
  const minted = (distribution || []).map((qty, idx) => ({
    status: "PLANNED",
    plannedQty: qty,
    planBatchId: batchId,
    barcodeValue: `RU-${batchId}-new-${idx}`,
    ruNo: `RU-${batchId}-new-${idx}`,
  }));
  if (failAfter === "before-publish") {
    rus.push(...minted);
    return { ok: false, published: false, rolledBack: false, line, rus };
  }
  const expected = expectedVersion != null ? Number(expectedVersion) : currentRuPlanVersion(line);
  const claim = tryClaimRuPlanVersion(line, expected, batchId);
  if (!claim.ok) {
    throw new ReceivingUnitError(
      "Another user updated this ASN line label plan. Refresh and try again.",
      409,
      "RU_PLAN_CONFLICT"
    );
  }
  for (const ru of active) {
    ru.status = retireStatusForRu(ru);
    ru.supersededByPlanBatchId = batchId;
  }
  rus.push(...minted);
  assertCompletedPlanQtyInvariant(line, rus);
  return { ok: true, reused: false, published: true, line, rus };
}

/**
 * First COMPLETED print freezes labelPrintedAt. Duplicate COMPLETED / reprint
 * only refresh lastLabelJobId. Inactive or non-current RUs stay inactive and
 * only record stale physical-print telemetry.
 */
export function applySuccessfulPrintToRu(
  ru,
  { jobId, printedAt, printedBy, current = true } = {}
) {
  if (!ru) return ru;
  const inactive =
    ru.status === "CANCELLED" || ru.status === "SUPERSEDED" || current === false;
  if (inactive) {
    ru.staleLabelJobId = jobId;
    ru.staleLabelPrintedAt = printedAt;
    ru.staleLabelPrintedBy = printedBy || "";
    return ru;
  }
  if (ru.status === "PLANNED") {
    ru.status = "PRINTED";
    ru.labelPrintedAt = printedAt;
    ru.labelPrintedBy = printedBy || "";
    ru.lastLabelJobId = jobId;
    return ru;
  }
  if (ru.status === "PRINTED") {
    ru.lastLabelJobId = jobId;
    return ru;
  }
  return ru;
}

export function assertAsnEligibleForRuPlan(status) {
  const s = String(status || "").toUpperCase();
  if (!RU_PLAN_ELIGIBLE_ASN_STATUSES.includes(s)) {
    throw new ReceivingUnitError(
      `Receiving Unit labels can only be prepared when the ASN is SHIPPED or ARRIVED (current: ${s || "UNKNOWN"})`,
      400,
      "RU_ASN_STATUS"
    );
  }
  return s;
}

export function plannedQtyList(rus = []) {
  return (rus || [])
    .filter((ru) => isActiveRuStatus(ru.status))
    .map((ru) => roundAsnQty(ru.plannedQty));
}

export function distributionsMatch(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (Math.abs(roundAsnQty(a[i]) - roundAsnQty(b[i])) > ASN_QTY_EPS) return false;
  }
  return true;
}

export function sumPlannedQty(rus = []) {
  return roundAsnQty(
    (rus || []).reduce((s, ru) => s + (Number(ru.plannedQty) || 0), 0)
  );
}

/** Fingerprint of a persisted RU print plan. Different splits must differ. */
export function buildReceivingUnitLabelFingerprint(rus = []) {
  const parts = (rus || [])
    .map((ru) => {
      const id = String(ru._id || ru.receivingUnitId || "").trim();
      const ruNo = String(ru.ruNo || "").trim().toUpperCase();
      const barcode = String(ru.barcodeValue || ruNo).trim().toUpperCase();
      const qty = roundAsnQty(ru.plannedQty);
      const line = String(ru.asnLineId || "").trim();
      const article = String(ru.article || "").trim().toUpperCase();
      return `${id}|${ruNo}|q:${qty}|b:${barcode}|line:${line}|a:${article}`;
    })
    .filter((p) => p && p !== "||q:0|b:|line:|a:")
    .sort();
  return parts.join(";");
}

export function formatAsnPartNo(line = {}) {
  const part = String(line.partNo || line.partNumber || "").trim();
  const spn = String(line.spn || line.supplierPartNumber || "").trim();
  if (part && spn && part.toUpperCase() !== spn.toUpperCase()) return `${part} / ${spn}`;
  return part || spn || "";
}

/**
 * Identity fields that must not change after a successful print.
 */
export const RU_CREATED_IMMUTABLE_KEYS = Object.freeze([
  "companyId",
  "ruNo",
  "barcodeValue",
  "asnId",
  "asnNo",
  "asnLineId",
  "sourcePoId",
  "sourcePoLineId",
  "article",
  "planBatchId",
  "createdBy",
]);

export const RU_PRINTED_IMMUTABLE_KEYS = Object.freeze([
  "ruNo",
  "barcodeValue",
  "asnId",
  "asnLineId",
  "article",
  "plannedQty",
  "uom",
  "partNo",
  "spn",
]);

export function assertPrintedIdentityUnchanged(existing, patch = {}) {
  if (!isPrintedRuStatus(existing?.status)) return true;
  for (const key of RU_PRINTED_IMMUTABLE_KEYS) {
    if (patch[key] === undefined) continue;
    const before = key === "plannedQty" ? roundAsnQty(existing[key]) : String(existing[key] || "");
    const after = key === "plannedQty" ? roundAsnQty(patch[key]) : String(patch[key] || "");
    if (before !== after) {
      throw new ReceivingUnitError(
        `Cannot change ${key} on a printed Receiving Unit ${existing.ruNo}`,
        409,
        "RU_PRINTED_IMMUTABLE"
      );
    }
  }
  return true;
}

export { ASN_QTY_EPS, roundAsnQty };
