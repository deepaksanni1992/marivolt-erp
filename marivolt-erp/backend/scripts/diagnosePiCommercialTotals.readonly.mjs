/**
 * READ-ONLY diagnosis: QT/OA/PI commercial totals for the known mismatch case.
 * Does not mutate. Does not print secrets.
 *
 * Usage: node scripts/diagnosePiCommercialTotals.readonly.mjs
 */
import "../src/loadEnv.js";
import mongoose from "mongoose";
import Quotation from "../src/models/Quotation.js";
import OrderAcknowledgement from "../src/models/OrderAcknowledgement.js";
import ProformaInvoice from "../src/models/ProformaInvoice.js";
import { resolvePiPaymentRequest, piPayableTotal, roundMoney } from "../src/utils/piPaymentRequest.js";
import { computeSalesCommercialTotals, plainCommercialSource } from "../src/utils/salesCommercialTotals.js";
import { buildOaPiProgressSummary } from "../src/utils/oaLifecycle.js";

const QT_NO = "QT/260824.03";
const OA_NO = "OA/260824.02";
const PI_NO = "PI/260824.02";

function pickCommercial(doc = {}) {
  return {
    subTotal: doc.subTotal,
    packingCost: doc.packingCost,
    clearanceCost: doc.clearanceCost,
    discountType: doc.discountType,
    discountValue: doc.discountValue,
    discountTotal: doc.discountTotal,
    taxTotal: doc.taxTotal,
    grandTotal: doc.grandTotal,
    commercialGrandTotal: doc.commercialGrandTotal,
    requestedAmount: doc.requestedAmount,
    commercialBalanceAmount: doc.commercialBalanceAmount,
    piValueType: doc.piValueType,
    advancePercentage: doc.advancePercentage,
    status: doc.status,
    paymentStatus: doc.paymentStatus,
    totalReceivedAmount: doc.totalReceivedAmount,
    balanceAmount: doc.balanceAmount,
    currency: doc.currency,
    linkedOANo: doc.linkedOANo,
    linkedQuotationNo: doc.linkedQuotationNo,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGO_URI missing — cannot diagnose");
  process.exit(1);
}

await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

const qt = await Quotation.findOne({ quotationNo: QT_NO }).lean();
const oa = await OrderAcknowledgement.findOne({ oaNo: OA_NO }).lean();
const pi = await ProformaInvoice.findOne({ proformaNo: PI_NO }).lean();

const siblingPis = oa
  ? await ProformaInvoice.find({ linkedOAId: oa._id, status: { $ne: "CANCELLED" } })
      .select(
        "proformaNo status paymentStatus requestedAmount grandTotal commercialGrandTotal packingCost clearanceCost subTotal piValueType"
      )
      .lean()
  : [];

let issued = 0;
for (const row of siblingPis) {
  issued += piPayableTotal(resolvePiPaymentRequest(row));
}
issued = roundMoney(issued);

const report = {
  quotation: qt ? pickCommercial(qt) : null,
  oa: oa ? pickCommercial(oa) : null,
  pi: pi ? pickCommercial(pi) : null,
  piResolvedPayment: pi ? resolvePiPaymentRequest(pi) : null,
  recomputedFromPiLines: pi
    ? computeSalesCommercialTotals(pi.lines || [], plainCommercialSource(pi))
    : null,
  recomputedFromOa: oa
    ? computeSalesCommercialTotals(oa.lines || [], plainCommercialSource(oa))
    : null,
  siblingPis: siblingPis.map((r) => ({
    proformaNo: r.proformaNo,
    status: r.status,
    paymentStatus: r.paymentStatus,
    subTotal: r.subTotal,
    packingCost: r.packingCost,
    clearanceCost: r.clearanceCost,
    grandTotal: r.grandTotal,
    commercialGrandTotal: r.commercialGrandTotal,
    requestedAmount: r.requestedAmount,
    payable: piPayableTotal(resolvePiPaymentRequest(r)),
  })),
  oaProgress: oa
    ? buildOaPiProgressSummary(oa, {
        piIssuedRequestedTotal: issued,
        piRemainingEligibleAmount: roundMoney(Math.max(0, (Number(oa.grandTotal) || 0) - issued)),
        activePiCount: siblingPis.length,
      })
    : null,
  analysis: {
    expectedCommercial: 1406.08,
    qtMatches: qt ? roundMoney(qt.grandTotal) === 1406.08 : null,
    oaMatches: oa ? roundMoney(oa.grandTotal) === 1406.08 : null,
    piGrandTotal: pi ? roundMoney(pi.grandTotal) : null,
    piCommercialSnap: pi ? roundMoney(pi.commercialGrandTotal) : null,
    piRequested: pi ? roundMoney(pi.requestedAmount) : null,
    badPersistedRequested:
      pi != null && roundMoney(pi.requestedAmount) === 1331.08,
    badPersistedCommercialSnap:
      pi != null && roundMoney(pi.commercialGrandTotal) === 1331.08,
    costsMissingOnPi:
      pi != null &&
      roundMoney(pi.packingCost || 0) === 0 &&
      roundMoney(pi.clearanceCost || 0) === 0,
    repairableDraftUnpaid:
      pi != null &&
      String(pi.status).toUpperCase() === "DRAFT" &&
      String(pi.paymentStatus || "UNPAID").toUpperCase() === "UNPAID" &&
      (Number(pi.totalReceivedAmount) || 0) <= 0.005,
  },
};

console.log(JSON.stringify(report, null, 2));
await mongoose.disconnect();
