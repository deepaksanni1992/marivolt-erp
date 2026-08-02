/**
 * S1 — Backfill Sales Invoice documentStatus / paymentStatus / dispatchStatus.
 *
 * Default: dry-run. Execute:
 *   node scripts/migrate-sales-invoice-states-s1.mjs --execute
 *
 * Evidence-driven. Ambiguous SalesDispatch-only invoices are reported and
 * left with conservative NOT_DISPATCHED dispatchStatus + document ISSUED
 * (never invent physical dispatch).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";
import { classifyInvoiceForMigration } from "../src/utils/salesInvoiceState.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const EXECUTE = process.argv.includes("--execute");
const POSTED_DISPATCH = ["POSTED", "PARTIALLY_DISPATCHED", "FULLY_DISPATCHED"];

function maskNo(no) {
  const s = String(no || "");
  if (s.length <= 4) return "***";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

async function receivedForInvoice(db, inv) {
  const receipts = db.collection("paymentreceipts");
  const rows = await receipts
    .find({
      companyId: inv.companyId,
      status: { $nin: ["CANCELLED", "REVERSED"] },
      "allocations.targetType": "SALES_INVOICE",
      "allocations.targetId": inv._id,
    })
    .project({ allocations: 1 })
    .toArray();
  let received = 0;
  for (const r of rows) {
    for (const a of r.allocations || []) {
      if (String(a.targetType) === "SALES_INVOICE" && String(a.targetId) === String(inv._id)) {
        received += Number(a.allocatedAmount) || 0;
      }
    }
  }
  return received;
}

async function storeDispatchQty(db, inv) {
  const storeDisp = db.collection("storedispatches");
  const rows = await storeDisp
    .find({ companyId: inv.companyId, salesInvoiceId: inv._id, status: { $in: POSTED_DISPATCH } })
    .toArray();
  let qty = 0;
  for (const d of rows) {
    for (const ln of d.lines || []) qty += Number(ln.dispatchQty) || 0;
  }
  return { qty, count: rows.length };
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  console.log("=== S1 Sales Invoice state migration ===");
  console.log("Mode:", EXECUTE ? "EXECUTE" : "DRY RUN");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const invoices = db.collection("salesinvoices");
  const salesDisp = db.collection("salesdispatches");

  const all = await invoices.find({}).toArray();
  const plan = [];
  const ambiguous = [];
  let wouldUpdate = 0;
  let unchanged = 0;

  for (const inv of all) {
    const received = await receivedForInvoice(db, inv);
    const { qty: storeQty, count: storeCount } = await storeDispatchQty(db, inv);
    const salesCount = await salesDisp.countDocuments({
      companyId: inv.companyId,
      linkedSalesInvoiceId: inv._id,
      status: { $ne: "CANCELLED" },
    });
    const invoiceQty = (inv.lines || []).reduce((s, ln) => s + (Number(ln.qty) || 0), 0);
    const classified = classifyInvoiceForMigration(inv, {
      receivedAmount: received,
      grandTotal: inv.grandTotal,
      invoiceQty,
      storeDispatchedQty: storeQty,
      hasSalesDispatchOnly: salesCount > 0 && storeCount === 0,
    });

    const next = {
      documentStatus: classified.documentStatus,
      paymentStatus: classified.paymentStatus,
      dispatchStatus: classified.dispatchStatus,
      status: classified.legacyStatusCompat,
    };

    const same =
      String(inv.documentStatus || "") === next.documentStatus &&
      String(inv.paymentStatus || "") === next.paymentStatus &&
      String(inv.dispatchStatus || "") === next.dispatchStatus;

    if (classified.ambiguous) {
      ambiguous.push({
        id: String(inv._id),
        no: maskNo(inv.invoiceNo),
        reason: classified.ambiguousReason,
        legacyStatus: inv.status,
        applied: next,
      });
    }

    if (same) {
      unchanged += 1;
      continue;
    }
    wouldUpdate += 1;
    plan.push({
      id: String(inv._id),
      no: maskNo(inv.invoiceNo),
      before: {
        status: inv.status,
        documentStatus: inv.documentStatus || null,
        paymentStatus: inv.paymentStatus || null,
        dispatchStatus: inv.dispatchStatus || null,
      },
      after: next,
      evidence: { received, storeQty, salesCount, invoiceQty },
    });

    if (EXECUTE) {
      await invoices.updateOne(
        { _id: inv._id },
        {
          $set: {
            documentStatus: next.documentStatus,
            paymentStatus: next.paymentStatus,
            dispatchStatus: next.dispatchStatus,
            status: next.status,
          },
        }
      );
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = {
    capturedAt: new Date().toISOString(),
    mode: EXECUTE ? "EXECUTE" : "DRY_RUN",
    totals: { invoices: all.length, wouldUpdate, unchanged, ambiguous: ambiguous.length },
    ambiguous,
    samples: plan.slice(0, 30),
  };
  const p = path.join(evidenceDir, `s1-si-state-migrate-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidencePath: p, ...evidence.totals }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
