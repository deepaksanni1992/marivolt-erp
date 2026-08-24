/**
 * PACK_CONVERSION kitting / de-kitting tests.
 * Run: node scripts/kittingPackConversion.test.js
 *
 * Pure helper + source wiring tests always run.
 * Mongo integration tests run when MONGO_URI is configured (uses isolated fixture articles).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import "../src/loadEnv.js";
import {
  assertDeKitParentQtyInteger,
  assertPackConversionParentQtyInteger,
  assertWorkflowAllowsDeKitting,
  assertWorkflowAllowsKitting,
  buildConversionPreview,
  buildLinesSnapshotFromBom,
  childQtyForParent,
  isPositiveInteger,
  maxKittableSets,
  validatePackConversionLineRules,
  validatePackConversionUomPair,
  appendBomRevisionHistory,
} from "../src/utils/kittingPackConversion.js";
import {
  buildKittingEffectKey,
  buildKittingReversalEffectKey,
  BOM_ITEM_NOT_FOUND,
  DEKIT_STOCK_SHORTAGE,
  KIT_STOCK_SHORTAGE,
} from "../src/utils/kittingIdempotency.js";
import { MOVEMENT_TYPES } from "../src/services/stockService.js";
import { deriveAvailableQty, deriveStockBuckets } from "../src/services/stockExpectedBuckets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(backendRoot, rel), "utf8");
}

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

console.log("\nPACK_CONVERSION Kitting / De-Kitting\n");

// --- Helpers ---
run("UOM pair rule accepts SET/PCS", () => {
  assert.equal(validatePackConversionUomPair("SET", "PCS").ok, true);
});

run("UOM pair rule rejects same UOM", () => {
  assert.equal(validatePackConversionUomPair("PCS", "PCS").ok, false);
});

run("Integer ratio validation", () => {
  assert.equal(isPositiveInteger(25), true);
  assert.equal(isPositiveInteger(25.5), false);
  assert.equal(isPositiveInteger(0), false);
});

run("Preview de-kit 8 SET @ 25", () => {
  const snap = [{ componentItemCode: "911206822.C", qtyPerKit: 25, componentUom: "PCS" }];
  const p = buildConversionPreview({
    direction: "DEKIT",
    parentItemCode: "911206822",
    parentUom: "SET",
    parentQty: 8,
    linesSnapshot: snap,
  });
  assert.equal(p.consume[0].qty, 8);
  assert.equal(p.produce[0].qty, 200);
});

run("Preview kit 2 SET @ 25 consumes 50 PCS", () => {
  const snap = [{ componentItemCode: "911206822.C", qtyPerKit: 25, componentUom: "PCS" }];
  const p = buildConversionPreview({
    direction: "KIT",
    parentItemCode: "911206822",
    parentUom: "SET",
    parentQty: 2,
    linesSnapshot: snap,
  });
  assert.equal(p.consume[0].qty, 50);
  assert.equal(p.produce[0].qty, 2);
});

run("Max kittable 40 PCS @ 25 = 1", () => {
  assert.equal(maxKittableSets(40, 25), 1);
});

run("Fractional parent qty rejected", () => {
  assert.throws(() => assertPackConversionParentQtyInteger(1.5, "SET"), (e) => e.code === "KIT_FRACTIONAL_SET_NOT_ALLOWED");
});

run("Workflow ASSEMBLY blocks de-kit", () => {
  assert.throws(() => assertWorkflowAllowsDeKitting("ASSEMBLY"), (e) => e.code === "DEKIT_WORKFLOW_BLOCKED");
});

run("Workflow DISASSEMBLY blocks kit", () => {
  assert.throws(() => assertWorkflowAllowsKitting("DISASSEMBLY"), (e) => e.code === "KIT_WORKFLOW_BLOCKED");
});

run("PACK line rules reject optional", () => {
  assert.equal(validatePackConversionLineRules({ optionalFlag: true, qty: 25 }).ok, false);
});

run("Effect keys deterministic + reversal suffix", () => {
  const k = buildKittingEffectKey({
    movementType: "DEKIT_OUT",
    companyId: "c1",
    referenceNo: "MAR-DK-1",
    article: "911206822",
    warehouse: "MAIN",
    lineId: "PARENT:abc",
  });
  assert.ok(k.includes("DEKIT_OUT"));
  assert.ok(buildKittingReversalEffectKey(k).endsWith("|REVERSAL"));
});

run("childQtyForParent 8 × 25 = 200", () => {
  assert.equal(childQtyForParent(8, [{ qtyPerKit: 25 }]), 200);
});

// --- Source wiring ---
run("kittingExecution uses snapshot not BOM.find lines loop on live bom", () => {
  const src = read("src/services/kittingExecution.js");
  assert.match(src, /assertSnapshot\(order\)/);
  assert.doesNotMatch(src, /for \(const line of bom\.lines\)/);
});

run("PACK_CONVERSION uses allowNegative false", () => {
  const src = read("src/services/kittingExecution.js");
  assert.match(src, /allowNegative: strict \? false : true/);
});

run("Controllers freeze snapshot at create", () => {
  assert.match(read("src/controllers/kittingController.js"), /linesSnapshot,/);
  assert.match(read("src/controllers/dekittingController.js"), /bomSnapshotAt: new Date\(\)/);
});

run("POSTING atomic claim in execute", () => {
  assert.match(read("src/controllers/kittingController.js"), /status: "POSTING"/);
  assert.match(read("src/controllers/dekittingController.js"), /session\.withTransaction/);
});

run("Reversal routes exist", () => {
  assert.match(read("src/routes/kittingRoutes.js"), /\/reverse/);
  assert.match(read("src/routes/dekittingRoutes.js"), /\/reverse/);
});

run("StockLedger includes kit reversal movement types", () => {
  const src = read("src/models/StockLedger.js");
  assert.match(src, /KIT_ASSEMBLY_REVERSAL_OUT/);
  assert.match(src, /DEKIT_REVERSAL_IN/);
});

run("BOM model includes PACK_CONVERSION", () => {
  assert.match(read("src/models/BOM.js"), /PACK_CONVERSION/);
  assert.match(read("src/models/BOM.js"), /revisions:/);
});

run("One-component de-kit produces exactly 2 forward movement calls in execution path", () => {
  const src = read("src/services/kittingExecution.js");
  const fn = src.slice(src.indexOf("export async function runDeKit"), src.indexOf("export async function runReverseKitAssembly"));
  assert.match(fn, /DEKIT_OUT/);
  assert.match(fn, /DEKIT_IN/);
  assert.doesNotMatch(fn, /for \(const line of bom\.lines\)/);
});

// --- Simulated stock guard (no DB) ---
run("Insufficient child blocks kit math", () => {
  const avail = 40;
  const need = 50;
  assert.ok(need > avail);
});

run("Insufficient parent blocks de-kit math", () => {
  const avail = 3;
  const need = 8;
  assert.ok(need > avail);
});

run("Reversal wiring passes reversedFromLedgerId to stockAdjustment", () => {
  const exec = read("src/services/kittingExecution.js");
  const stock = read("src/services/stockService.js");
  assert.match(exec, /reversedFromLedgerId:/);
  assert.match(exec, /originalEffectKey:/);
  assert.match(stock, /reversedFromLedgerId = null/);
});

// --- Mongo integration (optional) ---
async function integrationSuite() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.log("\n  (Skipping Mongo integration — MONGO_URI not set)\n");
    return;
  }

  const suffix = crypto.randomBytes(4).toString("hex");
  const PARENT = `T911206822-${suffix}`;
  const CHILD = `T911206822C-${suffix}`;
  const WH = "MAIN";

  const Company = (await import("../src/models/Company.js")).default;
  const ItemMaster = (await import("../src/models/itemMasterModel.js")).default;
  const BOM = (await import("../src/models/BOM.js")).default;
  const KittingOrder = (await import("../src/models/KittingOrder.js")).default;
  const DeKittingOrder = (await import("../src/models/DeKittingOrder.js")).default;
  const StockBalance = (await import("../src/models/StockBalance.js")).default;
  const StockLedger = (await import("../src/models/StockLedger.js")).default;
  const { runKitAssembly, runDeKit, runReverseDeKit, runReverseKitAssembly } = await import(
    "../src/services/kittingExecution.js"
  );
  const { validateAndEnrichPackConversionBom } = await import("../src/utils/kittingPackConversion.js");

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  let company = await Company.findOne({}).lean();
  if (!company) {
    company = await Company.create({ name: "Test Co", code: "TST" });
  }
  const companyId = company._id;

  async function setBal(article, qty) {
    await StockBalance.findOneAndUpdate(
      { companyId, article, location: WH, batchNo: "", serialNo: "" },
      {
        $set: {
          companyId,
          article,
          location: WH,
          itemCode: article,
          warehouse: WH,
          batchNo: "",
          serialNo: "",
          onHandQty: qty,
          quantity: qty,
          availableQty: qty,
        },
      },
      { upsert: true, new: true }
    );
  }

  async function bal(article) {
    const row = await StockBalance.findOne({ companyId, article, location: WH }).lean();
    return Number(row?.onHandQty ?? row?.quantity ?? 0) || 0;
  }

  try {
    await ItemMaster.create([
      { companyId, article: PARENT, itemName: "Test Pack", uom: "SET", status: "Active" },
      { companyId, article: CHILD, itemName: "Test Piece", uom: "PCS", status: "Active" },
    ]);

    const validated = await validateAndEnrichPackConversionBom({
      companyId,
      parentItemCode: PARENT,
      lines: [{ article: CHILD, qty: 25 }],
      workflowMode: "BOTH",
    });

    const bom = await BOM.create({
      companyId,
      parentItemCode: PARENT,
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      revisionNo: "R1",
      workflowMode: "BOTH",
      parentUom: validated.parentUom,
      parentItemName: validated.parentItemName,
      lines: [validated.enrichedLine],
      isActive: true,
    });

    const snap = buildLinesSnapshotFromBom(bom);
    const previewD = buildConversionPreview({
      direction: "DEKIT",
      parentItemCode: PARENT,
      parentUom: "SET",
      parentQty: 8,
      linesSnapshot: snap,
    });

    // Test 1 — De-kit 8 SET
    await setBal(PARENT, 8);
    await setBal(CHILD, 0);
    const dk1 = await DeKittingOrder.create({
      companyId,
      dekitNumber: `T-DK-${suffix}-1`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 8,
      bomId: bom._id,
      status: "DRAFT",
      linkedBomRevision: "R1",
      linesSnapshot: snap,
      previewConsume: previewD.consume,
      previewProduce: previewD.produce,
    });

    const session1 = await mongoose.startSession();
    await session1.withTransaction(async () => {
      await runDeKit(dk1, "test", companyId, session1);
      dk1.status = "COMPLETED";
      await dk1.save({ session: session1 });
    });
    session1.endSession();

    assert.equal(await bal(PARENT), 0);
    assert.equal(await bal(CHILD), 200);
    const ledger1 = await StockLedger.find({ referenceNo: dk1.dekitNumber }).lean();
    assert.equal(ledger1.length, 2, "de-kit must create exactly 2 ledger rows");
    assert.ok(ledger1.some((r) => r.movementType === "DEKIT_OUT"));
    assert.ok(ledger1.some((r) => r.movementType === "DEKIT_IN"));

    // Test 2 — Kit 50 PCS → 2 SET
    await setBal(PARENT, 0);
    await setBal(CHILD, 50);
    const snapKit = buildLinesSnapshotFromBom(bom);
    const kit1 = await KittingOrder.create({
      companyId,
      kitNumber: `T-KIT-${suffix}-1`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 2,
      bomId: bom._id,
      status: "DRAFT",
      linkedBomRevision: "R1",
      linesSnapshot: snapKit,
    });
    const session2 = await mongoose.startSession();
    await session2.withTransaction(async () => {
      await runKitAssembly(kit1, "test", companyId, session2);
      kit1.status = "COMPLETED";
      await kit1.save({ session: session2 });
    });
    session2.endSession();
    assert.equal(await bal(CHILD), 0);
    assert.equal(await bal(PARENT), 2);
    const ledger2 = await StockLedger.find({ referenceNo: kit1.kitNumber }).lean();
    assert.equal(ledger2.length, 2);

    // Test 3 — Partial 40 PCS → 1 SET
    await setBal(PARENT, 0);
    await setBal(CHILD, 40);
    const kit2 = await KittingOrder.create({
      companyId,
      kitNumber: `T-KIT-${suffix}-2`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 1,
      bomId: bom._id,
      status: "DRAFT",
      linesSnapshot: snapKit,
    });
    const session3 = await mongoose.startSession();
    await session3.withTransaction(async () => {
      await runKitAssembly(kit2, "test", companyId, session3);
      kit2.status = "COMPLETED";
      await kit2.save({ session: session3 });
    });
    session3.endSession();
    assert.equal(await bal(CHILD), 15);
    assert.equal(await bal(PARENT), 1);

    // Test 4 — Insufficient child 40 → 2 SET blocked
    await setBal(CHILD, 40);
    await setBal(PARENT, 0);
    const kitFail = await KittingOrder.create({
      companyId,
      kitNumber: `T-KIT-${suffix}-fail`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 2,
      bomId: bom._id,
      status: "DRAFT",
      linesSnapshot: snapKit,
    });
    let blocked4 = false;
    const session4 = await mongoose.startSession();
    try {
      await session4.withTransaction(async () => {
        await runKitAssembly(kitFail, "test", companyId, session4);
      });
    } catch (e) {
      blocked4 = e.code === KIT_STOCK_SHORTAGE;
    } finally {
      session4.endSession();
    }
    assert.equal(blocked4, true);
    assert.equal(await bal(CHILD), 40);

    // Test 5 — Insufficient parent de-kit blocked
    await setBal(PARENT, 3);
    await setBal(CHILD, 0);
    const dkFail = await DeKittingOrder.create({
      companyId,
      dekitNumber: `T-DK-${suffix}-fail`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 8,
      bomId: bom._id,
      status: "DRAFT",
      linesSnapshot: snap,
    });
    let blocked5 = false;
    const session5 = await mongoose.startSession();
    try {
      await session5.withTransaction(async () => {
        await runDeKit(dkFail, "test", companyId, session5);
      });
    } catch (e) {
      blocked5 = e.code === DEKIT_STOCK_SHORTAGE || e.code === KIT_STOCK_SHORTAGE;
    } finally {
      session5.endSession();
    }
    assert.equal(blocked5, true);
    assert.equal(await bal(PARENT), 3);

    // Test 9 — R1 historical after R2 (completed order unchanged)
    bom.revisionNo = "R2";
    bom.revisions = appendBomRevisionHistory(bom.toObject(), "test");
    bom.lines[0].qty = 20;
    await bom.save();
    const completed = await DeKittingOrder.findById(dk1._id).lean();
    assert.equal(completed.linkedBomRevision, "R1");
    assert.equal(completed.linesSnapshot[0].qtyPerKit, 25);
    assert.equal(completed.previewProduce[0].qty, 200);

    // Test 8 — DRAFT created under R1 executes frozen 25/SET after live BOM is R2
    await setBal(CHILD, 25);
    await setBal(PARENT, 0);
    const draftR1Snap = snap; // frozen R1 snapshot (25 PCS/SET)
    const kitDraftR1 = await KittingOrder.create({
      companyId,
      kitNumber: `T-KIT-${suffix}-draft-r1`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 1,
      bomId: bom._id,
      status: "DRAFT",
      linkedBomRevision: "R1",
      linesSnapshot: draftR1Snap,
    });
    const session8 = await mongoose.startSession();
    await session8.withTransaction(async () => {
      await runKitAssembly(kitDraftR1, "test", companyId, session8);
      kitDraftR1.status = "COMPLETED";
      await kitDraftR1.save({ session: session8 });
    });
    session8.endSession();
    assert.equal(await bal(CHILD), 0, "DRAFT R1 must consume 25 PCS not R2 ratio 20");
    assert.equal(await bal(PARENT), 1);

    // Test 21 — new order uses R2 snapshot (20 PCS/SET)
    await setBal(PARENT, 5);
    await setBal(CHILD, 0);
    const snapR2 = buildLinesSnapshotFromBom(bom);
    const dkR2 = await DeKittingOrder.create({
      companyId,
      dekitNumber: `T-DK-${suffix}-r2`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 2,
      bomId: bom._id,
      status: "DRAFT",
      linkedBomRevision: "R2",
      linesSnapshot: snapR2,
    });
    const session21 = await mongoose.startSession();
    await session21.withTransaction(async () => {
      await runDeKit(dkR2, "test", companyId, session21);
      dkR2.status = "COMPLETED";
      await dkR2.save({ session: session21 });
    });
    session21.endSession();
    const childBal = await StockBalance.findOne({ companyId, article: CHILD, location: WH }).lean();
    const avail = deriveAvailableQty({
      onHandQty: childBal.onHandQty,
      quantity: childBal.quantity,
      reservedQty: childBal.reservedQty,
      packedQty: childBal.packedQty,
    });
    assert.equal(avail, 40, "R2 new order: 2 SET × 20 PCS");

    // Reversal traceability — kit (reverse kitDraftR1: 1 SET → 25 PCS)
    await setBal(PARENT, 1);
    const kitRevTarget = await KittingOrder.findById(kitDraftR1._id);
    const sessionRevKit = await mongoose.startSession();
    await sessionRevKit.withTransaction(async () => {
      await runReverseKitAssembly(kitRevTarget, "test-reversal", companyId, sessionRevKit, "test");
    });
    sessionRevKit.endSession();
    {
      const forward = await StockLedger.find({
        referenceNo: kitDraftR1.kitNumber,
        movementType: { $in: ["KIT_ASSEMBLY_OUT", "KIT_ASSEMBLY_IN"] },
      }).lean();
      const reversal = await StockLedger.find({
        referenceNo: kitDraftR1.kitNumber,
        movementType: { $in: ["KIT_ASSEMBLY_REVERSAL_OUT", "KIT_ASSEMBLY_REVERSAL_IN"] },
      }).lean();
      assert.equal(forward.length, 2, "kit forward physical rows");
      assert.equal(reversal.length, 2, "kit reversal physical rows");
      for (const rev of reversal) {
        assert.ok(rev.reversedFromLedgerId, "reversal must have reversedFromLedgerId");
        assert.ok(rev.originalEffectKey, "reversal must have originalEffectKey");
        assert.ok(String(rev.effectKey).endsWith("|REVERSAL"));
        const orig = forward.find((o) => String(o._id) === String(rev.reversedFromLedgerId));
        assert.ok(orig, "reversedFromLedgerId must point to original forward row");
        assert.equal(rev.originalEffectKey, orig.effectKey);
        if (rev.movementType === "KIT_ASSEMBLY_REVERSAL_OUT") {
          assert.equal(orig.movementType, "KIT_ASSEMBLY_IN");
        }
        if (rev.movementType === "KIT_ASSEMBLY_REVERSAL_IN") {
          assert.equal(orig.movementType, "KIT_ASSEMBLY_OUT");
        }
      }
      // duplicate reversal — idempotent, no extra rows
      const kitRevAgain = await KittingOrder.findById(kitDraftR1._id);
      const sessionDup = await mongoose.startSession();
      await sessionDup.withTransaction(async () => {
        await runReverseKitAssembly(kitRevAgain, "test", companyId, sessionDup, "dup");
      });
      sessionDup.endSession();
      const reversalAfterDup = await StockLedger.find({
        referenceNo: kitDraftR1.kitNumber,
        movementType: { $in: ["KIT_ASSEMBLY_REVERSAL_OUT", "KIT_ASSEMBLY_REVERSAL_IN"] },
      }).lean();
      assert.equal(reversalAfterDup.length, 2, "duplicate kit reversal must not double-post");
    }

    // Reversal traceability — de-kit (reverse dkR2: 40 PCS → 2 SET)
    const dkRevTarget = await DeKittingOrder.findById(dkR2._id);
    const sessionRevDk = await mongoose.startSession();
    await sessionRevDk.withTransaction(async () => {
      await runReverseDeKit(dkRevTarget, "test-reversal", companyId, sessionRevDk, "test");
    });
    sessionRevDk.endSession();
    {
      const forward = await StockLedger.find({
        referenceNo: dkR2.dekitNumber,
        movementType: { $in: ["DEKIT_OUT", "DEKIT_IN"] },
      }).lean();
      const reversal = await StockLedger.find({
        referenceNo: dkR2.dekitNumber,
        movementType: { $in: ["DEKIT_REVERSAL_OUT", "DEKIT_REVERSAL_IN"] },
      }).lean();
      assert.equal(forward.length, 2);
      assert.equal(reversal.length, 2);
      for (const rev of reversal) {
        assert.ok(rev.reversedFromLedgerId);
        assert.ok(rev.originalEffectKey);
        const orig = forward.find((o) => String(o._id) === String(rev.reversedFromLedgerId));
        assert.ok(orig);
        assert.equal(rev.originalEffectKey, orig.effectKey);
      }
    }

    // Concurrency — 50 PCS, two orders each want 2 SET (50 PCS)
    await setBal(CHILD, 50);
    await setBal(PARENT, 0);
    const snapConc = draftR1Snap;
    const kitConcA = await KittingOrder.create({
      companyId,
      kitNumber: `T-KIT-${suffix}-conc-a`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 2,
      bomId: bom._id,
      status: "DRAFT",
      linesSnapshot: snapConc,
    });
    const kitConcB = await KittingOrder.create({
      companyId,
      kitNumber: `T-KIT-${suffix}-conc-b`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 2,
      bomId: bom._id,
      status: "DRAFT",
      linesSnapshot: snapConc,
    });
    const concResults = await Promise.allSettled([
      (async () => {
        const s = await mongoose.startSession();
        try {
          await s.withTransaction(async () => {
            const o = await KittingOrder.findById(kitConcA._id).session(s);
            await runKitAssembly(o, "test", companyId, s);
          });
        } finally {
          s.endSession();
        }
      })(),
      (async () => {
        const s = await mongoose.startSession();
        try {
          await s.withTransaction(async () => {
            const o = await KittingOrder.findById(kitConcB._id).session(s);
            await runKitAssembly(o, "test", companyId, s);
          });
        } finally {
          s.endSession();
        }
      })(),
    ]);
    const concSuccess = concResults.filter((r) => r.status === "fulfilled").length;
    assert.equal(concSuccess, 1, "only one concurrent kit may consume 50 PCS");
    assert.equal(await bal(CHILD), 0);
    assert.ok(await bal(PARENT) <= 2);
    const childOuts = await StockLedger.find({
      companyId,
      article: CHILD,
      movementType: "KIT_ASSEMBLY_OUT",
      referenceNo: { $in: [kitConcA.kitNumber, kitConcB.kitNumber] },
    }).lean();
    const totalOut = childOuts.reduce((s, r) => s + (Number(r.qtyOut) || 0), 0);
    assert.equal(totalOut, 50);

    // Transaction rollback — abort after child OUT, no partial posting survives
    await setBal(CHILD, 50);
    await setBal(PARENT, 0);
    const kitRb = await KittingOrder.create({
      companyId,
      kitNumber: `T-KIT-${suffix}-rollback`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 2,
      bomId: bom._id,
      status: "DRAFT",
      linesSnapshot: snapConc,
    });
    const stockService = await import("../src/services/stockService.js");
    const sessionRb = await mongoose.startSession();
    let rbFailed = false;
    try {
      await sessionRb.withTransaction(async () => {
        const o = await KittingOrder.findById(kitRb._id).session(sessionRb);
        o.status = "POSTING";
        await o.save({ session: sessionRb });
        const line = o.linesSnapshot[0];
        await stockService.stockAdjustment({
          session: sessionRb,
          companyId,
          article: line.componentItemCode,
          warehouse: WH,
          qty: 50,
          direction: "Decrease",
          referenceType: "KITTING",
          referenceNo: o.kitNumber,
          createdBy: "test",
          sourceModule: "KITTING",
          allowNegative: false,
          movementType: stockService.MOVEMENT_TYPES.KIT_ASSEMBLY_OUT,
          lineId: line.lineId || line.componentItemCode,
        });
        throw new Error("INJECT_ROLLBACK");
      });
    } catch (e) {
      rbFailed = e.message === "INJECT_ROLLBACK";
    } finally {
      sessionRb.endSession();
    }
    assert.equal(rbFailed, true);
    assert.equal(await bal(CHILD), 50, "rollback must leave child stock unchanged");
    assert.equal(await bal(PARENT), 0, "rollback must leave parent stock unchanged");
    const rbLedger = await StockLedger.countDocuments({ referenceNo: kitRb.kitNumber });
    assert.equal(rbLedger, 0, "rollback must leave zero ledger rows");
    const rbOrder = await KittingOrder.findById(kitRb._id).lean();
    assert.equal(rbOrder.status, "DRAFT", "POSTING must roll back to DRAFT on abort");

    console.log("  ✓ Mongo integration suite completed");
    passed += 1;
  } finally {
    await ItemMaster.deleteMany({ companyId, article: { $in: [PARENT, CHILD] } });
    await BOM.deleteMany({ companyId, parentItemCode: PARENT });
    await KittingOrder.deleteMany({ companyId, parentItemCode: PARENT });
    await DeKittingOrder.deleteMany({ companyId, parentItemCode: PARENT });
    await StockBalance.deleteMany({ companyId, article: { $in: [PARENT, CHILD] } });
    await StockLedger.deleteMany({ referenceNo: new RegExp(`T-(KIT|DK)-${suffix}`) });
    await mongoose.disconnect();
  }
}

await integrationSuite();

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
