/**
 * AvailableQty projection repair — commercial StockBalance hygiene only.
 * Mutates ONLY StockBalance.availableQty from deriveAvailableQty(authoritative buckets).
 * Never touches onHand / reserved / allocated / packed / StockLedger / allocations.
 */
import { deriveAvailableQty } from "./stockExpectedBuckets.js";

export const AVAILABLE_QTY_PROJECTION_REPAIR_ACTION = "AVAILABLE_QTY_PROJECTION_REPAIRED";

export const EVIDENCE_STATUS = Object.freeze({
  DRY_RUN: "DRY_RUN",
  APPLY_STARTED: "APPLY_STARTED",
  APPLIED: "APPLIED",
  APPLIED_AUDIT_FAILED: "APPLIED_AUDIT_FAILED",
  NO_CHANGE: "NO_CHANGE",
  FAILED_BEFORE_APPLY: "FAILED_BEFORE_APPLY",
});

const EPS = 1e-6;

export function storedAvailableQty(doc) {
  const derived = deriveAvailableQty(doc);
  if (doc?.availableQty == null) return derived;
  return Number(doc.availableQty) || 0;
}

/**
 * Build repair plan from StockBalance docs (mongoose docs or lean objects).
 * @returns {Array<object>}
 */
export function buildAvailableQtyMismatchPlan(docs = []) {
  const plan = [];
  for (const doc of docs || []) {
    const derived = deriveAvailableQty(doc);
    const stored = storedAvailableQty(doc);
    if (Math.abs(stored - derived) <= EPS) continue;
    plan.push({
      stockBalanceId: String(doc._id),
      article: doc.article || doc.itemCode || "",
      warehouse: doc.warehouse || doc.location || "",
      onHandQty: Number(doc.onHandQty ?? doc.quantity) || 0,
      quantity: Number(doc.quantity ?? doc.onHandQty) || 0,
      reservedQty: Number(doc.reservedQty) || 0,
      allocatedQty: Number(doc.allocatedQty) || 0,
      packedQty: Number(doc.packedQty) || 0,
      fromAvailableQty: stored,
      toAvailableQty: derived,
      difference: stored - derived,
    });
  }
  return plan;
}

export function buildAuditPayload({
  companyId,
  stockBalanceId,
  article,
  warehouse,
  before,
  after,
  tool = "repairAvailableQtyProjection.mjs",
}) {
  return {
    companyId,
    userEmail: tool,
    userName: "SYSTEM_REPAIR",
    action: AVAILABLE_QTY_PROJECTION_REPAIR_ACTION,
    module: "STOCK",
    entityType: "StockBalance",
    entityId: String(stockBalanceId),
    documentNo: String(article || ""),
    description: `Repaired availableQty projection ${before.availableQty} → ${after.availableQty} for ${article} / ${warehouse}`,
    beforeData: {
      onHandQty: before.onHandQty,
      quantity: before.quantity,
      reservedQty: before.reservedQty,
      allocatedQty: before.allocatedQty,
      packedQty: before.packedQty,
      availableQty: before.availableQty,
    },
    afterData: {
      onHandQty: after.onHandQty,
      quantity: after.quantity,
      reservedQty: after.reservedQty,
      allocatedQty: after.allocatedQty,
      packedQty: after.packedQty,
      availableQty: after.availableQty,
    },
    metadata: {
      reason: "AVAILABLE_QTY_MISMATCH",
      repairTool: tool,
      warehouse: warehouse || "",
      article: article || "",
      stockBalanceId: String(stockBalanceId),
      oldAvailableQty: before.availableQty,
      newAvailableQty: after.availableQty,
      onHandQty: after.onHandQty,
      reservedQty: after.reservedQty,
      allocatedQty: after.allocatedQty,
      packedQty: after.packedQty,
      repairedAt: new Date().toISOString(),
    },
  };
}

/**
 * Apply one availableQty projection repair.
 * Separates stock mutation success from audit success.
 *
 * @param {object} opts
 * @param {object} opts.doc — mongoose StockBalance document with save()
 * @param {*} opts.companyId
 * @param {(payload: object) => Promise<*>} [opts.writeAuditLog]
 * @returns {Promise<object>}
 */
export async function applyAvailableQtyProjectionRepair({
  doc,
  companyId,
  writeAuditLog = null,
  tool = "repairAvailableQtyProjection.mjs",
} = {}) {
  if (!doc) {
    return {
      status: EVIDENCE_STATUS.FAILED_BEFORE_APPLY,
      mutated: false,
      message: "StockBalance document not found",
    };
  }

  const derived = deriveAvailableQty(doc);
  const beforeAvailable = storedAvailableQty(doc);
  const beforeSnapshot = {
    onHandQty: Number(doc.onHandQty ?? doc.quantity) || 0,
    quantity: Number(doc.quantity ?? doc.onHandQty) || 0,
    reservedQty: Number(doc.reservedQty) || 0,
    allocatedQty: Number(doc.allocatedQty) || 0,
    packedQty: Number(doc.packedQty) || 0,
    availableQty: beforeAvailable,
  };

  if (Math.abs(beforeAvailable - derived) <= EPS) {
    return {
      status: EVIDENCE_STATUS.NO_CHANGE,
      mutated: false,
      stockBalanceId: String(doc._id),
      article: doc.article || doc.itemCode || "",
      warehouse: doc.warehouse || doc.location || "",
      before: beforeSnapshot,
      after: beforeSnapshot,
      message: "stored availableQty already matches deriveAvailableQty — no mutation",
    };
  }

  // Mutate ONLY availableQty
  doc.availableQty = derived;
  try {
    await doc.save();
  } catch (err) {
    return {
      status: EVIDENCE_STATUS.FAILED_BEFORE_APPLY,
      mutated: false,
      stockBalanceId: String(doc._id),
      article: doc.article || doc.itemCode || "",
      warehouse: doc.warehouse || doc.location || "",
      before: beforeSnapshot,
      error: err?.message || String(err),
      message: "STOCK REPAIR FAILED BEFORE/DURING SAVE",
    };
  }

  const afterSnapshot = {
    onHandQty: Number(doc.onHandQty ?? doc.quantity) || 0,
    quantity: Number(doc.quantity ?? doc.onHandQty) || 0,
    reservedQty: Number(doc.reservedQty) || 0,
    allocatedQty: Number(doc.allocatedQty) || 0,
    packedQty: Number(doc.packedQty) || 0,
    availableQty: Number(doc.availableQty) || 0,
  };

  // Verify post-save
  if (Math.abs(afterSnapshot.availableQty - derived) > EPS) {
    return {
      status: EVIDENCE_STATUS.APPLIED_AUDIT_FAILED,
      mutated: true,
      stockBalanceId: String(doc._id),
      article: doc.article || doc.itemCode || "",
      warehouse: doc.warehouse || doc.location || "",
      before: beforeSnapshot,
      after: afterSnapshot,
      message:
        "STOCK REPAIR APPLIED but post-save verification of availableQty failed — do not retry automatically",
      error: `expected availableQty ${derived}, found ${afterSnapshot.availableQty}`,
    };
  }

  if (typeof writeAuditLog !== "function") {
    return {
      status: EVIDENCE_STATUS.APPLIED,
      mutated: true,
      stockBalanceId: String(doc._id),
      article: doc.article || doc.itemCode || "",
      warehouse: doc.warehouse || doc.location || "",
      before: beforeSnapshot,
      after: afterSnapshot,
      auditWritten: false,
      message: "STOCK REPAIR APPLIED SUCCESSFULLY (no audit writer provided)",
    };
  }

  const auditPayload = buildAuditPayload({
    companyId,
    stockBalanceId: doc._id,
    article: doc.article || doc.itemCode || "",
    warehouse: doc.warehouse || doc.location || "",
    before: beforeSnapshot,
    after: afterSnapshot,
    tool,
  });

  try {
    await writeAuditLog(auditPayload);
    return {
      status: EVIDENCE_STATUS.APPLIED,
      mutated: true,
      stockBalanceId: String(doc._id),
      article: doc.article || doc.itemCode || "",
      warehouse: doc.warehouse || doc.location || "",
      before: beforeSnapshot,
      after: afterSnapshot,
      auditWritten: true,
      message: "STOCK REPAIR APPLIED SUCCESSFULLY; AUDIT LOG WRITE SUCCEEDED",
    };
  } catch (err) {
    return {
      status: EVIDENCE_STATUS.APPLIED_AUDIT_FAILED,
      mutated: true,
      stockBalanceId: String(doc._id),
      article: doc.article || doc.itemCode || "",
      warehouse: doc.warehouse || doc.location || "",
      before: beforeSnapshot,
      after: afterSnapshot,
      auditWritten: false,
      error: err?.message || String(err),
      timestamp: new Date().toISOString(),
      message:
        "STOCK REPAIR APPLIED SUCCESSFULLY; AUDIT LOG WRITE FAILED — do not retry StockBalance mutation",
    };
  }
}
