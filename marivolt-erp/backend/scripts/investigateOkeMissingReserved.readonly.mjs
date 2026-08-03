/**
 * READ-ONLY investigation of OKE MISSING_RESERVED + MAR safe-candidate balances.
 * Does not mutate data.
 *
 * Run: node scripts/investigateOkeMissingReserved.readonly.mjs
 */
import "../src/loadEnv.js";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import StockBalance from "../src/models/StockBalance.js";
import OrderAllocation from "../src/models/OrderAllocation.js";
import StorePacking from "../src/models/StorePacking.js";
import StoreDispatch from "../src/models/StoreDispatch.js";
import StockLedger from "../src/models/StockLedger.js";

const OKE_ARTICLES = ["85130", "85510", "252563", "252566", "252564", "252565", "252562", "10000"];
const MAR_ARTICLES = ["8X0098", "85509", "700004.28"];

function n(v) {
  return Number(v) || 0;
}
function up(v) {
  return String(v ?? "").trim().toUpperCase();
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const mar = await Company.findOne({ code: "MAR" }).lean();
  const oke = await Company.findOne({ code: "OKE" }).lean();

  console.log("=== MAR balances (preview candidates) ===");
  for (const art of MAR_ARTICLES) {
    const b = await StockBalance.findOne({ companyId: mar._id, article: up(art) }).lean();
    const onHand = n(b?.onHandQty ?? b?.quantity);
    const reserved = Math.max(n(b?.allocatedQty), n(b?.reservedQty));
    const packed = n(b?.packedQty);
    const storedAvail = b?.availableQty != null ? n(b.availableQty) : onHand - reserved - packed;
    const unclamped = onHand - reserved - packed;
    console.log(
      JSON.stringify({
        article: art,
        onHand,
        reserved,
        packed,
        storedAvailable: storedAvail,
        unclampedDerivedAvailable: unclamped,
        availableMatchesUnclamped: Math.abs(storedAvail - unclamped) < 1e-6,
        intentionalNegativeAvailable: unclamped < 0,
        updatedAt: b?.updatedAt || null,
      })
    );
  }

  console.log("\n=== OKE MISSING_RESERVED investigation ===");
  const rows = [];
  for (const art of OKE_ARTICLES) {
    const b = await StockBalance.findOne({ companyId: oke._id, article: up(art) }).lean();
    const allocs = await OrderAllocation.find({
      companyId: oke._id,
      "lines.article": up(art),
      status: { $ne: "CANCELLED" },
    })
      .select(
        "allocationNo status warehouse stockReservedAt hasNegativeAllocation createdAt lines packingStatus invoiceStatus dispatchStatus"
      )
      .lean();
    const packs = await StorePacking.find({
      companyId: oke._id,
      "lines.article": up(art),
      status: { $nin: ["CANCELLED", "DRAFT"] },
    })
      .select("packingNo status allocationNo lines")
      .lean();
    const dispatches = await StoreDispatch.find({
      companyId: oke._id,
      "lines.article": up(art),
      status: { $nin: ["CANCELLED", "DRAFT"] },
    })
      .select("dispatchNo status packingNo lines")
      .limit(10)
      .lean();
    const ledgers = await StockLedger.find({
      companyId: oke._id,
      article: up(art),
      $or: [
        { movementType: { $in: ["ALLOCATION", "ALLOCATION_CANCEL", "PACKED", "UNPACKED"] } },
        {
          transactionType: {
            $in: ["SALES_ALLOCATION", "ORDER_ALLOCATION_CANCEL", "PACKED", "UNPACKED"],
          },
        },
      ],
    })
      .select("movementType transactionType referenceNo effectKey qtyIn qtyOut createdAt")
      .lean();

    for (const a of allocs) {
      for (const ln of a.lines || []) {
        if (up(ln.article) !== up(art)) continue;
        const lineQty = n(ln.qty);
        const linePacked = n(ln.packedQty);
        const expectedHold = Math.max(0, lineQty - linePacked);
        const storedReserved = Math.max(n(b?.allocatedQty), n(b?.reservedQty));
        const reserveFx = ledgers.filter((l) => {
          const mt = up(l.movementType || l.transactionType);
          return (
            (mt === "ALLOCATION" || mt === "SALES_ALLOCATION") &&
            up(l.referenceNo) === up(a.allocationNo)
          );
        });
        const cancelFx = ledgers.filter((l) => {
          const mt = up(l.movementType || l.transactionType);
          return (
            (mt === "ALLOCATION_CANCEL" || mt === "ORDER_ALLOCATION_CANCEL") &&
            up(l.referenceNo) === up(a.allocationNo)
          );
        });
        const packLines = packs.flatMap((p) =>
          (p.lines || [])
            .filter((x) => up(x.article) === up(art))
            .map((x) => ({
              packingNo: p.packingNo,
              status: p.status,
              packQty: n(x.packQty),
              dispatchedQty: n(x.dispatchedQty),
            }))
        );
        const totalDispatchedOnPack = packLines.reduce((s, x) => s + x.dispatchedQty, 0);
        const totalPackQty = packLines.reduce((s, x) => s + x.packQty, 0);

        let classification = "6. Needs manual business decision";
        let likelyRootCause = "";
        let recommendedAction = "Do not auto-increase reserved; investigate manually.";

        if (expectedHold <= 1e-6) {
          classification = "4. Closed/fully packed false-positive";
          likelyRootCause = "Line fully packed (qty − packedQty = 0); should not contribute to expected reserved.";
          recommendedAction = "Confirm audit formula; no stock repair.";
        } else if (!a.stockReservedAt && reserveFx.length === 0) {
          classification = "1. Allocation never reserved by design";
          likelyRootCause =
            "Active allocation document exists but no ALLOCATION ledger and stockReservedAt is null — reservation never posted.";
          recommendedAction =
            "Business decision: post reserve (if stock should be held) or cancel/close allocation without inventing reservedQty.";
        } else if (a.stockReservedAt && reserveFx.length === 0) {
          classification = "2. Missing reserve effect defect";
          likelyRootCause = "stockReservedAt set but no ALLOCATION ledger row found for this reference.";
          recommendedAction = "Investigate ledger gap; do not blindly bump reservedQty.";
        } else if (reserveFx.length > 0 && storedReserved < expectedHold && totalPackQty >= expectedHold) {
          classification = "3. Reservation already moved to packed";
          likelyRootCause = "Reserve effect exists; packing may have moved reserved→packed but balance reserved is low.";
          recommendedAction = "Reconcile packed bucket vs packing docs before any reserved bump.";
        } else if (String(a.allocationNo).includes("/") || !String(a.allocationNo).startsWith("OKE-ALLOC")) {
          classification = "5. Legacy malformed record";
          likelyRootCause = "Legacy allocation numbering / workflow without modern reserve posting.";
          recommendedAction = "Treat as legacy; manual business decision only.";
        } else if (reserveFx.length > 0 && cancelFx.length >= reserveFx.length) {
          classification = "2. Missing reserve effect defect";
          likelyRootCause = "Reserve was cancelled/released but allocation document still active.";
          recommendedAction = "Cancel or re-reserve document; do not auto-repair projection alone.";
        } else if (reserveFx.length === 0) {
          classification = "1. Allocation never reserved by design";
          likelyRootCause = "No reserve ledger for allocation reference.";
          recommendedAction = "Do not invent reservedQty; cancel or properly post allocation.";
        }

        const row = {
          company: "OKE",
          warehouse: a.warehouse || "MAIN",
          article: art,
          allocationNo: a.allocationNo,
          allocationStatus: a.status,
          allocationQty: lineQty,
          packedQty: linePacked,
          dispatchedQty: totalDispatchedOnPack,
          expectedRemainingReservation: expectedHold,
          storedReserved,
          reserveEffectExists: reserveFx.length > 0,
          effectKey: reserveFx.map((x) => x.effectKey || "(empty)").join("|") || null,
          stockReservedAt: a.stockReservedAt || null,
          negativeAllocation: Boolean(a.hasNegativeAllocation || ln.isNegativeAllocation),
          currentOnHand: n(b?.onHandQty ?? b?.quantity),
          currentPackedBucket: n(b?.packedQty),
          packingDocumentLinks: [...new Set(packLines.map((p) => p.packingNo))],
          dispatchLinks: dispatches.map((d) => d.dispatchNo),
          createdAt: a.createdAt,
          legacyOrNew: String(a.allocationNo).startsWith("OKE-ALLOC") ? "new" : "legacy",
          classification,
          likelyRootCause,
          recommendedAction,
          safeToRepair: false,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
    }
  }

  console.log("\n=== Classification tally ===");
  const tally = {};
  for (const r of rows) {
    tally[r.classification] = (tally[r.classification] || 0) + 1;
  }
  console.log(JSON.stringify(tally, null, 2));
  console.log("\nCONFIRMATION: no data mutated.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
