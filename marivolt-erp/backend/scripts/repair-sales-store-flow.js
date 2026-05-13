import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "../src/models/Company.js";
import StorePacking from "../src/models/StorePacking.js";
import StoreDispatch from "../src/models/StoreDispatch.js";
import SalesInvoice from "../src/models/SalesInvoice.js";
import OrderAllocation from "../src/models/OrderAllocation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const POSTED_PACKING_STATUSES = ["POSTED", "PARTIALLY_PACKED", "FULLY_PACKED"];
const POSTED_DISPATCH_STATUSES = ["POSTED", "PARTIALLY_DISPATCHED", "FULLY_DISPATCHED"];

async function invoicedQtyByPackingLine(companyId, packingId) {
  const invoices = await SalesInvoice.find({ companyId, linkedStorePackingId: packingId, status: { $ne: "CANCELLED" } })
    .select("lines")
    .lean();
  const map = new Map();
  for (const inv of invoices) {
    for (const line of inv.lines || []) {
      if (!line.packingLineId) continue;
      const key = String(line.packingLineId);
      map.set(key, (map.get(key) || 0) + (Number(line.qty) || 0));
    }
  }
  return map;
}

async function repairCompany(company) {
  const companyId = company._id;
  const summary = {
    company: company.code || company.name || String(companyId),
    packingsChecked: 0,
    packingsUpdated: 0,
    allocationsUpdated: 0,
    legacyAllocationsSkippedNoPacking: 0,
    dispatchesLinkedToInvoice: 0,
  };

  const packings = await StorePacking.find({ companyId, status: { $in: POSTED_PACKING_STATUSES } });
  for (const packing of packings) {
    summary.packingsChecked += 1;
    const invoices = await SalesInvoice.find({ companyId, linkedStorePackingId: packing._id, status: { $ne: "CANCELLED" } })
      .select("_id invoiceNo invoiceDate lines")
      .sort({ invoiceDate: 1 })
      .lean();
    const invoicedByLine = await invoicedQtyByPackingLine(companyId, packing._id);
    const packedQty = (packing.lines || []).reduce((sum, line) => sum + (Number(line.packQty) || 0), 0);
    const invoicedQty = (packing.lines || []).reduce((sum, line) => sum + (invoicedByLine.get(String(line._id)) || 0), 0);
    const nextStatus =
      invoicedQty <= 0 ? "NOT_INVOICED" : invoicedQty >= packedQty - 1e-6 ? "FULLY_INVOICED" : "PARTIALLY_INVOICED";
    const nextIds = invoices.map((inv) => inv._id);
    const nextNos = invoices.map((inv) => inv.invoiceNo).filter(Boolean);
    if (
      packing.invoiceStatus !== nextStatus ||
      String(packing.linkedSalesInvoiceNos || "") !== String(nextNos)
    ) {
      packing.invoiceStatus = nextStatus;
      packing.linkedSalesInvoiceIds = nextIds;
      packing.linkedSalesInvoiceNos = nextNos;
      packing.lastInvoicedAt = invoices.length ? invoices[invoices.length - 1].invoiceDate || new Date() : null;
      await packing.save();
      summary.packingsUpdated += 1;
    }
  }

  const allocations = await OrderAllocation.find({ companyId });
  for (const allocation of allocations) {
    const allocationPackings = await StorePacking.find({
      companyId,
      allocationId: allocation._id,
      status: { $in: POSTED_PACKING_STATUSES },
    })
      .select("_id lines")
      .lean();
    const allocationInvoices = await SalesInvoice.find({
      companyId,
      linkedOrderAllocationId: allocation._id,
      status: { $ne: "CANCELLED" },
    })
      .select("_id invoiceNo invoiceDate")
      .sort({ invoiceDate: -1 })
      .lean();
    const legacyStatus = ["PARTIALLY_RTS", "RTS_COMPLETE"].includes(String(allocation.status || "").toUpperCase());
    if (!allocationPackings.length) {
      if (legacyStatus) summary.legacyAllocationsSkippedNoPacking += 1;
      continue;
    }

    const allocatedQty = (allocation.lines || []).reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
    const packedQty = allocationPackings.reduce(
      (sum, packing) => sum + (packing.lines || []).reduce((lineSum, line) => lineSum + (Number(line.packQty) || 0), 0),
      0
    );
    const nextStatus = allocationInvoices.length
      ? "CLOSED"
      : packedQty >= allocatedQty - 1e-6
        ? "FULLY_PACKED"
        : "PARTIALLY_PACKED";
    const latestInvoice = allocationInvoices[0] || null;
    if (
      allocation.status !== nextStatus ||
      String(allocation.linkedSalesInvoiceId || "") !== String(latestInvoice?._id || "") ||
      String(allocation.linkedSalesInvoiceNo || "") !== String(latestInvoice?.invoiceNo || "")
    ) {
      allocation.status = nextStatus;
      allocation.linkedSalesInvoiceId = latestInvoice?._id || null;
      allocation.linkedSalesInvoiceNo = latestInvoice?.invoiceNo || "";
      await allocation.save();
      summary.allocationsUpdated += 1;
    }
  }

  const dispatches = await StoreDispatch.find({
    companyId,
    status: { $in: POSTED_DISPATCH_STATUSES },
    $or: [{ salesInvoiceId: null }, { salesInvoiceNo: "" }],
  });
  for (const dispatch of dispatches) {
    const invoice = await SalesInvoice.findOne({
      companyId,
      linkedStorePackingId: dispatch.packingId,
      status: { $ne: "CANCELLED" },
    }).sort({ invoiceDate: -1 });
    if (!invoice) continue;
    dispatch.salesInvoiceId = invoice._id;
    dispatch.salesInvoiceNo = invoice.invoiceNo;
    dispatch.sourceDocumentType = "SALES_INVOICE";
    dispatch.sourceDocumentId = invoice._id;
    dispatch.linkedQuotationNo = invoice.linkedQuotationNo || "";
    await dispatch.save();
    summary.dispatchesLinkedToInvoice += 1;
  }

  return summary;
}

async function run() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI is required");
  await mongoose.connect(uri);
  const companies = await Company.find({}).sort({ code: 1 }).lean();
  const summaries = [];
  for (const company of companies) summaries.push(await repairCompany(company));
  console.log("Sales/Store flow repair completed. No documents were deleted.");
  console.table(summaries);
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
