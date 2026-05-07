import mongoose from "mongoose";
import SalesInvoice from "../models/SalesInvoice.js";
import SalesDispatch from "../models/SalesDispatch.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import CustomerLedgerEntry from "../models/CustomerLedgerEntry.js";
import SupplierLedgerEntry from "../models/SupplierLedgerEntry.js";
import CashBankEntry from "../models/CashBankEntry.js";
import BankDetail from "../models/BankDetail.js";
import PaymentReceipt from "../models/PaymentReceipt.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
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
    const prior = await CustomerLedgerEntry.find(withCompany(req, { customerName: name }))
      .sort({ entryDate: 1, createdAt: 1 })
      .limit(skip)
      .select("debit credit")
      .lean();
    let running = prior.reduce(
      (acc, e) => acc + (Number(e.debit) || 0) - (Number(e.credit) || 0),
      0
    );
    const entries = await CustomerLedgerEntry.find(withCompany(req, { customerName: name }))
      .sort({ entryDate: 1, createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean();
    const total = await CustomerLedgerEntry.countDocuments(withCompany(req, { customerName: name }));
    const withBal = entries.map((e) => {
      running += (Number(e.debit) || 0) - (Number(e.credit) || 0);
      return { ...e, runningBalance: running };
    });
    res.json({ items: withBal, total, page, limit });
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
    const row = await CustomerLedgerEntry.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
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
    const { customerId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(customerId)) return res.status(400).json({ message: "Invalid customerId" });
    const customer = await Customer.findOne(withCompany(req, { _id: customerId })).lean();
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    const entries = await CustomerLedgerEntry.find(withCompany(req, { customerId: customer._id }))
      .sort({ entryDate: 1, createdAt: 1 })
      .lean();
    let running = 0;
    const items = entries.map((e) => {
      running += (Number(e.debit) || 0) - (Number(e.credit) || 0);
      return { ...e, runningBalance: running };
    });
    res.json({ customer: { _id: customer._id, name: customer.name }, items, closingBalance: running });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listOutstandingReport(req, res) {
  try {
    const filter = withCompany(req);
    if (req.query.customerName) filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    if (req.query.currency) filter.currency = String(req.query.currency).trim().toUpperCase();
    if (req.query.fromDate || req.query.toDate) {
      filter.proformaDate = {};
      if (req.query.fromDate) filter.proformaDate.$gte = new Date(String(req.query.fromDate));
      if (req.query.toDate) {
        const d = new Date(String(req.query.toDate));
        d.setHours(23, 59, 59, 999);
        filter.proformaDate.$lte = d;
      }
    }
    const proformas = await ProformaInvoice.find(filter).sort({ proformaDate: -1 }).lean();
    const rows = proformas.map((p) => {
      const invoiceAmount = Math.max(0, Number(p.grandTotal) || 0);
      const paidAmount = Math.max(0, Number(p.totalReceivedAmount) || 0);
      const balanceAmount = Math.max(0, invoiceAmount - paidAmount);
      const dueDate = p.proformaDate ? new Date(p.proformaDate) : new Date();
      const agingDays = Math.max(0, Math.floor((Date.now() - dueDate.getTime()) / (1000 * 60 * 60 * 24)));
      return {
        customer: p.customerName || "",
        invoiceNo: p.proformaNo || "",
        invoiceDate: p.proformaDate || null,
        dueDate,
        invoiceAmount,
        paidAmount,
        balanceAmount,
        currency: p.currency || "USD",
        agingDays,
        status: balanceAmount <= 0 ? "PAID" : paidAmount > 0 ? "PARTIALLY_PAID" : "UNPAID",
        sourceType: "PROFORMA_INVOICE",
        sourceId: p._id,
      };
    });
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listAgingReport(req, res) {
  try {
    const out = await ProformaInvoice.find(withCompany(req)).lean();
    const bucketByCustomer = new Map();
    for (const p of out) {
      const total = Math.max(0, Number(p.grandTotal) || 0);
      const paid = Math.max(0, Number(p.totalReceivedAmount) || 0);
      const bal = Math.max(0, total - paid);
      if (bal <= 0) continue;
      const days = Math.max(0, Math.floor((Date.now() - new Date(p.proformaDate || p.createdAt || Date.now()).getTime()) / (1000 * 60 * 60 * 24)));
      const key = `${p.customerName || ""}::${p.currency || "USD"}`;
      if (!bucketByCustomer.has(key)) {
        bucketByCustomer.set(key, {
          customer: p.customerName || "",
          currency: p.currency || "USD",
          notDue: 0,
          d0_30: 0,
          d31_60: 0,
          d61_90: 0,
          d90Plus: 0,
          totalOutstanding: 0,
        });
      }
      const row = bucketByCustomer.get(key);
      if (days <= 0) row.notDue += bal;
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
