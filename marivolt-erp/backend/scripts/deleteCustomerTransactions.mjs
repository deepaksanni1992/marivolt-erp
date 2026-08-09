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
import * as stockService from "../src/services/stockService.js";
import StoreDispatch from "../src/models/StoreDispatch.js";
import SalesDispatch from "../src/models/SalesDispatch.js";
import SalesReturn from "../src/models/SalesReturn.js";
import Cipl from "../src/models/Cipl.js";
import PaymentReceipt from "../src/models/PaymentReceipt.js";
import Shipment from "../src/models/Shipment.js";
import CustomsInvoice from "../src/models/CustomsInvoice.js";
import CustomerLedgerEntry from "../src/models/CustomerLedgerEntry.js";
import CustomerLedger from "../src/models/CustomerLedger.js";
import CashBankEntry from "../src/models/CashBankEntry.js";
import SalesDoc from "../src/models/SalesDoc.js";
import ApprovalRequest from "../src/models/ApprovalRequest.js";
import StockLedger from "../src/models/StockLedger.js";
import { resolveAllocReleaseEffectKey } from "../src/utils/allocationReservationKeys.js";

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

/**
 * Cancel allocations with atomic remaining-reservation release (Option A).
 * Never hard-deletes; never soft-cancels without releasing stock.
 */
async function cancelAllocationsWithStockRelease(filter, dryRun) {
  const docs = await OrderAllocation.find(filter);
  if (!docs.length) {
    return { label: "Order allocations", model: "OrderAllocation", deleted: 0, cancelled: 0 };
  }
  const active = docs.filter((d) => String(d.status || "").toUpperCase() !== "CANCELLED");
  if (dryRun) {
    return {
      label: "Order allocations (cancel + release remaining reservation)",
      model: "OrderAllocation",
      deleted: 0,
      wouldCancel: active.length,
    };
  }

  let cancelled = 0;
  for (const alloc of active) {
    const warehouse = String(alloc.warehouse || "MAIN").trim().toUpperCase() || "MAIN";
    const releaseLines = (alloc.lines || [])
      .map((line) => ({
        article: String(line.article || "").trim().toUpperCase(),
        qty: Math.max(0, (Number(line.qty) || 0) - (Number(line.packedQty) || 0)),
      }))
      .filter((x) => x.article && x.qty > 0);

    // Block if non-cancelled packing still exists for this allocation
    const openPacking = await StorePacking.countDocuments({
      companyId: alloc.companyId,
      allocationId: alloc._id,
      status: { $ne: "CANCELLED" },
    });
    if (openPacking) {
      throw new Error(
        `Cannot wipe customer while Store Packing still open for allocation ${alloc.allocationNo}. Cancel packing first.`
      );
    }

    await stockService.withTransaction(async (session) => {
      for (const [article, qty] of dedupeArticles(releaseLines)) {
        const resolved = await resolveAllocReleaseEffectKey({
          companyId: alloc.companyId,
          allocation: alloc,
          article,
          reserveExists: async (effectKey) => {
            const q = StockLedger.findOne({ effectKey }).select("_id").lean();
            if (session) q.session(session);
            return Boolean(await q);
          },
        });
        try {
          await stockService.cancelAllocation({
            session,
            companyId: alloc.companyId,
            article,
            warehouse,
            qty,
            customerName: alloc.customerName || "",
            referenceType: "ORDER_ALLOCATION_CANCEL",
            referenceNo: alloc.allocationNo,
            remarks: "Customer transaction wipe — atomic cancel with reservation release",
            createdBy: "deleteCustomerTransactions.mjs",
            sourceModule: "SALES",
            effectKey: resolved.effectKey,
            allocationId: alloc._id,
          });
        } catch (err) {
          // Already released / never reserved — still allow document cancel (idempotent wipe).
          const msg = String(err?.message || "");
          if (!/reserved bucket lower/i.test(msg) && err?.code !== 11000) throw err;
          console.warn(
            `Skip release for ${alloc.allocationNo} ${article}: ${msg || "already released"}`
          );
        }
      }
      alloc.status = "CANCELLED";
      alloc.cancelledAt = new Date();
      alloc.cancelledBy = "deleteCustomerTransactions.mjs";
      alloc.cancellationReason =
        "Customer transaction wipe — cancelled with remaining reservation released (hard delete blocked)";
      await alloc.save({ session });
    });
    cancelled += 1;
  }

  return {
    label: "Order allocations (cancelled + reservation released; not deleted)",
    model: "OrderAllocation",
    deleted: 0,
    cancelled,
  };
}

function dedupeArticles(lines) {
  const byArticle = new Map();
  for (const ln of lines || []) {
    const code = String(ln?.article || "").trim().toUpperCase();
    const q = Number(ln?.qty) || 0;
    if (!code || !(q > 0)) continue;
    byArticle.set(code, (byArticle.get(code) || 0) + q);
  }
  return byArticle;
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
    await cancelAllocationsWithStockRelease(byName, dryRun),
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
