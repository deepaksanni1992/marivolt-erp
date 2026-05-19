/**
 * Fix PurchaseOrder indexes: drop legacy global poNo_1 / poNumber_1 unique indexes
 * and ensure compound { companyId, poNo } / { companyId, poNumber } uniques only.
 *
 * Run from marivolt-erp/backend:
 *   npm run migrate:po-number-indexes
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import PurchaseOrder from "../src/models/PurchaseOrder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

function isLegacyGlobalPoIndex(idx) {
  if (!idx?.unique || idx.name === "_id_") return false;
  const key = idx.key || {};
  const keys = Object.keys(key);
  if (keys.length !== 1) return false;
  return keys[0] === "poNo" || keys[0] === "poNumber";
}

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in .env");
  }
  await mongoose.connect(process.env.MONGO_URI);

  const coll = PurchaseOrder.collection;
  const indexes = await coll.indexes();
  let dropped = 0;
  for (const idx of indexes) {
    if (!isLegacyGlobalPoIndex(idx)) continue;
    await coll.dropIndex(idx.name);
    console.log(`purchaseorders: dropped legacy unique index "${idx.name}" key=${JSON.stringify(idx.key)}`);
    dropped += 1;
  }
  if (dropped === 0) {
    console.log("purchaseorders: no legacy single-field poNo/poNumber unique indexes found.");
  }

  await PurchaseOrder.syncIndexes();
  console.log("purchaseorders: syncIndexes() completed.");
  const after = await coll.indexes();
  console.log(
    "purchaseorders indexes:",
    after.map((i) => `${i.name} ${JSON.stringify(i.key)}${i.unique ? " unique" : ""}`).join("\n  "),
  );

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
