/**
 * Hard-delete all sales transactions for a customer (admin cleanup).
 *
 * Usage (from marivolt-erp/backend):
 *   node scripts/deleteCustomerTransactions.mjs --customer "ALTAMAR OCEANIC MANAGEMENT - FZCO LLC" --dry-run
 *   node scripts/deleteCustomerTransactions.mjs --customer "ALTAMAR OCEANIC MANAGEMENT - FZCO LLC" --confirm
 *   node scripts/deleteCustomerTransactions.mjs --customer "ALTAMAR OCEANIC MANAGEMENT - FZCO LLC" --confirm --delete-customer
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "../src/models/Company.js";
import Customer from "../src/models/Customer.js";
import Quotation from "../src/models/Quotation.js";
import OrderAcknowledgement from "../src/models/OrderAcknowledgement.js";
import ProformaInvoice from "../src/models/ProformaInvoice.js";
import OrderAllocation from "../src/models/OrderAllocation.js";
import StorePacking from "../src/models/StorePacking.js";
import SalesInvoice from "../src/models/SalesInvoice.js";
import StoreDispatch from "../src/models/StoreDispatch.js";
import SalesDispatch from "../src/models/SalesDispatch.js";
import SalesReturn from "../src/models/SalesReturn.js";
import Rts from "../src/models/Rts.js";
import Cipl from "../src/models/Cipl.js";
import PaymentReceipt from "../src/models/PaymentReceipt.js";
import Shipment from "../src/models/Shipment.js";
import CustomsInvoice from "../src/models/CustomsInvoice.js";
import CustomerLedgerEntry from "../src/models/CustomerLedgerEntry.js";
import CustomerLedger from "../src/models/CustomerLedger.js";
import CashBankEntry from "../src/models/CashBankEntry.js";
import SalesDoc from "../src/models/SalesDoc.js";
import ApprovalRequest from "../src/models/ApprovalRequest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

function parseArgs(argv) {
  const args = { customer: "", dryRun: false, confirm: false, deleteCustomer: false, companyCode: "MAR" };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--confirm") args.confirm = true;
    else if (a === "--delete-customer") args.deleteCustomer = true;
    else if (a === "--customer") args.customer = String(argv[++i] || "").trim();
    else if (a === "--company") args.companyCode = String(argv[++i] || "MAR").trim().toUpperCase();
  }
  return args;
}

function customerFilter(companyId, customerId, customerName) {
  const name = String(customerName || "").trim();
  const or = [{ customerName: name }];
  if (customerId) {
    or.push({ customerId });
  }
  return { companyId, $or: or };
}

function customerIdFilter(companyId, customerId) {
  return { companyId, customerId };
}

async function countModel(Model, filter, label) {
  const n = await Model.countDocuments(filter);
  return { label, model: Model.modelName, count: n, filter };
}

async function deleteModel(Model, filter, label, dryRun) {
  const n = await Model.countDocuments(filter);
  if (!n) return { label, model: Model.modelName, deleted: 0 };
  if (dryRun) return { label, model: Model.modelName, deleted: 0, wouldDelete: n };
  const res = await Model.deleteMany(filter);
  return { label, model: Model.modelName, deleted: res.deletedCount || 0 };
}

async function run() {
  const args = parseArgs(process.argv);
  if (!args.customer) {
    throw new Error('Provide --customer "Customer Name"');
  }
  if (!args.dryRun && !args.confirm) {
    throw new Error("Pass --dry-run to preview or --confirm to execute deletion");
  }
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in .env");
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

  const company = await Company.findOne({ code: args.companyCode }).lean();
  if (!company) {
    throw new Error(`Company not found for code ${args.companyCode}`);
  }
  const companyId = company._id;

  const customer = await Customer.findOne({
    companyId,
    name: new RegExp(`^${args.customer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  }).lean();

  const customerName = customer?.name || args.customer;
  const customerId = customer?._id || null;

  console.log("Company:", company.code, company.name);
  console.log("Customer:", customerName, customerId ? `(${customerId})` : "(master not found — matching by name only)");
  console.log("Mode:", args.dryRun ? "DRY RUN" : "DELETE");
  console.log("---");

  const byName = customerFilter(companyId, customerId, customerName);
  const byId = customerId ? customerIdFilter(companyId, customerId) : null;

  const preview = [
    await countModel(SalesReturn, byName, "Sales returns"),
    await countModel(Shipment, byId || byName, "Shipments"),
    await countModel(CustomsInvoice, byId || byName, "Customs invoices"),
    await countModel(SalesDispatch, byName, "Sales dispatches"),
    await countModel(StoreDispatch, byName, "Store dispatches"),
    await countModel(PaymentReceipt, byId || byName, "Payment receipts"),
    await countModel(SalesInvoice, byName, "Sales invoices"),
    await countModel(StorePacking, byName, "Store packing"),
    await countModel(Rts, byName, "RTS"),
    await countModel(OrderAllocation, byName, "Order allocations"),
    await countModel(ProformaInvoice, byName, "Proforma invoices"),
    await countModel(Cipl, byName, "CI/PI (CIPL)"),
    await countModel(OrderAcknowledgement, byName, "Order acknowledgements"),
    await countModel(Quotation, byId || byName, "Quotations"),
    await countModel(CustomerLedgerEntry, byId || byName, "Customer ledger entries"),
    await countModel(CustomerLedger, byId || byName, "Customer ledgers"),
    await countModel(CashBankEntry, byId || byName, "Cash/bank entries"),
    await countModel(SalesDoc, byId || byName, "Legacy sales docs"),
    await countModel(ApprovalRequest, { companyId, customerName }, "Approval requests"),
  ];

  for (const row of preview) {
    if (row.count > 0) {
      console.log(`${row.label}: ${row.count}`);
    }
  }

  const total = preview.reduce((s, r) => s + r.count, 0);
  console.log("---");
  console.log("Total documents:", total);

  if (args.dryRun) {
    await mongoose.disconnect();
    return;
  }

  if (total === 0 && !args.deleteCustomer) {
    console.log("Nothing to delete.");
    await mongoose.disconnect();
    return;
  }

  const dryRun = false;
  const steps = [
    await deleteModel(SalesReturn, byName, "Sales returns", dryRun),
    await deleteModel(Shipment, byId || byName, "Shipments", dryRun),
    await deleteModel(CustomsInvoice, byId || byName, "Customs invoices", dryRun),
    await deleteModel(SalesDispatch, byName, "Sales dispatches", dryRun),
    await deleteModel(StoreDispatch, byName, "Store dispatches", dryRun),
    await deleteModel(PaymentReceipt, byId || byName, "Payment receipts", dryRun),
    await deleteModel(SalesInvoice, byName, "Sales invoices", dryRun),
    await deleteModel(StorePacking, byName, "Store packing", dryRun),
    await deleteModel(Rts, byName, "RTS", dryRun),
    await deleteModel(OrderAllocation, byName, "Order allocations", dryRun),
    await deleteModel(ProformaInvoice, byName, "Proforma invoices", dryRun),
    await deleteModel(Cipl, byName, "CI/PI (CIPL)", dryRun),
    await deleteModel(OrderAcknowledgement, byName, "Order acknowledgements", dryRun),
    await deleteModel(Quotation, byId || byName, "Quotations", dryRun),
    await deleteModel(CustomerLedgerEntry, byId || byName, "Customer ledger entries", dryRun),
    await deleteModel(CustomerLedger, byId || byName, "Customer ledgers", dryRun),
    await deleteModel(CashBankEntry, byId || byName, "Cash/bank entries", dryRun),
    await deleteModel(SalesDoc, byId || byName, "Legacy sales docs", dryRun),
    await deleteModel(ApprovalRequest, { companyId, customerName }, "Approval requests", dryRun),
  ];

  console.log("---");
  console.log("Deleted:");
  for (const row of steps) {
    if (row.deleted > 0) console.log(`${row.label}: ${row.deleted}`);
  }

  if (args.deleteCustomer && customerId) {
    const res = await Customer.deleteOne({ _id: customerId, companyId });
    console.log(`Customer master: ${res.deletedCount || 0}`);
  }

  console.log("Done.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
