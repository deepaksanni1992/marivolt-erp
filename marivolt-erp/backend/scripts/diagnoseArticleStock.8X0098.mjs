/**
 * READ-ONLY diagnostic for Article 8X0098 / MAR-GRN-0010 stock inconsistency.
 * Does not write or mutate any data.
 *
 * Run: node scripts/diagnoseArticleStock.8X0098.mjs
 */
import "../src/loadEnv.js";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import GRN from "../src/models/GRN.js";
import StockLedger from "../src/models/StockLedger.js";
import StockBalance from "../src/models/StockBalance.js";
import OrderAllocation from "../src/models/OrderAllocation.js";
import StorePacking from "../src/models/StorePacking.js";
import CustomsLotItem from "../src/models/CustomsLotItem.js";
import CustomsLot from "../src/models/CustomsLot.js";
import CustomsMovement from "../src/models/CustomsMovement.js";

const ARTICLE = "8X0098";
const GRN_NO = "MAR-GRN-0010";
const WAREHOUSE = "MAIN";
const COMPANY_CODE = "MAR";

function n(v) {
  return Number(v) || 0;
}

function section(title) {
  console.log(`\n========== ${title} ==========`);
}

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing");
  }
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

  const company =
    (await Company.findOne({ code: COMPANY_CODE }).lean()) ||
    (await Company.findOne({ companyCode: COMPANY_CODE }).lean()) ||
    (await Company.findOne({ shortCode: COMPANY_CODE }).lean());

  if (!company?._id) {
    // Fallback: find GRN by number and take its companyId
    const grnProbe = await GRN.findOne({ grnNo: GRN_NO }).lean();
    if (!grnProbe) throw new Error(`Company ${COMPANY_CODE} and GRN ${GRN_NO} not found`);
    console.log("Company document not found by code; using companyId from GRN:", String(grnProbe.companyId));
  }

  const companyId = company?._id || (await GRN.findOne({ grnNo: GRN_NO }).lean())?.companyId;
  console.log("Diagnostic params:", {
    article: ARTICLE,
    grnNo: GRN_NO,
    warehouse: WAREHOUSE,
    companyId: String(companyId),
    companyCode: company?.code || company?.companyCode || COMPANY_CODE,
  });

  // A. GRN
  section("A. GRN");
  const grn = await GRN.findOne({ companyId, grnNo: GRN_NO }).lean();
  if (!grn) {
    console.log("GRN NOT FOUND");
  } else {
    const lines = (grn.items || grn.lines || []).filter(
      (ln) => String(ln.article || "").toUpperCase() === ARTICLE
    );
    console.log(
      JSON.stringify(
        {
          grnNo: grn.grnNo,
          status: grn.status,
          postedAt: grn.postedAt || grn.receivedAt || null,
          grnDate: grn.grnDate,
          warehouse: grn.warehouse || grn.location || null,
          lineCountMatchingArticle: lines.length,
          lines: lines.map((ln) => ({
            lineId: ln._id,
            article: ln.article,
            receivedQty: ln.receivedQty ?? ln.acceptedQty ?? ln.qty,
            acceptedQty: ln.acceptedQty,
            location: ln.location || ln.putawayLocation || null,
          })),
          hasCustomsCapture: Boolean(grn.customsCapture),
        },
        null,
        2
      )
    );
  }

  // B. Stock Ledger
  section("B. Stock Ledger (article)");
  const ledger = await StockLedger.find({
    companyId,
    article: ARTICLE,
  })
    .sort({ transactionDate: 1, createdAt: 1 })
    .lean();
  console.log(`Ledger rows: ${ledger.length}`);
  let run = 0;
  for (const row of ledger) {
    const qin = n(row.qtyIn);
    const qout = n(row.qtyOut);
    run += qin - qout;
    console.log(
      JSON.stringify({
        transactionType: row.transactionType,
        movementType: row.movementType,
        qtyIn: qin,
        qtyOut: qout,
        runningBalanceDerived: run,
        onHandAfter: row.onHandAfter,
        allocatedAfter: row.allocatedAfter,
        packedAfter: row.packedAfter,
        availableAfter: row.availableAfter,
        referenceType: row.referenceType,
        referenceNo: row.referenceNo,
        sourceDocumentType: row.sourceDocumentType,
        sourceDocumentId: row.sourceDocumentId,
        effectKey: row.effectKey || "",
        warehouse: row.warehouse || row.location,
        location: row.location,
        createdAt: row.createdAt,
        reversedFromLedgerId: row.reversedFromLedgerId || null,
      })
    );
  }
  const grnLedgerHits = ledger.filter(
    (r) =>
      String(r.referenceNo || "").toUpperCase() === GRN_NO ||
      String(r.referenceType || "").toUpperCase().includes("GRN")
  );
  console.log(`\nLedger rows referencing ${GRN_NO} or GRN type: ${grnLedgerHits.length}`);
  console.log(`Derived net ledger qty (sum in - out): ${run}`);

  // C. StockBalance
  section("C. StockBalance");
  const balances = await StockBalance.find({
    companyId,
    $or: [{ article: ARTICLE }, { itemCode: ARTICLE }],
  }).lean();
  console.log(`Balance rows: ${balances.length}`);
  for (const b of balances) {
    const onHand = n(b.onHandQty ?? b.quantity);
    const reserved = Math.max(n(b.allocatedQty), n(b.reservedQty));
    const packed = n(b.packedQty);
    console.log(
      JSON.stringify(
        {
          _id: b._id,
          article: b.article,
          itemCode: b.itemCode,
          location: b.location,
          warehouse: b.warehouse,
          batchNo: b.batchNo,
          serialNo: b.serialNo,
          onHandQty: b.onHandQty,
          quantity: b.quantity,
          allocatedQty: b.allocatedQty,
          reservedQty: b.reservedQty,
          packedQty: b.packedQty,
          dispatchedQty: b.dispatchedQty,
          availableQty_stored: b.availableQty,
          availableQty_derived: onHand - reserved - packed,
          updatedAt: b.updatedAt,
        },
        null,
        2
      )
    );
  }

  // D. Allocations
  section("D. Order Allocations");
  const allocs = await OrderAllocation.find({
    companyId,
    "lines.article": ARTICLE,
  })
    .sort({ createdAt: -1 })
    .lean();
  console.log(`Allocation docs touching article: ${allocs.length}`);
  for (const a of allocs) {
    for (const ln of a.lines || []) {
      if (String(ln.article || "").toUpperCase() !== ARTICLE) continue;
      console.log(
        JSON.stringify({
          allocationNo: a.allocationNo,
          status: a.status,
          warehouse: a.warehouse,
          customerName: a.customerName,
          lineQty: ln.qty,
          linePackedQty: ln.packedQty,
          remainingClaim: Math.max(0, n(ln.qty) - n(ln.packedQty)),
          isNegativeAllocation: ln.isNegativeAllocation,
          cancelled: String(a.status).toUpperCase() === "CANCELLED",
        })
      );
    }
  }
  const activeAllocs = allocs.filter((a) => String(a.status).toUpperCase() !== "CANCELLED");
  console.log(`Non-cancelled allocations: ${activeAllocs.length}`);

  // E. Packing
  section("E. Store Packing");
  const packings = await StorePacking.find({
    companyId,
    "lines.article": ARTICLE,
  })
    .sort({ createdAt: -1 })
    .lean();
  console.log(`Packing docs touching article: ${packings.length}`);
  for (const p of packings) {
    const lineQty = (p.lines || [])
      .filter((ln) => String(ln.article || "").toUpperCase() === ARTICLE)
      .reduce((s, ln) => s + n(ln.packQty), 0);
    console.log(
      JSON.stringify({
        packingNo: p.packingNo,
        status: p.status,
        warehouse: p.warehouse,
        packQtyForArticle: lineQty,
        allocationNo: p.allocationNo,
        postedAt: p.postedAt,
        cancelledAt: p.cancelledAt,
      })
    );
  }

  // F. Customs
  section("F. Customs");
  const customsItems = await CustomsLotItem.find({
    companyId,
    articleNumber: ARTICLE,
  }).lean();
  console.log(`CustomsLotItem rows: ${customsItems.length}`);
  for (const it of customsItems) {
    const lot = it.customsLotId ? await CustomsLot.findById(it.customsLotId).lean() : null;
    console.log(
      JSON.stringify({
        itemId: it._id,
        customsLotRef: it.customsLotRef || lot?.customsLotRef,
        grnNo: it.grnNo,
        qtyImported: it.qtyImported,
        qtyAvailable: it.qtyAvailable,
        qtyConsumed: it.qtyConsumed,
        status: it.status,
        boeNumber: it.boeNumber || lot?.boeNumber,
        blNumber: it.blNumber || lot?.blNumber,
        isConversionLayer: it.isConversionLayer,
        originalReceivedArticle: it.originalReceivedArticle,
        conversionNo: it.conversionNo,
      })
    );
  }
  const customsMoves = await CustomsMovement.find({
    companyId,
    articleNumber: ARTICLE,
  })
    .sort({ movementDate: 1 })
    .lean();
  console.log(`CustomsMovement rows: ${customsMoves.length}`);
  for (const mv of customsMoves) {
    console.log(
      JSON.stringify({
        movementType: mv.movementType,
        qty: mv.qty,
        referenceType: mv.referenceType,
        referenceNumber: mv.referenceNumber,
        movementDate: mv.movementDate,
      })
    );
  }

  // G. Traceability calc (as coded)
  section("G. Article Traceability calculation (as coded today)");
  let erpStockQty_asCoded = 0;
  for (const b of balances) {
    const onHand = n(b.onHandQty ?? b.quantity);
    const allocated = Math.max(n(b.allocatedQty), n(b.reservedQty));
    const packed = n(b.packedQty);
    erpStockQty_asCoded += onHand - allocated - packed;
  }
  const customsStockQty = customsItems
    .filter((it) => String(it.status).toUpperCase() !== "CANCELLED")
    .reduce((s, it) => s + n(it.qtyAvailable), 0);
  let erpOnHand = 0;
  let erpReserved = 0;
  let erpPacked = 0;
  for (const b of balances.filter((x) => String(x.location || x.warehouse || "MAIN").toUpperCase() === WAREHOUSE || !WAREHOUSE)) {
    const onHand = n(b.onHandQty ?? b.quantity);
    const reserved = Math.max(n(b.allocatedQty), n(b.reservedQty));
    const packed = n(b.packedQty);
    erpOnHand += onHand;
    erpReserved += reserved;
    erpPacked += packed;
  }
  // Prefer MAIN warehouse rows if any
  const mainBalances = balances.filter(
    (x) => String(x.location || x.warehouse || "").toUpperCase() === WAREHOUSE
  );
  if (mainBalances.length) {
    erpOnHand = 0;
    erpReserved = 0;
    erpPacked = 0;
    for (const b of mainBalances) {
      erpOnHand += n(b.onHandQty ?? b.quantity);
      erpReserved += Math.max(n(b.allocatedQty), n(b.reservedQty));
      erpPacked += n(b.packedQty);
    }
  }
  console.log(
    JSON.stringify(
      {
        erpStockQty_asCoded_IS_FREE_AVAILABLE: erpStockQty_asCoded,
        correct_erpOnHand: erpOnHand,
        correct_reserved: erpReserved,
        correct_packed: erpPacked,
        correct_freeAvailable: Math.max(0, erpOnHand - erpReserved - erpPacked),
        customsStockQty,
        ledgerNetQty: run,
        hasGrnErpLedgerInbound: grnLedgerHits.some((r) => n(r.qtyIn) > 0),
        activeAllocationCount: activeAllocs.length,
        packingDocCount: packings.length,
      },
      null,
      2
    )
  );

  // Root-cause classification
  section("ROOT-CAUSE CLASSIFICATION");
  const hasGrnInbound = grnLedgerHits.some((r) => n(r.qtyIn) > 0 || String(r.movementType || "").includes("GRN"));
  const anyGrnRef = ledger.some((r) => String(r.referenceNo || "").toUpperCase() === GRN_NO && n(r.qtyIn) > 0);
  const caseA = !anyGrnRef && customsStockQty > 0;
  const caseB = run >= 9 - 1e-6 && erpOnHand < 1e-6;
  const caseC =
    erpOnHand >= 9 - 1e-6 &&
    (erpReserved > 1e-6 || erpPacked > 1e-6) &&
    activeAllocs.length === 0 &&
    packings.filter((p) => !["CANCELLED", "DRAFT"].includes(String(p.status).toUpperCase())).length === 0;
  const caseD = erpOnHand >= 9 - 1e-6 && erpStockQty_asCoded < 1e-6; // UI shows free as ERP stock
  const caseE = activeAllocs.length > 0 || packings.some((p) => ["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED"].includes(String(p.status).toUpperCase()));

  console.log(
    JSON.stringify(
      {
        CASE_A_missing_erp_grn_ledger: caseA,
        CASE_B_ledger_vs_balance_mismatch: caseB,
        CASE_C_orphaned_reserved_or_packed: caseC,
        CASE_D_traceability_labels_free_as_erp_stock: caseD,
        CASE_E_valid_active_allocation_or_packing: caseE,
        notes: [
          "CASE D is confirmed in source: computeErpStockQty = onHand - reserved - packed, UI label 'ERP Stock Qty'.",
          "Multiple cases can be true together (e.g. C + D).",
        ],
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("DIAGNOSTIC FAILED:", err.message);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
