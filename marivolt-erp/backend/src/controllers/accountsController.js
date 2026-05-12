import mongoose from "mongoose";
import SalesInvoice from "../models/SalesInvoice.js";
import SalesDispatch from "../models/SalesDispatch.js";
import PurchaseInvoice from "../models/PurchaseInvoice.js";
import GRN from "../models/GRN.js";
import CustomerLedger from "../models/CustomerLedger.js";
import CustomerLedgerEntry from "../models/CustomerLedgerEntry.js";
import SupplierLedgerEntry from "../models/SupplierLedgerEntry.js";
import SupplierPayment from "../models/SupplierPayment.js";
import CashBankEntry from "../models/CashBankEntry.js";
import BankDetail from "../models/BankDetail.js";
import PaymentReceipt from "../models/PaymentReceipt.js";
import JournalEntry from "../models/JournalEntry.js";
import Customer from "../models/Customer.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import PurchaseDocument from "../models/PurchaseDocument.js";
import Supplier from "../models/Supplier.js";
import { syncPurchaseOrderApExtensionFields } from "./purchasePoDocumentController.js";
import { nextSequentialNumber } from "../utils/docNumbers.js";
import { writeAudit } from "../services/auditService.js";
import { approvalRequiredPayload, ensureApproval } from "../services/approvalService.js";
import { createDraftPurchaseInvoiceFromPurchaseDocument } from "../services/purchaseInvoiceDraftFromDocumentService.js";

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

function dueDateForPurchaseInvoice(inv) {
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
    if (req.query.linkedPoId && mongoose.Types.ObjectId.isValid(String(req.query.linkedPoId))) {
      filter.linkedPoId = new mongoose.Types.ObjectId(String(req.query.linkedPoId));
    }
    const linkedPoNumberQ = String(req.query.linkedPoNumber || "").trim();
    if (linkedPoNumberQ) {
      const esc = linkedPoNumberQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.linkedPoNumber = new RegExp(esc, "i");
    }
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
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
    if ((!body.lines || !body.lines.length) && body.grnNo) {
      const grn = await GRN.findOne(withCompany(req, { grnNo: String(body.grnNo).trim().toUpperCase() })).lean();
      if (!grn) return res.status(404).json({ message: "Linked GRN not found" });
      body.supplierName = body.supplierName || grn.supplierName || "";
      body.currency = body.currency || grn.currency || "USD";
      body.linkedPoNumber = body.linkedPoNumber || grn.poNo || "";
      body.lines = (grn.items || []).map((ln) => ({
        itemCode: ln.article || "",
        description: ln.description || "",
        qty: Number(ln.acceptedQty || ln.receivedQty || 0),
        rate: Number(ln.unitCost || 0),
      }));
      body.remarks = body.remarks || `Created from GRN ${grn.grnNo}`;
    }
    if (!body.invoiceNumber) {
      body.invoiceNumber = await nextSequentialNumber(
        PurchaseInvoice,
        "invoiceNumber",
        `${req.companyCode || "CMP"}-PI`,
        { companyId: req.companyId }
      );
    }
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "ACCOUNTS",
      actionKey: "purchase_invoice_post",
      documentType: "PURCHASE_INVOICE",
      documentNo: body.invoiceNumber || "",
      customerName: body.supplierName || "",
      amount: Number(body.totalAmount || 0),
      currency: String(body.currency || "USD").trim().toUpperCase(),
      description: `Post purchase invoice for ${body.supplierName || ""}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));
    body.createdBy = req.user?.email || "";
    body.companyId = req.companyId;
    const doc = new PurchaseInvoice(body);
    doc.subTotal = sumInvoiceLines(doc.lines, "rate");
    doc.totalAmount =
      (doc.subTotal || 0) + (Number(doc.taxAmount) || 0) + (Number(doc.otherCharges) || 0);
    doc.totalPaidAmount = 0;
    doc.balanceAmount = doc.totalAmount;
    doc.status = "POSTED";
    doc.dueDate = body.dueDate ? new Date(body.dueDate) : dueDateForPurchaseInvoice(body);
    await doc.save();
    await SupplierLedgerEntry.create({
      companyId: req.companyId,
      branchId: doc.branchId || null,
      entryDate: doc.invoiceDate || new Date(),
      supplierName: doc.supplierName,
      referenceType: "PURCHASE_INVOICE",
      referenceNumber: doc.invoiceNumber,
      poNo: String(doc.linkedPoNumber || "").trim(),
      supplierInvoiceNo: String(doc.supplierInvoiceNo || "").trim(),
      currency: String(doc.currency || "USD").trim().toUpperCase(),
      paymentStatus: String(doc.paymentStatus || "UNPAID"),
      debit: Number(doc.totalAmount) || 0,
      credit: 0,
      narrative: `Purchase invoice ${doc.invoiceNumber}`,
      createdBy: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "CREATE",
      module: "ACCOUNTS",
      entityType: "PURCHASE_INVOICE",
      entityId: doc._id,
      documentNo: doc.invoiceNumber,
      description: `Purchase invoice ${doc.invoiceNumber} posted for ${doc.supplierName}`,
      metadata: { linkedPoNumber: doc.linkedPoNumber || "", lineCount: doc.lines.length },
    });
    await writeAudit(req, {
      action: "POST",
      module: "ACCOUNTS",
      entityType: "PURCHASE_INVOICE",
      entityId: doc._id,
      documentNo: doc.invoiceNumber,
      description: `Purchase invoice ${doc.invoiceNumber} posted`,
      metadata: { supplierName: doc.supplierName, totalAmount: doc.totalAmount },
    });
    if (doc.linkedPoId) {
      await syncPurchaseOrderApExtensionFields(req.companyId, doc.linkedPoId);
    }
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
      "linkedPoId",
      "supplierId",
      "branchId",
      "supplierInvoiceNo",
      "supplierInvoiceDate",
      "paymentTerms",
      "dueDate",
      "grnNo",
      "currency",
      "lines",
      "taxAmount",
      "otherCharges",
      "paymentStatus",
      "attachments",
      "remarks",
      "invoiceDate",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    doc.subTotal = sumInvoiceLines(doc.lines, "rate");
    doc.totalAmount =
      (doc.subTotal || 0) + (Number(doc.taxAmount) || 0) + (Number(doc.otherCharges) || 0);
    doc.balanceAmount = Math.max(0, (Number(doc.totalAmount) || 0) - (Number(doc.totalPaidAmount) || 0));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "ACCOUNTS",
      entityType: "PURCHASE_INVOICE",
      entityId: doc._id,
      documentNo: doc.invoiceNumber,
      description: `Purchase invoice ${doc.invoiceNumber} updated`,
    });
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
    const row = await PurchaseInvoice.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    return res.status(409).json({
      message: "Hard delete is not allowed for purchase invoices. Use cancel endpoint.",
      code: "HARD_DELETE_BLOCKED",
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelPurchaseInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const inv = await PurchaseInvoice.findOne(withCompany(req, { _id: id }));
    if (!inv) return res.status(404).json({ message: "Not found" });
    if (String(inv.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Invoice already cancelled" });
    }
    if ((Number(inv.totalPaidAmount) || 0) > 0.001) {
      return res.status(400).json({
        message: "Cannot cancel purchase invoice with payments. Reverse supplier payments first.",
        code: "PI_HAS_PAYMENTS",
      });
    }
    if (String(inv.status || "").toUpperCase() === "POSTED") {
      await SupplierLedgerEntry.create({
        companyId: req.companyId,
        branchId: inv.branchId || null,
        entryDate: new Date(),
        supplierName: inv.supplierName,
        referenceType: "PURCHASE_INVOICE_CANCEL",
        referenceNumber: inv.invoiceNumber,
        poNo: String(inv.linkedPoNumber || "").trim(),
        supplierInvoiceNo: String(inv.supplierInvoiceNo || "").trim(),
        currency: String(inv.currency || "USD").trim().toUpperCase(),
        paymentStatus: "CANCELLED",
        debit: 0,
        credit: Number(inv.totalAmount) || 0,
        narrative: `Reversal of purchase invoice ${inv.invoiceNumber}`,
        createdBy: req.user?.email || "",
      });
    }
    inv.status = "CANCELLED";
    inv.balanceAmount = 0;
    inv.updatedBy = req.user?.email || "";
    await inv.save();
    if (inv.linkedPoId) {
      await syncPurchaseOrderApExtensionFields(req.companyId, inv.linkedPoId);
    }
    await writeAudit(req, {
      action: "CANCEL",
      module: "ACCOUNTS",
      entityType: "PURCHASE_INVOICE",
      entityId: inv._id,
      documentNo: inv.invoiceNumber,
      fromStatus: "POSTED",
      toStatus: "CANCELLED",
      description: `Purchase invoice ${inv.invoiceNumber} cancelled`,
    });
    res.json(inv);
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

async function recalcPurchaseInvoicePaymentState(req, purchaseInvoiceId) {
  const inv = await PurchaseInvoice.findOne(withCompany(req, { _id: purchaseInvoiceId }));
  if (!inv) return null;
  const paidAgg = await SupplierPayment.aggregate([
    {
      $match: withCompany(req, {
        status: { $nin: ["CANCELLED", "DRAFT"] },
        "allocations.purchaseInvoiceId": inv._id,
      }),
    },
    { $unwind: "$allocations" },
    { $match: { "allocations.purchaseInvoiceId": inv._id } },
    { $group: { _id: null, paid: { $sum: "$allocations.allocatedAmount" } } },
  ]);
  const paid = Math.max(0, Number(paidAgg[0]?.paid || 0));
  const total = Math.max(0, Number(inv.totalAmount) || 0);
  inv.totalPaidAmount = paid;
  inv.balanceAmount = Math.max(0, total - paid);
  inv.paymentStatus = paid <= 0 ? "UNPAID" : paid < total ? "PARTIAL" : "PAID";
  await inv.save();
  return inv;
}

export async function listSupplierPayments(req, res) {
  try {
    const { page, limit, skip } = paginate(req);
    const filter = withCompany(req);
    if (req.query.supplierName) filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    const [items, total] = await Promise.all([
      SupplierPayment.find(filter).sort({ paymentDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      SupplierPayment.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSupplierPayment(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await SupplierPayment.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** POST /supplier-payments/:id/post — payments post on create; this confirms current state. */
export async function postSupplierPaymentAck(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await SupplierPayment.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({
      ok: true,
      payment: row,
      note: "Supplier payments are posted when created; there is no separate draft post step.",
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function buildSupplierPaymentAllocations(req, { supplierName, amountPaid, payCur, exchangeRate, allocationsInput }) {
  const allocations = [];
  const rows = Array.isArray(allocationsInput) ? allocationsInput : [];
  for (const row of rows) {
    if (!mongoose.Types.ObjectId.isValid(String(row?.purchaseInvoiceId || ""))) {
      if (Number(row?.allocatedAmount) > 0) {
        return { error: "Invalid purchaseInvoiceId in allocations", allocations: [], allocatedAmount: 0 };
      }
      continue;
    }
    const allocatedAmount = Number(row?.allocatedAmount) || 0;
    if (!(allocatedAmount > 0)) continue;
    const inv = await PurchaseInvoice.findOne(withCompany(req, { _id: row.purchaseInvoiceId }));
    if (!inv) return { error: "Purchase invoice not found for allocation", allocations: [], allocatedAmount: 0 };
    if (String(inv.status || "").toUpperCase() !== "POSTED") {
      return {
        error: `Invoice ${inv.invoiceNumber} is not booked (POSTED). Book the purchase invoice before allocating this payment.`,
        allocations: [],
        allocatedAmount: 0,
      };
    }
    if (String(inv.supplierName || "").trim().toLowerCase() !== supplierName.toLowerCase()) {
      return { error: `Supplier mismatch for invoice ${inv.invoiceNumber}`, allocations: [], allocatedAmount: 0 };
    }
    const invCur = String(inv.currency || "USD").trim().toUpperCase();
    if (invCur !== payCur) {
      const xr = Number(exchangeRate);
      if (!Number.isFinite(xr) || xr <= 0) {
        return { error: "Currency mismatch with invoice requires exchangeRate", allocations: [], allocatedAmount: 0 };
      }
    }
    const remaining = Math.max(0, (Number(inv.totalAmount) || 0) - (Number(inv.totalPaidAmount) || 0));
    if (allocatedAmount > remaining + 0.01) {
      return {
        error: `Allocation exceeds balance for ${inv.invoiceNumber} (balance ${remaining.toFixed(2)})`,
        allocations: [],
        allocatedAmount: 0,
      };
    }
    allocations.push({
      purchaseInvoiceId: inv._id,
      purchaseInvoiceNo: inv.invoiceNumber || "",
      allocatedAmount,
    });
  }
  const allocatedAmount = allocations.reduce((n, x) => n + (Number(x.allocatedAmount) || 0), 0);
  if (allocatedAmount - amountPaid > 0.0001) {
    return { error: "Allocated amount cannot exceed amount paid", allocations: [], allocatedAmount: 0 };
  }
  return { error: null, allocations, allocatedAmount };
}

export async function createSupplierPayment(req, res) {
  try {
    const supplierName = String(req.body?.supplierName || "").trim();
    if (!supplierName) return res.status(400).json({ message: "supplierName is required" });
    const amountPaid = Number(req.body?.amountPaid);
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      return res.status(400).json({ message: "amountPaid must be greater than zero" });
    }
    const payCur = String(req.body?.currency || "USD").trim().toUpperCase();

    const saveAsDraft = Boolean(req.body?.saveAsDraft);
    if (saveAsDraft) {
      const paymentNo = await nextSequentialNumber(
        SupplierPayment,
        "paymentNo",
        `${req.companyCode || "CMP"}-SP`,
        { companyId: req.companyId }
      );
      const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
      const payment = await SupplierPayment.create({
        companyId: req.companyId,
        branchId: mongoose.Types.ObjectId.isValid(String(req.body?.branchId || ""))
          ? new mongoose.Types.ObjectId(String(req.body.branchId))
          : null,
        linkedPoNo: String(req.body?.linkedPoNo || "").trim(),
        supplierPiNo: String(req.body?.supplierPiNo || "").trim(),
        supplierInvoiceNo: String(req.body?.supplierInvoiceNo || "").trim(),
        exchangeRate: Number(req.body?.exchangeRate) > 0 ? Number(req.body.exchangeRate) : 1,
        paymentNo,
        paymentDate: req.body?.paymentDate ? new Date(req.body.paymentDate) : new Date(),
        supplierName,
        currency: payCur,
        amountPaid,
        allocatedAmount: 0,
        unallocatedAmount: amountPaid,
        paymentMode: String(req.body?.paymentMode || "BANK_TRANSFER").trim().toUpperCase(),
        bankCashAccountName: String(req.body?.bankCashAccountName || req.body?.accountName || "").trim(),
        paymentReference: String(req.body?.paymentReference || "").trim(),
        remarks: String(req.body?.remarks || "").trim(),
        attachments,
        allocations: [],
        status: "DRAFT",
        paymentCategory: String(req.body?.paymentCategory || "").trim().toUpperCase(),
        createdBy: req.user?.email || "",
        updatedBy: req.user?.email || "",
      });
      await writeAudit(req, {
        action: "CREATE",
        module: "ACCOUNTS",
        entityType: "SUPPLIER_PAYMENT",
        entityId: payment._id,
        documentNo: payment.paymentNo,
        description: `Supplier payment draft ${payment.paymentNo} for ${supplierName}`,
      });
      return res.status(201).json(payment);
    }

    const allocBuild = await buildSupplierPaymentAllocations(req, {
      supplierName,
      amountPaid,
      payCur,
      exchangeRate: req.body?.exchangeRate,
      allocationsInput: req.body?.allocations,
    });
    if (allocBuild.error) return res.status(400).json({ message: allocBuild.error });
    const { allocations, allocatedAmount } = allocBuild;
    const paymentNo = await nextSequentialNumber(
      SupplierPayment,
      "paymentNo",
      `${req.companyCode || "CMP"}-SP`,
      { companyId: req.companyId }
    );
    const status = allocatedAmount <= 0 ? "POSTED" : allocatedAmount < amountPaid ? "PARTIALLY_ALLOCATED" : "FULLY_ALLOCATED";
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "ACCOUNTS",
      actionKey: "supplier_payment_post",
      documentType: "SUPPLIER_PAYMENT",
      documentNo: paymentNo,
      customerName: supplierName,
      amount: amountPaid,
      currency: String(req.body?.currency || "USD").trim().toUpperCase(),
      description: `Post supplier payment for ${supplierName}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));
    const payment = await SupplierPayment.create({
      companyId: req.companyId,
      branchId: mongoose.Types.ObjectId.isValid(String(req.body?.branchId || ""))
        ? new mongoose.Types.ObjectId(String(req.body.branchId))
        : null,
      linkedPoNo: String(req.body?.linkedPoNo || "").trim(),
      supplierPiNo: String(req.body?.supplierPiNo || "").trim(),
      supplierInvoiceNo: String(req.body?.supplierInvoiceNo || "").trim(),
      exchangeRate: Number(req.body?.exchangeRate) > 0 ? Number(req.body.exchangeRate) : 1,
      paymentNo,
      paymentDate: req.body?.paymentDate ? new Date(req.body.paymentDate) : new Date(),
      supplierName,
      currency: String(req.body?.currency || "USD").trim().toUpperCase(),
      amountPaid,
      allocatedAmount,
      unallocatedAmount: Math.max(0, amountPaid - allocatedAmount),
      paymentMode: String(req.body?.paymentMode || "BANK_TRANSFER").trim().toUpperCase(),
      bankCashAccountName: String(req.body?.bankCashAccountName || req.body?.accountName || "").trim(),
      paymentReference: String(req.body?.paymentReference || "").trim(),
      remarks: String(req.body?.remarks || "").trim(),
      attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
      allocations,
      status,
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    const cashBank = await CashBankEntry.create({
      companyId: req.companyId,
      entryDate: payment.paymentDate,
      accountName: payment.bankCashAccountName || "Bank/Cash",
      transactionType: "PAYMENT",
      referenceNumber: payment.paymentReference || payment.paymentNo,
      sourceModule: "Accounts",
      sourceType: "Supplier Payment",
      sourceId: payment._id,
      currency: payment.currency,
      partyName: payment.supplierName,
      amount: payment.amountPaid,
      mode: payment.paymentMode,
      paymentReference: payment.paymentReference || "",
      remarks: payment.remarks || "",
      createdBy: req.user?.email || "",
    });
    let firstPoNo = "";
    let firstBranchId = null;
    if (allocations.length) {
      const inv0 = await PurchaseInvoice.findOne(withCompany(req, { _id: allocations[0].purchaseInvoiceId }))
        .select("linkedPoNumber branchId")
        .lean();
      firstPoNo = String(inv0?.linkedPoNumber || "").trim();
      firstBranchId = inv0?.branchId || null;
    }
    const supplierLedger = await SupplierLedgerEntry.create({
      companyId: req.companyId,
      branchId: firstBranchId || payment.branchId || null,
      entryDate: payment.paymentDate,
      supplierName: payment.supplierName,
      referenceType: "SUPPLIER_PAYMENT",
      referenceNumber: payment.paymentNo,
      poNo: firstPoNo,
      supplierInvoiceNo: String(req.body?.supplierInvoiceNo || payment.supplierInvoiceNo || "").trim(),
      currency: String(payment.currency || "USD").trim().toUpperCase(),
      paymentStatus: "PAID",
      debit: 0,
      credit: payment.amountPaid,
      narrative: `Supplier payment ${payment.paymentNo}`,
      createdBy: req.user?.email || "",
    });
    payment.linkedCashBankEntryId = cashBank._id;
    payment.linkedSupplierLedgerEntryId = supplierLedger._id;
    await payment.save();
    for (const row of allocations) {
      await recalcPurchaseInvoicePaymentState(req, row.purchaseInvoiceId);
    }
    const linkedPoIds = new Set();
    for (const row of allocations) {
      const inv = await PurchaseInvoice.findOne(withCompany(req, { _id: row.purchaseInvoiceId }))
        .select("linkedPoId")
        .lean();
      if (inv?.linkedPoId) linkedPoIds.add(String(inv.linkedPoId));
    }
    const linkedPoRaw = String(req.body?.linkedPoNo || payment.linkedPoNo || "").trim();
    if (linkedPoRaw) {
      const poRow = await PurchaseOrder.findOne(
        withCompany(req, { $or: [{ poNo: linkedPoRaw }, { poNumber: linkedPoRaw }] })
      )
        .select("_id")
        .lean();
      if (poRow?._id) linkedPoIds.add(String(poRow._id));
    }
    for (const pid of linkedPoIds) {
      await syncPurchaseOrderApExtensionFields(req.companyId, pid);
    }
    await writeAudit(req, {
      action: "PAYMENT",
      module: "ACCOUNTS",
      entityType: "SUPPLIER_PAYMENT",
      entityId: payment._id,
      documentNo: payment.paymentNo,
      description: `Supplier payment ${payment.paymentNo} posted for ${payment.supplierName}`,
      metadata: { amountPaid: payment.amountPaid, allocationCount: allocations.length },
    });
    res.status(201).json(payment);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/** POST /accounts/supplier-payments/:id/post — finalize a DRAFT supplier payment (ledger, cash bank, PI recalc). */
export async function postDraftSupplierPayment(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await SupplierPayment.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (String(row.status || "").toUpperCase() !== "DRAFT") {
      return res.status(400).json({ message: "Only draft supplier payments can be posted via this action" });
    }

    const body = req.body || {};
    const supplierName = String(body.supplierName || row.supplierName || "").trim();
    if (!supplierName) return res.status(400).json({ message: "supplierName is required" });
    const amountPaid = Number(body.amountPaid ?? row.amountPaid);
    if (!Number.isFinite(amountPaid) || amountPaid <= 0) {
      return res.status(400).json({ message: "amountPaid must be greater than zero" });
    }
    const payCur = String(body.currency || row.currency || "USD").trim().toUpperCase();

    row.supplierName = supplierName;
    row.amountPaid = amountPaid;
    row.currency = payCur;
    if (body.paymentDate) row.paymentDate = new Date(body.paymentDate);
    row.linkedPoNo = String(body.linkedPoNo ?? row.linkedPoNo ?? "").trim();
    row.supplierPiNo = String(body.supplierPiNo ?? row.supplierPiNo ?? "").trim();
    row.supplierInvoiceNo = String(body.supplierInvoiceNo ?? row.supplierInvoiceNo ?? "").trim();
    row.paymentMode = String(body.paymentMode || row.paymentMode || "BANK_TRANSFER").trim().toUpperCase();
    row.bankCashAccountName = String(body.bankCashAccountName || row.bankCashAccountName || "").trim();
    row.paymentReference = String(body.paymentReference ?? row.paymentReference ?? "").trim();
    row.remarks = String(body.remarks ?? row.remarks ?? "").trim();
    row.paymentCategory = String(body.paymentCategory ?? row.paymentCategory ?? "").trim().toUpperCase();
    if (Array.isArray(body.attachments) && body.attachments.length) {
      row.attachments = [...(row.attachments || []), ...body.attachments];
    }
    row.exchangeRate = Number(body.exchangeRate) > 0 ? Number(body.exchangeRate) : Number(row.exchangeRate) || 1;

    const allocBuild = await buildSupplierPaymentAllocations(req, {
      supplierName,
      amountPaid,
      payCur,
      exchangeRate: body.exchangeRate,
      allocationsInput: body.allocations,
    });
    if (allocBuild.error) return res.status(400).json({ message: allocBuild.error });
    const { allocations, allocatedAmount } = allocBuild;

    const status =
      allocatedAmount <= 0 ? "POSTED" : allocatedAmount < amountPaid ? "PARTIALLY_ALLOCATED" : "FULLY_ALLOCATED";

    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "ACCOUNTS",
      actionKey: "supplier_payment_post",
      documentType: "SUPPLIER_PAYMENT",
      documentNo: row.paymentNo,
      customerName: supplierName,
      amount: amountPaid,
      currency: payCur,
      description: `Post supplier payment for ${supplierName}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));

    row.allocations = allocations;
    row.allocatedAmount = allocatedAmount;
    row.unallocatedAmount = Math.max(0, amountPaid - allocatedAmount);
    row.status = status;
    row.updatedBy = req.user?.email || "";

    const cashBank = await CashBankEntry.create({
      companyId: req.companyId,
      entryDate: row.paymentDate,
      accountName: row.bankCashAccountName || "Bank/Cash",
      transactionType: "PAYMENT",
      referenceNumber: row.paymentReference || row.paymentNo,
      sourceModule: "Accounts",
      sourceType: "Supplier Payment",
      sourceId: row._id,
      currency: row.currency,
      partyName: row.supplierName,
      amount: row.amountPaid,
      mode: row.paymentMode,
      paymentReference: row.paymentReference || "",
      remarks: row.remarks || "",
      createdBy: req.user?.email || "",
    });
    let firstPoNo = "";
    let firstBranchId = null;
    if (allocations.length) {
      const inv0 = await PurchaseInvoice.findOne(withCompany(req, { _id: allocations[0].purchaseInvoiceId }))
        .select("linkedPoNumber branchId")
        .lean();
      firstPoNo = String(inv0?.linkedPoNumber || "").trim();
      firstBranchId = inv0?.branchId || null;
    }
    const supplierLedger = await SupplierLedgerEntry.create({
      companyId: req.companyId,
      branchId: firstBranchId || row.branchId || null,
      entryDate: row.paymentDate,
      supplierName: row.supplierName,
      referenceType: "SUPPLIER_PAYMENT",
      referenceNumber: row.paymentNo,
      poNo: firstPoNo,
      supplierInvoiceNo: String(body.supplierInvoiceNo || row.supplierInvoiceNo || "").trim(),
      currency: String(row.currency || "USD").trim().toUpperCase(),
      paymentStatus: "PAID",
      debit: 0,
      credit: row.amountPaid,
      narrative: `Supplier payment ${row.paymentNo}`,
      createdBy: req.user?.email || "",
    });
    row.linkedCashBankEntryId = cashBank._id;
    row.linkedSupplierLedgerEntryId = supplierLedger._id;
    await row.save();

    for (const alloc of allocations) {
      await recalcPurchaseInvoicePaymentState(req, alloc.purchaseInvoiceId);
    }
    const linkedPoIds = new Set();
    for (const alloc of allocations) {
      const inv = await PurchaseInvoice.findOne(withCompany(req, { _id: alloc.purchaseInvoiceId }))
        .select("linkedPoId")
        .lean();
      if (inv?.linkedPoId) linkedPoIds.add(String(inv.linkedPoId));
    }
    const linkedPoRaw = String(body.linkedPoNo || row.linkedPoNo || "").trim();
    if (linkedPoRaw) {
      const poRow = await PurchaseOrder.findOne(
        withCompany(req, { $or: [{ poNo: linkedPoRaw }, { poNumber: linkedPoRaw }] })
      )
        .select("_id")
        .lean();
      if (poRow?._id) linkedPoIds.add(String(poRow._id));
    }
    for (const pid of linkedPoIds) {
      await syncPurchaseOrderApExtensionFields(req.companyId, pid);
    }
    await writeAudit(req, {
      action: "PAYMENT",
      module: "ACCOUNTS",
      entityType: "SUPPLIER_PAYMENT",
      entityId: row._id,
      documentNo: row.paymentNo,
      description: `Supplier payment ${row.paymentNo} posted for ${row.supplierName}`,
      metadata: { amountPaid: row.amountPaid, allocationCount: allocations.length },
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/** DELETE /accounts/supplier-payments/:id/draft — remove a DRAFT payment only (no ledger impact). */
export async function deleteSupplierPaymentDraft(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await SupplierPayment.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (String(row.status || "").toUpperCase() !== "DRAFT") {
      return res.status(400).json({ message: "Only draft supplier payments can be deleted here" });
    }
    await row.deleteOne();
    await writeAudit(req, {
      action: "DELETE",
      module: "ACCOUNTS",
      entityType: "SUPPLIER_PAYMENT",
      entityId: row._id,
      documentNo: row.paymentNo,
      description: `Draft supplier payment ${row.paymentNo} deleted`,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateSupplierPayment(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const row = await SupplierPayment.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (String(row.status || "").toUpperCase() === "CANCELLED") {
      return res.status(409).json({ message: "Cancelled payment cannot be edited" });
    }
    const b = req.body || {};
    if (String(row.status || "").toUpperCase() === "DRAFT") {
      if (b.supplierName !== undefined) row.supplierName = String(b.supplierName || "").trim();
      if (b.amountPaid !== undefined) row.amountPaid = Number(b.amountPaid) || 0;
      if (b.currency !== undefined) row.currency = String(b.currency || "USD").trim().toUpperCase();
      if (b.paymentDate !== undefined) row.paymentDate = b.paymentDate ? new Date(b.paymentDate) : row.paymentDate;
      if (b.linkedPoNo !== undefined) row.linkedPoNo = String(b.linkedPoNo || "").trim();
      if (b.supplierInvoiceNo !== undefined) row.supplierInvoiceNo = String(b.supplierInvoiceNo || "").trim();
      if (b.supplierPiNo !== undefined) row.supplierPiNo = String(b.supplierPiNo || "").trim();
      if (b.paymentMode !== undefined) row.paymentMode = String(b.paymentMode || "").trim().toUpperCase();
      if (b.bankCashAccountName !== undefined) row.bankCashAccountName = String(b.bankCashAccountName || "").trim();
      if (b.paymentReference !== undefined) row.paymentReference = String(b.paymentReference || "").trim();
      if (b.paymentCategory !== undefined) row.paymentCategory = String(b.paymentCategory || "").trim().toUpperCase();
      if (b.exchangeRate !== undefined) row.exchangeRate = Number(b.exchangeRate) > 0 ? Number(b.exchangeRate) : 1;
      if (Array.isArray(b.attachments)) row.attachments = b.attachments;
      if (b.remarks !== undefined) row.remarks = String(b.remarks || "");
      row.unallocatedAmount = Math.max(0, (Number(row.amountPaid) || 0) - (Number(row.allocatedAmount) || 0));
    } else {
      if (Array.isArray(b.attachments)) row.attachments = b.attachments;
      if (b.remarks !== undefined) row.remarks = String(b.remarks || "");
    }
    row.updatedBy = req.user?.email || "";
    await row.save();
    await writeAudit(req, {
      action: "UPDATE",
      module: "ACCOUNTS",
      entityType: "SUPPLIER_PAYMENT",
      entityId: row._id,
      documentNo: row.paymentNo,
      description: `Supplier payment ${row.paymentNo} updated`,
      metadata: { attachmentCount: row.attachments?.length || 0 },
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelSupplierPayment(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const reason = String(req.body?.reason || req.body?.cancellationReason || "").trim();
    if (!reason) return res.status(400).json({ message: "cancellationReason is required" });
    const row = await SupplierPayment.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    if (String(row.status || "").toUpperCase() === "CANCELLED") {
      return res.status(400).json({ message: "Payment already cancelled" });
    }
    if (String(row.status || "").toUpperCase() === "DRAFT") {
      row.status = "CANCELLED";
      row.updatedBy = req.user?.email || "";
      row.remarks = `${row.remarks || ""}${row.remarks ? " " : ""}[CANCELLED (draft): ${reason}]`;
      await row.save();
      await writeAudit(req, {
        action: "CANCEL",
        module: "ACCOUNTS",
        entityType: "SUPPLIER_PAYMENT",
        entityId: row._id,
        documentNo: row.paymentNo,
        description: `Draft supplier payment ${row.paymentNo} cancelled`,
      });
      return res.json(row);
    }
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "ACCOUNTS",
      actionKey: "supplier_payment_cancel",
      documentType: "SUPPLIER_PAYMENT",
      documentId: row._id,
      documentNo: row.paymentNo,
      customerName: row.supplierName,
      amount: row.amountPaid,
      currency: row.currency,
      description: `Cancel supplier payment ${row.paymentNo}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));

    await SupplierLedgerEntry.create({
      companyId: req.companyId,
      entryDate: new Date(),
      supplierName: row.supplierName,
      referenceType: "SUPPLIER_PAYMENT_CANCEL",
      referenceNumber: row.paymentNo,
      debit: Number(row.amountPaid) || 0,
      credit: 0,
      narrative: `Reversal of supplier payment ${row.paymentNo}`,
      createdBy: req.user?.email || "",
    });
    await CashBankEntry.create({
      companyId: req.companyId,
      entryDate: new Date(),
      accountName: row.bankCashAccountName || "Bank/Cash",
      transactionType: "RECEIPT",
      referenceNumber: row.paymentReference || row.paymentNo,
      sourceModule: "Accounts",
      sourceType: "Supplier Payment Reversal",
      sourceId: row._id,
      currency: row.currency || "USD",
      partyName: row.supplierName || "",
      amount: Number(row.amountPaid) || 0,
      mode: row.paymentMode || "",
      paymentReference: row.paymentReference || "",
      remarks: `Reversal of supplier payment ${row.paymentNo}`,
      createdBy: req.user?.email || "",
    });
    row.status = "CANCELLED";
    row.updatedBy = req.user?.email || "";
    row.remarks = `${row.remarks || ""}${row.remarks ? " " : ""}[CANCELLED: ${reason}]`;
    await row.save();
    for (const a of row.allocations || []) {
      await recalcPurchaseInvoicePaymentState(req, a.purchaseInvoiceId);
    }
    const linkedPoIds = new Set();
    for (const a of row.allocations || []) {
      const inv = await PurchaseInvoice.findOne(withCompany(req, { _id: a.purchaseInvoiceId }))
        .select("linkedPoId")
        .lean();
      if (inv?.linkedPoId) linkedPoIds.add(String(inv.linkedPoId));
    }
    const linkedPoRaw = String(row.linkedPoNo || "").trim();
    if (linkedPoRaw) {
      const poRow = await PurchaseOrder.findOne(
        withCompany(req, { $or: [{ poNo: linkedPoRaw }, { poNumber: linkedPoRaw }] })
      )
        .select("_id")
        .lean();
      if (poRow?._id) linkedPoIds.add(String(poRow._id));
    }
    for (const pid of linkedPoIds) {
      await syncPurchaseOrderApExtensionFields(req.companyId, pid);
    }
    await writeAudit(req, {
      action: "CANCEL",
      module: "ACCOUNTS",
      entityType: "SUPPLIER_PAYMENT",
      entityId: row._id,
      documentNo: row.paymentNo,
      fromStatus: "POSTED",
      toStatus: "CANCELLED",
      description: `Supplier payment ${row.paymentNo} cancelled`,
      metadata: { reason, reversal: true },
    });
    await writeAudit(req, {
      action: "STATUS_CHANGE",
      module: "ACCOUNTS",
      entityType: "AP_LEDGER",
      entityId: row._id,
      documentNo: row.paymentNo,
      description: `AP ledger reversal posted for ${row.paymentNo}`,
      metadata: { reason },
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function supplierOutstandingReport(req, res) {
  try {
    const filter = withCompany(req, { status: "POSTED" });
    if (req.query.supplierName) filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    const invoices = await PurchaseInvoice.find(filter).sort({ invoiceDate: -1 }).lean();
    const rows = invoices
      .map((inv) => {
        const invoiceAmount = Math.max(0, Number(inv.totalAmount) || 0);
        const paidAmount = Math.max(0, Number(inv.totalPaidAmount) || 0);
        const balance = Math.max(0, invoiceAmount - paidAmount);
        const dueDate = inv.dueDate ? new Date(inv.dueDate) : dueDateForPurchaseInvoice(inv);
        const ageing = ageingBucketFromDueDate(dueDate);
        return {
          supplier: inv.supplierName || "",
          invoiceNo: inv.invoiceNumber || "",
          invoiceAmount,
          paidAmount,
          balance,
          dueDate,
          ageingBucket: ageing.bucket,
          currency: inv.currency || "USD",
        };
      })
      .filter((x) => x.balance > 0 || req.query.includePaid === "1");
    res.json({ items: rows });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function apAgeingReport(req, res) {
  try {
    const filter = withCompany(req, { status: "POSTED" });
    if (req.query.supplierName) filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    const invs = await PurchaseInvoice.find(filter).lean();
    const bucketBySupplier = new Map();
    for (const inv of invs) {
      const total = Math.max(0, Number(inv.totalAmount) || 0);
      const paid = Math.max(0, Number(inv.totalPaidAmount) || 0);
      const bal = Math.max(0, total - paid);
      if (bal <= 0) continue;
      const dueDate = inv.dueDate ? new Date(inv.dueDate) : dueDateForPurchaseInvoice(inv);
      const { bucket, days } = ageingBucketFromDueDate(dueDate);
      const key = `${inv.supplierName || ""}::${inv.currency || "USD"}`;
      if (!bucketBySupplier.has(key)) {
        bucketBySupplier.set(key, {
          supplier: inv.supplierName || "",
          currency: inv.currency || "USD",
          current: 0,
          d0_30: 0,
          d31_60: 0,
          d61_90: 0,
          d90Plus: 0,
          totalOutstanding: 0,
        });
      }
      const row = bucketBySupplier.get(key);
      if (bucket === "Current") row.current += bal;
      else if (days <= 30) row.d0_30 += bal;
      else if (days <= 60) row.d31_60 += bal;
      else if (days <= 90) row.d61_90 += bal;
      else row.d90Plus += bal;
      row.totalOutstanding += bal;
    }
    res.json({ items: Array.from(bucketBySupplier.values()) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function supplierPaymentSummaryReport(req, res) {
  try {
    const filter = withCompany(req, {});
    if (req.query.status) filter.status = String(req.query.status).trim().toUpperCase();
    const payments = await SupplierPayment.find(filter).sort({ paymentDate: -1 }).lean();
    const bySupplier = new Map();
    for (const p of payments) {
      const key = p.supplierName || "—";
      if (!bySupplier.has(key)) bySupplier.set(key, { supplier: key, paymentCount: 0, amountPaid: 0, allocatedAmount: 0, cancelledCount: 0, currency: p.currency || "USD" });
      const row = bySupplier.get(key);
      row.paymentCount += 1;
      row.amountPaid += Number(p.amountPaid) || 0;
      row.allocatedAmount += Number(p.allocatedAmount) || 0;
      if (String(p.status || "").toUpperCase() === "CANCELLED") row.cancelledCount += 1;
    }
    res.json({ items: Array.from(bySupplier.values()).sort((a, b) => b.amountPaid - a.amountPaid) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function supplierLedgerSummaryReport(req, res) {
  try {
    const filter = withCompany(req, {});
    if (req.query.supplierName) filter.supplierName = new RegExp(String(req.query.supplierName).trim(), "i");
    const rows = await SupplierLedgerEntry.find(filter).sort({ entryDate: 1, createdAt: 1 }).lean();
    let running = 0;
    const items = rows.map((r) => {
      running += (Number(r.debit) || 0) - (Number(r.credit) || 0);
      return { ...r, runningBalance: running };
    });
    res.json({ items, closingBalance: running });
  } catch (err) {
    res.status(500).json({ message: err.message });
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

/** Consolidated AP dashboard metrics (company-scoped). */
export async function getApDashboard(req, res) {
  try {
    const pos = await PurchaseOrder.find(withCompany(req, { status: { $nin: ["CANCELLED", "DRAFT"] } }))
      .select("grandTotal currency status")
      .lean();
    const totalPurchaseValue = pos.reduce((n, p) => n + (Number(p.grandTotal) || 0), 0);

    const pis = await PurchaseInvoice.find(withCompany(req, { status: "POSTED" })).lean();
    let totalPayables = 0;
    let overduePayables = 0;
    let pendingInvoices = 0;
    let partialInvoices = 0;
    let paidInvoices = 0;
    const now = Date.now();
    for (const inv of pis) {
      const bal = Math.max(0, (Number(inv.totalAmount) || 0) - (Number(inv.totalPaidAmount) || 0));
      totalPayables += bal;
      const due = inv.dueDate ? new Date(inv.dueDate) : dueDateForPurchaseInvoice(inv);
      if (bal > 0.001 && due.getTime() < now) overduePayables += bal;
      const ps = String(inv.paymentStatus || "").toUpperCase();
      if (ps === "UNPAID" && bal > 0.001) pendingInvoices += 1;
      else if (ps === "PARTIAL") partialInvoices += 1;
      else if (ps === "PAID" || bal <= 0.001) paidInvoices += 1;
    }

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const paymentsMonth = await SupplierPayment.aggregate([
      { $match: { ...withCompany(req), status: { $nin: ["CANCELLED", "DRAFT"] }, paymentDate: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$amountPaid" } } },
    ]);
    const paymentsDoneThisMonth = Number(paymentsMonth[0]?.total || 0);

    const unalloc = await SupplierPayment.aggregate([
      { $match: { ...withCompany(req), status: { $nin: ["CANCELLED", "DRAFT"] } } },
      { $group: { _id: null, u: { $sum: "$unallocatedAmount" } } },
    ]);
    const advancePaid = Number(unalloc[0]?.u || 0);

    const supplierWise = new Map();
    for (const inv of pis) {
      const bal = Math.max(0, (Number(inv.totalAmount) || 0) - (Number(inv.totalPaidAmount) || 0));
      if (bal <= 0.001) continue;
      const k = `${inv.supplierName || "—"}::${inv.currency || "USD"}`;
      supplierWise.set(k, (supplierWise.get(k) || 0) + bal);
    }
    const supplierWiseOutstanding = Array.from(supplierWise.entries()).map(([k, balance]) => {
      const [supplier, currency] = k.split("::");
      return { supplier, currency, balance };
    });

    const draftCount = await PurchaseInvoice.countDocuments(withCompany(req, { status: "DRAFT" }));

    res.json({
      totalPurchaseValue,
      totalPayables,
      overduePayables,
      paymentsDoneThisMonth,
      advancePaid,
      pendingSupplierInvoices: pendingInvoices,
      partiallyPaidInvoices: partialInvoices,
      fullyPaidInvoices: paidInvoices,
      draftPurchaseInvoices: draftCount,
      supplierWiseOutstanding,
      currencyWiseOutstanding: [], // optional: aggregate from supplierWise
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listSupplierLedgerBySupplierId(req, res) {
  try {
    const { supplierId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(supplierId)) {
      return res.status(400).json({ message: "Invalid supplier id" });
    }
    const sup = await Supplier.findOne(withCompany(req, { _id: supplierId })).select("supplierName").lean();
    if (!sup) return res.status(404).json({ message: "Supplier not found" });
    const name = String(sup.supplierName || "").trim();
    const { page, limit, skip } = paginate(req);
    const prior = await SupplierLedgerEntry.find(withCompany(req, { supplierName: name }))
      .sort({ entryDate: 1, createdAt: 1 })
      .limit(skip)
      .select("debit credit")
      .lean();
    let running = prior.reduce((acc, e) => acc + (Number(e.debit) || 0) - (Number(e.credit) || 0), 0);
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
    res.json({ items: withBal, total, page, limit, supplierName: name, supplierId });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createPurchaseInvoiceDraftFromPo(req, res) {
  try {
    const poId = req.params.poId;
    if (!mongoose.Types.ObjectId.isValid(poId)) return res.status(400).json({ message: "Invalid PO id" });
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: poId }));
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    const body = req.body || {};
    const bodySupplier = String(body.supplierName || "").trim();
    if (bodySupplier && bodySupplier.toLowerCase() !== String(po.supplierName || "").trim().toLowerCase()) {
      return res.status(400).json({ message: "Supplier must match the purchase order supplier" });
    }
    if (!String(body.supplierInvoiceNo || "").trim()) {
      return res.status(400).json({ message: "supplierInvoiceNo is required" });
    }
    const cur = String(body.currency || po.currency || "USD")
      .trim()
      .toUpperCase();
    const lines =
      Array.isArray(body.lines) && body.lines.length
        ? body.lines.map((l) => ({
            itemCode: String(l.itemCode || "").trim().toUpperCase(),
            description: String(l.description || "").trim(),
            qty: Number(l.qty) || 0,
            rate: Number(l.rate ?? l.unitPrice) || 0,
          }))
        : (po.lines || []).map((l) => ({
            itemCode: String(l.itemCode || "").trim().toUpperCase(),
            description: String(l.description || "").trim(),
            qty: Number(l.qty) || 0,
            rate: Number(l.unitPrice) || 0,
          }));
    const filtered = lines.filter((l) => l.itemCode && l.qty > 0);
    if (!filtered.length) return res.status(400).json({ message: "At least one invoice line is required" });

    const invoiceNumber =
      String(body.invoiceNumber || "").trim() ||
      (await nextSequentialNumber(PurchaseInvoice, "invoiceNumber", `${req.companyCode || "CMP"}-PI`, {
        companyId: req.companyId,
      }));

    const doc = new PurchaseInvoice({
      companyId: req.companyId,
      branchId: body.branchId || po.branchId || null,
      linkedPoId: po._id,
      supplierId: po.supplierId || body.supplierId || null,
      invoiceNumber,
      invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : new Date(),
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      supplierName: po.supplierName,
      supplierInvoiceNo: String(body.supplierInvoiceNo || "").trim(),
      supplierInvoiceDate: body.supplierInvoiceDate ? new Date(body.supplierInvoiceDate) : null,
      linkedPoNumber: String(po.poNo || po.poNumber || "").trim(),
      currency: cur,
      paymentTerms: String(body.paymentTerms || po.paymentTerms || "").trim(),
      grnNo: String(body.grnNo || "").trim(),
      lines: filtered,
      taxAmount: Number(body.taxAmount) || 0,
      otherCharges: Number(body.otherCharges) || 0,
      remarks: String(body.remarks || "").trim(),
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      status: "DRAFT",
      paymentStatus: "UNPAID",
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    });
    doc.subTotal = sumInvoiceLines(doc.lines, "rate");
    doc.totalAmount = (doc.subTotal || 0) + (Number(doc.taxAmount) || 0) + (Number(doc.otherCharges) || 0);
    doc.totalPaidAmount = 0;
    doc.balanceAmount = doc.totalAmount;
    doc.dueDate = doc.dueDate || dueDateForPurchaseInvoice(doc);
    await doc.save();
    await syncPurchaseOrderApExtensionFields(req.companyId, po._id);
    await writeAudit(req, {
      action: "CREATE",
      module: "ACCOUNTS",
      entityType: "PURCHASE_INVOICE",
      entityId: doc._id,
      documentNo: doc.invoiceNumber,
      description: `Purchase invoice draft ${doc.invoiceNumber} for PO ${po.poNo}`,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function bookPurchaseInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const inv = await PurchaseInvoice.findOne(withCompany(req, { _id: id }));
    if (!inv) return res.status(404).json({ message: "Not found" });
    if (String(inv.status || "").toUpperCase() !== "DRAFT") {
      return res.status(400).json({ message: "Only DRAFT purchase invoices can be booked" });
    }
    const gate = await ensureApproval(req, {
      companyId: req.companyId,
      module: "ACCOUNTS",
      actionKey: "purchase_invoice_post",
      documentType: "PURCHASE_INVOICE",
      documentNo: inv.invoiceNumber || "",
      customerName: inv.supplierName || "",
      amount: Number(inv.totalAmount || 0),
      currency: String(inv.currency || "USD").trim().toUpperCase(),
      description: `Book purchase invoice ${inv.invoiceNumber}`,
    });
    if (!gate.approved) return res.status(202).json(approvalRequiredPayload(gate.request));

    inv.subTotal = sumInvoiceLines(inv.lines, "rate");
    inv.totalAmount = (inv.subTotal || 0) + (Number(inv.taxAmount) || 0) + (Number(inv.otherCharges) || 0);
    inv.balanceAmount = Math.max(0, (Number(inv.totalAmount) || 0) - (Number(inv.totalPaidAmount) || 0));
    inv.status = "POSTED";
    inv.updatedBy = req.user?.email || "";
    await inv.save();

    await SupplierLedgerEntry.create({
      companyId: req.companyId,
      branchId: inv.branchId || null,
      entryDate: inv.invoiceDate || new Date(),
      supplierName: inv.supplierName,
      referenceType: "PURCHASE_INVOICE",
      referenceNumber: inv.invoiceNumber,
      poNo: String(inv.linkedPoNumber || "").trim(),
      supplierInvoiceNo: String(inv.supplierInvoiceNo || "").trim(),
      currency: String(inv.currency || "USD").trim().toUpperCase(),
      paymentStatus: String(inv.paymentStatus || "UNPAID"),
      debit: Number(inv.totalAmount) || 0,
      credit: 0,
      narrative: `Purchase invoice ${inv.invoiceNumber} booked`,
      createdBy: req.user?.email || "",
    });
    if (inv.linkedPoId) {
      await syncPurchaseOrderApExtensionFields(req.companyId, inv.linkedPoId);
    }
    await writeAudit(req, {
      action: "POST",
      module: "ACCOUNTS",
      entityType: "PURCHASE_INVOICE",
      entityId: inv._id,
      documentNo: inv.invoiceNumber,
      description: `Purchase invoice ${inv.invoiceNumber} booked`,
    });
    res.json(inv);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/** GET /accounts/supplier-payments/from-po/:poId — PO, invoices, payments for supplier payment form */
export async function getSupplierPaymentContextFromPo(req, res) {
  try {
    const poId = req.params.poId;
    if (!mongoose.Types.ObjectId.isValid(poId)) return res.status(400).json({ message: "Invalid PO id" });
    const po = await PurchaseOrder.findOne(withCompany(req, { _id: poId }))
      .select("_id poNo poNumber supplierName supplierId currency grandTotal status paymentTerms orderDate")
      .lean();
    if (!po) return res.status(404).json({ message: "Purchase order not found" });
    const purchaseInvoices = await PurchaseInvoice.find(withCompany(req, { linkedPoId: poId }))
      .sort({ invoiceDate: -1 })
      .lean();
    const poNos = [...new Set([po.poNo, po.poNumber].map((s) => String(s || "").trim()).filter(Boolean))];
    const supplierPayments =
      poNos.length > 0
        ? await SupplierPayment.find(
            withCompany(req, { linkedPoNo: { $in: poNos }, status: { $ne: "CANCELLED" } })
          )
            .sort({ paymentDate: -1 })
            .limit(80)
            .lean()
        : [];
    const warnings = [];
    if (purchaseInvoices.some((i) => String(i.status || "").toUpperCase() === "DRAFT")) {
      warnings.push(
        "Supplier invoice is not booked. Payment can be saved as draft or advance without allocation to a PI."
      );
    }
    res.json({ po, purchaseInvoices, supplierPayments, warnings });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** POST /purchase-invoices/from-document/:documentId — draft PI from linked PO + purchase document */
export async function createPurchaseInvoiceFromPurchaseDocument(req, res) {
  try {
    const documentId = req.params.documentId;
    if (!mongoose.Types.ObjectId.isValid(documentId)) {
      return res.status(400).json({ message: "Invalid document id" });
    }
    const pd = await PurchaseDocument.findOne(withCompany(req, { _id: documentId, status: "ACTIVE" })).lean();
    if (!pd) return res.status(404).json({ message: "Purchase document not found" });
    const r = await createDraftPurchaseInvoiceFromPurchaseDocument({
      companyId: req.companyId,
      companyCode: req.companyCode || "CMP",
      userEmail: req.user?.email || "",
      purchaseDocument: pd,
      skipIfDraftExists: true,
      restrictAutoTypes: false,
    });
    if (r.skippedReason === "DRAFT_EXISTS" && r.invoice) {
      const full = await PurchaseInvoice.findOne(withCompany(req, { _id: r.invoice._id })).lean();
      return res.status(200).json({ ok: true, draftExists: true, invoice: full });
    }
    if (!r.created) {
      return res.status(400).json({ message: r.message || "Could not create purchase invoice draft" });
    }
    const inv = await PurchaseInvoice.findOne(withCompany(req, { _id: r.invoice._id }));
    if (!inv) return res.status(500).json({ message: "Invoice not found after create" });
    await syncPurchaseOrderApExtensionFields(req.companyId, inv.linkedPoId);
    await writeAudit(req, {
      action: "CREATE",
      module: "ACCOUNTS",
      entityType: "PURCHASE_INVOICE",
      entityId: inv._id,
      documentNo: inv.invoiceNumber,
      description: `Purchase invoice draft ${inv.invoiceNumber} from PO supplier document`,
    });
    res.status(201).json(inv);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

/** Recent supplier files attached to POs (for Accounts: create PI, trace payments). */
export async function listApPoSupplierDocuments(req, res) {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "40"), 10) || 40));
    const docs = await PurchaseDocument.find(withCompany(req, { status: "ACTIVE" }))
      .sort({ uploadedAt: -1 })
      .limit(limit)
      .lean();
    const rawIds = [...new Set(docs.map((d) => String(d.linkedPoId)).filter(Boolean))];
    const poIds = rawIds.filter((id) => mongoose.Types.ObjectId.isValid(id)).map((id) => new mongoose.Types.ObjectId(id));
    const pos =
      poIds.length === 0
        ? []
        : await PurchaseOrder.find(withCompany(req, { _id: { $in: poIds } }))
            .select("_id poNo poNumber supplierName currency status")
            .lean();
    const poMap = new Map(pos.map((p) => [String(p._id), p]));
    const invByPo =
      poIds.length === 0
        ? []
        : await PurchaseInvoice.find(
            withCompany(req, { linkedPoId: { $in: poIds }, status: { $in: ["DRAFT", "POSTED"] } })
          )
            .select("linkedPoId invoiceNumber status supplierInvoiceNo balanceAmount totalAmount totalPaidAmount _id")
            .lean();
    const invGroups = new Map();
    for (const i of invByPo) {
      const k = String(i.linkedPoId);
      if (!invGroups.has(k)) invGroups.set(k, []);
      invGroups.get(k).push(i);
    }
    const draftInvs =
      poIds.length === 0
        ? []
        : await PurchaseInvoice.find(withCompany(req, { linkedPoId: { $in: poIds }, status: "DRAFT" }))
            .select("linkedPoId invoiceNumber status supplierInvoiceNo _id")
            .lean();
    const draftByKey = new Map();
    for (const inv of draftInvs) {
      const kn = String(inv.supplierInvoiceNo || "").trim().toLowerCase();
      if (!kn) continue;
      const k = `${String(inv.linkedPoId)}:::${kn}`;
      if (!draftByKey.has(k)) draftByKey.set(k, inv);
    }
    const items = docs.map((d) => {
      const kn = String(d.documentNo || "").trim().toLowerCase();
      const draftKey = kn ? `${String(d.linkedPoId)}:::${kn}` : "";
      return {
        purchaseDocumentId: d._id,
        linkedPoId: d.linkedPoId,
        documentType: d.documentType,
        documentNo: d.documentNo,
        documentDate: d.documentDate,
        fileUrl: d.fileUrl,
        documentId: d.documentId,
        amount: d.amount,
        currency: d.currency,
        uploadedAt: d.uploadedAt,
        po: poMap.get(String(d.linkedPoId)) || null,
        purchaseInvoicesOnPo: invGroups.get(String(d.linkedPoId)) || [],
        draftPiForDoc: draftKey ? draftByKey.get(draftKey) || null : null,
      };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** Quick PO lookup for supplier payment / AP (by PO # or supplier name fragment). */
export async function searchApPurchaseOrders(req, res) {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ items: [] });
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rx = new RegExp(esc, "i");
    const items = await PurchaseOrder.find(
      withCompany(req, {
        status: { $nin: ["CANCELLED"] },
        $or: [{ poNo: rx }, { poNumber: rx }, { supplierName: rx }],
      })
    )
      .sort({ orderDate: -1 })
      .limit(30)
      .select("_id poNo poNumber supplierName currency grandTotal status")
      .lean();
    res.json({ items });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** Pending supplier PI / invoice documents (PurchaseDocument collection). */
export async function reportPendingSupplierDocuments(req, res) {
  try {
    const kind = String(req.query.kind || "PI").toUpperCase();
    const pos = await PurchaseOrder.find(withCompany(req, { status: { $nin: ["CANCELLED", "DRAFT"] } }))
      .select("_id poNo supplierName status supplierDocumentStatus")
      .lean();
    const poIds = pos.map((p) => p._id);
    const docs = await PurchaseDocument.find(withCompany(req, { linkedPoId: { $in: poIds }, status: "ACTIVE" }))
      .select("linkedPoId documentType uploadedAt")
      .lean();
    const hasPi = new Set(
      docs.filter((d) => d.documentType === "SUPPLIER_PROFORMA").map((d) => String(d.linkedPoId))
    );
    const hasInv = new Set(
      docs
        .filter((d) => ["SUPPLIER_TAX_INVOICE", "COMMERCIAL_INVOICE"].includes(d.documentType))
        .map((d) => String(d.linkedPoId))
    );
    const bookedInvByPo = new Set(
      (
        await PurchaseInvoice.find(
          withCompany(req, { status: "POSTED", linkedPoId: { $in: poIds } })
        )
          .select("linkedPoId")
          .lean()
      ).map((x) => String(x.linkedPoId))
    );
    const rows = [];
    for (const p of pos) {
      const id = String(p._id);
      if (kind === "PI" && !hasPi.has(id)) rows.push({ poNo: p.poNo, supplierName: p.supplierName, status: p.status });
      if (kind === "INVOICE" && !hasInv.has(id) && !bookedInvByPo.has(id)) {
        rows.push({ poNo: p.poNo, supplierName: p.supplierName, status: p.status });
      }
    }
    res.json({ items: rows, kind });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** PO vs GRN vs booked purchase invoice (lightweight reconciliation list). */
export async function reportPoGrnInvoice(req, res) {
  try {
    const pos = await PurchaseOrder.find(withCompany(req, {}))
      .sort({ createdAt: -1 })
      .limit(200)
      .select("poNo supplierName status grandTotal currency lines")
      .lean();
    const out = [];
    for (const p of pos) {
      const grnCount = await GRN.countDocuments(withCompany(req, { poId: p._id }));
      const invCount = await PurchaseInvoice.countDocuments(
        withCompany(req, { linkedPoId: p._id, status: { $ne: "CANCELLED" } })
      );
      out.push({
        poNo: p.poNo,
        supplierName: p.supplierName,
        poStatus: p.status,
        grnCount,
        purchaseInvoiceCount: invCount,
        grandTotal: p.grandTotal,
        currency: p.currency,
      });
    }
    res.json({ items: out });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
