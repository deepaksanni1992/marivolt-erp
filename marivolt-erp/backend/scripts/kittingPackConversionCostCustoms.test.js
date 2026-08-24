/**
 * PACK_CONVERSION cost conservation + customs provenance tests.
 * Run: node scripts/kittingPackConversionCostCustoms.test.js
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
import CustomsLot from "../src/models/CustomsLot.js";
import CustomsLotItem from "../src/models/CustomsLotItem.js";
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
import {
  computeConservedTargetUnitCost,
  computeWeightedAverageUnitCost,
  resolveBalanceUnitCost,
} from "../src/utils/packConversionCost.js";

const WH = "MAIN";
const RATIO = 25;

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
  }
}

async function setBal(companyId, article, qty, avgCost = 0, currency = "EUR") {
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

async function getBal(companyId, article) {
  return StockBalance.findOne({ companyId, article, location: WH }).lean();
}

async function createTestGrn({ companyId, grnNo, article, qty, unitCost = 75, uom = "SET" }) {
  return GRN.create({
    companyId,
    grnNo,
    grnDate: new Date("2026-01-01"),
    status: "POSTED",
    currency: "EUR",
    items: [
      {
        article,
        receivedQty: qty,
        acceptedQty: qty,
        uom,
        unitCost,
        lineAmount: qty * unitCost,
        currency: "EUR",
      },
    ],
  });
}

async function createCustomsLayer({
  companyId,
  article,
  qty,
  totalValue,
  boeNumber = "TEST-BOE-1",
  grnNo = "",
  receivedDate = new Date("2026-01-01"),
}) {
  const uniqueGrnNo = grnNo || `T-GRN-${crypto.randomBytes(4).toString("hex")}`;
  const grn = await createTestGrn({
    companyId,
    grnNo: uniqueGrnNo,
    article,
    qty,
    unitCost: totalValue / qty,
  });
  const lot = await CustomsLot.create({
    companyId,
    customsLotRef: `LOT-${crypto.randomBytes(3).toString("hex")}`,
    grnId: grn._id,
    grnNo: uniqueGrnNo,
    boeNumber,
    boeDate: receivedDate,
    supplierInvoiceDate: receivedDate,
    receivedDate,
    status: "OPEN",
    currency: "EUR",
    customsUom: "SET",
  });
  const item = await CustomsLotItem.create({
    companyId,
    customsLotId: lot._id,
    customsLotRef: lot.customsLotRef,
    grnId: grn._id,
    grnNo: uniqueGrnNo,
    articleNumber: article,
    qtyImported: qty,
    qtyAvailable: qty,
    qtyConsumed: 0,
    unitPrice: totalValue / qty,
    customsUnitValue: totalValue / qty,
    totalValue,
    customsQtyImported: qty,
    customsValueAED: totalValue * 4.33,
    exchangeRateToAED: 4.33,
    boeNumber,
    boeDate: receivedDate,
    receivedDate,
    status: "IN_STOCK",
  });
  return { lot, item, grn };
}

async function createPackBom(companyId, parentArt, childArt) {
  const validated = await validateAndEnrichPackConversionBom({
    companyId,
    parentItemCode: parentArt,
    lines: [{ article: childArt, qty: RATIO }],
    workflowMode: "BOTH",
  });
  const bom = await BOM.create({
    companyId,
    parentItemCode: parentArt,
    bomCode: `${parentArt}-R1`,
    kitType: "PACK_CONVERSION",
    bomKind: "PACK_CONVERSION",
    revisionNo: "R1",
    workflowMode: "BOTH",
    parentUom: validated.parentUom,
    parentItemName: validated.parentItemName,
    lines: [validated.enrichedLine],
    isActive: true,
  });
  return { bom, snap: buildLinesSnapshotFromBom(bom) };
}

async function execDeKit(dk) {
  const s = await mongoose.startSession();
  await s.withTransaction(async () => {
    await runDeKit(dk, "test", dk.companyId, s);
    dk.status = "COMPLETED";
    await dk.save({ session: s });
  });
  s.endSession();
}

async function execKit(kit) {
  const s = await mongoose.startSession();
  await s.withTransaction(async () => {
    await runKitAssembly(kit, "test", kit.companyId, s);
    kit.status = "COMPLETED";
    await kit.save({ session: s });
  });
  s.endSession();
}

async function execReverseDeKit(dk) {
  const s = await mongoose.startSession();
  await s.withTransaction(async () => {
    await runReverseDeKit(dk, "test", dk.companyId, s);
    dk.status = "REVERSED";
    await dk.save({ session: s });
  });
  s.endSession();
}

async function execReverseKit(kit) {
  const s = await mongoose.startSession();
  await s.withTransaction(async () => {
    await runReverseKitAssembly(kit, "test", kit.companyId, s);
    kit.status = "REVERSED";
    await kit.save({ session: s });
  });
  s.endSession();
}

console.log("\nPACK_CONVERSION Cost + Customs\n");

await test("Cost Test 2 weighted average formula", async () => {
  const wac = computeWeightedAverageUnitCost(100, 2, 200, 3);
  assert.equal(wac, (100 * 2 + 200 * 3) / 300);
});

await test("Cost Test 1 conserved target unit cost 75/25=3", async () => {
  assert.equal(computeConservedTargetUnitCost(8, 75, 200), 3);
});

const uri = process.env.MONGO_URI;
if (!uri) {
  console.log("\n  (Skipping Mongo integration — MONGO_URI not set)\n");
} else {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  const suffix = crypto.randomBytes(4).toString("hex");
  const PARENT = `T-PACK-PARENT-${suffix}`;
  const CHILD = `T-PACK-CHILD-${suffix}`;
  let company = await Company.findOne({}).lean();
  if (!company) company = await Company.create({ name: "Test Co", code: "TST" });
  const companyId = company._id;

  try {
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
    const linesSnapshot = buildLinesSnapshotFromBom(bom);

    await test("Cost Test 1 de-kit 8 SET @75 → 200 PCS @3", async () => {
      await setBal(companyId, PARENT, 8, 75, "EUR");
      await setBal(companyId, CHILD, 0, 0, "EUR");
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-COST1-${suffix}`,
        parentItemCode: PARENT,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 8,
        bomId: bom._id,
        status: "DRAFT",
        linesSnapshot,
      });
      const s = await mongoose.startSession();
      await s.withTransaction(async () => {
        await runDeKit(dk, "test", companyId, s);
        dk.status = "COMPLETED";
        await dk.save({ session: s });
      });
      s.endSession();
      const childBal = await getBal(companyId, CHILD);
      assert.equal(childBal?.onHandQty ?? childBal?.quantity, 200);
      assert.equal(resolveBalanceUnitCost(childBal), 3);
      assert.equal(dk.costSnapshot.producedTotalCost, 600);
    });

    await test("Cost Test 2 de-kit into existing child stock WAC", async () => {
      await setBal(companyId, PARENT, 8, 75, "EUR");
      await setBal(companyId, CHILD, 100, 2, "EUR");
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-COST2-${suffix}`,
        parentItemCode: PARENT,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 8,
        bomId: bom._id,
        status: "DRAFT",
        linesSnapshot,
      });
      const s = await mongoose.startSession();
      await s.withTransaction(async () => {
        await runDeKit(dk, "test", companyId, s);
        dk.status = "COMPLETED";
        await dk.save({ session: s });
      });
      s.endSession();
      const childBal = await getBal(companyId, CHILD);
      const expected = (100 * 2 + 200 * 3) / 300;
      assert.ok(Math.abs(resolveBalanceUnitCost(childBal) - expected) < 0.0001);
    });

    await test("Cost Test 3 kit 50 PCS @3 → 2 SET @75", async () => {
      await setBal(companyId, PARENT, 0, 0, "EUR");
      await setBal(companyId, CHILD, 50, 3, "EUR");
      const kit = await KittingOrder.create({
        companyId,
        kitNumber: `T-KIT-COST3-${suffix}`,
        parentItemCode: PARENT,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 2,
        bomId: bom._id,
        status: "DRAFT",
        linesSnapshot,
      });
      const s = await mongoose.startSession();
      await s.withTransaction(async () => {
        await runKitAssembly(kit, "test", companyId, s);
        kit.status = "COMPLETED";
        await kit.save({ session: s });
      });
      s.endSession();
      const parentBal = await getBal(companyId, PARENT);
      assert.equal(resolveBalanceUnitCost(parentBal), 75);
    });

    await test("Customs Test 1 single lot 8 SET de-kit full", async () => {
      const parentArt = `${PARENT}-C1`;
      const childArt = `${CHILD}-C1`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const v = await validateAndEnrichPackConversionBom({
        companyId,
        parentItemCode: parentArt,
        lines: [{ article: childArt, qty: RATIO }],
        workflowMode: "BOTH",
      });
      const b = await BOM.create({
        companyId,
        parentItemCode: parentArt,
        bomCode: `${parentArt}-R1`,
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        revisionNo: "R1",
        workflowMode: "BOTH",
        parentUom: v.parentUom,
        lines: [v.enrichedLine],
        isActive: true,
      });
      const snap = buildLinesSnapshotFromBom(b);
      await setBal(companyId, parentArt, 8, 75, "EUR");
      await setBal(companyId, childArt, 0, 0, "EUR");
      const { item: srcItem } = await createCustomsLayer({
        companyId,
        article: parentArt,
        qty: 8,
        totalValue: 600,
        boeNumber: "TEST-BOE-1",
      });
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-CUST1-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 8,
        bomId: b._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      const s = await mongoose.startSession();
      await s.withTransaction(async () => {
        await runDeKit(dk, "test", companyId, s);
        dk.status = "COMPLETED";
        await dk.save({ session: s });
      });
      s.endSession();
      const srcAfter = await CustomsLotItem.findById(srcItem._id).lean();
      const childCustoms = await CustomsLotItem.find({
        companyId,
        articleNumber: childArt,
        isConversionLayer: true,
      }).lean();
      assert.equal(srcAfter.qtyAvailable, 0);
      assert.equal(childCustoms.length, 1);
      assert.equal(childCustoms[0].qtyAvailable, 200);
      assert.equal(childCustoms[0].boeNumber, "TEST-BOE-1");
      assert.equal(childCustoms[0].totalValue, 600);
    });

    await test("Customs Test 8 non-customs stock succeeds", async () => {
      const parentArt = `${PARENT}-NC`;
      const childArt = `${CHILD}-NC`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const v = await validateAndEnrichPackConversionBom({
        companyId,
        parentItemCode: parentArt,
        lines: [{ article: childArt, qty: RATIO }],
        workflowMode: "BOTH",
      });
      const b = await BOM.create({
        companyId,
        parentItemCode: parentArt,
        bomCode: `${parentArt}-R1`,
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        revisionNo: "R1",
        workflowMode: "BOTH",
        parentUom: v.parentUom,
        lines: [v.enrichedLine],
        isActive: true,
      });
      const snap = buildLinesSnapshotFromBom(b);
      await setBal(companyId, parentArt, 2, 75, "EUR");
      await setBal(companyId, childArt, 0, 0, "EUR");
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-NC-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 2,
        bomId: b._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      const s = await mongoose.startSession();
      await s.withTransaction(async () => {
        await runDeKit(dk, "test", companyId, s);
        dk.status = "COMPLETED";
        await dk.save({ session: s });
      });
      s.endSession();
      assert.equal((dk.customsLotLayers || []).length, 0);
    });

    await test("Cost Test 4 kit into existing parent stock WAC", async () => {
      await setBal(companyId, PARENT, 4, 80, "EUR");
      await setBal(companyId, CHILD, 50, 3, "EUR");
      const kit = await KittingOrder.create({
        companyId,
        kitNumber: `T-KIT-COST4-${suffix}`,
        parentItemCode: PARENT,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 2,
        bomId: bom._id,
        status: "DRAFT",
        linesSnapshot,
      });
      await execKit(kit);
      const parentBal = await getBal(companyId, PARENT);
      const expected = (4 * 80 + 2 * 75) / 6;
      assert.ok(Math.abs(resolveBalanceUnitCost(parentBal) - expected) < 0.0001);
      assert.equal(parentBal?.onHandQty ?? parentBal?.quantity, 6);
    });

    await test("Cost Test 5 reverse de-kit restores original value basis", async () => {
      const parentArt = `${PARENT}-REV-DK`;
      const childArt = `${CHILD}-REV-DK`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const { snap } = await createPackBom(companyId, parentArt, childArt);
      await setBal(companyId, parentArt, 8, 75, "EUR");
      await setBal(companyId, childArt, 0, 0, "EUR");
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-COST5-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 8,
        bomId: (await BOM.findOne({ companyId, parentItemCode: parentArt }))._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      await execDeKit(dk);
      await execReverseDeKit(dk);
      const parentBal = await getBal(companyId, parentArt);
      const childBal = await getBal(companyId, childArt);
      assert.equal(parentBal?.onHandQty ?? parentBal?.quantity, 8);
      assert.equal(resolveBalanceUnitCost(parentBal), 75);
      assert.equal(childBal?.onHandQty ?? childBal?.quantity, 0);
    });

    await test("Cost Test 6 reverse kit restores original conversion value basis", async () => {
      const parentArt = `${PARENT}-REV-KIT`;
      const childArt = `${CHILD}-REV-KIT`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const { snap } = await createPackBom(companyId, parentArt, childArt);
      await setBal(companyId, parentArt, 0, 0, "EUR");
      await setBal(companyId, childArt, 50, 3, "EUR");
      const kit = await KittingOrder.create({
        companyId,
        kitNumber: `T-KIT-COST6-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 2,
        bomId: (await BOM.findOne({ companyId, parentItemCode: parentArt }))._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      await execKit(kit);
      await execReverseKit(kit);
      const parentBal = await getBal(companyId, parentArt);
      const childBal = await getBal(companyId, childArt);
      assert.equal(parentBal?.onHandQty ?? parentBal?.quantity, 0);
      assert.equal(childBal?.onHandQty ?? childBal?.quantity, 50);
      assert.equal(resolveBalanceUnitCost(childBal), 3);
    });

    await test("Customs Test 2 partial de-kit 3 SET from 8", async () => {
      const parentArt = `${PARENT}-C2`;
      const childArt = `${CHILD}-C2`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const { snap } = await createPackBom(companyId, parentArt, childArt);
      await setBal(companyId, parentArt, 8, 75, "EUR");
      await setBal(companyId, childArt, 0, 0, "EUR");
      const { item: srcItem } = await createCustomsLayer({
        companyId,
        article: parentArt,
        qty: 8,
        totalValue: 600,
        boeNumber: "TEST-BOE-2",
      });
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-CUST2-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 3,
        bomId: (await BOM.findOne({ companyId, parentItemCode: parentArt }))._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      await execDeKit(dk);
      const srcAfter = await CustomsLotItem.findById(srcItem._id).lean();
      const childCustoms = await CustomsLotItem.find({
        companyId,
        articleNumber: childArt,
        isConversionLayer: true,
      }).lean();
      assert.equal(srcAfter.qtyAvailable, 5);
      assert.equal(childCustoms[0].qtyAvailable, 75);
      assert.equal(childCustoms[0].totalValue, 225);
    });

    await test("Customs Test 3 FIFO two source lots de-kit 5 SET", async () => {
      const parentArt = `${PARENT}-C3`;
      const childArt = `${CHILD}-C3`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const { snap } = await createPackBom(companyId, parentArt, childArt);
      await setBal(companyId, parentArt, 10, 75, "EUR");
      await setBal(companyId, childArt, 0, 0, "EUR");
      const lotA = await createCustomsLayer({
        companyId,
        article: parentArt,
        qty: 4,
        totalValue: 300,
        boeNumber: "TEST-BOE-A",
        receivedDate: new Date("2026-01-01"),
      });
      const lotB = await createCustomsLayer({
        companyId,
        article: parentArt,
        qty: 6,
        totalValue: 450,
        boeNumber: "TEST-BOE-B",
        receivedDate: new Date("2026-02-01"),
      });
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-CUST3-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 5,
        bomId: (await BOM.findOne({ companyId, parentItemCode: parentArt }))._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      await execDeKit(dk);
      const srcA = await CustomsLotItem.findById(lotA.item._id).lean();
      const srcB = await CustomsLotItem.findById(lotB.item._id).lean();
      const childCustoms = await CustomsLotItem.find({
        companyId,
        articleNumber: childArt,
        isConversionLayer: true,
      }).lean();
      assert.equal(srcA.qtyAvailable, 0);
      assert.equal(srcB.qtyAvailable, 5);
      assert.equal(childCustoms.length, 2);
      const pcsTotal = childCustoms.reduce((s, r) => s + r.qtyAvailable, 0);
      assert.equal(pcsTotal, 125);
      const valTotal = childCustoms.reduce((s, r) => s + r.totalValue, 0);
      assert.equal(valTotal, 375);
    });

    await test("Customs Test 4 kit child back to parent reverses provenance", async () => {
      const parentArt = `${PARENT}-C4`;
      const childArt = `${CHILD}-C4`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const { snap } = await createPackBom(companyId, parentArt, childArt);
      await setBal(companyId, parentArt, 0, 0, "EUR");
      await setBal(companyId, childArt, 50, 3, "EUR");
      await createCustomsLayer({
        companyId,
        article: childArt,
        qty: 50,
        totalValue: 150,
        boeNumber: "TEST-BOE-4",
      });
      const kit = await KittingOrder.create({
        companyId,
        kitNumber: `T-KIT-CUST4-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 2,
        bomId: (await BOM.findOne({ companyId, parentItemCode: parentArt }))._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      await execKit(kit);
      const parentCustoms = await CustomsLotItem.find({
        companyId,
        articleNumber: parentArt,
        isConversionLayer: true,
      }).lean();
      const childSrc = await CustomsLotItem.find({
        companyId,
        articleNumber: childArt,
        isConversionLayer: { $ne: true },
      }).lean();
      assert.equal(parentCustoms[0].qtyAvailable, 2);
      assert.equal(parentCustoms[0].totalValue, 150);
      assert.equal(childSrc[0].qtyAvailable, 0);
    });

    await test("Customs Test 5 duplicate execute does not duplicate customs transfer", async () => {
      const parentArt = `${PARENT}-C5`;
      const childArt = `${CHILD}-C5`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const { snap } = await createPackBom(companyId, parentArt, childArt);
      await setBal(companyId, parentArt, 4, 75, "EUR");
      await setBal(companyId, childArt, 0, 0, "EUR");
      await createCustomsLayer({
        companyId,
        article: parentArt,
        qty: 4,
        totalValue: 300,
        boeNumber: "TEST-BOE-5",
      });
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-CUST5-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 4,
        bomId: (await BOM.findOne({ companyId, parentItemCode: parentArt }))._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      await execDeKit(dk);
      const childBefore = await CustomsLotItem.countDocuments({
        companyId,
        articleNumber: childArt,
        isConversionLayer: true,
      });
      const s = await mongoose.startSession();
      await s.withTransaction(async () => {
        await runDeKit(dk, "test", companyId, s);
      });
      s.endSession();
      const childAfter = await CustomsLotItem.countDocuments({
        companyId,
        articleNumber: childArt,
        isConversionLayer: true,
      });
      assert.equal(childBefore, childAfter);
      assert.equal(childBefore, 1);
    });

    await test("Customs Test 6 transaction abort when customs shortage leaves stock unchanged", async () => {
      const parentArt = `${PARENT}-C6`;
      const childArt = `${CHILD}-C6`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const { snap } = await createPackBom(companyId, parentArt, childArt);
      await setBal(companyId, parentArt, 8, 75, "EUR");
      await setBal(companyId, childArt, 0, 0, "EUR");
      await createCustomsLayer({
        companyId,
        article: parentArt,
        qty: 5,
        totalValue: 375,
        boeNumber: "TEST-BOE-6",
      });
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-CUST6-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 8,
        bomId: (await BOM.findOne({ companyId, parentItemCode: parentArt }))._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      let threw = false;
      try {
        await execDeKit(dk);
      } catch {
        threw = true;
      }
      assert.equal(threw, true);
      const parentBal = await getBal(companyId, parentArt);
      assert.equal(parentBal?.onHandQty ?? parentBal?.quantity, 8);
      const childCustoms = await CustomsLotItem.countDocuments({
        companyId,
        articleNumber: childArt,
        isConversionLayer: true,
      });
      assert.equal(childCustoms, 0);
    });

    await test("Customs Test 7 reverse de-kit restores customs provenance", async () => {
      const parentArt = `${PARENT}-C7`;
      const childArt = `${CHILD}-C7`;
      await ItemMaster.create([
        { companyId, article: parentArt, itemName: "P", uom: "SET", status: "Active" },
        { companyId, article: childArt, itemName: "C", uom: "PCS", status: "Active" },
      ]);
      const { snap } = await createPackBom(companyId, parentArt, childArt);
      await setBal(companyId, parentArt, 4, 75, "EUR");
      await setBal(companyId, childArt, 0, 0, "EUR");
      const { item: srcItem } = await createCustomsLayer({
        companyId,
        article: parentArt,
        qty: 4,
        totalValue: 300,
        boeNumber: "TEST-BOE-7",
      });
      const dk = await DeKittingOrder.create({
        companyId,
        dekitNumber: `T-DK-CUST7-${suffix}`,
        parentItemCode: parentArt,
        parentUom: "SET",
        kitType: "PACK_CONVERSION",
        bomKind: "PACK_CONVERSION",
        warehouse: WH,
        quantity: 4,
        bomId: (await BOM.findOne({ companyId, parentItemCode: parentArt }))._id,
        status: "DRAFT",
        linesSnapshot: snap,
      });
      await execDeKit(dk);
      await execReverseDeKit(dk);
      const srcAfter = await CustomsLotItem.findById(srcItem._id).lean();
      const childCustoms = await CustomsLotItem.find({
        companyId,
        articleNumber: childArt,
        isConversionLayer: true,
      }).lean();
      assert.equal(srcAfter.qtyAvailable, 4);
      assert.equal(srcAfter.totalValue, 300);
      assert.equal(childCustoms[0].qtyAvailable, 0);
    });
  } finally {
    await ItemMaster.deleteMany({ companyId, article: { $regex: suffix } });
    await BOM.deleteMany({ companyId, parentItemCode: { $regex: suffix } });
    await KittingOrder.deleteMany({ companyId, kitNumber: { $regex: suffix } });
    await DeKittingOrder.deleteMany({ companyId, dekitNumber: { $regex: suffix } });
    await StockBalance.deleteMany({ companyId, article: { $regex: suffix } });
    await StockLedger.deleteMany({ referenceNo: { $regex: suffix } });
    await CustomsLotItem.deleteMany({ companyId, articleNumber: { $regex: suffix } });
    await CustomsLot.deleteMany({ companyId, grnNo: { $regex: /^T-GRN/ } });
    await GRN.deleteMany({ companyId, grnNo: { $regex: /^T-GRN/ } });
    await mongoose.disconnect();
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
