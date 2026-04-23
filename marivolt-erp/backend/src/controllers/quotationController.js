import mongoose from "mongoose";
import Quotation from "../models/Quotation.js";
import Company from "../models/Company.js";
import { applyStockOut } from "../services/stockService.js";
import { nextSalesDocNumber } from "../utils/salesDocNumber.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function normalizeLines(lines = []) {
  return (lines || [])
    .map((line) => {
      const qty = Number(line.qty) || 0;
      const unitPrice = Number(line.salePrice ?? line.unitPrice) || 0;
      const discountPct = Number(line.discountPct) || 0;
      const taxPct = Number(line.taxPct) || 0;
      const gross = qty * unitPrice;
      const discountAmount = (gross * discountPct) / 100;
      const taxable = gross - discountAmount;
      const taxAmount = (taxable * taxPct) / 100;
      const lineTotal = taxable + taxAmount;
      return {
        ...line,
        itemCode: String(line.itemCode || "").trim().toUpperCase(),
        article: String(line.article || line.itemCode || "").trim().toUpperCase(),
        description: String(line.description || ""),
        unit: String(line.unit || "PCS").trim() || "PCS",
        qty,
        salePrice: unitPrice,
        currency: String(line.currency || "USD").trim().toUpperCase(),
        discountPct,
        taxPct,
        discountAmount,
        taxAmount,
        lineTotal,
        pendingQty: Math.max(0, qty - (Number(line.deliveredQty) || 0)),
      };
    })
    .filter((line) => line.itemCode && line.qty > 0);
}

function recalcQuotationTotals(doc) {
  let subTotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  doc.lines = normalizeLines(doc.lines);
  for (const line of doc.lines) {
    const gross = (Number(line.qty) || 0) * (Number(line.salePrice) || 0);
    subTotal += gross;
    discountTotal += Number(line.discountAmount) || 0;
    taxTotal += Number(line.taxAmount) || 0;
  }
  doc.subTotal = subTotal;
  doc.discountTotal = discountTotal;
  doc.taxTotal = taxTotal;
  doc.grandTotal = subTotal - discountTotal + taxTotal;
}

export async function listQuotations(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.customerName) {
      filter.customerName = new RegExp(String(req.query.customerName).trim(), "i");
    }
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [
        { quotationNo: new RegExp(q, "i") },
        { customerName: new RegExp(q, "i") },
        { customerReference: new RegExp(q, "i") },
      ];
    }
    const [rows, total] = await Promise.all([
      Quotation.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Quotation.countDocuments(filter),
    ]);
    res.json({ items: rows, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getQuotation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Quotation.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createQuotation(req, res) {
  try {
    const body = { ...req.body };
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      return res.status(400).json({ message: "Quotation must contain at least one line" });
    }
    const company = await Company.findById(req.companyId).lean();
    if (!company || !company.isActive) {
      return res.status(403).json({ message: "Active company context required" });
    }
    if (!body.quotationNo) {
      body.quotationNo = await nextSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "QUOTATION",
      });
    }
    body.createdBy = req.user?.email || "";
    body.companyId = req.companyId;
    body.companySnapshot = {
      companyName: company.name || "",
      logo: company.logoUrl || "",
      address: company.address || "",
      email: company.email || "",
      phone: company.phone || "",
      registrationNo: "",
    };
    body.validityDate = body.validityDate || body.validUntil || null;
    const doc = new Quotation(body);
    recalcQuotationTotals(doc);
    await doc.save();
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateQuotation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const doc = await Quotation.findOne(withCompany(req, { _id: id }));
    if (!doc) return res.status(404).json({ message: "Not found" });

    const allowed = [
      "quotationNo",
      "customerName",
      "customerReference",
      "attention",
      "paymentTerms",
      "deliveryTerms",
      "incoterm",
      "currency",
      "exchangeRate",
      "portOfLoading",
      "portOfDischarge",
      "finalDestination",
      "lines",
      "status",
      "remarks",
      "internalNotes",
      "customer",
      "quotationDate",
      "validityDate",
      "shipmentReference",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    doc.updatedBy = req.user?.email || "";
    recalcQuotationTotals(doc);
    await doc.save();
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function patchQuotationStatus(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const { status } = req.body;
    if (!status) return res.status(400).json({ message: "status required" });
    const allowed = ["DRAFT", "SENT", "APPROVED", "REJECTED", "EXPIRED", "CONVERTED", "CANCELLED"];
    if (!allowed.includes(String(status).toUpperCase())) {
      return res.status(400).json({ message: "invalid status" });
    }
    const doc = await Quotation.findOneAndUpdate(
      withCompany(req, { _id: id }),
      { status: String(status).toUpperCase(), updatedBy: req.user?.email || "" },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function stockOutFromQuotation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const q = await Quotation.findOne(withCompany(req, { _id: id }));
    if (!q) return res.status(404).json({ message: "Not found" });

    const { warehouse = "MAIN", lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "lines array required" });
    }

    const userEmail = req.user?.email || "";

    for (const row of lines) {
      const lineId = row.lineId;
      const qty = Number(row.qty);
      if (!lineId) return res.status(400).json({ message: "Each line needs lineId" });
      if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: "Invalid qty" });

      const line = q.lines.id(lineId);
      if (!line) return res.status(400).json({ message: `Invalid lineId ${lineId}` });
      if (qty > (Number(line.qty) || 0)) {
        return res.status(400).json({ message: "qty exceeds quotation line qty" });
      }

      await applyStockOut({
        companyId: req.companyId,
        itemCode: line.itemCode,
        warehouse,
        qty,
        movementType: "OUT_SALE",
        referenceType: "QUOTATION",
        referenceId: q._id,
        referenceNumber: q.quotationNo,
        remarks: row.remarks || "",
        createdBy: userEmail,
      });
    }

    res.json({ success: true, quotationId: q._id });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteQuotation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Quotation.findOneAndDelete(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function duplicateQuotation(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const src = await Quotation.findOne(withCompany(req, { _id: id })).lean();
    if (!src) return res.status(404).json({ message: "Not found" });
    if (src.status === "CANCELLED") {
      return res.status(400).json({ message: "Cannot duplicate cancelled quotation" });
    }
    const nextNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "QUOTATION",
    });
    const doc = await Quotation.create({
      ...src,
      _id: undefined,
      quotationNo: nextNo,
      quotationDate: new Date(),
      validityDate: null,
      status: "DRAFT",
      sourceType: "DUPLICATE",
      createdBy: req.user?.email || "",
      updatedBy: "",
      createdAt: undefined,
      updatedAt: undefined,
    });
    res.status(201).json(doc);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getQuotationPrintData(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Quotation.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json({
      title: "Quotation",
      documentNo: row.quotationNo,
      quotation: row,
      printGeneratedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
