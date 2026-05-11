/**
 * Sync Supplier and Customer master data between companies MAR (Marivolt) and OKE (Okeanos).
 *
 * Uses upsert on (companyId + supplierCode) for suppliers and (companyId + name) for customers
 * so re-running is safe and both tenants converge on the same master list.
 *
 * Usage (from marivolt-erp/backend, with MONGO_URI in .env):
 *   npm run sync:masters-mar-oke
 *
 * Optional env:
 *   SYNC_DIRECTION=mar-to-oke | oke-to-mar | both   (default: both)
 *
 * On legacy databases, run once first: npm run migrate:isolate-masters
 *
 * If you still see E11000 on supplierCode alone (without companyId in the index name), an old
 * global unique index may exist. Inspect with db.suppliers.getIndexes() in mongosh; the intended
 * index is compound { companyId: 1, supplierCode: 1 }. Drop any standalone supplierCode unique
 * index only after confirming with your DBA.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "../src/models/Company.js";
import Supplier from "../src/models/Supplier.js";
import Customer from "../src/models/Customer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

function supplierPayload(row, companyId) {
  const supplierName = String(row.supplierName || row.name || "").trim();
  const code = String(row.supplierCode || "").trim().toUpperCase();
  return {
    companyId,
    supplierCode: code,
    supplierName,
    name: supplierName,
    shortName: String(row.shortName || "").trim(),
    supplierType: String(row.supplierType || "LOCAL").trim().toUpperCase(),
    country: String(row.country || "").trim(),
    phone: String(row.phone || "").trim(),
    email: String(row.email || "").trim(),
    address: String(row.address || "").trim(),
    vatNo: String(row.vatNo || "").trim(),
    registrationNo: String(row.registrationNo || "").trim(),
    contactPerson: String(row.contactPerson || row.contactName || "").trim(),
    contactName: String(row.contactPerson || row.contactName || "").trim(),
    paymentTerms: String(row.paymentTerms || "").trim(),
    currency: String(row.currency || "USD").trim().toUpperCase(),
    bankDetails: Array.isArray(row.bankDetails) ? row.bankDetails : [],
    remarks: String(row.remarks || row.notes || "").trim(),
    notes: String(row.remarks || row.notes || "").trim(),
    activeStatus: row.activeStatus !== false,
    tradeLicenseNo: String(row.tradeLicenseNo || "").trim(),
    gstNo: String(row.gstNo || "").trim(),
    panNo: String(row.panNo || "").trim(),
    createdBy: String(row.createdBy || "sync:masters-mar-oke").trim(),
  };
}

function customerPayload(row, companyId) {
  const name = String(row.name || "").trim();
  const pt = row.paymentTerms === "ADVANCE" || row.paymentTerms === "CREDIT" ? row.paymentTerms : "CREDIT";
  return {
    companyId,
    name,
    contactName: String(row.contactName || "").trim(),
    phone: String(row.phone || "").trim(),
    email: String(row.email || "").trim(),
    address: String(row.address || "").trim(),
    paymentTerms: pt,
    notes: String(row.notes || "").trim(),
  };
}

async function syncSuppliers(from, to) {
  const rows = await Supplier.find({ companyId: from._id }).lean();
  let upserted = 0;
  for (const row of rows) {
    const code = String(row.supplierCode || "").trim().toUpperCase();
    const supplierName = String(row.supplierName || row.name || "").trim();
    if (!code || !supplierName) continue;
    const payload = supplierPayload(row, to._id);
    await Supplier.findOneAndUpdate(
      { companyId: to._id, supplierCode: code },
      { $set: payload },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    upserted += 1;
  }
  return upserted;
}

async function syncCustomers(from, to) {
  const rows = await Customer.find({ companyId: from._id }).lean();
  let upserted = 0;
  for (const row of rows) {
    const name = String(row.name || "").trim();
    if (!name) continue;
    const payload = customerPayload(row, to._id);
    await Customer.findOneAndUpdate(
      { companyId: to._id, name },
      { $set: payload },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );
    upserted += 1;
  }
  return upserted;
}

async function run() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in .env");
  }
  const direction = String(process.env.SYNC_DIRECTION || "both").trim().toLowerCase();
  if (!["mar-to-oke", "oke-to-mar", "both"].includes(direction)) {
    throw new Error(`Invalid SYNC_DIRECTION="${direction}". Use mar-to-oke, oke-to-mar, or both.`);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const mar = await Company.findOne({ code: "MAR" }).lean();
  const oke = await Company.findOneAndUpdate(
    { code: "OKE" },
    {
      $setOnInsert: {
        name: "Okeanos",
        code: "OKE",
        logoUrl: "",
        address: "",
        email: "",
        phone: "",
        currency: "USD",
        isActive: true,
      },
    },
    { upsert: true, new: true }
  ).lean();

  if (!mar?._id) {
    throw new Error('Company with code "MAR" not found. Run seed:companies if needed.');
  }
  if (!oke?._id) {
    throw new Error('Company with code "OKE" could not be loaded/created.');
  }

  let sMarOke = 0,
    cMarOke = 0,
    sOkeMar = 0,
    cOkeMar = 0;

  if (direction === "mar-to-oke" || direction === "both") {
    sMarOke = await syncSuppliers(mar, oke);
    cMarOke = await syncCustomers(mar, oke);
    console.log(`MAR → OKE: suppliers upserted ${sMarOke}, customers upserted ${cMarOke}`);
  }
  if (direction === "oke-to-mar" || direction === "both") {
    sOkeMar = await syncSuppliers(oke, mar);
    cOkeMar = await syncCustomers(oke, mar);
    console.log(`OKE → MAR: suppliers upserted ${sOkeMar}, customers upserted ${cOkeMar}`);
  }

  await mongoose.disconnect();
  console.log("Done.");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
