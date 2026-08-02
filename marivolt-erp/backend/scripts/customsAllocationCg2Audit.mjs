/**
 * CG2 production audit — READ ONLY. Does not repair data.
 *
 * Usage:
 *   node scripts/customsAllocationCg2Audit.mjs
 *   node scripts/customsAllocationCg2Audit.mjs --company=MAR
 *
 * Reports:
 *   - Lot counts / remaining qty
 *   - Negative remaining
 *   - Duplicate active customs invoices per sales invoice
 *   - Posted invoices without allocations
 *   - Allocation qty exceeding lot imported (snapshot vs lot)
 *   - Orphan allocations (missing lot item)
 */
import "dotenv/config";
import mongoose from "mongoose";
import CustomsLotItem from "../src/models/CustomsLotItem.js";
import CustomsInvoice from "../src/models/CustomsInvoice.js";
import Company from "../src/models/Company.js";

const MONGO = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/marivolt";
const companyArg = process.argv.find((a) => a.startsWith("--company="));
const companyCode = companyArg ? companyArg.split("=")[1].trim().toUpperCase() : "";

function num(v) {
  return Number(v) || 0;
}

async function main() {
  await mongoose.connect(MONGO);
  console.log("=== CG2 Customs Allocation Audit (READ ONLY) ===");
  console.log(`Mongo: ${MONGO.replace(/\/\/.*@/, "//***@")}`);

  let companyFilter = {};
  if (companyCode) {
    const co = await Company.findOne({ code: companyCode }).select("_id code name").lean();
    if (!co) {
      console.error(`Company ${companyCode} not found`);
      process.exit(2);
    }
    companyFilter = { companyId: co._id };
    console.log(`Company: ${co.code} (${co.name})`);
  } else {
    console.log("Company: ALL");
  }

  const items = await CustomsLotItem.find({ ...companyFilter, status: { $ne: "CANCELLED" } })
    .select("articleNumber boeNumber qtyImported qtyAvailable qtyConsumed customsLotRef companyId status")
    .lean();

  const lotCount = items.length;
  const remainingQty = items.reduce((s, i) => s + num(i.qtyAvailable), 0);
  const negativeRemaining = items.filter((i) => num(i.qtyAvailable) < -1e-6);
  const overConsumed = items.filter(
    (i) => num(i.qtyConsumed) - num(i.qtyImported) > 1e-6 && num(i.qtyAvailable) < -1e-6,
  );

  const invoices = await CustomsInvoice.find(companyFilter)
    .select("customsInvoiceNumber salesInvoiceId salesInvoiceNumber status items companyId")
    .lean();

  const activeBySi = new Map();
  const postedWithoutAlloc = [];
  const allocExceedImported = [];
  const orphanAllocations = [];

  const lotItemIds = new Set(items.map((i) => String(i._id)));
  // Also load cancelled lots for orphan check completeness
  const allItemIds = new Set(
    (
      await CustomsLotItem.find(companyFilter).select("_id qtyImported qtyAvailable").lean()
    ).map((i) => String(i._id)),
  );
  const itemQtyMap = new Map(
    (
      await CustomsLotItem.find(companyFilter).select("_id qtyImported qtyAvailable").lean()
    ).map((i) => [String(i._id), i]),
  );

  for (const inv of invoices) {
    const st = String(inv.status || "").toUpperCase();
    if (st !== "CANCELLED") {
      const key = String(inv.salesInvoiceId || "");
      if (key) {
        if (!activeBySi.has(key)) activeBySi.set(key, []);
        activeBySi.get(key).push(inv.customsInvoiceNumber);
      }
    }

    let allocCount = 0;
    for (const line of inv.items || []) {
      for (const a of line.allocations || []) {
        allocCount += 1;
        const id = a.customsLotItemId ? String(a.customsLotItemId) : "";
        if (st === "POSTED" && a.allocationMode !== "OVERRIDE_DUMMY") {
          if (!id || !allItemIds.has(id)) {
            orphanAllocations.push({
              customsInvoiceNumber: inv.customsInvoiceNumber,
              article: line.articleNumber,
              customsLotItemId: id || null,
              qty: a.qty,
            });
          } else {
            const lot = itemQtyMap.get(id);
            if (lot && num(a.qty) - num(lot.qtyImported) > 1e-6) {
              allocExceedImported.push({
                customsInvoiceNumber: inv.customsInvoiceNumber,
                article: line.articleNumber,
                allocQty: a.qty,
                qtyImported: lot.qtyImported,
              });
            }
          }
        }
      }
    }
    if (st === "POSTED" && allocCount === 0) {
      postedWithoutAlloc.push(inv.customsInvoiceNumber);
    }
  }

  const duplicateActive = [...activeBySi.entries()]
    .filter(([, nos]) => nos.length > 1)
    .map(([si, nos]) => ({ salesInvoiceId: si, invoices: nos }));

  const report = {
    auditedAt: new Date().toISOString(),
    companyCode: companyCode || "ALL",
    lots: {
      count: lotCount,
      remainingQtyTotal: remainingQty,
      negativeRemainingCount: negativeRemaining.length,
      negativeRemainingSample: negativeRemaining.slice(0, 20).map((i) => ({
        id: String(i._id),
        article: i.articleNumber,
        boe: i.boeNumber,
        qtyAvailable: i.qtyAvailable,
        customsLotRef: i.customsLotRef,
      })),
      overConsumedHintCount: overConsumed.length,
    },
    invoices: {
      total: invoices.length,
      duplicateActivePerSalesInvoice: duplicateActive.length,
      duplicateActiveSample: duplicateActive.slice(0, 20),
      postedWithoutAllocations: postedWithoutAlloc.length,
      postedWithoutAllocationsSample: postedWithoutAlloc.slice(0, 20),
      allocationExceedingLotImported: allocExceedImported.length,
      allocationExceedingSample: allocExceedImported.slice(0, 20),
      orphanAllocations: orphanAllocations.length,
      orphanSample: orphanAllocations.slice(0, 20),
    },
    note: "READ ONLY — no repairs applied. CG2 Phase audit.",
  };

  console.log(JSON.stringify(report, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
