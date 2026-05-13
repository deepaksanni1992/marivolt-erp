import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "../src/models/Company.js";
import Counter from "../src/models/Counter.js";
import Quotation from "../src/models/Quotation.js";
import OrderAcknowledgement from "../src/models/OrderAcknowledgement.js";
import ProformaInvoice from "../src/models/ProformaInvoice.js";
import OrderAllocation from "../src/models/OrderAllocation.js";
import StorePacking from "../src/models/StorePacking.js";
import SalesInvoice from "../src/models/SalesInvoice.js";
import StoreDispatch from "../src/models/StoreDispatch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI && !process.env.MONGODB_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const POSTED_PACKING_STATUSES = ["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED"];
const POSTED_DISPATCH_STATUSES = ["POSTED", "PARTIALLY_DISPATCHED", "FULLY_DISPATCHED", "POSTED"];

const DOCS = [
  { label: "quotation", key: "quotation", prefix: "QTN", model: Quotation, field: "quotationNo", mirrors: ["quotationNumber"] },
  { label: "oa", key: "oa", prefix: "OA", model: OrderAcknowledgement, field: "oaNo" },
  { label: "pi", key: "pi", prefix: "PI", model: ProformaInvoice, field: "proformaNo" },
  { label: "allocation", key: "allocation", prefix: "ALLOC", model: OrderAllocation, field: "allocationNo" },
  { label: "packing", key: "packing", prefix: "PK", model: StorePacking, field: "packingNo" },
  { label: "salesInvoice", key: "salesInvoice", prefix: "SI", model: SalesInvoice, field: "invoiceNo", mirrors: ["invoiceNumber"] },
  { label: "dispatch", key: "dispatch", prefix: "DSP", model: StoreDispatch, field: "dispatchNo" },
];

function normalizeCompanyCode(value = "") {
  const raw = String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (raw === "OKEANOS" || raw === "OKE") return "OKE";
  if (raw === "MARIVOLT" || raw === "MAR") return "MAR";
  return raw.slice(0, 3) || "CMP";
}

function numberRegex(companyCode, prefix) {
  return new RegExp(`^${companyCode}-${prefix}-(\\d+)$`, "i");
}

function parseSeq(value, companyCode, prefix) {
  const match = String(value || "").trim().match(numberRegex(companyCode, prefix));
  return match ? Number(match[1]) || 0 : 0;
}

async function dropUnsafeUniqueIndex(collectionName, field, summary) {
  const collection = mongoose.connection.db.collection(collectionName);
  const indexes = await collection.indexes();
  for (const idx of indexes) {
    const keys = Object.keys(idx.key || {});
    if (idx.unique && keys.length === 1 && keys[0] === field) {
      await collection.dropIndex(idx.name);
      summary.indexesDropped += 1;
    }
  }
}

async function ensureCompanyIndex(collectionName, field, summary) {
  const collection = mongoose.connection.db.collection(collectionName);
  await collection.createIndex({ companyId: 1, [field]: 1 }, { unique: true });
  summary.indexesEnsured += 1;
}

async function nextNumberForCompany(companyId, code, doc, currentMaxByKey) {
  const counterKey = `${doc.key}:${code}`;
  const nextSeq = (currentMaxByKey.get(counterKey) || 0) + 1;
  currentMaxByKey.set(counterKey, nextSeq);
  await Counter.findOneAndUpdate(
    { companyId, key: counterKey },
    { $max: { seq: nextSeq }, $setOnInsert: { companyId, key: counterKey } },
    { upsert: true, new: true }
  );
  return `${code}-${doc.prefix}-${String(nextSeq).padStart(4, "0")}`;
}

async function repairNumbersForCompany(company, summary) {
  const companyId = company._id;
  const code = normalizeCompanyCode(company.code || company.shortName || company.name);
  const maxByKey = new Map();

  for (const doc of DOCS) {
    const rows = await doc.model.find({ companyId }).select(`${doc.field} ${(doc.mirrors || []).join(" ")}`).lean();
    let maxSeq = 0;
    for (const row of rows) {
      const values = [row[doc.field], ...(doc.mirrors || []).map((field) => row[field])];
      for (const value of values) maxSeq = Math.max(maxSeq, parseSeq(value, code, doc.prefix));
    }
    maxByKey.set(`${doc.key}:${code}`, maxSeq);
    await Counter.findOneAndUpdate(
      { companyId, key: `${doc.key}:${code}` },
      { $max: { seq: maxSeq }, $setOnInsert: { companyId, key: `${doc.key}:${code}` } },
      { upsert: true, new: true }
    );
    summary.countersSynced += 1;

    const missing = await doc.model.find({
      companyId,
      $or: [
        { [doc.field]: { $exists: false } },
        { [doc.field]: null },
        { [doc.field]: "" },
        ...(doc.mirrors || []).map((field) => ({ [field]: null })),
      ],
    });
    for (const row of missing) {
      const existing = String(row[doc.field] || "").trim();
      const nextNo = existing || (await nextNumberForCompany(companyId, code, doc, maxByKey));
      row[doc.field] = nextNo;
      for (const mirror of doc.mirrors || []) row[mirror] = nextNo;
      await row.save();
      summary.numbersAssigned += 1;
    }
  }
}

async function recalcPackingInvoiceStatus(companyId, packing) {
  const invoices = await SalesInvoice.find({ companyId, linkedStorePackingId: packing._id, status: { $ne: "CANCELLED" } })
    .select("_id invoiceNo invoiceDate lines")
    .sort({ invoiceDate: 1 })
    .lean();
  const invoicedByLine = new Map();
  for (const invoice of invoices) {
    for (const line of invoice.lines || []) {
      if (!line.packingLineId) continue;
      const key = String(line.packingLineId);
      invoicedByLine.set(key, (invoicedByLine.get(key) || 0) + (Number(line.qty) || 0));
    }
  }
  const packedQty = (packing.lines || []).reduce((sum, line) => sum + (Number(line.packQty) || 0), 0);
  const invoicedQty = (packing.lines || []).reduce((sum, line) => sum + (invoicedByLine.get(String(line._id)) || 0), 0);
  packing.invoiceStatus =
    invoicedQty <= 0 ? "NOT_INVOICED" : invoicedQty >= packedQty - 1e-6 ? "FULLY_INVOICED" : "PARTIALLY_INVOICED";
  packing.linkedSalesInvoiceIds = invoices.map((invoice) => invoice._id);
  packing.linkedSalesInvoiceNos = invoices.map((invoice) => invoice.invoiceNo).filter(Boolean);
  packing.lastInvoicedAt = invoices.length ? invoices[invoices.length - 1].invoiceDate || new Date() : null;
  return { packedQty, invoicedQty };
}

async function recalcAllocationStatuses(companyId, allocation) {
  const [packings, invoices, dispatches] = await Promise.all([
    StorePacking.find({ companyId, allocationId: allocation._id, status: { $in: POSTED_PACKING_STATUSES } }).select("lines").lean(),
    SalesInvoice.find({ companyId, linkedOrderAllocationId: allocation._id, status: { $ne: "CANCELLED" } }).select("_id invoiceNo invoiceDate lines").sort({ invoiceDate: -1 }).lean(),
    StoreDispatch.find({ companyId, allocationId: allocation._id, status: { $in: POSTED_DISPATCH_STATUSES } }).select("lines").lean(),
  ]);
  const allocatedQty = (allocation.lines || []).reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
  const packedQty = packings.reduce((sum, packing) => sum + (packing.lines || []).reduce((s, line) => s + (Number(line.packQty) || 0), 0), 0);
  const invoicedQty = invoices.reduce((sum, invoice) => sum + (invoice.lines || []).reduce((s, line) => s + (Number(line.qty) || 0), 0), 0);
  const dispatchedQty = dispatches.reduce((sum, dispatch) => sum + (dispatch.lines || []).reduce((s, line) => s + (Number(line.dispatchQty) || 0), 0), 0);
  allocation.packingStatus =
    packedQty <= 0 ? "NOT_PACKED" : packedQty >= allocatedQty - 1e-6 ? "FULLY_PACKED" : "PARTIALLY_PACKED";
  allocation.invoiceStatus =
    invoicedQty <= 0 ? "NOT_INVOICED" : invoicedQty >= packedQty - 1e-6 ? "FULLY_INVOICED" : "PARTIALLY_INVOICED";
  allocation.dispatchStatus =
    dispatchedQty <= 0 ? "NOT_DISPATCHED" : dispatchedQty >= invoicedQty - 1e-6 ? "DISPATCHED" : "PARTIALLY_DISPATCHED";
  if (packings.length && allocation.status !== "CANCELLED" && !["CLOSED"].includes(allocation.status)) {
    allocation.status = allocation.packingStatus === "FULLY_PACKED" ? "FULLY_PACKED" : "PARTIALLY_PACKED";
  }
  const latestInvoice = invoices[0] || null;
  allocation.linkedSalesInvoiceId = latestInvoice?._id || allocation.linkedSalesInvoiceId || null;
  allocation.linkedSalesInvoiceNo = latestInvoice?.invoiceNo || allocation.linkedSalesInvoiceNo || "";
}

async function repairStatusesForCompany(company, summary) {
  const companyId = company._id;
  const packings = await StorePacking.find({ companyId, status: { $in: POSTED_PACKING_STATUSES } });
  for (const packing of packings) {
    const before = JSON.stringify({
      invoiceStatus: packing.invoiceStatus,
      ids: packing.linkedSalesInvoiceIds,
      nos: packing.linkedSalesInvoiceNos,
    });
    await recalcPackingInvoiceStatus(companyId, packing);
    if (JSON.stringify({ invoiceStatus: packing.invoiceStatus, ids: packing.linkedSalesInvoiceIds, nos: packing.linkedSalesInvoiceNos }) !== before) {
      await packing.save();
      summary.packingsUpdated += 1;
    }
  }

  const allocations = await OrderAllocation.find({ companyId });
  for (const allocation of allocations) {
    const before = JSON.stringify({
      status: allocation.status,
      packingStatus: allocation.packingStatus,
      invoiceStatus: allocation.invoiceStatus,
      dispatchStatus: allocation.dispatchStatus,
      invoiceNo: allocation.linkedSalesInvoiceNo,
    });
    await recalcAllocationStatuses(companyId, allocation);
    if (JSON.stringify({
      status: allocation.status,
      packingStatus: allocation.packingStatus,
      invoiceStatus: allocation.invoiceStatus,
      dispatchStatus: allocation.dispatchStatus,
      invoiceNo: allocation.linkedSalesInvoiceNo,
    }) !== before) {
      await allocation.save();
      summary.allocationsUpdated += 1;
    }
  }
}

async function repairCompany(company) {
  const summary = {
    company: company.code || company.name || String(company._id),
    countersSynced: 0,
    numbersAssigned: 0,
    packingsUpdated: 0,
    allocationsUpdated: 0,
    indexesDropped: 0,
    indexesEnsured: 0,
  };
  await repairNumbersForCompany(company, summary);
  await repairStatusesForCompany(company, summary);
  return summary;
}

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI or MONGODB_URI is required");
  await mongoose.connect(uri);
  const indexSummary = { indexesDropped: 0, indexesEnsured: 0 };
  await dropUnsafeUniqueIndex("salesinvoices", "invoiceNo", indexSummary);
  await dropUnsafeUniqueIndex("salesinvoices", "invoiceNumber", indexSummary);
  const companies = await Company.find({ $or: [{ code: /^OKE/i }, { code: /^MAR/i }, { name: /Okeanos/i }, { name: /Marivolt/i }] }).sort({ code: 1 });
  const targetCompanies = companies.length ? companies : await Company.find({}).sort({ code: 1 });
  const summaries = [];
  for (const company of targetCompanies) {
    const summary = await repairCompany(company);
    summary.indexesDropped += indexSummary.indexesDropped;
    summary.indexesEnsured += indexSummary.indexesEnsured;
    summaries.push(summary);
    indexSummary.indexesDropped = 0;
    indexSummary.indexesEnsured = 0;
  }
  await ensureCompanyIndex("salesinvoices", "invoiceNo", indexSummary);
  await ensureCompanyIndex("salesinvoices", "invoiceNumber", indexSummary);
  console.log("Sales/Store/Logistics flow repair completed. No documents were deleted.");
  console.table(summaries);
  console.log("Index repair:", indexSummary);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
