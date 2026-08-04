/**
 * Read-only pre-post verification for MAR-STC-0001.
 * Does not mutate stock / does not post the conversion.
 *
 * Usage: node scripts/verifyMarStc0001.readonly.mjs
 */
import "../src/loadEnv.js";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import ArticleStockConversion from "../src/models/ArticleStockConversion.js";
import StockBalance from "../src/models/StockBalance.js";
import StockLedger from "../src/models/StockLedger.js";
import AuditLog from "../src/models/AuditLog.js";
import { buildArticleConversionEffectKey } from "../src/utils/articleConversionIdempotency.js";
import { deriveAvailableQty } from "../src/services/stockExpectedBuckets.js";

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });

const mar = await Company.findOne({ code: "MAR" }).lean();
if (!mar?._id) {
  console.error("MAR company not found");
  process.exit(1);
}

const conversion = await ArticleStockConversion.findOne({
  companyId: mar._id,
  conversionNo: "MAR-STC-0001",
}).lean();

if (!conversion) {
  console.error("MAR-STC-0001 not found");
  await mongoose.disconnect();
  process.exit(1);
}

const cid = mar._id;
const src = String(conversion.sourceArticle || "").toUpperCase();
const tgt = String(conversion.targetArticle || "").toUpperCase();
const wh = String(conversion.warehouse || "MAIN").toUpperCase();

const sourceBal = await StockBalance.findOne({
  companyId: cid,
  article: src,
  $or: [{ warehouse: wh }, { location: wh }],
}).lean();
const targetBal = await StockBalance.findOne({
  companyId: cid,
  article: tgt,
  $or: [{ warehouse: wh }, { location: wh }],
}).lean();

const outKey = buildArticleConversionEffectKey({
  companyId: cid,
  conversionId: conversion._id,
  movementType: "ARTICLE_CONVERSION_OUT",
  warehouse: wh,
  article: src,
});
const inKey = buildArticleConversionEffectKey({
  companyId: cid,
  conversionId: conversion._id,
  movementType: "ARTICLE_CONVERSION_IN",
  warehouse: wh,
  article: tgt,
});

const outLedgers = await StockLedger.find({
  companyId: cid,
  $or: [
    { effectKey: outKey },
    {
      movementType: "ARTICLE_CONVERSION_OUT",
      referenceNo: conversion.conversionNo,
      article: src,
    },
  ],
}).lean();
const inLedgers = await StockLedger.find({
  companyId: cid,
  $or: [
    { effectKey: inKey },
    {
      movementType: "ARTICLE_CONVERSION_IN",
      referenceNo: conversion.conversionNo,
      article: tgt,
    },
  ],
}).lean();

const postedAudits = await AuditLog.find({
  companyId: cid,
  entityType: "ARTICLE_STOCK_CONVERSION",
  documentNo: conversion.conversionNo,
  action: "POST",
}).lean();

const summary = {
  readOnly: true,
  conversionNo: conversion.conversionNo,
  status: conversion.status,
  sourceArticle: src,
  targetArticle: tgt,
  warehouse: wh,
  sourceQty: conversion.sourceQty,
  targetQty: conversion.targetQty,
  sourceOnHand: Number(sourceBal?.onHandQty ?? sourceBal?.quantity ?? 0),
  sourceDerivedAvailable: deriveAvailableQty(sourceBal || {}),
  targetOnHand: Number(targetBal?.onHandQty ?? targetBal?.quantity ?? 0),
  outLedgerCount: outLedgers.length,
  inLedgerCount: inLedgers.length,
  outEffectKeys: outLedgers.map((x) => x.effectKey).filter(Boolean),
  inEffectKeys: inLedgers.map((x) => x.effectKey).filter(Boolean),
  postedAuditCount: postedAudits.length,
  expectedOutEffectKey: outKey,
  expectedInEffectKey: inKey,
  safeToRetryPost:
    String(conversion.status).toUpperCase() === "DRAFT" &&
    outLedgers.length === 0 &&
    inLedgers.length === 0 &&
    postedAudits.length === 0,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.safeToRetryPost) {
  console.error("\nSTOP: partial effects detected or status not DRAFT — do not post without review.");
} else {
  console.log("\nOK: no partial stock/ledger/audit effects. Safe to click Post after code deploy.");
}

await mongoose.disconnect();
