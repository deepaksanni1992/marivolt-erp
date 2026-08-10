/**
 * AvailableQty projection repair tooling (no production DB).
 * Run: node scripts/repairAvailableQtyProjection.test.js
 */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import AuditLog from "../src/models/AuditLog.js";
import {
  AVAILABLE_QTY_PROJECTION_REPAIR_ACTION,
  EVIDENCE_STATUS,
  buildAvailableQtyMismatchPlan,
  buildAuditPayload,
  applyAvailableQtyProjectionRepair,
  storedAvailableQty,
} from "../src/services/repairAvailableQtyProjectionService.js";
import { deriveAvailableQty } from "../src/services/stockExpectedBuckets.js";

function mockDoc(partial = {}) {
  const state = {
    _id: partial._id || "bal-1",
    article: "ART-1",
    warehouse: "MAIN",
    location: "MAIN",
    onHandQty: 0,
    quantity: 0,
    reservedQty: 0,
    allocatedQty: 0,
    packedQty: 0,
    availableQty: 0,
    ...partial,
  };
  return {
    ...state,
    get onHandQty() {
      return state.onHandQty;
    },
    set onHandQty(v) {
      state.onHandQty = v;
    },
    get quantity() {
      return state.quantity;
    },
    set quantity(v) {
      state.quantity = v;
    },
    get reservedQty() {
      return state.reservedQty;
    },
    set reservedQty(v) {
      state.reservedQty = v;
    },
    get allocatedQty() {
      return state.allocatedQty;
    },
    set allocatedQty(v) {
      state.allocatedQty = v;
    },
    get packedQty() {
      return state.packedQty;
    },
    set packedQty(v) {
      state.packedQty = v;
    },
    get availableQty() {
      return state.availableQty;
    },
    set availableQty(v) {
      state.availableQty = v;
    },
    get article() {
      return state.article;
    },
    get warehouse() {
      return state.warehouse;
    },
    get location() {
      return state.location;
    },
    get _id() {
      return state._id;
    },
    get itemCode() {
      return state.itemCode;
    },
    async save() {
      if (state._failSave) throw new Error("save failed");
      state._saved = true;
      return this;
    },
    _state: state,
  };
}

// A — AuditLog enum accepts AVAILABLE_QTY_PROJECTION_REPAIRED
{
  const enums = AuditLog.schema.path("action").enumValues;
  assert.ok(enums.includes(AVAILABLE_QTY_PROJECTION_REPAIR_ACTION));
  const doc = new AuditLog({
    action: AVAILABLE_QTY_PROJECTION_REPAIR_ACTION,
    module: "STOCK",
    documentNo: "8X0098",
  });
  const err = doc.validateSync();
  assert.equal(err, undefined);
}

// Plan builder — mismatch vs match
{
  const plan = buildAvailableQtyMismatchPlan([
    {
      _id: "a",
      article: "8X0098",
      warehouse: "MAIN",
      onHandQty: 0,
      quantity: 0,
      reservedQty: 0,
      allocatedQty: 0,
      packedQty: 0,
      availableQty: 9,
    },
    {
      _id: "b",
      article: "OK",
      warehouse: "MAIN",
      onHandQty: 5,
      quantity: 5,
      reservedQty: 0,
      availableQty: 5,
    },
  ]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].article, "8X0098");
  assert.equal(plan[0].fromAvailableQty, 9);
  assert.equal(plan[0].toAvailableQty, 0);
}

// B — successful repair: mutation + audit
{
  const doc = mockDoc({
    onHandQty: 0,
    quantity: 0,
    availableQty: 9,
    article: "8X0098",
  });
  let auditPayload = null;
  const result = await applyAvailableQtyProjectionRepair({
    doc,
    companyId: "cmp",
    writeAuditLog: async (p) => {
      auditPayload = p;
      return { _id: "audit-1" };
    },
  });
  assert.equal(result.status, EVIDENCE_STATUS.APPLIED);
  assert.equal(result.mutated, true);
  assert.equal(result.auditWritten, true);
  assert.equal(doc.availableQty, 0);
  assert.equal(doc._state._saved, true);
  assert.equal(auditPayload.action, AVAILABLE_QTY_PROJECTION_REPAIR_ACTION);
  assert.equal(auditPayload.metadata.reason, "AVAILABLE_QTY_MISMATCH");
  assert.equal(auditPayload.beforeData.availableQty, 9);
  assert.equal(auditPayload.afterData.availableQty, 0);
  assert.equal(auditPayload.metadata.onHandQty, 0);
  assert.equal(auditPayload.metadata.reservedQty, 0);
}

// C — AuditLog failure after mutation → APPLIED_AUDIT_FAILED, no retry
{
  const doc = mockDoc({ onHandQty: 0, quantity: 0, availableQty: 9, article: "X" });
  let saveCount = 0;
  const origSave = doc.save.bind(doc);
  doc.save = async () => {
    saveCount += 1;
    return origSave();
  };
  const result = await applyAvailableQtyProjectionRepair({
    doc,
    companyId: "cmp",
    writeAuditLog: async () => {
      throw new Error("enum rejected");
    },
  });
  assert.equal(result.status, EVIDENCE_STATUS.APPLIED_AUDIT_FAILED);
  assert.equal(result.mutated, true);
  assert.equal(doc.availableQty, 0);
  assert.equal(saveCount, 1);
  assert.match(result.message, /STOCK REPAIR APPLIED SUCCESSFULLY/);
  assert.match(result.message, /AUDIT LOG WRITE FAILED/);
  // accidental second call is no-op (idempotent)
  const again = await applyAvailableQtyProjectionRepair({
    doc,
    companyId: "cmp",
    writeAuditLog: async () => {
      throw new Error("should not be called for no-op");
    },
  });
  assert.equal(again.status, EVIDENCE_STATUS.NO_CHANGE);
  assert.equal(again.mutated, false);
  assert.equal(saveCount, 1);
}

// D — failure before mutation
{
  const doc = mockDoc({ onHandQty: 0, quantity: 0, availableQty: 9 });
  doc._state._failSave = true;
  const result = await applyAvailableQtyProjectionRepair({
    doc,
    companyId: "cmp",
    writeAuditLog: async () => {
      throw new Error("should not audit");
    },
  });
  assert.equal(result.status, EVIDENCE_STATUS.FAILED_BEFORE_APPLY);
  assert.equal(result.mutated, false);
  // availableQty may have been set in memory before save threw — document not persisted
  assert.match(result.message, /FAILED/);
}

// E — no-op when already matching
{
  const doc = mockDoc({ onHandQty: 0, quantity: 0, availableQty: 0 });
  let audited = false;
  const result = await applyAvailableQtyProjectionRepair({
    doc,
    companyId: "cmp",
    writeAuditLog: async () => {
      audited = true;
    },
  });
  assert.equal(result.status, EVIDENCE_STATUS.NO_CHANGE);
  assert.equal(result.mutated, false);
  assert.equal(audited, false);
  assert.equal(doc._state._saved, undefined);
}

// F — rerun after successful repair (same as E on repaired doc)
{
  const doc = mockDoc({
    onHandQty: 0,
    quantity: 0,
    reservedQty: 0,
    availableQty: 0,
    article: "8X0098",
  });
  assert.equal(storedAvailableQty(doc), deriveAvailableQty(doc));
  const plan = buildAvailableQtyMismatchPlan([doc]);
  assert.equal(plan.length, 0);
}

// G — dry-run semantics: plan only, no mutation helpers invoked on docs
{
  const lean = {
    _id: "z",
    article: "Z",
    warehouse: "MAIN",
    onHandQty: 1,
    quantity: 1,
    reservedQty: 0,
    availableQty: 9,
  };
  const plan = buildAvailableQtyMismatchPlan([lean]);
  assert.equal(plan.length, 1);
  assert.equal(lean.availableQty, 9); // unchanged
}

// Audit payload shape
{
  const companyId = new mongoose.Types.ObjectId();
  const payload = buildAuditPayload({
    companyId,
    stockBalanceId: "id1",
    article: "8X0098",
    warehouse: "MAIN",
    before: {
      onHandQty: 0,
      quantity: 0,
      reservedQty: 0,
      allocatedQty: 0,
      packedQty: 0,
      availableQty: 9,
    },
    after: {
      onHandQty: 0,
      quantity: 0,
      reservedQty: 0,
      allocatedQty: 0,
      packedQty: 0,
      availableQty: 0,
    },
  });
  const doc = new AuditLog(payload);
  assert.equal(doc.validateSync(), undefined);
  assert.equal(payload.metadata.reason, "AVAILABLE_QTY_MISMATCH");
}

// Evidence status constants present
{
  assert.equal(EVIDENCE_STATUS.DRY_RUN, "DRY_RUN");
  assert.equal(EVIDENCE_STATUS.APPLIED, "APPLIED");
  assert.equal(EVIDENCE_STATUS.APPLIED_AUDIT_FAILED, "APPLIED_AUDIT_FAILED");
  assert.equal(EVIDENCE_STATUS.NO_CHANGE, "NO_CHANGE");
  assert.equal(EVIDENCE_STATUS.FAILED_BEFORE_APPLY, "FAILED_BEFORE_APPLY");
  assert.equal(EVIDENCE_STATUS.APPLY_STARTED, "APPLY_STARTED");
}

console.log("repairAvailableQtyProjection.test.js: all passed");
