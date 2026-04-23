import mongoose from "mongoose";
import SalesInvoice from "../models/SalesInvoice.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import CustomerLedgerEntry from "../models/CustomerLedgerEntry.js";
import SupplierLedgerEntry from "../models/SupplierLedgerEntry.js";
import CashBankEntry from "../models/CashBankEntry.js";
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
