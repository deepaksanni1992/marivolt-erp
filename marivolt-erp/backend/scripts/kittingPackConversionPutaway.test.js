/**
 * PACK_CONVERSION Last Known Putaway provenance tests.
 * Run: node scripts/kittingPackConversionPutaway.test.js
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import "../src/loadEnv.js";
import Company from "../src/models/Company.js";
import ItemMaster from "../src/models/itemMasterModel.js";
import BOM from "../src/models/BOM.js";
import KittingOrder from "../src/models/KittingOrder.js";
import DeKittingOrder from "../src/models/DeKittingOrder.js";
import StockBalance from "../src/models/StockBalance.js";
import StockLedger from "../src/models/StockLedger.js";
import GRN from "../src/models/GRN.js";
import {
  runKitAssembly,
  runDeKit,
  runReverseDeKit,
  runReverseKitAssembly,
} from "../src/services/kittingExecution.js";
import {
  buildLinesSnapshotFromBom,
  validateAndEnrichPackConversionBom,
} from "../src/utils/kittingPackConversion.js";
import { batchLastKnownPutaway } from "../src/services/lastKnownPutawayService.js";
import {
  appendPutawayToRemarks,
  buildPackingStorePresentation,
  derivePackingLineStock,
  parsePutawayFromLedgerRemarks,
  resolvePutawayViaPackConversionLineage,
  selectLatestPutawayByArticle,
} from "../src/utils/packingPhysicalStock.js";

const WH = "MAIN";
const RATIO = 25;
const PUTAWAY_A = "MAIN-R01-A01";
const PUTAWAY_B = "MAIN-R02-B03";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    if (e.stack) console.error(e.stack.split("\n").slice(1, 3).join("\n"));
  }
}

async function setBal(companyId, article, qty, avgCost = 75, currency = "EUR") {
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
        avgCost,
        unitCost: avgCost,
        currency,
      },
    },
    { upsert: true, new: true }
  );
}

async function createGrnWithPutaway({ companyId, grnNo, article, qty, location, postedAt }) {
  return GRN.create({
    companyId,
    grnNo,
    grnDate: postedAt || new Date("2026-01-01"),
    postedAt: postedAt || new Date("2026-01-01"),
    status: "POSTED",
    currency: "EUR",
    items: [
      {
        article,
        receivedQty: qty,
        acceptedQty: qty,
        uom: article.endsWith(".C") ? "PCS" : "SET",
        unitCost: article.endsWith(".C") ? 3 : 75,
        lineAmount: qty * (article.endsWith(".C") ? 3 : 75),
        currency: "EUR",
        warehouse: WH,
        location,
      },
    ],
  });
}

async function createPackFixture(companyId, suffix) {
  const PARENT = `TPUT-P-${suffix}`;
  const CHILD = `TPUT-C-${suffix}`;

  await ItemMaster.create([
    { companyId, article: PARENT, itemName: "Pack Parent", uom: "SET", status: "Active" },
    { companyId, article: CHILD, itemName: "Pack Child", uom: "PCS", status: "Active" },
  ]);

  const validated = await validateAndEnrichPackConversionBom({
    companyId,
    parentItemCode: PARENT,
    lines: [{ article: CHILD, qty: RATIO }],
    workflowMode: "BOTH",
  });

  const bom = await BOM.create({
    companyId,
    parentItemCode: PARENT,
    bomCode: `${PARENT}-R1`,
    kitType: "PACK_CONVERSION",
    bomKind: "PACK_CONVERSION",
    revisionNo: "R1",
    workflowMode: "BOTH",
    parentUom: validated.parentUom,
    parentItemName: validated.parentItemName,
    lines: [validated.enrichedLine],
    isActive: true,
  });

  return { PARENT, CHILD, bom, snap: buildLinesSnapshotFromBom(bom) };
}

console.log("\nPACK_CONVERSION Last Known Putaway\n");

await test("appendPutawayToRemarks follows GRN convention", () => {
  assert.equal(
    appendPutawayToRemarks("De-kit component from (PACK_CONVERSION) X", PUTAWAY_A),
    `De-kit component from (PACK_CONVERSION) X | Putaway: ${PUTAWAY_A}`
  );
  assert.equal(appendPutawayToRemarks("Base only", ""), "Base only");
});

await test("selectLatestPutawayByArticle prefers newer dated evidence", () => {
  const map = selectLatestPutawayByArticle(
    [
      {
        article: "ART1",
        putaway: PUTAWAY_A,
        warehouse: WH,
        status: "POSTED",
        source: "STOCK_LEDGER",
        date: new Date("2026-01-01"),
      },
      {
        article: "ART1",
        putaway: PUTAWAY_B,
        warehouse: WH,
        status: "POSTED",
        source: "STOCK_LEDGER",
        date: new Date("2026-06-01"),
      },
    ],
    WH
  );
  assert.equal(map.get("ART1")?.value, PUTAWAY_B);
});

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.log("\n  (Skipping Mongo integration — MONGO_URI not set)\n");
} else {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  let company = await Company.findOne({}).lean();
  if (!company) {
    company = await Company.create({ name: "Putaway Test Co", code: "PTW" });
  }
  const companyId = company._id;
  const suffix = crypto.randomBytes(4).toString("hex");

  await test("TEST 1 — DE-KIT INHERITANCE", async () => {
    const s = `${suffix}-dk`;
    const { PARENT, CHILD, bom, snap } = await createPackFixture(companyId, s);
    await createGrnWithPutaway({
      companyId,
      grnNo: `GRN-${s}-P`,
      article: PARENT,
      qty: 8,
      location: PUTAWAY_A,
    });
    await setBal(companyId, PARENT, 8);
    await setBal(companyId, CHILD, 0);

    const dk = await DeKittingOrder.create({
      companyId,
      dekitNumber: `T-DK-${s}`,
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
    });

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runDeKit(dk, "test", companyId, session);
      dk.status = "COMPLETED";
      dk.postedAt = new Date();
      await dk.save({ session });
    });
    session.endSession();

    const inLeg = await StockLedger.findOne({
      companyId,
      referenceNo: dk.dekitNumber,
      movementType: "DEKIT_IN",
    }).lean();
    assert.ok(inLeg, "DEKIT_IN must exist");
    assert.match(inLeg.remarks, /Putaway:\s*MAIN-R01-A01/i);
    assert.equal(parsePutawayFromLedgerRemarks(inLeg.remarks), PUTAWAY_A);
    assert.equal(dk.sourcePutawayLocation, PUTAWAY_A);
    assert.equal(dk.producedPutawayLocation, PUTAWAY_A);

    const putaway = await batchLastKnownPutaway({ companyId, warehouse: WH, articles: [CHILD] });
    const row = putaway.get(String(CHILD).toUpperCase());
    assert.equal(row?.value, PUTAWAY_A);
    assert.equal(row?.sourceType, "STOCK_LEDGER");

    const presentation = buildPackingStorePresentation(
      derivePackingLineStock({ onHandQty: 200, reservedQty: 0, packedQty: 0 }, { allocatedQty: 200 }),
      row
    );
    assert.equal(presentation.storeRemarks, "STOCK EXISTS — BIN QTY NOT TRACKED");
  });

  await test("TEST 2 — KIT INHERITANCE", async () => {
    const s = `${suffix}-kit`;
    const { PARENT, CHILD, bom, snap } = await createPackFixture(companyId, s);
    await createGrnWithPutaway({
      companyId,
      grnNo: `GRN-${s}-C`,
      article: CHILD,
      qty: 50,
      location: PUTAWAY_A,
    });
    await setBal(companyId, PARENT, 0);
    await setBal(companyId, CHILD, 50);

    const kit = await KittingOrder.create({
      companyId,
      kitNumber: `T-KIT-${s}`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 2,
      bomId: bom._id,
      status: "DRAFT",
      linkedBomRevision: "R1",
      linesSnapshot: snap,
    });

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runKitAssembly(kit, "test", companyId, session);
      kit.status = "COMPLETED";
      kit.postedAt = new Date();
      await kit.save({ session });
    });
    session.endSession();

    const inLeg = await StockLedger.findOne({
      companyId,
      referenceNo: kit.kitNumber,
      movementType: "KIT_ASSEMBLY_IN",
    }).lean();
    assert.match(inLeg.remarks, /Putaway:\s*MAIN-R01-A01/i);
    assert.equal(kit.sourcePutawayLocation, PUTAWAY_A);

    const putaway = await batchLastKnownPutaway({ companyId, warehouse: WH, articles: [PARENT] });
    assert.equal(putaway.get(String(PARENT).toUpperCase())?.value, PUTAWAY_A);
  });

  await test("TEST 3 — NO SOURCE LOCATION", async () => {
    const s = `${suffix}-none`;
    const { PARENT, CHILD, bom, snap } = await createPackFixture(companyId, s);
    await setBal(companyId, PARENT, 4);
    await setBal(companyId, CHILD, 0);

    const dk = await DeKittingOrder.create({
      companyId,
      dekitNumber: `T-DK-${s}`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 4,
      bomId: bom._id,
      status: "DRAFT",
      linesSnapshot: snap,
    });

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runDeKit(dk, "test", companyId, session);
      dk.status = "COMPLETED";
      await dk.save({ session });
    });
    session.endSession();

    const inLeg = await StockLedger.findOne({
      companyId,
      referenceNo: dk.dekitNumber,
      movementType: "DEKIT_IN",
    }).lean();
    assert.doesNotMatch(inLeg.remarks, /Putaway:/i);
    assert.equal(dk.sourcePutawayLocation, "");
    const putaway = await batchLastKnownPutaway({ companyId, warehouse: WH, articles: [CHILD] });
    assert.equal(putaway.get(String(CHILD).toUpperCase()), undefined);

    const presentation = buildPackingStorePresentation(
      derivePackingLineStock({ onHandQty: 100, reservedQty: 0, packedQty: 0 }, { allocatedQty: 100 }),
      null
    );
    assert.equal(presentation.storeRemarks, "STOCK EXISTS — LOCATION NOT RECORDED");
  });

  await test("TEST 4 — EXISTING TARGET / LATEST EVIDENCE", async () => {
    const s = `${suffix}-latest`;
    const { PARENT, CHILD, bom, snap } = await createPackFixture(companyId, s);

    await createGrnWithPutaway({
      companyId,
      grnNo: `GRN-${s}-C-NEW`,
      article: CHILD,
      qty: 10,
      location: PUTAWAY_B,
      postedAt: new Date("2026-06-01"),
    });

    await createGrnWithPutaway({
      companyId,
      grnNo: `GRN-${s}-P-OLD`,
      article: PARENT,
      qty: 8,
      location: PUTAWAY_A,
      postedAt: new Date("2026-01-01"),
    });

    await setBal(companyId, PARENT, 8);
    await setBal(companyId, CHILD, 10);

    const dk = await DeKittingOrder.create({
      companyId,
      dekitNumber: `T-DK-${s}`,
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

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runDeKit(dk, "test", companyId, session);
      dk.status = "COMPLETED";
      dk.postedAt = new Date("2026-02-01");
      await dk.save({ session });
    });
    session.endSession();

    // Backdate DEKIT_IN so older conversion putaway does not beat newer child GRN evidence.
    await StockLedger.updateOne(
      { companyId, referenceNo: dk.dekitNumber, movementType: "DEKIT_IN" },
      {
        $set: {
          transactionDate: new Date("2026-02-01"),
          createdAt: new Date("2026-02-01"),
        },
      }
    );

    const putaway = await batchLastKnownPutaway({ companyId, warehouse: WH, articles: [CHILD] });
    assert.equal(putaway.get(String(CHILD).toUpperCase())?.value, PUTAWAY_B);
    assert.equal(putaway.get(String(CHILD).toUpperCase())?.sourceType, "GRN");

    const lineageOnly = resolvePutawayViaPackConversionLineage(CHILD, {
      warehouse: WH,
      putawayCandidates: [
        {
          article: PARENT,
          putaway: PUTAWAY_A,
          warehouse: WH,
          status: "POSTED",
          source: "GRN",
          date: new Date("2026-01-01"),
        },
      ],
      transforms: [
        {
          status: "COMPLETED",
          warehouse: WH,
          sourceArticle: PARENT,
          targetArticle: CHILD,
          postedAt: new Date("2026-02-01"),
          conversionNo: dk.dekitNumber,
        },
      ],
    });
    assert.equal(lineageOnly?.value, PUTAWAY_A);
    assert.notEqual(putaway.get(String(CHILD).toUpperCase())?.value, lineageOnly?.value);
  });

  await test("TEST 5 — REVERSAL preserves audit + restores parent putaway", async () => {
    const s = `${suffix}-rev`;
    const { PARENT, CHILD, bom, snap } = await createPackFixture(companyId, s);
    await createGrnWithPutaway({
      companyId,
      grnNo: `GRN-${s}-P`,
      article: PARENT,
      qty: 8,
      location: PUTAWAY_A,
    });
    await setBal(companyId, PARENT, 8);
    await setBal(companyId, CHILD, 0);

    const dk = await DeKittingOrder.create({
      companyId,
      dekitNumber: `T-DK-${s}`,
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

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runDeKit(dk, "test", companyId, session);
      dk.status = "COMPLETED";
      dk.postedAt = new Date();
      await dk.save({ session });
    });
    session.endSession();

    const forwardIn = await StockLedger.findOne({
      companyId,
      referenceNo: dk.dekitNumber,
      movementType: "DEKIT_IN",
    }).lean();
    assert.match(forwardIn.remarks, /Putaway:/i);

    const session2 = await mongoose.startSession();
    await session2.withTransaction(async () => {
      await runReverseDeKit(dk, "test", companyId, session2, "test reversal");
      dk.status = "REVERSED";
      await dk.save({ session: session2 });
    });
    session2.endSession();

    const parentBal = await StockBalance.findOne({ companyId, article: PARENT, location: WH }).lean();
    assert.equal(Number(parentBal?.onHandQty ?? parentBal?.quantity), 8);

    const childBal = await StockBalance.findOne({ companyId, article: CHILD, location: WH }).lean();
    assert.equal(Number(childBal?.onHandQty ?? childBal?.quantity), 0);

    const revIn = await StockLedger.findOne({
      companyId,
      referenceNo: dk.dekitNumber,
      movementType: "DEKIT_REVERSAL_IN",
    }).lean();
    assert.match(revIn.remarks, /Putaway:\s*MAIN-R01-A01/i);
    assert.ok(revIn.reversedFromLedgerId);

    const forwardStill = await StockLedger.findById(forwardIn._id).lean();
    assert.match(forwardStill.remarks, /Putaway:/i);

    const ledgerCount = await StockLedger.countDocuments({ referenceNo: dk.dekitNumber });
    assert.equal(ledgerCount, 4);
  });

  await test("TEST 6 — GENERIC BOM unchanged (no putaway on CUSTOM_KIT)", async () => {
    const s = `${suffix}-generic`;
    const PARENT = `TGEN-P-${s}`;
    const CHILD = `TGEN-C-${s}`;
    await ItemMaster.create([
      { companyId, article: PARENT, itemName: "Generic Parent", uom: "SET", status: "Active" },
      { companyId, article: CHILD, itemName: "Generic Child", uom: "PCS", status: "Active" },
    ]);
    await createGrnWithPutaway({
      companyId,
      grnNo: `GRN-${s}-P`,
      article: PARENT,
      qty: 5,
      location: PUTAWAY_A,
    });
    const bom = await BOM.create({
      companyId,
      parentItemCode: PARENT,
      bomCode: `${PARENT}-R1`,
      kitType: "CUSTOM_KIT",
      bomKind: "GENERIC",
      revisionNo: "R1",
      workflowMode: "BOTH",
      parentUom: "SET",
      lines: [{ article: CHILD, qty: 2, uom: "PCS" }],
      isActive: true,
    });
    const snap = buildLinesSnapshotFromBom(bom);
    await setBal(companyId, PARENT, 0);
    await setBal(companyId, CHILD, 10);

    const kit = await KittingOrder.create({
      companyId,
      kitNumber: `T-GKIT-${s}`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "CUSTOM_KIT",
      bomKind: "GENERIC",
      warehouse: WH,
      quantity: 2,
      bomId: bom._id,
      status: "DRAFT",
      linesSnapshot: snap,
    });

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runKitAssembly(kit, "test", companyId, session);
      kit.status = "COMPLETED";
      await kit.save({ session });
    });
    session.endSession();

    const inLeg = await StockLedger.findOne({
      companyId,
      referenceNo: kit.kitNumber,
      movementType: "KIT_ASSEMBLY_IN",
    }).lean();
    assert.doesNotMatch(inLeg.remarks, /Putaway:/i);
    assert.equal(kit.sourcePutawayLocation, "");
  });

  await test("TEST 7 — IDEMPOTENCY (duplicate effectKey returns same ledger)", async () => {
    const s = `${suffix}-idem`;
    const { PARENT, CHILD, bom, snap } = await createPackFixture(companyId, s);
    await createGrnWithPutaway({
      companyId,
      grnNo: `GRN-${s}-P`,
      article: PARENT,
      qty: 2,
      location: PUTAWAY_A,
    });
    await setBal(companyId, PARENT, 2);

    const dk = await DeKittingOrder.create({
      companyId,
      dekitNumber: `T-DK-${s}`,
      parentItemCode: PARENT,
      parentUom: "SET",
      kitType: "PACK_CONVERSION",
      bomKind: "PACK_CONVERSION",
      warehouse: WH,
      quantity: 2,
      bomId: bom._id,
      status: "DRAFT",
      linesSnapshot: snap,
    });

    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await runDeKit(dk, "test", companyId, session);
      await runDeKit(dk, "test", companyId, session);
    });
    session.endSession();

    const rows = await StockLedger.find({ companyId, referenceNo: dk.dekitNumber }).lean();
    assert.equal(rows.length, 2);
    const inLeg = rows.find((r) => r.movementType === "DEKIT_IN");
    assert.match(inLeg.remarks, /Putaway:/i);
  });

  await mongoose.disconnect();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
