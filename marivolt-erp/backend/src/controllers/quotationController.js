import mongoose from "mongoose";
import Quotation from "../models/Quotation.js";
import Company from "../models/Company.js";
import Customer from "../models/Customer.js";
import Item from "../models/itemModel.js";
import { applyStockOut } from "../services/stockService.js";
import { nextSalesDocNumber } from "../utils/salesDocNumber.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function normalizeLines(lines = []) {
  return (lines || [])
    .map((line) => {
      const serialNo = Number(line.serialNo) || 0;
      const qty = Number(line.qty) || 0;
      const price = Number(line.price ?? line.salePrice ?? line.unitPrice) || 0;
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
    .map((line, idx) => ({
      ...line,
      serialNo: idx + 1,
    }));
}

function recalcQuotationTotals(doc) {
  doc.lines = normalizeLines(doc.lines);
  doc.subTotal = doc.lines.reduce((acc, line) => acc + (Number(line.totalPrice) || 0), 0);
  doc.discountTotal = 0;
  doc.taxTotal = 0;
  doc.grandTotal = doc.subTotal;
}

async function resolveCustomerFromMaster(req, payload = {}) {
  const customerId = payload.customerId ? String(payload.customerId).trim() : "";
  const customerName = String(payload.customerName || "").trim();
  let customer = null;
  if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
    customer = await Customer.findOne(withCompany(req, { _id: customerId })).lean();
  }
  if (!customer && customerName) {
    customer = await Customer.findOne(withCompany(req, { name: new RegExp(`^${customerName}$`, "i") })).lean();
  }
  if (!customer) {
    throw new Error("Customer must be selected from Customer Master");
  }
  return customer;
}

async function autoCreateItemsFromQuotation({ req, quotation }) {
  for (const line of quotation.lines || []) {
    const article = String(line.article || "").trim().toUpperCase();
    if (!article) continue;
    const existing = await Item.findOne({ companyId: req.companyId, itemCode: article }).select("_id").lean();
    if (existing) continue;
    await Item.create({
      companyId: req.companyId,
      itemCode: article,
      description: line.description || "",
      uom: line.uom || "PCS",
      makerPartNo: line.partNumber || "",
      materialCode: line.materialCode || "",
      engine: quotation.engine || "",
      modelName: quotation.model || "",
      config: quotation.config || "",
      esn: quotation.esn || "",
      source: "quotation",
      sourceDocumentType: "quotation",
      sourceDocumentId: quotation._id,
      sourceDocumentNo: quotation.quotationNo,
    });
  }
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
        { engine: new RegExp(q, "i") },
        { model: new RegExp(q, "i") },
        { config: new RegExp(q, "i") },
        { esn: new RegExp(q, "i") },
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
    const customer = await resolveCustomerFromMaster(req, body);
    body.customerId = customer._id;
    body.customerName = customer.name;
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
    body.customer = {
      name: customer.name || "",
      billingAddress: customer.address || "",
      shippingAddress: customer.address || "",
      contactPerson: customer.contactName || "",
      email: customer.email || "",
      phone: customer.phone || "",
      country: "",
    };
    body.validityDate = body.validityDate || body.validUntil || null;
    const doc = new Quotation(body);
    recalcQuotationTotals(doc);
    if (!doc.lines.length) {
      return res.status(400).json({ message: "Each line must contain article, description, uom, qty and price" });
    }
    await doc.save();
    await autoCreateItemsFromQuotation({ req, quotation: doc });
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
      "customerId",
      "customerName",
      "customerReference",
      "attention",
      "engine",
      "model",
      "config",
      "esn",
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
    if (req.body.customerId !== undefined || req.body.customerName !== undefined) {
      const customer = await resolveCustomerFromMaster(req, doc);
      doc.customerId = customer._id;
      doc.customerName = customer.name;
      doc.customer = {
        name: customer.name || "",
        billingAddress: customer.address || "",
        shippingAddress: customer.address || "",
        contactPerson: customer.contactName || "",
        email: customer.email || "",
        phone: customer.phone || "",
        country: "",
      };
    }
    doc.updatedBy = req.user?.email || "";
    recalcQuotationTotals(doc);
    if (!doc.lines.length) {
      return res.status(400).json({ message: "Each line must contain article, description, uom, qty and price" });
    }
    await doc.save();
    await autoCreateItemsFromQuotation({ req, quotation: doc });
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
        itemCode: line.article,
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
