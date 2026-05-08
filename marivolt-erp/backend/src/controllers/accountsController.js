import mongoose from "mongoose";
import SalesInvoice from "../models/SalesInvoice.js";
import SalesDispatch from "../models/SalesDispatch.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import CustomerLedger from "../models/CustomerLedger.js";
import CustomerLedgerEntry from "../models/CustomerLedgerEntry.js";
import SupplierLedgerEntry from "../models/SupplierLedgerEntry.js";
import CashBankEntry from "../models/CashBankEntry.js";
import BankDetail from "../models/BankDetail.js";
import PaymentReceipt from "../models/PaymentReceipt.js";
import JournalEntry from "../models/JournalEntry.js";
import Customer from "../models/Customer.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function paginate(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function dateRangeFromQuery(req, fieldName) {
  const range = {};
  if (req.query.fromDate) range.$gte = new Date(String(req.query.fromDate));
  if (req.query.toDate) {
    const d = new Date(String(req.query.toDate));
    d.setHours(23, 59, 59, 999);
    range.$lte = d;
  }
  return Object.keys(range).length ? { [fieldName]: range } : {};
}

function dueDateForInvoice(inv) {
  const base = new Date(inv.invoiceDate || inv.createdAt || Date.now());
  const terms = String(inv.paymentTerms || "");
  const match = terms.match(/(\d+)\s*(day|days|net)?/i);
  const days = match ? Number(match[1]) || 0 : 0;
  const due = new Date(base);
  due.setDate(due.getDate() + days);
  return due;
}

function ageingBucketFromDueDate(dueDate) {
  const days = Math.max(0, Math.floor((Date.now() - dueDate.getTime()) / (1000 * 60 * 60 * 24)));
  if (dueDate.getTime() > Date.now()) return { bucket: "Current", days: 0 };
  if (days <= 30) return { bucket: "0-30", days };
  if (days <= 60) return { bucket: "31-60", days };
  if (days <= 90) return { bucket: "61-90", days };
  return { bucket: "90+", days };
}

function sumInvoiceLines(lines, rateField) {
  let sub = 0;
  for (const line of lines || []) {
    const amt = (Number(line.qty) || 0) * (Number(line[rateField]) || 0);
    line.amount = amt;
    sub += amt;
  }
  return sub;
}

// --- Sales dispatches (logistics / AR follow-up; same collection as Sales module) ---
export async function listSalesDispatchesAccounts(req, res) {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = withCompany(req);
    if (req.query.customerName) {
      filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    }
    const [items, total] = await Promise.all([
      SalesDispatch.find(filter).sort({ dispatchDate: -1 }).skip(skip).limit(limit).lean(),
      SalesDispatch.countDocuments(filter),
    ]);
    const ids = [...new Set(items.map((d) => d.linkedSalesInvoiceId).filter(Boolean).map(String))];
    let invMap = {};
    if (ids.length) {
      const invs = await SalesInvoice.find({ companyId: req.companyId, _id: { $in: ids } })
        .select("status paymentTerms invoiceNo grandTotal currency")
        .lean();
      invMap = Object.fromEntries(invs.map((i) => [String(i._id), i]));
    }
    const enriched = items.map((d) => ({
      ...d,
      linkedInvoice: invMap[String(d.linkedSalesInvoiceId)] || null,
    }));
    res.json({ items: enriched, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// --- Sales invoices ---
export async function listSalesInvoices(req, res) {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = withCompany(req);
    if (req.query.customerName) {
      filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    }
    if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
    const [items, total] = await Promise.all([
      SalesInvoice.find(filter).sort({ invoiceDate: -1 }).skip(skip).limit(limit).lean(),
      SalesInvoice.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await SalesInvoice.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createSalesInvoice(req, res) {
  try {
    const body = { ...req.body };
    if (!body.invoiceNumber) {
      body.invoiceNumber = await nextSequentialNumber(
        SalesInvoice,
        "invoiceNumber",
        `${req.companyCode || "CMP"}-SI`,
        { companyId: req.companyId }
      );
    }
    body.createdBy = req.user?.email || "";
    body.companyId = req.companyId;
    const doc = new SalesInvoice(body);
    doc.subTotal = sumInvoiceLines(doc.lines, "rate");
    doc.totalAmount = (doc.subTotal || 0) + (Number(doc.taxAmount) || 0);
    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await SalesInvoice.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    const allowed = [
      "customerName",
      "linkedQuotationNumber",
      "currency",
      "lines",
      "taxAmount",
      "paymentStatus",
      "remarks",
      "invoiceDate",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    doc.subTotal = sumInvoiceLines(doc.lines, "rate");
    doc.totalAmount = (doc.subTotal || 0) + (Number(doc.taxAmount) || 0);
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const existing = await SalesInvoice.findOne(withCompany(req, { _id: id }));
    if (!existing) return res.status(404).json({ message: "Not found" });
    const status = String(existing.status || "").toUpperCase();
    if (!["DRAFT", ""].includes(status)) {
      return res.status(409).json({
        message: "Posted sales invoices cannot be deleted. Cancel/reverse the invoice instead.",
        code: "POSTED_DELETE_BLOCKED",
      });
    }
    const row = await SalesInvoice.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

// --- Purchase invoices ---
export async function listPurchaseInvoices(req, res) {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = withCompany(req);
    if (req.query.supplierName) {
      filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    }
    if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;
    const [items, total] = await Promise.all([
      PurchaseInvoice.find(filter).sort({ invoiceDate: -1 }).skip(skip).limit(limit).lean(),
      PurchaseInvoice.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getPurchaseInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseInvoice.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createPurchaseInvoice(req, res) {
  try {
    const body = { ...req.body };
    if (!body.invoiceNumber) {
      body.invoiceNumber = await nextSequentialNumber(
        PurchaseInvoice,
        "invoiceNumber",
        `${req.companyCode || "CMP"}-PI`,
        { companyId: req.companyId }
      );
    }
    body.createdBy = req.user?.email || "";
    body.companyId = req.companyId;
    const doc = new PurchaseInvoice(body);
    doc.subTotal = sumInvoiceLines(doc.lines, "rate");
    doc.totalAmount = (doc.subTotal || 0) + (Number(doc.taxAmount) || 0);
    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updatePurchaseInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await PurchaseInvoice.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    const allowed = [
      "supplierName",
      "linkedPoNumber",
      "currency",
      "lines",
      "taxAmount",
      "paymentStatus",
      "remarks",
      "invoiceDate",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    doc.subTotal = sumInvoiceLines(doc.lines, "rate");
    doc.totalAmount = (doc.subTotal || 0) + (Number(doc.taxAmount) || 0);
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deletePurchaseInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await PurchaseInvoice.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

// --- Customer ledger ---
export async function listCustomerLedger(req, res) {
  try {
    const { page, limit, skip } = paginate(req);
    const name = String(req.query.customerName || "").trim();
    if (!name) {
      return res.status(400).json({ message: "customerName query required" });
    }
    const filter = withCompany(req, { customerName: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (req.query.currency) filter.currency = String(req.query.currency).trim().toUpperCase();
    Object.assign(filter, dateRangeFromQuery(req, "transactionDate"));
    const [entries, total] = await Promise.all([
      CustomerLedger.find(filter)
        .sort({ transactionDate: 1, createdAt: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      CustomerLedger.countDocuments(filter),
    ]);
    if (entries.length || total > 0) {
      return res.json({ items: entries, total, page, limit, sourceModel: "CustomerLedger" });
    }

    // Backward-compatible fallback for historical rows created before
    // Phase-8.3. New financial movements are written to CustomerLedger.
    const prior = await CustomerLedgerEntry.find(withCompany(req, { customerName: name }))
      .sort({ entryDate: 1, createdAt: 1 })
      .limit(skip)
      .select("debit credit")
      .lean();
    let running = prior.reduce((acc, e) => acc + (Number(e.debit) || 0) - (Number(e.credit) || 0), 0);
    const legacyEntries = await CustomerLedgerEntry.find(withCompany(req, { customerName: name }))
      .sort({ entryDate: 1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const legacyTotal = await CustomerLedgerEntry.countDocuments(withCompany(req, { customerName: name }));
    const withBal = legacyEntries.map((e) => {
      running += (Number(e.debit) || 0) - (Number(e.credit) || 0);
      return {
        ...e,
        transactionDate: e.entryDate,
        documentNo: e.referenceNumber,
        movementType: e.referenceType || e.sourceType || "JOURNAL",
        debitAmount: Number(e.debit) || 0,
        creditAmount: Number(e.credit) || 0,
        remarks: e.narrative || "",
        runningBalance: running,
        sourceModel: "CustomerLedgerEntry",
      };
    });
    res.json({ items: withBal, total: legacyTotal, page, limit, sourceModel: "CustomerLedgerEntry" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createCustomerLedgerEntry(req, res) {
  try {
    const body = { ...req.body, companyId: req.companyId, createdBy: req.user?.email || "" };
    const doc = await CustomerLedgerEntry.create(body);
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteCustomerLedgerEntry(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await CustomerLedgerEntry.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.sourceId || row.proformaInvoiceId) {
      return res.status(409).json({
        message: "Posted customer ledger rows cannot be deleted. Post a reversing entry instead.",
        code: "POSTED_DELETE_BLOCKED",
      });
    }
    await row.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

// --- Supplier ledger ---
export async function listSupplierLedger(req, res) {
  try {
    const { page, limit, skip } = paginate(req);
    const name = String(req.query.supplierName || "").trim();
    if (!name) {
      return res.status(400).json({ message: "supplierName query required" });
    }
    const prior = await SupplierLedgerEntry.find(withCompany(req, { supplierName: name }))
      .sort({ entryDate: 1, createdAt: 1 })
      .limit(skip)
      .select("debit credit")
      .lean();
    let running = prior.reduce(
      (acc, e) => acc + (Number(e.debit) || 0) - (Number(e.credit) || 0),
      0
    );
    const entries = await SupplierLedgerEntry.find(withCompany(req, { supplierName: name }))
      .sort({ entryDate: 1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const total = await SupplierLedgerEntry.countDocuments(withCompany(req, { supplierName: name }));
    const withBal = entries.map((e) => {
      running += (Number(e.debit) || 0) - (Number(e.credit) || 0);
      return { ...e, runningBalance: running };
    });
    res.json({ items: withBal, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createSupplierLedgerEntry(req, res) {
  try {
    const body = { ...req.body, companyId: req.companyId, createdBy: req.user?.email || "" };
    const doc = await SupplierLedgerEntry.create(body);
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteSupplierLedgerEntry(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await SupplierLedgerEntry.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

// --- Cash / bank ---
export async function listCashBank(req, res) {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = withCompany(req);
    if (req.query.accountName) {
      filter.accountName = new RegExp(String(req.query.accountName).trim(), "i");
    }
    if (req.query.transactionType) filter.transactionType = req.query.transactionType;
    const [items, total] = await Promise.all([
      CashBankEntry.find(filter).sort({ entryDate: -1 }).skip(skip).limit(limit).lean(),
      CashBankEntry.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createCashBankEntry(req, res) {
  try {
    const body = { ...req.body, companyId: req.companyId, createdBy: req.user?.email || "" };
    const doc = await CashBankEntry.create(body);
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteCashBankEntry(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await CashBankEntry.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

// --- Bank details ---
const BANK_CURRENCY_GROUPS = {
  EUR: ["EUR", "EURO"],
  EURO: ["EUR", "EURO"],
  USD: ["USD"],
  AED: ["AED"],
};

function currencyCodesForBankMatch(raw) {
  const u = String(raw || "USD").trim().toUpperCase();
  if (BANK_CURRENCY_GROUPS[u]) return BANK_CURRENCY_GROUPS[u];
  for (const arr of Object.values(BANK_CURRENCY_GROUPS)) {
    if (arr.includes(u)) return [...arr];
  }
  return [u];
}

/** Resolve invoice currency (EUR/EURO/AED/USD) to a stored bank row for this company. */
export async function getBankDetailForCurrency(req, res) {
  try {
    const raw = req.params.currency ?? req.query.currency ?? "USD";
    const codes = currencyCodesForBankMatch(raw);
    const row = await BankDetail.findOne(withCompany(req, { currency: { $in: codes } }))
      .sort({ isDefault: -1, createdAt: -1 })
      .lean();
    res.json({ bankDetail: row || null });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listBankDetails(req, res) {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ bankName: new RegExp(q, "i") }, { accountName: new RegExp(q, "i") }, { accountNumber: new RegExp(q, "i") }];
    }
    if (req.query.currency) filter.currency = String(req.query.currency).trim().toUpperCase();
    const [items, total] = await Promise.all([
      BankDetail.find(filter).sort({ isDefault: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      BankDetail.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createBankDetail(req, res) {
  try {
    const body = {
      ...req.body,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    };
    body.currency = String(body.currency || "USD").trim().toUpperCase();
    if (body.currency === "EURO") body.currency = "EUR";
    if (body.isDefault) {
      await BankDetail.updateMany(withCompany(req), { $set: { isDefault: false } });
    }
    const doc = await BankDetail.create(body);
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateBankDetail(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const existing = await BankDetail.findOne(withCompany(req, { _id: id }));
    if (!existing) return res.status(404).json({ message: "Not found" });

    const raw = { ...req.body };
    delete raw.companyId;
    delete raw._id;
    delete raw.createdAt;
    raw.updatedBy = req.user?.email || "";
    if (raw.currency !== undefined) {
      raw.currency = String(raw.currency || "USD").trim().toUpperCase();
      if (raw.currency === "EURO") raw.currency = "EUR";
    }
    if (raw.isDefault) {
      await BankDetail.updateMany(withCompany(req, { _id: { $ne: id } }), { $set: { isDefault: false } });
    }
    const doc = await BankDetail.findOneAndUpdate(
      withCompany(req, { _id: id }),
      { $set: raw },
      { new: true, runValidators: true }
    );
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteBankDetail(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await BankDetail.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getCustomerLedgerByCustomerId(req, res) {
  try {
    const { customerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(customerId)) return res.status(400).json({ message: "Invalid customerId" });
    const customer = await Customer.findOne(withCompany(req, { _id: customerId })).lean();
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    req.query.customerName = customer.name;
    return listCustomerLedger(req, res);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getCustomerStatement(req, res) {
  try {
    const customerId = req.params.customerId || req.query.customerId || "";
    const customerName = String(req.query.customerName || req.query.customer || "").trim();
    const filter = withCompany(req);
    let customer = null;
    if (mongoose.Types.ObjectId.isValid(customerId)) {
      customer = await Customer.findOne(withCompany(req, { _id: customerId })).lean();
      if (!customer) return res.status(404).json({ message: "Customer not found" });
      filter.customerId = customer._id;
    } else if (customerName) {
      filter.customerName = new RegExp(`^${customerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    } else {
      return res.status(400).json({ message: "customerName or customerId query required" });
    }
    if (req.query.currency) filter.currency = String(req.query.currency).trim().toUpperCase();
    Object.assign(filter, dateRangeFromQuery(req, "transactionDate"));
    const entries = await CustomerLedger.find(filter)
      .sort({ transactionDate: 1, createdAt: 1, _id: 1 })
      .lean();
    const closingBalance = Number(entries[entries.length - 1]?.runningBalance || 0);
    res.json({
      customer: customer ? { _id: customer._id, name: customer.name } : { _id: null, name: customerName },
      items: entries,
      closingBalance,
      currency: req.query.currency || entries[0]?.currency || "USD",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listOutstandingReport(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.customerName) filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    if (req.query.currency) filter.currency = String(req.query.currency).trim().toUpperCase();
    Object.assign(filter, dateRangeFromQuery(req, "invoiceDate"));
    filter.status = { $ne: "CANCELLED" };
    const invoices = await SalesInvoice.find(filter).sort({ invoiceDate: -1, createdAt: -1 }).lean();
    const invoiceIds = invoices.map((x) => x._id);
    const latestPayments = invoiceIds.length
      ? await PaymentReceipt.aggregate([
          {
            $match: withCompany(req, {
              status: { $ne: "CANCELLED" },
              "allocations.targetType": "SALES_INVOICE",
              "allocations.targetId": { $in: invoiceIds },
            }),
          },
          { $unwind: "$allocations" },
          {
            $match: {
              "allocations.targetType": "SALES_INVOICE",
              "allocations.targetId": { $in: invoiceIds },
            },
          },
          {
            $group: {
              _id: "$allocations.targetId",
              received: { $sum: "$allocations.allocatedAmount" },
              latestPaymentDate: { $max: "$receiptDate" },
            },
          },
        ])
      : [];
    const payByInvoice = new Map(latestPayments.map((x) => [String(x._id), x]));
    const rows = invoices
      .map((inv) => {
        const invoiceAmount = Math.max(0, Number(inv.grandTotal) || 0);
        const payment = payByInvoice.get(String(inv._id));
        const received = Math.max(0, Number(payment?.received ?? inv.totalReceivedAmount) || 0);
        const balance = Math.max(0, invoiceAmount - received);
        const dueDate = dueDateForInvoice(inv);
        const ageing = ageingBucketFromDueDate(dueDate);
        return {
          customer: inv.customerName || "",
          totalInvoice: invoiceAmount,
          invoiceAmount,
          invoiceNo: inv.invoiceNo || "",
          invoiceDate: inv.invoiceDate || null,
          dueDate,
          received,
          paidAmount: received,
          balance,
          balanceAmount: balance,
          overdue: dueDate.getTime() < Date.now() && balance > 0,
          latestPaymentDate: payment?.latestPaymentDate || null,
          ageingBucket: ageing.bucket,
          agingDays: ageing.days,
          currency: inv.currency || "USD",
          status: balance <= 0 ? "PAID" : received > 0 ? "PARTIAL" : "UNPAID",
          sourceType: "SALES_INVOICE",
          sourceId: inv._id,
        };
      })
      .filter((r) => r.balance > 0 || req.query.includePaid === "1");
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listAgingReport(req, res) {
  try {
    const filter = withCompany(req, { status: { $ne: "CANCELLED" } });
    if (req.query.customerName) filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    if (req.query.currency) filter.currency = String(req.query.currency).trim().toUpperCase();
    const out = await SalesInvoice.find(filter).lean();
    const bucketByCustomer = new Map();
    for (const inv of out) {
      const total = Math.max(0, Number(inv.grandTotal) || 0);
      const paid = Math.max(0, Number(inv.totalReceivedAmount) || 0);
      const bal = Math.max(0, total - paid);
      if (bal <= 0) continue;
      const dueDate = dueDateForInvoice(inv);
      const { bucket, days } = ageingBucketFromDueDate(dueDate);
      const key = `${inv.customerName || ""}::${inv.currency || "USD"}`;
      if (!bucketByCustomer.has(key)) {
        bucketByCustomer.set(key, {
          customer: inv.customerName || "",
          currency: inv.currency || "USD",
          current: 0,
          d0_30: 0,
          d31_60: 0,
          d61_90: 0,
          d90Plus: 0,
          totalOutstanding: 0,
        });
      }
      const row = bucketByCustomer.get(key);
      if (bucket === "Current") row.current += bal;
      else if (days <= 30) row.d0_30 += bal;
      else if (days <= 60) row.d31_60 += bal;
      else if (days <= 90) row.d61_90 += bal;
      else row.d90Plus += bal;
      row.totalOutstanding += bal;
    }
    res.json({ items: Array.from(bucketByCustomer.values()) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listCashBankLedger(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.accountName) filter.accountName = new RegExp(String(req.query.accountName).trim(), "i");
    const itemsRaw = await CashBankEntry.find(filter).sort({ entryDate: 1, createdAt: 1 }).lean();
    let running = 0;
    const items = itemsRaw.map((r) => {
      const debit = String(r.transactionType || "").toUpperCase() === "RECEIPT" ? Math.max(0, Number(r.amount) || 0) : 0;
      const credit = String(r.transactionType || "").toUpperCase() === "PAYMENT" ? Math.max(0, Number(r.amount) || 0) : 0;
      running += debit - credit;
      return { ...r, debit, credit, runningBalance: running };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listJournalEntries(req, res) {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    if (req.query.referenceNo) filter.referenceNo = new RegExp(String(req.query.referenceNo).trim(), "i");
    const [items, total] = await Promise.all([
      JournalEntry.find(filter).sort({ entryDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      JournalEntry.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getJournalEntry(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await JournalEntry.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
