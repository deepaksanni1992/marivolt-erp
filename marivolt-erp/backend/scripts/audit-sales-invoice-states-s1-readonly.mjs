/**
 * S1 — Read-only Sales Invoice state classification (no writes).
 * node scripts/audit-sales-invoice-states-s1-readonly.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const POSTED_DISPATCH = ["POSTED", "PARTIALLY_DISPATCHED", "FULLY_DISPATCHED"];
const TOL = 0.0001;

function maskNo(no) {
  const s = String(no || "");
  if (s.length <= 4) return "***";
  return `${s.slice(0, 3)}***${s.slice(-2)}`;
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const invoices = db.collection("salesinvoices");
  const receipts = db.collection("paymentreceipts");
  const storeDisp = db.collection("storedispatches");
  const salesDisp = db.collection("salesdispatches");
  const ledgers = db.collection("stockledgers");

  const all = await invoices.find({}).toArray();
  const statusCounts = {};
  const paymentStatusCounts = {};
  let withReceipts = 0;
  let fullyPaidEvidence = 0;
  let partialPaidEvidence = 0;
  let unpaidEvidence = 0;
  let storeDispatched = 0;
  let salesDispatchOnly = 0;
  let bothDispatch = 0;
  let statusVsPaymentDisagree = 0;
  let statusVsStoreDispatchDisagree = 0;
  let cancelledWithReceipts = 0;
  let cancelledWithDispatch = 0;
  let ambiguous = [];
  const samples = {
    statusVsPaymentDisagree: [],
    statusVsStoreDispatchDisagree: [],
    salesDispatchOnly: [],
    bothDispatch: [],
  };

  for (const inv of all) {
    const st = String(inv.status || "").toUpperCase();
    statusCounts[st] = (statusCounts[st] || 0) + 1;
    const ps = String(inv.paymentStatus || "").toUpperCase();
    paymentStatusCounts[ps] = (paymentStatusCounts[ps] || 0) + 1;

    const total = Number(inv.grandTotal) || 0;
    const recRows = await receipts
      .find({
        companyId: inv.companyId,
        status: { $nin: ["CANCELLED", "REVERSED"] },
        "allocations.invoiceId": inv._id,
      })
      .project({ allocations: 1, status: 1 })
      .toArray();
    let received = 0;
    for (const r of recRows) {
      for (const a of r.allocations || []) {
        if (String(a.invoiceId) === String(inv._id)) received += Number(a.allocatedAmount) || 0;
      }
    }
    if (recRows.length) withReceipts += 1;
    let payEvidence = "UNPAID";
    if (received > TOL && received < total - TOL) payEvidence = "PARTIALLY_PAID";
    else if (total > 0 && received >= total - TOL) payEvidence = "PAID";
    if (payEvidence === "PAID") fullyPaidEvidence += 1;
    else if (payEvidence === "PARTIALLY_PAID") partialPaidEvidence += 1;
    else unpaidEvidence += 1;

    const storeRows = await storeDisp
      .find({ companyId: inv.companyId, salesInvoiceId: inv._id, status: { $in: POSTED_DISPATCH } })
      .project({ _id: 1, dispatchNo: 1, status: 1 })
      .toArray();
    const salesRows = await salesDisp
      .find({ companyId: inv.companyId, linkedSalesInvoiceId: inv._id, status: { $ne: "CANCELLED" } })
      .project({ _id: 1, dispatchNo: 1, status: 1 })
      .toArray();

    let storeQty = 0;
    if (storeRows.length) {
      storeDispatched += 1;
      const full = await storeDisp.find({ _id: { $in: storeRows.map((x) => x._id) } }).toArray();
      for (const d of full) {
        for (const ln of d.lines || []) storeQty += Number(ln.dispatchQty) || 0;
      }
    }
    if (salesRows.length && !storeRows.length) {
      salesDispatchOnly += 1;
      if (samples.salesDispatchOnly.length < 10) {
        samples.salesDispatchOnly.push({
          id: String(inv._id),
          no: maskNo(inv.invoiceNo),
          legacyStatus: st,
          salesDispatchNos: salesRows.map((x) => maskNo(x.dispatchNo)),
        });
      }
    }
    if (salesRows.length && storeRows.length) {
      bothDispatch += 1;
      if (samples.bothDispatch.length < 10) {
        samples.bothDispatch.push({ id: String(inv._id), no: maskNo(inv.invoiceNo) });
      }
    }

    // payment disagree: legacy status says PAID but evidence unpaid/partial, or vice versa
    const legacyPaid = st === "PAID" || ps === "PAID";
    const legacyPartial = st === "PARTIALLY_PAID" || ps === "PARTIAL" || ps === "PARTIALLY_PAID";
    if ((legacyPaid && payEvidence !== "PAID") || (payEvidence === "PAID" && !legacyPaid && st !== "DISPATCHED" && st !== "CANCELLED")) {
      statusVsPaymentDisagree += 1;
      if (samples.statusVsPaymentDisagree.length < 10) {
        samples.statusVsPaymentDisagree.push({
          id: String(inv._id),
          no: maskNo(inv.invoiceNo),
          legacyStatus: st,
          paymentStatus: ps,
          payEvidence,
          received,
          total,
        });
      }
    }
    if (legacyPartial && payEvidence === "UNPAID") {
      statusVsPaymentDisagree += 1;
    }

    const legacyDispatched = st === "DISPATCHED";
    const physicallyDispatched = storeQty > TOL;
    if (legacyDispatched !== physicallyDispatched) {
      statusVsStoreDispatchDisagree += 1;
      if (samples.statusVsStoreDispatchDisagree.length < 10) {
        samples.statusVsStoreDispatchDisagree.push({
          id: String(inv._id),
          no: maskNo(inv.invoiceNo),
          legacyStatus: st,
          storeQty,
          salesDispatchCount: salesRows.length,
        });
      }
    }

    if (st === "CANCELLED" && recRows.length) cancelledWithReceipts += 1;
    if (st === "CANCELLED" && (storeRows.length || salesRows.length)) cancelledWithDispatch += 1;

    if (salesRows.length && !storeRows.length && legacyDispatched) {
      ambiguous.push({
        id: String(inv._id),
        no: maskNo(inv.invoiceNo),
        reason: "SALES_DISPATCH_ONLY_LEGACY_DISPATCHED",
        legacyStatus: st,
      });
    }
  }

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = {
    capturedAt: new Date().toISOString(),
    phase: "S1-si-state-pre-audit",
    totalInvoices: all.length,
    statusCounts,
    paymentStatusCounts,
    evidence: {
      withReceipts,
      fullyPaidEvidence,
      partialPaidEvidence,
      unpaidEvidence,
      storeDispatched,
      salesDispatchOnly,
      bothDispatch,
      statusVsPaymentDisagree,
      statusVsStoreDispatchDisagree,
      cancelledWithReceipts,
      cancelledWithDispatch,
      ambiguousCount: ambiguous.length,
    },
    samples,
    ambiguous: ambiguous.slice(0, 50),
  };
  const p = path.join(evidenceDir, `s1-si-state-pre-audit-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidencePath: p, ...evidence.evidence, statusCounts, paymentStatusCounts }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
