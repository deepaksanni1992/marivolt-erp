import mongoose from "mongoose";
import Quotation from "../models/Quotation.js";
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import ProformaInvoice from "../models/ProformaInvoice.js";
import SalesInvoice from "../models/SalesInvoice.js";
import Cipl from "../models/Cipl.js";
import OrderAllocation from "../models/OrderAllocation.js";
import Rts from "../models/Rts.js";
import Customer from "../models/Customer.js";
import Company from "../models/Company.js";
import Item from "../models/Item.js";
import { nextSalesDocNumber } from "../utils/salesDocNumber.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function normalizeLines(lines = []) {
  return (lines || [])
    .map((line) => {
    const serialNo = Number(line.serialNo) || 0;
    const qty = Number(line.qty) || 0;
    const price = Number(line.price ?? line.salePrice) || 0;
    const totalPrice = qty * price;
    return {
      serialNo,
      article: String(line.article || line.itemCode || "").trim().toUpperCase(),
      partNumber: String(line.partNumber || line.partNo || "").trim(),
      description: String(line.description || ""),
      uom: String(line.uom || line.unit || "PCS").trim() || "PCS",
      qty,
      price,
      totalPrice,
      remarks: String(line.remarks || ""),
      materialCode: String(line.materialCode || "").trim(),
      availability: String(line.availability || "").trim(),
    };
  })
    .filter((line) => line.article && line.description && line.uom && line.qty > 0 && line.price >= 0)
    .map((line, idx) => ({ ...line, serialNo: idx + 1 }));
}

function computeTotals(lines = []) {
  let subTotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  for (const line of lines) {
    subTotal += Number(line.totalPrice) || 0;
  }
  return {
    subTotal,
    discountTotal,
    taxTotal,
    grandTotal: subTotal,
  };
}

function validateConversionSource(doc, messagePrefix = "document") {
  if (!doc) throw new Error("Source document not found");
  if (doc.status === "CANCELLED" || doc.status === "REJECTED") {
    throw new Error(`Cannot convert ${messagePrefix} with status ${doc.status}`);
  }
}

function requireApprovedQuotationForConversion(quotation) {
  const st = String(quotation?.status || "").toUpperCase();
  if (st !== "APPROVED") {
    throw new Error("Quotation must be APPROVED before it can be converted to OA, Proforma, or CIPL");
  }
}

function isOAEditLocked(doc) {
  if (!doc) return true;
  const st = String(doc.status || "").toUpperCase();
  if (["APPROVED", "CONVERTED", "CLOSED", "CANCELLED"].includes(st)) return true;
  const conv = Array.isArray(doc.convertedTo) ? doc.convertedTo.map(String) : [];
  return conv.includes("PROFORMA") || conv.includes("SALES_INVOICE");
}

/** Only DRAFT proformas are editable (matches Sales UI). */
function isProformaEditable(doc) {
  return doc && String(doc.status || "").toUpperCase() === "DRAFT";
}

function normalizeWeight(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function attachUnitWeightFromItems(req, lines = []) {
  if (!lines.length) return lines;
  const articles = Array.from(new Set(lines.map((l) => String(l.article || "").trim().toUpperCase()).filter(Boolean)));
  if (!articles.length) return lines;
  const items = await Item.find(withCompany(req, { itemCode: { $in: articles } }))
    .select("itemCode weightKg")
    .lean();
  const byCode = new Map(items.map((it) => [String(it.itemCode || "").toUpperCase(), normalizeWeight(it.weightKg)]));
  return lines.map((line) => {
    const fromItem = byCode.get(String(line.article || "").toUpperCase());
    return {
      ...line,
      unitWeightKg: normalizeWeight(line.unitWeightKg) ?? fromItem ?? null,
    };
  });
}

async function approvedRtsByAllocation(req, allocationId) {
  return Rts.find(
    withCompany(req, {
      linkedOrderAllocationId: allocationId,
      status: "APPROVED",
    })
  ).lean();
}

function shippedQtyMapForAllocation(approvedRtsDocs = []) {
  const shipped = new Map();
  for (const doc of approvedRtsDocs) {
    for (const line of doc.lines || []) {
      const key = String(line.allocationLineId || "");
      const prev = shipped.get(key) || 0;
      shipped.set(key, prev + (Number(line.qty) || 0));
    }
  }
  return shipped;
}

function isRtsEditable(doc) {
  if (!doc) return false;
  return !doc.linkedSalesInvoiceId;
}

const PENDING_QUOTATION_STATUSES = ["DRAFT", "SENT"];
const PENDING_OA_STATUSES = ["DRAFT", "CONFIRMED"];

function parseDateRange(query, fromKey = "dateFrom", toKey = "dateTo") {
  const range = {};
  if (query[fromKey]) {
    const from = new Date(String(query[fromKey]));
    if (!Number.isNaN(from.getTime())) range.$gte = from;
  }
  if (query[toKey]) {
    const to = new Date(String(query[toKey]));
    if (!Number.isNaN(to.getTime())) {
      to.setHours(23, 59, 59, 999);
      range.$lte = to;
    }
  }
  return Object.keys(range).length ? range : null;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export async function getSalesSummary(req, res) {
  try {
    const companyFilter = withCompany(req);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [
      totalQuotations,
      pendingQuotations,
      totalOA,
      pendingOA,
      totalProformas,
      totalSalesInvoices,
      unpaidSalesInvoices,
      totalCipl,
      salesValueAgg,
      monthSalesAgg,
    ] = await Promise.all([
      Quotation.countDocuments(companyFilter),
      Quotation.countDocuments(withCompany(req, { status: { $in: ["DRAFT", "SENT"] } })),
      OrderAcknowledgement.countDocuments(companyFilter),
      OrderAcknowledgement.countDocuments(withCompany(req, { status: { $in: ["DRAFT", "CONFIRMED"] } })),
      ProformaInvoice.countDocuments(companyFilter),
      SalesInvoice.countDocuments(companyFilter),
      SalesInvoice.countDocuments(withCompany(req, { status: { $in: ["DRAFT", "ISSUED", "PARTIALLY_PAID"] } })),
      Cipl.countDocuments(companyFilter),
      SalesInvoice.aggregate([
        { $match: companyFilter },
        { $group: { _id: null, total: { $sum: { $ifNull: ["$grandTotal", 0] } } } },
      ]),
      SalesInvoice.aggregate([
        { $match: withCompany(req, { invoiceDate: { $gte: monthStart } }) },
        { $group: { _id: null, total: { $sum: { $ifNull: ["$grandTotal", 0] } } } },
      ]),
    ]);

    res.json({
      totalQuotations,
      pendingQuotations,
      totalOA,
      pendingOA,
      totalProformas,
      totalSalesInvoices,
      unpaidSalesInvoices,
      totalCipl,
      totalSalesValue: Number(salesValueAgg?.[0]?.total || 0),
      thisMonthSales: Number(monthSalesAgg?.[0]?.total || 0),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportQuotationSummary(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const q = String(req.query.search || "").trim();
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.quotationDate = dateRange;
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.engine) filter.engine = new RegExp(String(req.query.engine).trim(), "i");
    if (req.query.model) filter.model = new RegExp(String(req.query.model).trim(), "i");
    if (req.query.esn) filter.esn = new RegExp(String(req.query.esn).trim(), "i");
    if (q) {
      filter.$or = [
        { quotationNo: new RegExp(q, "i") },
        { customerName: new RegExp(q, "i") },
        { customerReference: new RegExp(q, "i") },
        { engine: new RegExp(q, "i") },
        { model: new RegExp(q, "i") },
        { esn: new RegExp(q, "i") },
      ];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      Quotation.find(filter)
        .sort({ quotationDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Quotation.countDocuments(filter),
      Quotation.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalQuotedValue: { $sum: { $ifNull: ["$grandTotal", 0] } },
            approvedCount: { $sum: { $cond: [{ $eq: ["$status", "APPROVED"] }, 1, 0] } },
            rejectedCount: { $sum: { $cond: [{ $eq: ["$status", "REJECTED"] }, 1, 0] } },
            convertedCount: { $sum: { $cond: [{ $eq: ["$status", "CONVERTED"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const rows = rowsRaw.map((doc) => ({
      _id: doc._id,
      quotationNo: doc.quotationNo,
      quotationDate: doc.quotationDate,
      customerName: doc.customerName,
      customerReference: doc.customerReference || "",
      engine: doc.engine || "",
      model: doc.model || "",
      esn: doc.esn || "",
      lineItems: Array.isArray(doc.lines) ? doc.lines.length : 0,
      totalAmount: toNumber(doc.grandTotal),
      status: doc.status || "DRAFT",
    }));
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalQuotations: total,
        totalQuotedValue: toNumber(summary.totalQuotedValue),
        approvedQuotations: toNumber(summary.approvedCount),
        rejectedQuotations: toNumber(summary.rejectedCount),
        convertedQuotations: toNumber(summary.convertedCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPendingQuotation(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req, { status: { $in: PENDING_QUOTATION_STATUSES } });
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.quotationDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ quotationNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { remarks: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      Quotation.find(filter).sort({ quotationDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Quotation.countDocuments(filter),
      Quotation.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: { $ifNull: ["$grandTotal", 0] } },
            draftCount: { $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] } },
            sentCount: { $sum: { $cond: [{ $eq: ["$status", "SENT"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const now = Date.now();
    const rows = rowsRaw.map((doc) => {
      const baseDate = doc.quotationDate ? new Date(doc.quotationDate).getTime() : now;
      const ageDays = Math.max(0, Math.floor((now - baseDate) / 86400000));
      return {
        _id: doc._id,
        quotationNo: doc.quotationNo,
        quotationDate: doc.quotationDate,
        customerName: doc.customerName,
        articleCount: Array.isArray(doc.lines) ? doc.lines.length : 0,
        totalAmount: toNumber(doc.grandTotal),
        ageDays,
        status: doc.status || "DRAFT",
        followUpRemarks: String(doc.remarks || "").trim(),
      };
    });
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalPendingQuotations: total,
        totalPendingValue: toNumber(summary.totalAmount),
        draftCount: toNumber(summary.draftCount),
        sentCount: toNumber(summary.sentCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportOrderAcknowledgement(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.oaDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ oaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedQuotationNo: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      OrderAcknowledgement.find(filter).sort({ oaDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAcknowledgement.countDocuments(filter),
      OrderAcknowledgement.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            confirmedCount: { $sum: { $cond: [{ $eq: ["$status", "CONFIRMED"] }, 1, 0] } },
            closedCount: { $sum: { $cond: [{ $eq: ["$status", "CLOSED"] }, 1, 0] } },
            totalAmount: { $sum: { $ifNull: ["$grandTotal", 0] } },
          },
        },
      ]),
    ]);

    const rows = rowsRaw.map((doc) => ({
      _id: doc._id,
      oaNo: doc.oaNo,
      oaDate: doc.oaDate,
      linkedQuotationNo: doc.linkedQuotationNo || "",
      customerName: doc.customerName,
      customerPORef: doc.customerPORef || "",
      deliveryTerms: doc.deliverySchedule || "",
      status: doc.status || "DRAFT",
      totalAmount: toNumber(doc.grandTotal),
    }));
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalOaCount: total,
        confirmedOaCount: toNumber(summary.confirmedCount),
        closedOaCount: toNumber(summary.closedCount),
        totalOaValue: toNumber(summary.totalAmount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportPendingOrderAcknowledgement(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req, { status: { $in: PENDING_OA_STATUSES } });
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.oaDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ oaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedQuotationNo: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      OrderAcknowledgement.find(filter).sort({ oaDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAcknowledgement.countDocuments(filter),
      OrderAcknowledgement.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: { $ifNull: ["$grandTotal", 0] } },
            draftCount: { $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] } },
            confirmedCount: { $sum: { $cond: [{ $eq: ["$status", "CONFIRMED"] }, 1, 0] } },
          },
        },
      ]),
    ]);

    const now = Date.now();
    const rows = rowsRaw.map((doc) => {
      const baseDate = doc.oaDate ? new Date(doc.oaDate).getTime() : now;
      const ageDays = Math.max(0, Math.floor((now - baseDate) / 86400000));
      return {
        _id: doc._id,
        oaNo: doc.oaNo,
        customerName: doc.customerName,
        linkedQuotationNo: doc.linkedQuotationNo || "",
        amount: toNumber(doc.grandTotal),
        ageDays,
        status: doc.status || "DRAFT",
      };
    });
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalPendingOaCount: total,
        totalPendingOaValue: toNumber(summary.totalAmount),
        draftCount: toNumber(summary.draftCount),
        confirmedCount: toNumber(summary.confirmedCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportProforma(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.proformaDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ proformaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedOANo: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      ProformaInvoice.find(filter).sort({ proformaDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      ProformaInvoice.countDocuments(filter),
      ProformaInvoice.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: { $ifNull: ["$grandTotal", 0] } },
            openCount: { $sum: { $cond: [{ $in: ["$status", ["DRAFT", "ISSUED", "PAID_PENDING_SHIPMENT"]] }, 1, 0] } },
            convertedCount: { $sum: { $cond: [{ $eq: ["$status", "CONVERTED"] }, 1, 0] } },
            cancelledCount: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
          },
        },
      ]),
    ]);
    const summary = summaryAgg?.[0] || {};
    const rows = rowsRaw.map((doc) => ({
      _id: doc._id,
      proformaNo: doc.proformaNo,
      proformaDate: doc.proformaDate,
      linkedQuotationNo: doc.linkedQuotationNo || "",
      linkedOANo: doc.linkedOANo || "",
      customerName: doc.customerName,
      amount: toNumber(doc.grandTotal),
      status: doc.status || "DRAFT",
      validity: doc.validity || "",
      paymentTerms: doc.paymentTerms || "",
    }));
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalProformas: total,
        totalProformaValue: toNumber(summary.totalAmount),
        openProformas: toNumber(summary.openCount),
        convertedProformas: toNumber(summary.convertedCount),
        cancelledProformas: toNumber(summary.cancelledCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportSalesInvoiceSummary(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.invoiceDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [{ invoiceNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedProformaNo: new RegExp(q, "i") }];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      SalesInvoice.find(filter).sort({ invoiceDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      SalesInvoice.countDocuments(filter),
      SalesInvoice.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalInvoicedValue: { $sum: { $ifNull: ["$grandTotal", 0] } },
            paidValue: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, { $ifNull: ["$grandTotal", 0] }, 0] } },
            unpaidValue: { $sum: { $cond: [{ $ne: ["$status", "PAID"] }, { $ifNull: ["$grandTotal", 0] }, 0] } },
            overdueInvoicesCount: { $sum: 0 },
          },
        },
      ]),
    ]);
    const rows = rowsRaw.map((doc) => {
      const invoiceValue = toNumber(doc.grandTotal);
      const paidAmount = doc.status === "PAID" ? invoiceValue : 0;
      const balanceAmount = Math.max(0, invoiceValue - paidAmount);
      return {
        _id: doc._id,
        invoiceNo: doc.invoiceNo,
        invoiceDate: doc.invoiceDate,
        customerName: doc.customerName,
        linkedProformaNo: doc.linkedProformaNo || "",
        linkedOANo: doc.linkedOANo || "",
        currency: doc.currency || "USD",
        invoiceValue,
        paidAmount,
        balanceAmount,
        paymentStatus: doc.status || "DRAFT",
      };
    });
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalInvoices: total,
        totalInvoicedValue: toNumber(summary.totalInvoicedValue),
        paidValue: toNumber(summary.paidValue),
        unpaidValue: toNumber(summary.unpaidValue),
        overdueInvoicesCount: toNumber(summary.overdueInvoicesCount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportSalesInvoiceArticleWise(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const match = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) match.invoiceDate = dateRange;
    if (req.query.customer) match.customerName = new RegExp(String(req.query.customer).trim(), "i");
    const q = String(req.query.search || req.query.article || "").trim();

    const pipeline = [
      { $match: match },
      { $unwind: "$lines" },
      ...(q ? [{ $match: { "lines.article": new RegExp(q, "i") } }] : []),
      {
        $group: {
          _id: "$lines.article",
          description: { $first: "$lines.description" },
          totalQtySold: { $sum: { $ifNull: ["$lines.qty", 0] } },
          totalSalesValue: { $sum: { $ifNull: ["$lines.totalPrice", 0] } },
          invoices: { $addToSet: "$invoiceNo" },
          customers: { $addToSet: "$customerName" },
          avgSellingPrice: { $avg: { $ifNull: ["$lines.price", 0] } },
        },
      },
      { $sort: { totalSalesValue: -1 } },
    ];
    const rowsAgg = await SalesInvoice.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]);
    const totalAgg = await SalesInvoice.aggregate([...pipeline, { $count: "count" }]);
    const summaryAgg = await SalesInvoice.aggregate([
      ...pipeline,
      {
        $group: {
          _id: null,
          totalQtySold: { $sum: "$totalQtySold" },
          totalSalesValue: { $sum: "$totalSalesValue" },
          articleCount: { $sum: 1 },
        },
      },
    ]);

    const rows = rowsAgg.map((r) => ({
      _id: r._id || "",
      article: r._id || "-",
      description: r.description || "",
      totalQtySold: toNumber(r.totalQtySold),
      totalSalesValue: toNumber(r.totalSalesValue),
      invoiceCount: Array.isArray(r.invoices) ? r.invoices.length : 0,
      customersCount: Array.isArray(r.customers) ? r.customers.length : 0,
      avgSellingPrice: toNumber(r.avgSellingPrice),
    }));
    const summary = summaryAgg?.[0] || {};
    const total = toNumber(totalAgg?.[0]?.count || 0);
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalArticles: toNumber(summary.articleCount),
        totalQtySold: toNumber(summary.totalQtySold),
        totalSalesValue: toNumber(summary.totalSalesValue),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportSalesBranchWise(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const match = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) match.invoiceDate = dateRange;
    if (req.query.customer) match.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) match.status = String(req.query.status).toUpperCase();
    if (req.query.search) match.invoiceNo = new RegExp(String(req.query.search).trim(), "i");

    const pipeline = [
      { $match: match },
      { $unwind: { path: "$lines", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$_id",
          branch: { $first: { $ifNull: ["$branch", "UNSPECIFIED"] } },
          customerName: { $first: "$customerName" },
          status: { $first: "$status" },
          grandTotal: { $first: { $ifNull: ["$grandTotal", 0] } },
          qty: { $sum: { $ifNull: ["$lines.qty", 0] } },
        },
      },
      {
        $group: {
          _id: "$branch",
          noOfInvoices: { $sum: 1 },
          customers: { $addToSet: "$customerName" },
          totalQtySold: { $sum: "$qty" },
          totalSalesValue: { $sum: "$grandTotal" },
          paidAmount: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, "$grandTotal", 0] } },
          unpaidAmount: { $sum: { $cond: [{ $ne: ["$status", "PAID"] }, "$grandTotal", 0] } },
        },
      },
      { $sort: { totalSalesValue: -1 } },
    ];
    const rowsAgg = await SalesInvoice.aggregate([...pipeline, { $skip: skip }, { $limit: limit }]);
    const totalAgg = await SalesInvoice.aggregate([...pipeline, { $count: "count" }]);
    const summaryAgg = await SalesInvoice.aggregate([
      ...pipeline,
      {
        $group: {
          _id: null,
          totalSalesValue: { $sum: "$totalSalesValue" },
          paidAmount: { $sum: "$paidAmount" },
          unpaidAmount: { $sum: "$unpaidAmount" },
        },
      },
    ]);

    const rows = rowsAgg.map((r) => ({
      _id: r._id || "UNSPECIFIED",
      branch: r._id || "UNSPECIFIED",
      noOfInvoices: toNumber(r.noOfInvoices),
      noOfCustomers: Array.isArray(r.customers) ? r.customers.length : 0,
      totalQtySold: toNumber(r.totalQtySold),
      totalSalesValue: toNumber(r.totalSalesValue),
      paidAmount: toNumber(r.paidAmount),
      unpaidAmount: toNumber(r.unpaidAmount),
    }));
    const summary = summaryAgg?.[0] || {};
    const total = toNumber(totalAgg?.[0]?.count || 0);
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalBranches: total,
        totalSalesValue: toNumber(summary.totalSalesValue),
        paidAmount: toNumber(summary.paidAmount),
        unpaidAmount: toNumber(summary.unpaidAmount),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportCipl(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    const dateRange = parseDateRange(req.query);
    if (dateRange) filter.ciplDate = dateRange;
    if (req.query.customer) filter.customerName = new RegExp(String(req.query.customer).trim(), "i");
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      filter.$or = [
        { ciplNo: new RegExp(q, "i") },
        { customerName: new RegExp(q, "i") },
        { linkedSalesInvoiceNo: new RegExp(q, "i") },
        { linkedQuotationNo: new RegExp(q, "i") },
        { linkedOANo: new RegExp(q, "i") },
      ];
    }

    const [rowsRaw, total, summaryAgg] = await Promise.all([
      Cipl.find(filter).sort({ ciplDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Cipl.countDocuments(filter),
      Cipl.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalExportValue: { $sum: { $ifNull: ["$grandTotal", 0] } },
            totalPackages: { $sum: { $size: { $ifNull: ["$lines", []] } } },
            totalGrossWeight: { $sum: 0 },
          },
        },
      ]),
    ]);
    const rows = rowsRaw.map((doc) => ({
      _id: doc._id,
      ciplNo: doc.ciplNo,
      date: doc.ciplDate,
      customerOrConsignee: doc.consigneeName || doc.customerName,
      linkedReference: doc.linkedSalesInvoiceNo || doc.linkedQuotationNo || doc.linkedOANo || "",
      destination: doc.finalDestination || "-",
      portOfLoading: doc.portOfLoading || "-",
      portOfDischarge: doc.portOfDischarge || "-",
      packageCount: Array.isArray(doc.lines) ? doc.lines.length : 0,
      netWeight: toNumber(doc.netWeight),
      grossWeight: toNumber(doc.grossWeight),
      value: toNumber(doc.grandTotal),
      status: doc.status || "DRAFT",
    }));
    const summary = summaryAgg?.[0] || {};
    res.json({
      rows,
      page,
      limit,
      total,
      totals: {
        totalCiplCount: total,
        totalExportValue: toNumber(summary.totalExportValue),
        totalPackages: toNumber(summary.totalPackages),
        totalGrossWeight: toNumber(summary.totalGrossWeight),
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listCustomers(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ name: new RegExp(q, "i") }, { contactName: new RegExp(q, "i") }, { email: new RegExp(q, "i") }];
    }
    const [items, total] = await Promise.all([
      Customer.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      Customer.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createCustomer(req, res) {
  try {
    const body = { ...req.body };
    body.companyId = req.companyId;
    if (!String(body.name || "").trim()) {
      return res.status(400).json({ message: "Customer name is required" });
    }
    const doc = await Customer.create(body);
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateCustomer(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const allowed = ["name", "contactName", "phone", "email", "address", "paymentTerms", "notes"];
    const payload = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) payload[key] = req.body[key];
    }
    const doc = await Customer.findOneAndUpdate(withCompany(req, { _id: id }), payload, {
      new: true,
      runValidators: true,
    });
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteCustomer(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await Customer.findOneAndDelete(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listOAs(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ oaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    const [items, total] = await Promise.all([
      OrderAcknowledgement.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAcknowledgement.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getOA(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await OrderAcknowledgement.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getOAPrintData(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const [doc, company] = await Promise.all([
      OrderAcknowledgement.findOne(withCompany(req, { _id: id })).lean(),
      Company.findById(req.companyId).lean(),
    ]);
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json({
      orderAcknowledgement: doc,
      company: {
        companyName: company?.name || "",
        code: company?.code || "",
        logo: company?.logoUrl || "",
        address: company?.address || "",
        email: company?.email || "",
        phone: company?.phone || "",
      },
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getOAPdfData(req, res) {
  return getOAPrintData(req, res);
}

export async function createOA(req, res) {
  try {
    const body = { ...req.body };
    const lines = normalizeLines(body.lines || []);
    if (!lines.length) return res.status(400).json({ message: "OA requires at least one line" });
    const oaNo =
      body.oaNo ||
      (await nextSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "ORDER_ACK",
      }));
    const totals = computeTotals(lines);
    const doc = await OrderAcknowledgement.create({
      ...body,
      lines,
      ...totals,
      oaNo,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateOA(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (isOAEditLocked(doc)) {
      return res.status(400).json({
        message:
          "This order acknowledgement is locked after conversion to Proforma or Sales Invoice (or finalized status); it cannot be edited.",
      });
    }
    const allowed = [
      "oaDate",
      "customerName",
      "customerPORef",
      "acknowledgementNotes",
      "deliverySchedule",
      "paymentTerms",
      "incoterm",
      "dispatchTerms",
      "currency",
      "lines",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    if (req.body.customerPODate !== undefined) {
      const raw = req.body.customerPODate;
      doc.customerPODate = raw === "" || raw === null || raw === undefined ? null : new Date(raw);
    }
    if (req.body.status !== undefined) {
      const st = String(req.body.status || "").toUpperCase();
      if (["APPROVED", "CONVERTED"].includes(st)) {
        return res.status(400).json({
          message: "Status APPROVED is set automatically when converting to PI or Sales Invoice.",
        });
      }
      doc.status = req.body.status;
    }
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelOA(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await OrderAcknowledgement.findOneAndUpdate(
      withCompany(req, { _id: id }),
      { status: "CANCELLED", updatedBy: req.user?.email || "" },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listProformas(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ proformaNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    const [items, total] = await Promise.all([
      ProformaInvoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      ProformaInvoice.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await ProformaInvoice.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createProforma(req, res) {
  try {
    const body = { ...req.body };
    const lines = normalizeLines(body.lines || []);
    if (!lines.length) return res.status(400).json({ message: "Proforma requires at least one line" });
    const proformaNo =
      body.proformaNo ||
      (await nextSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "PROFORMA",
      }));
    const totals = computeTotals(lines);
    const doc = await ProformaInvoice.create({
      ...body,
      lines,
      ...totals,
      proformaNo,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!isProformaEditable(doc)) {
      return res.status(400).json({
        message: "Proforma can only be edited while in DRAFT (after SI/CIPL conversion it is approved and locked).",
      });
    }
    const allowed = [
      "proformaDate",
      "customerName",
      "paymentTerms",
      "bankDetails",
      "validity",
      "shipmentTerms",
      "remarks",
      "currency",
      "lines",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    if (req.body.status !== undefined) {
      const st = String(req.body.status || "").toUpperCase();
      if (["CONVERTED"].includes(st)) {
        return res.status(400).json({
          message: "Status CONVERTED is managed by the system.",
        });
      }
      doc.status = req.body.status;
    }
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await ProformaInvoice.findOneAndUpdate(
      withCompany(req, { _id: id }),
      { status: "CANCELLED", updatedBy: req.user?.email || "" },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertQuotationToOA(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid quotation id" });
    const quotation = await Quotation.findOne(withCompany(req, { _id: id }));
    validateConversionSource(quotation, "quotation");
    requireApprovedQuotationForConversion(quotation);
    if (!quotation.lines?.length) {
      return res.status(400).json({ message: "Quotation requires at least one line to convert" });
    }
    const already = await OrderAcknowledgement.findOne(withCompany(req, { linkedQuotationId: quotation._id }));
    if (already) return res.status(409).json({ message: `OA already exists (${already.oaNo})` });

    const oaNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "ORDER_ACK",
    });
    const lines = normalizeLines(quotation.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await OrderAcknowledgement.create({
      companyId: req.companyId,
      oaNo,
      oaDate: new Date(),
      linkedQuotationId: quotation._id,
      linkedQuotationNo: quotation.quotationNo,
      customerName: quotation.customerName,
      paymentTerms: quotation.paymentTerms || "",
      incoterm: quotation.incoterm || "",
      currency: quotation.currency || "USD",
      acknowledgementNotes: quotation.remarks || "",
      deliverySchedule: quotation.deliveryTerms || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!quotation.convertedTo?.includes("OA")) quotation.convertedTo = [...(quotation.convertedTo || []), "OA"];
    quotation.updatedBy = req.user?.email || "";
    await quotation.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertQuotationToProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid quotation id" });
    const quotation = await Quotation.findOne(withCompany(req, { _id: id }));
    validateConversionSource(quotation, "quotation");
    requireApprovedQuotationForConversion(quotation);
    if (!quotation.lines?.length) {
      return res.status(400).json({ message: "Quotation requires at least one line to convert" });
    }
    const already = await ProformaInvoice.findOne(withCompany(req, { linkedQuotationId: quotation._id }));
    if (already) return res.status(409).json({ message: `Proforma already exists (${already.proformaNo})` });

    const proformaNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "PROFORMA",
    });
    const lines = normalizeLines(quotation.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await ProformaInvoice.create({
      companyId: req.companyId,
      proformaNo,
      proformaDate: new Date(),
      linkedQuotationId: quotation._id,
      linkedQuotationNo: quotation.quotationNo,
      customerName: quotation.customerName,
      paymentTerms: quotation.paymentTerms || "",
      validity: quotation.validityDate ? new Date(quotation.validityDate).toISOString().slice(0, 10) : "",
      shipmentTerms: quotation.deliveryTerms || "",
      currency: quotation.currency || "USD",
      remarks: quotation.remarks || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!quotation.convertedTo?.includes("PROFORMA")) quotation.convertedTo = [...(quotation.convertedTo || []), "PROFORMA"];
    quotation.updatedBy = req.user?.email || "";
    await quotation.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertOAToProforma(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid OA id" });
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    validateConversionSource(oa, "order acknowledgement");
    if (!oa.lines?.length) return res.status(400).json({ message: "OA requires at least one line to convert" });
    const already = await ProformaInvoice.findOne(withCompany(req, { linkedOAId: oa._id }));
    if (already) return res.status(409).json({ message: `Proforma already exists (${already.proformaNo})` });

    const proformaNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "PROFORMA",
    });
    const lines = normalizeLines(oa.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await ProformaInvoice.create({
      companyId: req.companyId,
      proformaNo,
      proformaDate: new Date(),
      linkedQuotationId: oa.linkedQuotationId || null,
      linkedQuotationNo: oa.linkedQuotationNo || "",
      linkedOAId: oa._id,
      linkedOANo: oa.oaNo,
      customerName: oa.customerName,
      paymentTerms: oa.paymentTerms || "",
      shipmentTerms: oa.deliverySchedule || "",
      currency: oa.currency || "USD",
      remarks: oa.acknowledgementNotes || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!oa.convertedTo?.includes("PROFORMA")) oa.convertedTo = [...(oa.convertedTo || []), "PROFORMA"];
    oa.status = "APPROVED";
    oa.updatedBy = req.user?.email || "";
    await oa.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertOAToSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid OA id" });
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    validateConversionSource(oa, "order acknowledgement");
    if (!oa.lines?.length) return res.status(400).json({ message: "OA requires at least one line to convert" });
    const already = await SalesInvoice.findOne(withCompany(req, { linkedOAId: oa._id, linkedProformaId: null }));
    if (already) return res.status(409).json({ message: `Sales invoice already exists (${already.invoiceNo})` });

    const invoiceNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "SALES_INVOICE",
    });
    const lines = normalizeLines(oa.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await SalesInvoice.create({
      companyId: req.companyId,
      invoiceNo,
      invoiceDate: new Date(),
      linkedQuotationId: oa.linkedQuotationId || null,
      linkedQuotationNo: oa.linkedQuotationNo || "",
      linkedOAId: oa._id,
      linkedOANo: oa.oaNo,
      linkedProformaId: null,
      linkedProformaNo: "",
      customerName: oa.customerName,
      paymentTerms: oa.paymentTerms || "",
      shippingAddress: "",
      billingAddress: "",
      dispatchDetails: oa.dispatchTerms || oa.deliverySchedule || "",
      currency: oa.currency || "USD",
      remarks: oa.acknowledgementNotes || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!oa.convertedTo?.includes("SALES_INVOICE")) oa.convertedTo = [...(oa.convertedTo || []), "SALES_INVOICE"];
    oa.status = "APPROVED";
    oa.updatedBy = req.user?.email || "";
    await oa.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listSalesInvoices(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ invoiceNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    const [items, total] = await Promise.all([
      SalesInvoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
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
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await SalesInvoice.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createSalesInvoice(req, res) {
  try {
    const body = { ...req.body };
    const lines = normalizeLines(body.lines || []);
    if (!lines.length) return res.status(400).json({ message: "Sales invoice requires at least one line" });
    const invoiceNo =
      body.invoiceNo ||
      (await nextSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "SALES_INVOICE",
      }));
    const totals = computeTotals(lines);
    const doc = await SalesInvoice.create({
      ...body,
      lines,
      ...totals,
      invoiceNo,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await SalesInvoice.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    const allowed = [
      "invoiceDate",
      "customerName",
      "paymentTerms",
      "dispatchDetails",
      "shippingAddress",
      "billingAddress",
      "currency",
      "status",
      "remarks",
      "lines",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await SalesInvoice.findOneAndUpdate(
      withCompany(req, { _id: id }),
      { status: "CANCELLED", updatedBy: req.user?.email || "" },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertProformaToSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid proforma id" });
    const proforma = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    validateConversionSource(proforma, "proforma");
    if (!proforma.lines?.length) return res.status(400).json({ message: "Proforma requires at least one line to convert" });
    const already = await SalesInvoice.findOne(withCompany(req, { linkedProformaId: proforma._id }));
    if (already) return res.status(409).json({ message: `Sales invoice already exists (${already.invoiceNo})` });
    const ciplFromPi = await Cipl.findOne(withCompany(req, { linkedProformaId: proforma._id }));
    if (ciplFromPi) return res.status(409).json({ message: `CIPL already exists from this proforma (${ciplFromPi.ciplNo})` });

    const invoiceNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "SALES_INVOICE",
    });
    const lines = normalizeLines(proforma.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await SalesInvoice.create({
      companyId: req.companyId,
      invoiceNo,
      invoiceDate: new Date(),
      linkedQuotationId: proforma.linkedQuotationId || null,
      linkedQuotationNo: proforma.linkedQuotationNo || "",
      linkedOAId: proforma.linkedOAId || null,
      linkedOANo: proforma.linkedOANo || "",
      linkedProformaId: proforma._id,
      linkedProformaNo: proforma.proformaNo,
      customerName: proforma.customerName,
      paymentTerms: proforma.paymentTerms || "",
      shippingAddress: "",
      billingAddress: "",
      dispatchDetails: proforma.shipmentTerms || "",
      currency: proforma.currency || "USD",
      remarks: proforma.remarks || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    proforma.status = "APPROVED";
    proforma.updatedBy = req.user?.email || "";
    await proforma.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertProformaToCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid proforma id" });
    const proforma = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    validateConversionSource(proforma, "proforma");
    if (!proforma.lines?.length) return res.status(400).json({ message: "Proforma requires at least one line to convert" });
    const si = await SalesInvoice.findOne(withCompany(req, { linkedProformaId: proforma._id }));
    if (si) return res.status(409).json({ message: `Sales invoice already exists (${si.invoiceNo}) — cannot create CIPL from proforma` });
    const already = await Cipl.findOne(withCompany(req, { linkedProformaId: proforma._id }));
    if (already) return res.status(409).json({ message: `CIPL already exists (${already.ciplNo})` });

    const ciplNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "CIPL",
    });
    const lines = normalizeLines(proforma.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await Cipl.create({
      companyId: req.companyId,
      ciplNo,
      ciplDate: new Date(),
      linkedQuotationId: proforma.linkedQuotationId || null,
      linkedQuotationNo: proforma.linkedQuotationNo || "",
      linkedOAId: proforma.linkedOAId || null,
      linkedOANo: proforma.linkedOANo || "",
      linkedProformaId: proforma._id,
      linkedProformaNo: proforma.proformaNo,
      customerName: proforma.customerName,
      incoterm: "",
      currency: proforma.currency || "USD",
      remarks: proforma.remarks || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    proforma.status = "APPROVED";
    proforma.updatedBy = req.user?.email || "";
    await proforma.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listOrderAllocations(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ allocationNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [items, total] = await Promise.all([
      OrderAllocation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAllocation.countDocuments(filter),
    ]);
    const allocationIds = items.map((x) => x._id);
    const rtsDocs = allocationIds.length
      ? await Rts.find(
          withCompany(req, {
            linkedOrderAllocationId: { $in: allocationIds },
            status: "APPROVED",
          })
        )
          .sort({ rtsDate: -1, createdAt: -1 })
          .lean()
      : [];
    const latestByAllocation = new Map();
    for (const rts of rtsDocs) {
      const key = String(rts.linkedOrderAllocationId || "");
      if (!latestByAllocation.has(key)) latestByAllocation.set(key, rts);
    }
    const rows = items.map((x) => {
      const latest = latestByAllocation.get(String(x._id || ""));
      return {
        ...x,
        latestApprovedRtsId: latest?._id || null,
        latestApprovedRtsNo: latest?.rtsNo || "",
      };
    });
    res.json({ items: rows, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await OrderAllocation.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    const approvedRtsDocs = await approvedRtsByAllocation(req, doc._id);
    const shipped = shippedQtyMapForAllocation(approvedRtsDocs);
    const lines = (doc.lines || []).map((l) => {
      const lineId = String(l._id || "");
      const shippedQty = shipped.get(lineId) || 0;
      const pendingQty = Math.max(0, (Number(l.qty) || 0) - shippedQty);
      return { ...l, shippedQty, pendingQty };
    });
    res.json({ ...doc, lines });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportOrderAllocation(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ allocationNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [rows, total] = await Promise.all([
      OrderAllocation.find(filter).sort({ allocationDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      OrderAllocation.countDocuments(filter),
    ]);
    const rowsOut = rows.map((r) => ({
      _id: r._id,
      allocationNo: r.allocationNo,
      allocationDate: r.allocationDate,
      linkedOANo: r.linkedOANo || "",
      linkedProformaNo: r.linkedProformaNo || "",
      customerName: r.customerName || "",
      status: r.status || "OPEN",
      lineCount: Array.isArray(r.lines) ? r.lines.length : 0,
    }));
    res.json({ rows: rowsOut, total, page, limit, totals: { totalOrderAllocations: total } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function reportRts(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ rtsNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedOrderAllocationNo: new RegExp(q, "i") }];
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [rows, total] = await Promise.all([
      Rts.find(filter).sort({ rtsDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Rts.countDocuments(filter),
    ]);
    const rowsOut = rows.map((r) => ({
      _id: r._id,
      rtsNo: r.rtsNo,
      rtsDate: r.rtsDate,
      linkedOrderAllocationNo: r.linkedOrderAllocationNo || "",
      customerName: r.customerName || "",
      status: r.status || "DRAFT",
      boxCount: Number(r.packingDetails?.boxCount || 0),
      totalWeightKg: Number(r.packingDetails?.totalWeightKg || 0),
      lineCount: Array.isArray(r.lines) ? r.lines.length : 0,
    }));
    res.json({ rows: rowsOut, total, page, limit, totals: { totalRTS: total } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listRts(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ rtsNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }, { linkedOrderAllocationNo: new RegExp(q, "i") }];
    }
    if (req.query.allocationId && mongoose.Types.ObjectId.isValid(String(req.query.allocationId))) {
      filter.linkedOrderAllocationId = new mongoose.Types.ObjectId(String(req.query.allocationId));
    }
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [items, total] = await Promise.all([
      Rts.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Rts.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getRts(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Rts.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json({ ...doc, editable: isRtsEditable(doc) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function updateRts(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Rts.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!isRtsEditable(doc)) {
      return res.status(400).json({ message: "RTS is locked after Sales Invoice reference is created." });
    }

    if (req.body.rtsDate !== undefined) doc.rtsDate = req.body.rtsDate;
    if (req.body.packingDetails !== undefined) {
      doc.packingDetails = {
        totalWeightKg: Number(req.body?.packingDetails?.totalWeightKg || 0),
        boxCount: Number(req.body?.packingDetails?.boxCount || 0),
        boxDimensionsMm: String(req.body?.packingDetails?.boxDimensionsMm || ""),
      };
    }
    if (req.body.lines !== undefined) {
      const incoming = Array.isArray(req.body.lines) ? req.body.lines : [];
      if (!incoming.length) return res.status(400).json({ message: "RTS requires at least one line" });
      doc.lines = incoming.map((line, idx) => {
        const qty = Number(line.qty) || 0;
        const unitWeightKg = normalizeWeight(line.unitWeightKg);
        return {
          serialNo: idx + 1,
          allocationLineId: line.allocationLineId,
          article: String(line.article || "").trim().toUpperCase(),
          partNumber: String(line.partNumber || ""),
          description: String(line.description || ""),
          qty,
          uom: String(line.uom || "PCS"),
          remarks: String(line.remarks || ""),
          materialCode: String(line.materialCode || ""),
          availability: String(line.availability || ""),
          unitWeightKg,
          totalWeightKg: unitWeightKg == null ? null : qty * unitWeightKg,
        };
      });
    }
    if (req.body.status !== undefined) {
      const st = String(req.body.status || "").toUpperCase();
      if (!["DRAFT", "APPROVED", "CANCELLED"].includes(st)) {
        return res.status(400).json({ message: "Invalid RTS status" });
      }
      doc.status = st;
    }
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function approveRts(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Rts.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    if (!isRtsEditable(doc)) return res.status(400).json({ message: "RTS is locked after Sales Invoice reference is created." });
    if (doc.status === "APPROVED") return res.json(doc);
    doc.status = "APPROVED";
    doc.updatedBy = req.user?.email || "";
    await doc.save();

    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: doc.linkedOrderAllocationId }));
    if (allocation) {
      const approvedDocs = await approvedRtsByAllocation(req, allocation._id);
      const shipped = shippedQtyMapForAllocation(approvedDocs);
      let complete = true;
      for (const line of allocation.lines || []) {
        const qty = Number(line.qty) || 0;
        const done = shipped.get(String(line._id || "")) || 0;
        if (done < qty) {
          complete = false;
          break;
        }
      }
      allocation.status = complete ? "RTS_COMPLETE" : "PARTIALLY_RTS";
      allocation.updatedBy = req.user?.email || "";
      await allocation.save();
    }
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertOAToOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid OA id" });
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    validateConversionSource(oa, "order acknowledgement");
    if (!oa.lines?.length) return res.status(400).json({ message: "OA requires at least one line to convert" });
    const already = await OrderAllocation.findOne(withCompany(req, { linkedOAId: oa._id }));
    if (already) return res.status(409).json({ message: `Order allocation already exists (${already.allocationNo})` });
    const allocationNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "ORDER_ALLOCATION",
    });
    let lines = normalizeLines(oa.lines.map((line) => line.toObject?.() || line));
    lines = await attachUnitWeightFromItems(req, lines);
    const totals = computeTotals(lines);
    const doc = await OrderAllocation.create({
      companyId: req.companyId,
      allocationNo,
      allocationDate: new Date(),
      linkedQuotationId: oa.linkedQuotationId || null,
      linkedQuotationNo: oa.linkedQuotationNo || "",
      linkedOAId: oa._id,
      linkedOANo: oa.oaNo,
      customerName: oa.customerName,
      currency: oa.currency || "USD",
      lines,
      ...totals,
      status: "OPEN",
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertProformaToOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid proforma id" });
    const proforma = await ProformaInvoice.findOne(withCompany(req, { _id: id }));
    validateConversionSource(proforma, "proforma");
    if (String(proforma?.status || "").toUpperCase() !== "APPROVED") {
      return res.status(400).json({ message: "Proforma must be APPROVED before converting to Order Allocation" });
    }
    if (!proforma.lines?.length) return res.status(400).json({ message: "Proforma requires at least one line to convert" });
    const already = await OrderAllocation.findOne(withCompany(req, { linkedProformaId: proforma._id }));
    if (already) return res.status(409).json({ message: `Order allocation already exists (${already.allocationNo})` });
    const allocationNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "ORDER_ALLOCATION",
    });
    let lines = normalizeLines(proforma.lines.map((line) => line.toObject?.() || line));
    lines = await attachUnitWeightFromItems(req, lines);
    const totals = computeTotals(lines);
    const doc = await OrderAllocation.create({
      companyId: req.companyId,
      allocationNo,
      allocationDate: new Date(),
      linkedQuotationId: proforma.linkedQuotationId || null,
      linkedQuotationNo: proforma.linkedQuotationNo || "",
      linkedOAId: proforma.linkedOAId || null,
      linkedOANo: proforma.linkedOANo || "",
      linkedProformaId: proforma._id,
      linkedProformaNo: proforma.proformaNo,
      customerName: proforma.customerName,
      currency: proforma.currency || "USD",
      lines,
      ...totals,
      status: "OPEN",
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createRtsFromOrderAllocation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid order allocation id" });
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: id }));
    validateConversionSource(allocation, "order allocation");
    if (!allocation?.lines?.length) return res.status(400).json({ message: "Order allocation has no lines" });
    const approvedDocs = await approvedRtsByAllocation(req, allocation._id);
    const shipped = shippedQtyMapForAllocation(approvedDocs);

    const selected = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!selected.length) return res.status(400).json({ message: "Select at least one article/line for RTS" });
    const byId = new Map((allocation.lines || []).map((line) => [String(line._id), line]));
    const rtsLines = [];
    for (const row of selected) {
      const line = byId.get(String(row.allocationLineId || ""));
      if (!line) continue;
      const pending = Math.max(0, (Number(line.qty) || 0) - (shipped.get(String(line._id)) || 0));
      const qty = Number(row.qty) || 0;
      if (!(qty > 0) || qty > pending) {
        return res.status(400).json({ message: `Invalid RTS qty for article ${line.article}. Pending: ${pending}` });
      }
      const unitWeightKg = normalizeWeight(row.unitWeightKg) ?? normalizeWeight(line.unitWeightKg);
      rtsLines.push({
        serialNo: rtsLines.length + 1,
        allocationLineId: line._id,
        article: line.article,
        partNumber: line.partNumber || "",
        description: line.description || "",
        qty,
        uom: line.uom || "PCS",
        remarks: line.remarks || "",
        materialCode: line.materialCode || "",
        availability: line.availability || "",
        unitWeightKg,
        totalWeightKg: unitWeightKg == null ? null : qty * unitWeightKg,
      });
    }
    if (!rtsLines.length) return res.status(400).json({ message: "No valid RTS lines selected" });
    const rtsNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "RTS",
    });
    const doc = await Rts.create({
      companyId: req.companyId,
      rtsNo,
      rtsDate: req.body?.rtsDate || new Date(),
      linkedOrderAllocationId: allocation._id,
      linkedOrderAllocationNo: allocation.allocationNo,
      customerName: allocation.customerName,
      lines: rtsLines,
      packingDetails: {
        totalWeightKg: Number(req.body?.packingDetails?.totalWeightKg || 0),
        boxCount: Number(req.body?.packingDetails?.boxCount || 0),
        boxDimensionsMm: String(req.body?.packingDetails?.boxDimensionsMm || ""),
      },
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertOrderAllocationToSalesInvoice(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid order allocation id" });
    const allocation = await OrderAllocation.findOne(withCompany(req, { _id: id }));
    validateConversionSource(allocation, "order allocation");
    const approvedDocs = await approvedRtsByAllocation(req, allocation?._id);
    if (!approvedDocs.length) {
      return res.status(400).json({ message: "At least one APPROVED RTS is required before converting to Sales Invoice" });
    }
    const requestedRtsId = req.body?.rtsId;
    let refRts = null;
    if (requestedRtsId && mongoose.Types.ObjectId.isValid(String(requestedRtsId))) {
      refRts = approvedDocs.find((x) => String(x._id) === String(requestedRtsId)) || null;
      if (!refRts) return res.status(400).json({ message: "Selected RTS is not approved or not linked to this allocation" });
    } else {
      refRts = approvedDocs[0];
    }
    const already = await SalesInvoice.findOne(withCompany(req, { linkedOrderAllocationId: allocation._id }));
    if (already) return res.status(409).json({ message: `Sales invoice already exists (${already.invoiceNo})` });
    const invoiceNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "SALES_INVOICE",
    });
    const lines = normalizeLines((allocation.lines || []).map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await SalesInvoice.create({
      companyId: req.companyId,
      invoiceNo,
      invoiceDate: new Date(),
      linkedQuotationId: allocation.linkedQuotationId || null,
      linkedQuotationNo: allocation.linkedQuotationNo || "",
      linkedOAId: allocation.linkedOAId || null,
      linkedOANo: allocation.linkedOANo || "",
      linkedProformaId: allocation.linkedProformaId || null,
      linkedProformaNo: allocation.linkedProformaNo || "",
      linkedOrderAllocationId: allocation._id,
      linkedOrderAllocationNo: allocation.allocationNo,
      linkedRtsId: refRts?._id || null,
      linkedRtsNo: refRts?.rtsNo || "",
      customerName: allocation.customerName,
      paymentTerms: "",
      dispatchDetails: "",
      shippingAddress: "",
      billingAddress: "",
      currency: allocation.currency || "USD",
      remarks: "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    allocation.status = "CLOSED";
    allocation.linkedSalesInvoiceId = doc._id;
    allocation.linkedSalesInvoiceNo = doc.invoiceNo;
    allocation.updatedBy = req.user?.email || "";
    await allocation.save();
    if (refRts?._id) {
      await Rts.findOneAndUpdate(
        withCompany(req, { _id: refRts._id }),
        {
          linkedSalesInvoiceId: doc._id,
          linkedSalesInvoiceNo: doc.invoiceNo,
          updatedBy: req.user?.email || "",
        }
      );
    }
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listCipls(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [{ ciplNo: new RegExp(q, "i") }, { customerName: new RegExp(q, "i") }];
    }
    const [items, total] = await Promise.all([
      Cipl.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Cipl.countDocuments(filter),
    ]);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Cipl.findOne(withCompany(req, { _id: id })).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createCipl(req, res) {
  try {
    const body = { ...req.body };
    const lines = normalizeLines(body.lines || []);
    if (!lines.length) return res.status(400).json({ message: "CIPL requires at least one line" });
    const ciplNo =
      body.ciplNo ||
      (await nextSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "CIPL",
      }));
    const totals = computeTotals(lines);
    const doc = await Cipl.create({
      ...body,
      lines,
      ...totals,
      ciplNo,
      companyId: req.companyId,
      createdBy: req.user?.email || "",
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Cipl.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });
    const allowed = [
      "ciplDate",
      "customerName",
      "consigneeName",
      "shipmentMode",
      "incoterm",
      "currency",
      "status",
      "remarks",
      "lines",
    ];
    for (const key of allowed) {
      if (req.body[key] !== undefined) doc[key] = req.body[key];
    }
    doc.lines = normalizeLines(doc.lines || []);
    Object.assign(doc, computeTotals(doc.lines));
    doc.updatedBy = req.user?.email || "";
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function cancelCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid id" });
    const doc = await Cipl.findOneAndUpdate(
      withCompany(req, { _id: id }),
      { status: "CANCELLED", updatedBy: req.user?.email || "" },
      { new: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertQuotationToCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid quotation id" });
    const quotation = await Quotation.findOne(withCompany(req, { _id: id }));
    validateConversionSource(quotation, "quotation");
    requireApprovedQuotationForConversion(quotation);
    if (!quotation.lines?.length) return res.status(400).json({ message: "Quotation requires at least one line to convert" });
    const already = await Cipl.findOne(withCompany(req, { linkedQuotationId: quotation._id }));
    if (already) return res.status(409).json({ message: `CIPL already exists (${already.ciplNo})` });

    const ciplNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "CIPL",
    });
    const lines = normalizeLines(quotation.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await Cipl.create({
      companyId: req.companyId,
      ciplNo,
      ciplDate: new Date(),
      linkedQuotationId: quotation._id,
      linkedQuotationNo: quotation.quotationNo,
      customerName: quotation.customerName,
      incoterm: quotation.incoterm || "",
      currency: quotation.currency || "USD",
      remarks: quotation.remarks || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!quotation.convertedTo?.includes("CIPL")) quotation.convertedTo = [...(quotation.convertedTo || []), "CIPL"];
    quotation.updatedBy = req.user?.email || "";
    await quotation.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertOAToCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid OA id" });
    const oa = await OrderAcknowledgement.findOne(withCompany(req, { _id: id }));
    validateConversionSource(oa, "order acknowledgement");
    if (!oa.lines?.length) return res.status(400).json({ message: "OA requires at least one line to convert" });
    const already = await Cipl.findOne(withCompany(req, { linkedOAId: oa._id }));
    if (already) return res.status(409).json({ message: `CIPL already exists (${already.ciplNo})` });

    const ciplNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "CIPL",
    });
    const lines = normalizeLines(oa.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await Cipl.create({
      companyId: req.companyId,
      ciplNo,
      ciplDate: new Date(),
      linkedQuotationId: oa.linkedQuotationId || null,
      linkedQuotationNo: oa.linkedQuotationNo || "",
      linkedOAId: oa._id,
      linkedOANo: oa.oaNo,
      customerName: oa.customerName,
      incoterm: oa.incoterm || "",
      currency: oa.currency || "USD",
      remarks: oa.acknowledgementNotes || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    if (!oa.convertedTo?.includes("CIPL")) oa.convertedTo = [...(oa.convertedTo || []), "CIPL"];
    oa.updatedBy = req.user?.email || "";
    await oa.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function convertSalesInvoiceToCipl(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ message: "Invalid sales invoice id" });
    const invoice = await SalesInvoice.findOne(withCompany(req, { _id: id }));
    validateConversionSource(invoice, "sales invoice");
    if (!invoice.lines?.length) return res.status(400).json({ message: "Sales invoice requires at least one line to convert" });
    const already = await Cipl.findOne(withCompany(req, { linkedSalesInvoiceId: invoice._id }));
    if (already) return res.status(409).json({ message: `CIPL already exists (${already.ciplNo})` });

    const ciplNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "CIPL",
    });
    const lines = normalizeLines(invoice.lines.map((line) => line.toObject?.() || line));
    const totals = computeTotals(lines);
    const doc = await Cipl.create({
      companyId: req.companyId,
      ciplNo,
      ciplDate: new Date(),
      linkedQuotationId: invoice.linkedQuotationId || null,
      linkedQuotationNo: invoice.linkedQuotationNo || "",
      linkedOAId: invoice.linkedOAId || null,
      linkedOANo: invoice.linkedOANo || "",
      linkedSalesInvoiceId: invoice._id,
      linkedSalesInvoiceNo: invoice.invoiceNo,
      customerName: invoice.customerName,
      incoterm: "",
      currency: invoice.currency || "USD",
      remarks: invoice.remarks || "",
      lines,
      ...totals,
      status: "DRAFT",
      createdBy: req.user?.email || "",
    });
    invoice.updatedBy = req.user?.email || "";
    await invoice.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}
