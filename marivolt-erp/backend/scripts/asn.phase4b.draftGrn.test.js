/**
 * ASN Phase 4B — Draft GRN generation from receiving (no stock post).
 * Run: node scripts/asn.phase4b.draftGrn.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "url";
import { poLineEntitlement } from "../src/utils/grnReceiptQty.js";
import {
  ASN_RECEIVING_GRN_INDEX_SPECS,
  GRN_ASN_RECEIVING_SESSION_UNIQUE_INDEX,
  evaluateAsnReceivingGrnIndexInventory,
} from "../src/utils/receivingDraftGrnIndexes.js";
import {
  ASN_GRN_EDIT_FORBIDDEN,
  ASN_GRN_SOURCE_MISMATCH,
  GRN_DRAFT_ADDITIONAL_ENTITLEMENT_AVAILABLE,
  GRN_DRAFT_ENTITLEMENT_CHANGED,
  RECEIVING_GRN_MULTI_PO,
  RECEIVING_NO_ACCEPTED_QTY,
  RECEIVING_PO_ENTITLEMENT_EXHAUSTED,
  applyAsnReceivingDraftEdit,
  allocateGrnAcceptedAcrossSources,
  assertAsnReceivingGrnPostBlocked,
  assertAsnReceivingLineEditAllowed,
  assertCoherentReceivingSnapshot,
  assertDraftGrnEligibleResult,
  assertExcessSourceInvariants,
  assertReceivingSourcesMatchLineAccepted,
  assertSinglePoForReceivingGrn,
  buildDraftGrnLinesFromReceiving,
  claimReceivingDraftGrnSlot,
  computeAsnDraftEntitlementReview,
  freezeReceivingBecauseDraftGrnExists,
  generateDraftGrnIdempotent,
  groupReceivingUnitsForDraftGrn,
  isAsnReceivingGrn,
  receivingDraftGroupKey,
} from "../src/utils/receivingDraftGrnRules.js";
import {
  assertAsnReceivingGrnSnapshots,
  collectAsnSourcePoIds,
  buildAsnPoLineMaps,
} from "../src/services/asnReceivingSourceResolver.js";
import { ReceivingInspectionError } from "../src/utils/receivingInspectionRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");
const feRoot = path.join(__dirname, "..", "..", "src");

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

async function runAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

function poLine(id, extra = {}) {
  return {
    _id: id,
    itemCode: extra.article || "20834",
    article: extra.article || "20834",
    description: extra.description || "O-ring",
    partNumber: extra.partNo || "PN-1",
    uom: extra.uom || "PCS",
    orderedQty: extra.orderedQty ?? 50,
    cancelledQty: extra.cancelledQty ?? 0,
    unitPrice: extra.unitPrice ?? 1.5,
    currency: extra.currency || "USD",
  };
}

function ruRow(partial) {
  return {
    receivingUnitId: partial.receivingUnitId || "ru1",
    receivingSessionUnitId: partial.receivingSessionUnitId || "su1",
    ruNo: partial.ruNo || "MAR-RU-000101",
    poId: partial.poId || "po1",
    poNo: "MAR-PO-1",
    poLineId: partial.poLineId || "pola",
    asnLineId: partial.asnLineId || "asna",
    uom: partial.uom || "PCS",
    acceptedQty: partial.acceptedQty ?? 0,
    damagedQty: partial.damagedQty ?? 0,
    rejectedQty: partial.rejectedQty ?? 0,
    shortQty: partial.shortQty ?? 0,
  };
}

function mapsFromRows(rows, { orderedQty = 50, article, uom, cancelledQty = 0 } = {}) {
  const poLineByAsnLineId = new Map();
  const poLineIdByAsnLineId = new Map();
  const poIdByAsnLineId = new Map();
  for (const row of rows) {
    const line = poLine(row.poLineId, {
      orderedQty,
      cancelledQty,
      article: article || "20834",
      uom: uom || row.uom,
    });
    poLineByAsnLineId.set(String(row.asnLineId), line);
    poLineIdByAsnLineId.set(String(row.asnLineId), row.poLineId);
    poIdByAsnLineId.set(String(row.asnLineId), row.poId);
  }
  return { poLineByAsnLineId, poLineIdByAsnLineId, poIdByAsnLineId };
}

function build(rows, { orderedQty = 50, posted = 0, otherDraft = 0, article, uom } = {}) {
  const groups = groupReceivingUnitsForDraftGrn(rows);
  const maps = mapsFromRows(rows, { orderedQty, article, uom });
  const postedByPoLine = new Map();
  const otherDraftByPoLine = new Map();
  for (const row of rows) {
    postedByPoLine.set(String(row.poLineId), posted);
    otherDraftByPoLine.set(String(row.poLineId), otherDraft);
  }
  return buildDraftGrnLinesFromReceiving({
    groups,
    ...maps,
    postedByPoLine,
    otherDraftByPoLine,
  });
}

console.log("\nASN Phase 4B Draft GRN Generation\n");

run("happy path 50 accepted → Draft GRN 50", () => {
  const built = build([ruRow({ acceptedQty: 50 })]);
  assert.equal(built.items.length, 1);
  assert.equal(built.items[0].acceptedQty, 50);
  assert.equal(built.totals.grnEligibleQty, 50);
});

run("short 48 accepted → Draft 48", () => {
  const built = build([ruRow({ acceptedQty: 48, shortQty: 2 })]);
  assert.equal(built.items[0].acceptedQty, 48);
  assert.equal(built.totals.shortQty, 2);
});

run("rejected 45 accepted / 5 rejected → Draft 45", () => {
  const built = build([ruRow({ acceptedQty: 45, rejectedQty: 5 })]);
  assert.equal(built.items[0].acceptedQty, 45);
  assert.equal(built.items[0].rejectedQty, 0);
  assert.equal(built.totals.rejectedQty, 5);
});

run("damaged 45 accepted / 5 damaged → Draft 45", () => {
  const built = build([ruRow({ acceptedQty: 45, damagedQty: 5 })]);
  assert.equal(built.items[0].acceptedQty, 45);
  assert.equal(built.totals.damagedQty, 5);
});

run("mixed 43 accepted / 3 damaged / 2 rejected / 2 short → Draft 43", () => {
  const built = build([ruRow({ acceptedQty: 43, damagedQty: 3, rejectedQty: 2, shortQty: 2 })]);
  assert.equal(built.items[0].acceptedQty, 43);
  assert.equal(built.totals.acceptedQty, 43);
  assert.equal(built.totals.damagedQty, 3);
  assert.equal(built.totals.rejectedQty, 2);
  assert.equal(built.totals.shortQty, 2);
});

run("NOT_RECEIVED 0 accepted → RECEIVING_NO_ACCEPTED_QTY", () => {
  const built = build([ruRow({ acceptedQty: 0 })]);
  assert.throws(() => assertDraftGrnEligibleResult(built), (err) => err.code === RECEIVING_NO_ACCEPTED_QTY);
});

run("excess 52 vs entitlement 50 → Draft 50 + excess pending 2", () => {
  const built = build(
    [
      ruRow({ ruNo: "MAR-RU-000001", acceptedQty: 30, receivingUnitId: "1", receivingSessionUnitId: "s1" }),
      ruRow({ ruNo: "MAR-RU-000002", acceptedQty: 22, receivingUnitId: "2", receivingSessionUnitId: "s2" }),
    ],
    { orderedQty: 50 }
  );
  assert.equal(built.items[0].acceptedQty, 50);
  assert.equal(built.totals.excessPendingQty, 2);
  assert.equal(built.totals.acceptedQty, 52);
  const src = built.items[0].receivingSources;
  assert.equal(src[0].grnAcceptedQty, 30);
  assert.equal(src[0].excessPendingQty, 0);
  assert.equal(src[1].grnAcceptedQty, 20);
  assert.equal(src[1].excessPendingQty, 2);
  assertReceivingSourcesMatchLineAccepted(built.items[0]);
});

run("multiple RU 22+21 → one GRN line 43 with two sources", () => {
  const built = build([
    ruRow({ ruNo: "MAR-RU-000101", acceptedQty: 22, receivingUnitId: "a", receivingSessionUnitId: "sa" }),
    ruRow({ ruNo: "MAR-RU-000102", acceptedQty: 21, receivingUnitId: "b", receivingSessionUnitId: "sb" }),
  ]);
  assert.equal(built.items.length, 1);
  assert.equal(built.items[0].acceptedQty, 43);
  assert.equal(built.items[0].receivingSources.length, 2);
});

run("same article different ASN lines do not merge", () => {
  const built = build([
    ruRow({ asnLineId: "asna", poLineId: "pola", acceptedQty: 10 }),
    ruRow({
      asnLineId: "asnb",
      poLineId: "polb",
      acceptedQty: 10,
      receivingUnitId: "ru2",
      receivingSessionUnitId: "su2",
      ruNo: "MAR-RU-000102",
    }),
  ]);
  assert.equal(built.items.length, 2);
  assert.equal(receivingDraftGroupKey(built.items[0]) !== receivingDraftGroupKey(built.items[1]), true);
});

run("mixed UOM PCS/KG do not merge", () => {
  const built = build([
    ruRow({ uom: "PCS", acceptedQty: 10, poLineId: "p1", asnLineId: "a1" }),
    ruRow({
      uom: "KG",
      acceptedQty: 10,
      poLineId: "p2",
      asnLineId: "a2",
      receivingUnitId: "ru2",
      receivingSessionUnitId: "su2",
      ruNo: "MAR-RU-000102",
    }),
  ]);
  assert.equal(built.items.length, 2);
  assert.equal(built.items.some((i) => i.uom === "PCS"), true);
  assert.equal(built.items.some((i) => i.uom === "KG"), true);
});

run("commercial values come from PO line not RU", () => {
  const built = build([ruRow({ acceptedQty: 5 })]);
  assert.equal(built.items[0].unitCost, 1.5);
  assert.equal(built.items[0].article, "20834");
  assert.equal(built.items[0].currency, "USD");
});

run("multi-PO receiving is an explicit architectural error", () => {
  assert.throws(() => assertSinglePoForReceivingGrn(["poA", "poB"]), (err) => err.code === RECEIVING_GRN_MULTI_PO);
});

run("other draft GRNs consume entitlement", () => {
  const built = build([ruRow({ acceptedQty: 50 })], { otherDraft: 50 });
  assert.throws(() => assertDraftGrnEligibleResult(built), (err) => err.code === RECEIVING_PO_ENTITLEMENT_EXHAUSTED);
});

run("posted GRNs consume entitlement (same pending definition)", () => {
  const built = build([ruRow({ acceptedQty: 20 })], { posted: 50, orderedQty: 50 });
  assert.throws(() => assertDraftGrnEligibleResult(built), (err) => err.code === RECEIVING_PO_ENTITLEMENT_EXHAUSTED);
});

run("PO entitlement helper matches ordered - posted - cancelled - other drafts", () => {
  assert.equal(poLineEntitlement({ orderedQty: 50, cancelledQty: 0, postedAcceptedQty: 10, otherDraftAcceptedQty: 5 }), 35);
});

run("legacy ASN post-block helper still no-ops for MANUAL_PO", () => {
  assert.throws(
    () => assertAsnReceivingGrnPostBlocked({ sourceType: "ASN_RECEIVING", status: "DRAFT" }),
    (err) => err.code === "ASN_GRN_POST_PHASE4C_REQUIRED"
  );
  assert.doesNotThrow(() => assertAsnReceivingGrnPostBlocked({ sourceType: "", status: "DRAFT" }));
});

run("isAsnReceivingGrn uses sourceType or receivingSessionId", () => {
  assert.equal(isAsnReceivingGrn({ receivingSessionId: "x" }), true);
  assert.equal(isAsnReceivingGrn({ sourceType: "MANUAL_PO" }), false);
});

run("receiving freeze uses RECEIVING_GRN_DRAFT_EXISTS", () => {
  assert.throws(() => freezeReceivingBecauseDraftGrnExists(), (err) => {
    return err instanceof ReceivingInspectionError && err.code === "RECEIVING_GRN_DRAFT_EXISTS";
  });
});

run("snapshot CAS rejects mixed before/after receiving versions", () => {
  assert.throws(
    () =>
      assertCoherentReceivingSnapshot(
        [{ _id: "u1", version: 1 }],
        [{ _id: "u1", version: 2 }]
      ),
    (err) => err.code === "RECEIVING_GRN_SNAPSHOT_CHANGED"
  );
});

run("allocate excess is deterministic by ruNo", () => {
  const out = allocateGrnAcceptedAcrossSources(
    [
      { ruNo: "MAR-RU-000002", acceptedQty: 22, receivingUnitId: "2", receivingSessionUnitId: "s2" },
      { ruNo: "MAR-RU-000001", acceptedQty: 30, receivingUnitId: "1", receivingSessionUnitId: "s1" },
    ],
    50
  );
  assert.equal(out[0].ruNo, "MAR-RU-000001");
  assert.equal(out[1].excessPendingQty, 2);
});

run("zero-qty lines are omitted from GRN items", () => {
  const built = build([
    ruRow({ acceptedQty: 0, ruNo: "MAR-RU-000090" }),
    ruRow({ acceptedQty: 10, ruNo: "MAR-RU-000091", receivingUnitId: "z", receivingSessionUnitId: "sz" }),
  ]);
  assert.equal(built.items.length, 1);
  assert.equal(built.items[0].acceptedQty, 10);
});

run("unique index spec is companyId + receivingSessionId partial unique", () => {
  const spec = ASN_RECEIVING_GRN_INDEX_SPECS[0];
  assert.equal(spec.name, GRN_ASN_RECEIVING_SESSION_UNIQUE_INDEX);
  assert.equal(spec.unique, true);
  assert.deepEqual(spec.key, { companyId: 1, receivingSessionId: 1 });
  assert.ok(spec.partialFilterExpression.status.$in.includes("DRAFT"));
  const inv = evaluateAsnReceivingGrnIndexInventory({
    grns: [
      {
        name: spec.name,
        key: spec.key,
        unique: true,
        partialFilterExpression: spec.partialFilterExpression,
      },
    ],
  });
  assert.equal(inv.ok, true);
});

run("in-memory unique slot is one GRN per session", () => {
  const store = new Map();
  const a = claimReceivingDraftGrnSlot(store, { companyId: "MAR", receivingSessionId: "s1", grnNo: "MAR-GRN-0101" });
  const b = claimReceivingDraftGrnSlot(store, { companyId: "MAR", receivingSessionId: "s1", grnNo: "MAR-GRN-0102" });
  assert.equal(a.created, true);
  assert.equal(b.reused, true);
  assert.equal(b.grnNo, "MAR-GRN-0101");
  assert.equal(store.size, 1);
});

await runAsync("Promise.all double generate yields one grnNo", async () => {
  const store = new Map();
  let n = 100;
  const nextNo = () => `MAR-GRN-0${n++}`;
  const [x, y] = await Promise.all([
    generateDraftGrnIdempotent(store, { companyId: "MAR", receivingSessionId: "sess", nextNo }),
    generateDraftGrnIdempotent(store, { companyId: "MAR", receivingSessionId: "sess", nextNo }),
  ]);
  assert.equal(x.grnNo, y.grnNo);
  assert.equal(store.size, 1);
});

run("retry returns same draft", () => {
  const store = new Map();
  const first = claimReceivingDraftGrnSlot(store, { companyId: "MAR", receivingSessionId: "s1", grnNo: "MAR-GRN-0101" });
  const retry = claimReceivingDraftGrnSlot(store, { companyId: "MAR", receivingSessionId: "s1", grnNo: "MAR-GRN-0102" });
  assert.equal(first.grnNo, retry.grnNo);
});

run("source files: dedicated receiving GRN route, no generic draft re-enable", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "receivingInspectionRoutes.js"), "utf8");
  const grnRoutes = fs.readFileSync(path.join(srcRoot, "routes", "grnRoutes.js"), "utf8");
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "grnController.js"), "utf8");
  assert.match(routes, /sessions\/:sessionId\/grn/);
  assert.match(grnRoutes, /router\.post\("\/draft"/);
  assert.match(ctrl, /Draft GRN creation is disabled/);
  assert.match(ctrl, /postAsnReceivingDraftGrn|isAsnReceivingGrn/);
  assert.match(ctrl, /ASN_RECEIVING_GRN_DRAFT_DELETED/);
});

run("source files: GRN schema provenance without changing _id:false items", () => {
  const model = fs.readFileSync(path.join(srcRoot, "models", "GRN.js"), "utf8");
  assert.match(model, /sourceType/);
  assert.match(model, /receivingSessionId/);
  assert.match(model, /receivingSources/);
  assert.match(model, /asnLineId/);
  assert.match(model, /_id: false/);
  assert.match(model, /grns_one_active_asn_receiving_session/);
  assert.doesNotMatch(model, /AsnGrn|ReceivingGrn|DraftReceivingGrn/);
});

run("source files: service is server-authoritative and has no stock/customs/PO receipt", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingDraftService.js"), "utf8");
  assert.match(svc, /assertPhase4CanConsumeReceivingUnits/);
  assert.match(svc, /nextGrnNo/);
  assert.match(svc, /ASN_RECEIVING_GRN_DRAFT_CREATED/);
  assert.match(svc, /getPostedAcceptedQtyByPoLineMap/);
  assert.match(svc, /getOpenDraftAcceptedQtyByPoLineMap/);
  assert.doesNotMatch(svc, /grnReceive/);
  assert.doesNotMatch(svc, /createCustomsLotFromGrn/);
  assert.doesNotMatch(svc, /applyReceiveToPo/);
  assert.doesNotMatch(svc, /asnActiveQty\s*=/);
  assert.doesNotMatch(svc, /PARTIALLY_RECEIVED/);
  assert.doesNotMatch(svc, /req\.body\.(article|acceptedQty|unitPrice)/);
});

run("source files: freeze receiving after Draft GRN", () => {
  const insp = fs.readFileSync(path.join(srcRoot, "services", "receivingInspectionService.js"), "utf8");
  assert.match(insp, /assertReceivingNotFrozenByDraftGrn/);
  assert.equal((insp.match(/assertReceivingNotFrozenByDraftGrn/g) || []).length >= 4, true);
});

run("source files: RBAC generate = ASN.view + STORE.create; delete remains STORE.delete", () => {
  const routes = fs.readFileSync(path.join(srcRoot, "routes", "receivingInspectionRoutes.js"), "utf8");
  const grnRoutes = fs.readFileSync(path.join(srcRoot, "routes", "grnRoutes.js"), "utf8");
  assert.match(routes, /receivingMutate, c.generateSessionGrn/);
  assert.match(routes, /ASN", "view"/);
  assert.match(routes, /STORE", "create"/);
  assert.match(grnRoutes, /storeDelete, c.deleteGrnDraft/);
});

run("source files: company-scoped session/GRN lookups", () => {
  const resolver = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingSourceResolver.js"), "utf8");
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingDraftService.js"), "utf8");
  assert.match(resolver, /ReceivingSession.findOne\(\{ _id: sid, companyId \}\)/);
  assert.match(resolver, /AdvanceShipmentNotice.findOne\(\{ _id: receivingSession.asnId, companyId \}\)/);
  assert.match(resolver, /PurchaseOrder.findOne\(\{ _id: singlePoId, companyId \}\)/);
  assert.match(svc, /resolveAsnReceivingSource/);
  assert.doesNotMatch(svc, /PurchaseOrder.findOne/);
});

run("source files: warehouse default MAIN, location left for review", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingDraftService.js"), "utf8");
  const rules = fs.readFileSync(path.join(srcRoot, "utils", "receivingDraftGrnRules.js"), "utf8");
  assert.match(svc, /DEFAULT_GRN_WAREHOUSE_CODE = "MAIN"/);
  assert.match(rules, /location: ""/);
});

run("tablet UI Generate Draft GRN → Review Draft GRN", () => {
  const incoming = fs.readFileSync(path.join(feRoot, "components", "store", "IncomingShipmentsPanel.jsx"), "utf8");
  const store = fs.readFileSync(path.join(feRoot, "pages", "StoreModule.jsx"), "utf8");
  assert.match(incoming, /Generate Draft GRN/);
  assert.match(incoming, /Draft GRN Created/);
  assert.match(incoming, /Review Draft GRN/);
  assert.match(incoming, /\/receiving\/sessions\/\$\{session\._id\}\/grn/);
  assert.match(incoming, /POST GRN/);
  assert.match(incoming, /Confirm POST GRN/);
  assert.match(store, /ASN Receiving/);
  assert.match(store, /View Receiving Evidence/);
  assert.match(store, /POST GRN/);
  assert.match(store, /apiGet\(`\/grn\/\$\{encodeURIComponent\(grnNo\)\}`\)/);
  const proc = fs.readFileSync(path.join(feRoot, "pages", "ProcurementFoundation.jsx"), "utf8");
  assert.match(proc, /ASN_RECEIVING/);
  assert.match(proc, /POST GRN/);
});

run("generic store draft creation remains disabled", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "grnController.js"), "utf8");
  assert.match(ctrl, /Draft GRN creation is disabled/);
  assert.doesNotMatch(ctrl, /export async function createGrn[\s\S]{0,200}GRN\.create/);
});

run("shared posted-qty helper is reused (no second pending definition)", () => {
  const qty = fs.readFileSync(path.join(srcRoot, "utils", "grnReceiptQty.js"), "utf8");
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "grnController.js"), "utf8");
  assert.match(qty, /GRN_POSTED_FOR_RECEIPT_QTY/);
  assert.match(ctrl, /loadPostedAcceptedQtyByPoLineMap/);
  assert.match(ctrl, /GRN_POSTED_FOR_RECEIPT_QTY/);
});

run("A. GRN → ASN → PO: draft derives PO from ASN maps not GRN.poId", () => {
  const asn = {
    _id: "asn-50",
    sourcePoId: "po-75",
    poIds: ["po-75"],
    lines: [{ _id: "asna", poId: "po-75", poLineId: "pola" }],
  };
  const po = { _id: "po-75", lines: [poLine("pola", { orderedQty: 50 })] };
  const maps = buildAsnPoLineMaps(asn, new Map([["po-75", po]]));
  assert.equal(String(maps.poLineIdByAsnLineId.get("asna")), "pola");
  assert.equal(collectAsnSourcePoIds(asn).join(","), "po-75");
  const rows = [ruRow({ acceptedQty: 50, asnLineId: "asna", poLineId: "pola", poId: "po-75" })];
  const built = build(rows);
  assert.equal(String(built.items[0].poLineId), "pola");
  assert.equal(String(built.items[0].asnLineId), "asna");
});

run("B. client PO spoof cannot change ASN-derived PO line", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingDraftService.js"), "utf8");
  assert.doesNotMatch(svc, /req\.body/);
  const built = build([ruRow({ acceptedQty: 10, poLineId: "pola", asnLineId: "asna" })]);
  assert.equal(String(built.items[0].poLineId), "pola");
});

run("C. header mismatch GRN.poId vs ASN PO", () => {
  const source = {
    asn: { _id: "asn-50" },
    receivingSession: { _id: "sess-1" },
    po: { _id: "po-75" },
    asnLineById: new Map(),
    poLineIdByAsnLineId: new Map(),
  };
  assert.throws(
    () =>
      assertAsnReceivingGrnSnapshots(
        { asnId: "asn-50", receivingSessionId: "sess-1", poId: "po-99", items: [] },
        source
      ),
    (err) => err.code === ASN_GRN_SOURCE_MISMATCH
  );
});

run("D. line mismatch asnLine → PO line A but stored poLineId B", () => {
  const source = {
    asn: { _id: "asn-50" },
    receivingSession: { _id: "sess-1" },
    po: { _id: "po-75" },
    asnLineById: new Map([["asna", { _id: "asna", poLineId: "pola" }]]),
    poLineIdByAsnLineId: new Map([["asna", "pola"]]),
  };
  assert.throws(
    () =>
      assertAsnReceivingGrnSnapshots(
        {
          asnId: "asn-50",
          receivingSessionId: "sess-1",
          poId: "po-75",
          items: [{ asnLineId: "asna", poLineId: "polb", acceptedQty: 10 }],
        },
        source
      ),
    (err) => err.code === ASN_GRN_SOURCE_MISMATCH
  );
});

run("E. same Article two PO lines — no merge, independent entitlement", () => {
  const built = build(
    [
      ruRow({ article: "20834", poLineId: "p1", asnLineId: "a1", acceptedQty: 12, ruNo: "MAR-RU-000001" }),
      ruRow({
        article: "20834",
        poLineId: "p2",
        asnLineId: "a2",
        acceptedQty: 18,
        ruNo: "MAR-RU-000002",
        receivingUnitId: "ru2",
        receivingSessionUnitId: "su2",
      }),
    ],
    { orderedQty: 10 }
  );
  assert.equal(built.items.length, 2);
  const a = built.items.find((i) => String(i.asnLineId) === "a1");
  const b = built.items.find((i) => String(i.asnLineId) === "a2");
  assert.equal(a.acceptedQty, 10);
  assert.equal(a.receivingSources[0].excessPendingQty, 2);
  assert.equal(b.acceptedQty, 10);
  assert.equal(b.receivingSources[0].excessPendingQty, 8);
});

run("F. same Article across ASNs stays isolated by asnLineId", () => {
  const a = ruRow({ asnLineId: "asnA-line", poLineId: "poA", acceptedQty: 36, ruNo: "MAR-RU-000010" });
  const b1 = ruRow({
    asnLineId: "asnB-line",
    poLineId: "poB",
    acceptedQty: 22,
    ruNo: "MAR-RU-000011",
    receivingUnitId: "b1",
    receivingSessionUnitId: "sb1",
  });
  const b2 = ruRow({
    asnLineId: "asnB-line",
    poLineId: "poB",
    acceptedQty: 21,
    ruNo: "MAR-RU-000012",
    receivingUnitId: "b2",
    receivingSessionUnitId: "sb2",
  });
  const builtA = build([a], { orderedQty: 36 });
  const builtB = build([b1, b2], { orderedQty: 43 });
  assert.equal(builtA.items.length, 1);
  assert.equal(builtB.items.length, 1);
  assert.equal(builtA.items[0].acceptedQty, 36);
  assert.equal(builtB.items[0].acceptedQty, 43);
  assert.notEqual(String(builtA.items[0].asnLineId), String(builtB.items[0].asnLineId));
});

run("G. multi-line entitlement caps independently (12 vs 10 and 18 vs 20)", () => {
  const rows = [
    ruRow({ poLineId: "p1", asnLineId: "a1", acceptedQty: 12, ruNo: "MAR-RU-000001" }),
    ruRow({
      poLineId: "p2",
      asnLineId: "a2",
      acceptedQty: 18,
      ruNo: "MAR-RU-000002",
      receivingUnitId: "r2",
      receivingSessionUnitId: "s2",
    }),
  ];
  const groups = groupReceivingUnitsForDraftGrn(rows);
  const maps = mapsFromRows(rows, { orderedQty: 50 });
  maps.poLineByAsnLineId.set("a1", poLine("p1", { orderedQty: 10 }));
  maps.poLineByAsnLineId.set("a2", poLine("p2", { orderedQty: 20 }));
  const built = buildDraftGrnLinesFromReceiving({
    groups,
    ...maps,
    postedByPoLine: new Map(),
    otherDraftByPoLine: new Map(),
  });
  const a = built.items.find((i) => String(i.asnLineId) === "a1");
  const b = built.items.find((i) => String(i.asnLineId) === "a2");
  assert.equal(a.acceptedQty, 10);
  assert.equal(a.receivingSources[0].excessPendingQty, 2);
  assert.equal(b.acceptedQty, 18);
  assert.equal(b.receivingSources[0].excessPendingQty, 0);
});

run("H/I. stale entitlement: draft stays 50, shortfall 10, no silent shrink", () => {
  const rows = [ruRow({ acceptedQty: 50, asnLineId: "asna", poLineId: "pola" })];
  const built = build(rows);
  assert.equal(built.items[0].acceptedQty, 50);
  const maps = mapsFromRows(rows, { orderedQty: 50 });
  const review = computeAsnDraftEntitlementReview(
    { items: built.items },
    {
      ...maps,
      postedByPoLine: new Map([["pola", 10]]),
      otherDraftByPoLine: new Map(),
    }
  );
  assert.equal(review.entitlementValid, false);
  assert.equal(review.entitlementShortfall, 10);
  assert.equal(review.code, GRN_DRAFT_ENTITLEMENT_CHANGED);
  assert.equal(built.items[0].acceptedQty, 50);
});

run("J. no silent grow when entitlement becomes 52", () => {
  const rows = [ruRow({ acceptedQty: 50, asnLineId: "asna", poLineId: "pola" })];
  const built = build(rows);
  const maps = mapsFromRows(rows, { orderedQty: 52 });
  const review = computeAsnDraftEntitlementReview(
    { items: built.items },
    { ...maps, postedByPoLine: new Map(), otherDraftByPoLine: new Map() }
  );
  assert.equal(built.items[0].acceptedQty, 50);
  assert.equal(review.additionalEntitlementAvailable, 2);
  assert.equal(review.entitlementValid, true);
  assert.equal(review.code, GRN_DRAFT_ADDITIONAL_ENTITLEMENT_AVAILABLE);
});

run("K. edit whitelist: location allowed, commercial identity blocked", () => {
  const items = [
    {
      article: "20834",
      asnLineId: "asna",
      poLineId: "pola",
      uom: "PCS",
      acceptedQty: 50,
      receivedQty: 50,
      rejectedQty: 0,
      unitCost: 1.5,
      currency: "USD",
      warehouse: "MAIN",
      location: "",
      receivingSources: [{ ruNo: "MAR-RU-000101", acceptedQty: 50, grnAcceptedQty: 50, excessPendingQty: 0 }],
    },
  ];
  const grn = {
    sourceType: "ASN_RECEIVING",
    asnId: "asn-1",
    poId: "po-1",
    supplierName: "Acme",
    currency: "USD",
    remarks: "",
    items,
  };
  applyAsnReceivingDraftEdit(grn, { remarks: "ok", items: [{ ...items[0], location: "A-01", warehouse: "MAIN" }] });
  assert.equal(grn.items[0].location, "A-01");
  assert.throws(
    () => applyAsnReceivingDraftEdit({ ...grn, items: structuredClone(items) }, { poId: "po-SPOOF" }),
    (err) => err.code === ASN_GRN_EDIT_FORBIDDEN
  );
  assert.throws(
    () =>
      applyAsnReceivingDraftEdit(
        { ...grn, items: structuredClone(items) },
        { items: [{ ...items[0], acceptedQty: 99 }] }
      ),
    (err) => err.code === ASN_GRN_EDIT_FORBIDDEN
  );
});

run("L. receivingSources tampering blocked", () => {
  const existing = {
    article: "20834",
    asnLineId: "asna",
    poLineId: "pola",
    uom: "PCS",
    acceptedQty: 50,
    receivedQty: 50,
    rejectedQty: 0,
    unitCost: 1.5,
    currency: "USD",
    receivingSources: [
      {
        receivingUnitId: "ru1",
        receivingSessionUnitId: "su1",
        ruNo: "MAR-RU-000101",
        acceptedQty: 50,
        grnAcceptedQty: 50,
        excessPendingQty: 0,
      },
    ],
  };
  assert.throws(
    () =>
      assertAsnReceivingLineEditAllowed(existing, {
        ...existing,
        receivingSources: [{ ...existing.receivingSources[0], grnAcceptedQty: 40, excessPendingQty: 10 }],
      }),
    (err) => err.code === ASN_GRN_EDIT_FORBIDDEN
  );
});

run("M. excess invariants hold for 30+22 vs 50", () => {
  const built = build(
    [
      ruRow({ ruNo: "MAR-RU-000001", acceptedQty: 30, receivingUnitId: "1", receivingSessionUnitId: "s1" }),
      ruRow({ ruNo: "MAR-RU-000002", acceptedQty: 22, receivingUnitId: "2", receivingSessionUnitId: "s2" }),
    ],
    { orderedQty: 50 }
  );
  const inv = assertExcessSourceInvariants(built.items, built.totals.excessPendingQty);
  assert.equal(inv.sessionExcessPendingQty, 2);
  assert.equal(built.items[0].acceptedQty, 50);
});

run("N. delete then regenerate uses a new number in the unique slot model", () => {
  const store = new Map();
  const first = claimReceivingDraftGrnSlot(store, { companyId: "MAR", receivingSessionId: "s1", grnNo: "MAR-GRN-0101" });
  store.delete("MAR:s1");
  const second = claimReceivingDraftGrnSlot(store, { companyId: "MAR", receivingSessionId: "s1", grnNo: "MAR-GRN-0102" });
  assert.equal(first.grnNo, "MAR-GRN-0101");
  assert.equal(second.grnNo, "MAR-GRN-0102");
  assert.notEqual(first.grnNo, second.grnNo);
});

run("O. decimal KG quantities stay stable", () => {
  const built = build(
    [
      ruRow({
        uom: "KG",
        acceptedQty: 12.25,
        poLineId: "pk",
        asnLineId: "ak",
        ruNo: "MAR-RU-000050",
      }),
    ],
    { orderedQty: 12.5, uom: "KG" }
  );
  assert.equal(built.items[0].acceptedQty, 12.25);
  assert.equal(built.items[0].receivingSources[0].grnAcceptedQty, 12.25);
  assert.equal(built.items[0].receivingSources[0].excessPendingQty, 0);
});

run("P. manual GRN path remains GRN → PO (create/post not forced through ASN)", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers", "grnController.js"), "utf8");
  assert.match(ctrl, /export async function postGrnFromPo/);
  assert.match(ctrl, /isAsnReceivingGrn\(grn\)/);
  assert.match(ctrl, /postAsnReceivingDraftGrn/);
  assert.match(ctrl, /applyAsnReceivingDraftEdit/);
  const resolver = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingSourceResolver.js"), "utf8");
  assert.match(resolver, /GRN → ASN → PO/);
});

run("source files: generate uses ASN resolver not independent PO lookup", () => {
  const svc = fs.readFileSync(path.join(srcRoot, "services", "asnReceivingDraftService.js"), "utf8");
  assert.match(svc, /resolveAsnReceivingSource/);
  assert.match(svc, /poLineByAsnLineId/);
  assert.match(svc, /computeAsnDraftEntitlementReview/);
  assert.doesNotMatch(svc, /poDraftReservedQty|asnDraftReservedQty|grnReservedQty/);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
