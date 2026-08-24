/**
 * Controlled repair for PIs whose commercial/payment snapshot used line subtotal
 * instead of commercial grand total (packing/clearance dropped on OA→PI convert).
 *
 * Default: DRY-RUN only. Pass --apply to mutate (DRAFT + UNPAID only).
 *
 * Usage:
 *   node scripts/repairPiCommercialTotals.mjs
 *   node scripts/repairPiCommercialTotals.mjs --apply
 *   node scripts/repairPiCommercialTotals.mjs --proformaNo=PI/260824.02
 *   node scripts/repairPiCommercialTotals.mjs --proformaNo=PI/260824.02 --apply
 */
import "../src/loadEnv.js";
import mongoose from "mongoose";
import ProformaInvoice from "../src/models/ProformaInvoice.js";
import OrderAcknowledgement from "../src/models/OrderAcknowledgement.js";
import Quotation from "../src/models/Quotation.js";
import {
  buildValidatedPiPaymentRequest,
  resolvePiPaymentRequest,
  roundMoney,
} from "../src/utils/piPaymentRequest.js";
import {
  computeSalesCommercialTotals,
  plainCommercialSource,
} from "../src/utils/salesCommercialTotals.js";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const onlyNo = (args.find((a) => a.startsWith("--proformaNo=")) || "").split("=")[1] || "";

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGO_URI missing");
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

const filter = { status: { $ne: "CANCELLED" } };
if (onlyNo) filter.proformaNo = onlyNo;

const pis = await ProformaInvoice.find(filter).limit(onlyNo ? 5 : 500).lean();
const candidates = [];

for (const pi of pis) {
  let packing = Math.max(0, Number(pi.packingCost) || 0);
  let clearance = Math.max(0, Number(pi.clearanceCost) || 0);
  let discountType = pi.discountType;
  let discountValue = pi.discountValue;
  let discountTotal = pi.discountTotal;
  let taxTotal = pi.taxTotal;

  if (pi.linkedQuotationId && (packing <= 0 || clearance <= 0)) {
    const q = await Quotation.findById(pi.linkedQuotationId)
      .select("packingCost clearanceCost discountType discountValue discountTotal taxTotal")
      .lean();
    if (q) {
      if (packing <= 0) packing = Math.max(0, Number(q.packingCost) || 0);
      if (clearance <= 0) clearance = Math.max(0, Number(q.clearanceCost) || 0);
      if (!(Number(discountTotal) > 0)) {
        discountType = q.discountType || discountType;
        discountValue = q.discountValue;
        discountTotal = q.discountTotal;
      }
      if (!(Number(taxTotal) > 0)) taxTotal = q.taxTotal;
    }
  }

  if (pi.linkedOAId && (packing <= 0 || clearance <= 0)) {
    const oa = await OrderAcknowledgement.findById(pi.linkedOAId)
      .select("packingCost clearanceCost discountType discountValue discountTotal taxTotal grandTotal")
      .lean();
    if (oa) {
      if (packing <= 0) packing = Math.max(0, Number(oa.packingCost) || 0);
      if (clearance <= 0) clearance = Math.max(0, Number(oa.clearanceCost) || 0);
    }
  }

  const totals = computeSalesCommercialTotals(pi.lines || [], {
    ...plainCommercialSource(pi),
    packingCost: packing,
    clearanceCost: clearance,
    discountType,
    discountValue,
    discountTotal,
    taxTotal,
  });

  const commercial = roundMoney(totals.grandTotal);
  const snap = roundMoney(Number(pi.commercialGrandTotal ?? pi.grandTotal) || 0);
  const requested = roundMoney(Number(pi.requestedAmount ?? pi.grandTotal) || 0);
  const status = String(pi.status || "").toUpperCase();
  const paymentStatus = String(pi.paymentStatus || "UNPAID").toUpperCase();
  const received = Number(pi.totalReceivedAmount) || 0;

  const costsWereMissing =
    (Number(pi.packingCost) || 0) + 0.0001 < packing ||
    (Number(pi.clearanceCost) || 0) + 0.0001 < clearance;
  const snapLow = commercial > snap + 0.005;
  const requestedLowVsCommercial =
    String(pi.piValueType || "FULL").toUpperCase() === "FULL" &&
    commercial > requested + 0.005;

  if (!costsWereMissing && !snapLow && !requestedLowVsCommercial) continue;
  if (commercial <= 0) continue;

  const safe =
    status === "DRAFT" && paymentStatus === "UNPAID" && received <= 0.005;

  let afterPayment = null;
  let refuseReason = null;
  if (!safe) {
    refuseReason = `not DRAFT/UNPAID (status=${status}, paymentStatus=${paymentStatus}, received=${received})`;
  } else {
    try {
      afterPayment = buildValidatedPiPaymentRequest(commercial, {
        piValueType: pi.piValueType || "FULL",
        advancePercentage: pi.advancePercentage,
        requestedAmount: pi.requestedAmount,
        advanceRemarks: pi.advanceRemarks,
      });
    } catch (e) {
      refuseReason = e.message;
    }
  }

  candidates.push({
    proformaNo: pi.proformaNo,
    _id: String(pi._id),
    safe,
    refuseReason,
    before: {
      subTotal: pi.subTotal,
      packingCost: pi.packingCost,
      clearanceCost: pi.clearanceCost,
      grandTotal: pi.grandTotal,
      commercialGrandTotal: pi.commercialGrandTotal,
      requestedAmount: pi.requestedAmount,
      piValueType: pi.piValueType,
      status,
      paymentStatus,
      resolved: resolvePiPaymentRequest(pi),
    },
    after: afterPayment
      ? {
          ...totals,
          ...afterPayment,
        }
      : null,
  });
}

console.log(
  JSON.stringify(
    {
      mode: APPLY ? "APPLY" : "DRY-RUN",
      scanned: pis.length,
      candidates: candidates.length,
      rows: candidates,
    },
    null,
    2
  )
);

if (APPLY) {
  let updated = 0;
  for (const row of candidates) {
    if (!row.safe || !row.after) {
      console.log(`SKIP ${row.proformaNo}: ${row.refuseReason || "no after"}`);
      continue;
    }
    await ProformaInvoice.updateOne(
      { _id: row._id },
      {
        $set: {
          packingCost: row.after.packingCost,
          clearanceCost: row.after.clearanceCost,
          discountType: row.after.discountType,
          discountValue: row.after.discountValue,
          discountTotal: row.after.discountTotal,
          taxTotal: row.after.taxTotal,
          subTotal: row.after.subTotal,
          grandTotal: row.after.grandTotal,
          commercialGrandTotal: row.after.commercialGrandTotal,
          requestedAmount: row.after.requestedAmount,
          commercialBalanceAmount: row.after.commercialBalanceAmount,
          piValueType: row.after.piValueType,
          advancePercentage: row.after.advancePercentage,
          updatedBy: "repairPiCommercialTotals",
        },
      }
    );
    updated += 1;
    console.log(`UPDATED ${row.proformaNo}`);
  }
  console.log(`Applied updates: ${updated}`);
} else {
  console.log("Dry-run only. Re-run with --apply to mutate safe DRAFT/UNPAID rows.");
}

await mongoose.disconnect();
