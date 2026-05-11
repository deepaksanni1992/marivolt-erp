/**
 * Multi-tenant isolation for Supplier and Customer collections.
 *
 * Drops legacy MongoDB unique indexes that apply to a SINGLE field (e.g. name_1,
 * supplierCode_1) with no companyId. Those force Marivolt and Okeanos to share one
 * namespace and cause E11000 when the same supplier/customer name exists on both companies.
 *
 * Then syncIndexes() aligns the collection with Mongoose schema (company-scoped indexes only).
 *
 * Run from marivolt-erp/backend (MONGO_URI in .env):
 *   npm run migrate:isolate-masters
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Supplier from "../src/models/Supplier.js";
import Customer from "../src/models/Customer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

/** Single-field unique indexes on party masters break per-company isolation. */
const DANGEROUS_SINGLE_FIELD_KEYS = new Set(["name", "supplierName", "supplierCode", "email", "phone"]);

function shouldDropLegacyUnique(idx) {
  if (!idx || idx.name === "_id_") return false;
  if (!idx.unique) return false;
  const key = idx.key || {};
  const keys = Object.keys(key);
  if (keys.length !== 1) return false;
  return DANGEROUS_SINGLE_FIELD_KEYS.has(keys[0]);
}

async function fixModel(model, collectionLabel) {
  const coll = model.collection;
  const indexes = await coll.indexes();
  let dropped = 0;
  for (const idx of indexes) {
    if (!shouldDropLegacyUnique(idx)) continue;
    await coll.dropIndex(idx.name);
    console.log(`${collectionLabel}: dropped legacy unique index "${idx.name}" key=${JSON.stringify(idx.key)}`);
    dropped += 1;
  }
  if (dropped === 0) {
    console.log(`${collectionLabel}: no legacy single-field unique indexes found.`);
  }
  await model.syncIndexes();
  console.log(`${collectionLabel}: syncIndexes() completed.`);
}

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in .env");
  }
  await mongoose.connect(process.env.MONGO_URI);
  await fixModel(Supplier, "suppliers");
  await fixModel(Customer, "customers");
  await mongoose.disconnect();
  console.log("migrate:isolate-masters finished.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
