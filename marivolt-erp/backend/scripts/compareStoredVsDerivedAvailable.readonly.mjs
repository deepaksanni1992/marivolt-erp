/**
 * Read-only MAR comparison: stored availableQty vs canonical derived availability.
 * Does NOT write stock. Does NOT run rebuild/repair --apply.
 *
 * Usage: node scripts/compareStoredVsDerivedAvailable.readonly.mjs
 * Optional evidence JSON is written under scripts/repair-evidence/ and must stay untracked.
 */
import "../src/loadEnv.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import StockBalance from "../src/models/StockBalance.js";
import { deriveAvailableQty } from "../src/services/stockExpectedBuckets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EPS = 0.01;

await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });

const mar = await Company.findOne({ code: "MAR" }).lean();
if (!mar?._id) {
  console.error("Company MAR not found");
  await mongoose.disconnect();
  process.exit(1);
}

const rows = await StockBalance.find({ companyId: mar._id }).lean();
let storedNeg = 0;
let derivedNeg = 0;
let drift = 0;
let falseNegatives = 0; // derived healthy, stored negative (would miss true negatives if trusting stored... wait)
// false negative for analytics that trust stored: stored NOT negative but derived IS → miss counting negative
// false positive: stored IS negative but derived is healthy → wrongly count as negative

let falsePositivesFromStored = 0; // stored < 0, derived >= 0
let falseNegativesFromStored = 0; // stored >= 0, derived < 0

for (const r of rows) {
  const stored =
    r.availableQty != null
      ? Number(r.availableQty) || 0
      : deriveAvailableQty(r);
  const derived = deriveAvailableQty(r);
  if (stored < -EPS) storedNeg += 1;
  if (derived < -EPS) derivedNeg += 1;
  if (Math.abs(stored - derived) > EPS) drift += 1;
  if (stored < -EPS && derived >= -EPS) falsePositivesFromStored += 1;
  if (stored >= -EPS && derived < -EPS) falseNegativesFromStored += 1;
}

const summary = {
  companyCode: "MAR",
  companyId: String(mar._id),
  generatedAt: new Date().toISOString(),
  readOnly: true,
  totalStockBalanceRows: rows.length,
  rowsWhereStoredDiffersFromDerived: drift,
  rowsWhereStoredAvailableQtyNegative: storedNeg,
  rowsWhereDerivedAvailabilityNegative: derivedNeg,
  falsePositivesIfTrustingStored: falsePositivesFromStored,
  falseNegativesIfTrustingStored: falseNegativesFromStored,
  note:
    "falsePositives = stored negative while derived healthy; falseNegatives = stored healthy while derived negative",
};

console.log(JSON.stringify(summary, null, 2));

const outDir = path.join(__dirname, "repair-evidence");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(
  outDir,
  `stored-vs-derived-available-mar-${summary.generatedAt.replace(/[:.]/g, "-")}.json`
);
fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(`\nEvidence written (keep untracked): ${outPath}`);
console.log("CONFIRMATION: no stock data written; no rebuild/repair applied.");

await mongoose.disconnect();
