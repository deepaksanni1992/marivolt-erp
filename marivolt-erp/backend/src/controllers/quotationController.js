import mongoose from "mongoose";
import Quotation from "../models/Quotation.js";
import Company from "../models/Company.js";
import Customer from "../models/Customer.js";
import Item from "../models/itemModel.js";
import ItemTechnical from "../models/itemTechnicalModel.js";
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import * as stockService from "../services/stockService.js";
import { nextSalesDocNumber, nextUniqueSalesDocNumber } from "../utils/salesDocNumber.js";
import {
  isSalesQuotationDeleteAdmin,
  quotationCanBeDeleted,
  quotationDeleteBlockReason,
} from "../utils/salesAdminAccess.js";
import {
  buildOaWorkingCopyFromQuotation,
  buildQuotationSearchFilterForOA,
  mapQuotationSearchRowForOA,
} from "../services/documentSnapshot/documentSnapshotService.js";
import { getQuotationConsumptionReport } from "../services/documentSnapshot/documentChainService.js";
import {
  buildPartySnapshotFromFields,
  customerDetailSearchOr,
  customerTransactionAuditFieldSlice,
  diffCustomerTransactionFields,
  mapCustomerMasterToTransactionDefaults,
  pickCustomerTransactionFieldsFromBody,
  resolveDocumentCustomerFields,
} from "../utils/customerTransactionFields.js";
import { writeAudit } from "../services/auditService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

async function enrichQuotationsWithDeleteEligibility(req, rows = []) {
  if (!rows.length) return rows;
  const isAdmin = isSalesQuotationDeleteAdmin(req);
  if (!isAdmin) {
    return rows.map((row) => ({
      ...row,
      canDeleteQuotation: false,
      deleteQuotationBlockReason: "Only administrators can delete quotations.",
    }));
  }

  const ids = rows.map((r) => r._id).filter(Boolean);
  const linkedOAs = ids.length
    ? await OrderAcknowledgement.find(withCompany(req, { linkedQuotationId: { $in: ids } }))
        .select("linkedQuotationId status oaNo")
        .lean()
    : [];
  const activeOAByQuotation = new Map();
  for (const oa of linkedOAs) {
    if (String(oa.status || "").toUpperCase() === "CANCELLED") continue;
    activeOAByQuotation.set(String(oa.linkedQuotationId), oa.oaNo || "OA");
  }

  return rows.map((row) => {
    const hasActiveOA = activeOAByQuotation.has(String(row._id));
    const canDeleteQuotation = quotationCanBeDeleted(row, { hasActiveOA });
    return {
      ...row,
      canDeleteQuotation,
      deleteQuotationBlockReason: canDeleteQuotation
        ? ""
        : quotationDeleteBlockReason(row, { hasActiveOA }),
    };
  });
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
  const discountType = String(doc.discountType || "NONE").toUpperCase();
  const discountValue = Math.max(0, Number(doc.discountValue) || 0);
  doc.discountType = ["PERCENT", "FLAT"].includes(discountType) ? discountType : "NONE";
  doc.discountValue = discountValue;
  if (doc.discountType === "PERCENT") {
    doc.discountTotal = Math.min(doc.subTotal, (doc.subTotal * discountValue) / 100);
  } else if (doc.discountType === "FLAT") {
    doc.discountTotal = Math.min(doc.subTotal, discountValue);
  } else {
    doc.discountTotal = 0;
  }
  doc.taxTotal = 0;
  doc.packingCost = Math.max(0, Number(doc.packingCost) || 0);
  doc.clearanceCost = Math.max(0, Number(doc.clearanceCost) || 0);
  doc.grandTotal = doc.subTotal - doc.discountTotal + doc.packingCost + doc.clearanceCost;
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
  const UOM_ALLOWED = ["PCS", "SET", "KG", "NOS", "MTR"];
  const clean = (v) => String(v ?? "").trim();
  const normalizeUom = (v) => {
    const u = clean(v).toUpperCase();
    return UOM_ALLOWED.includes(u) ? u : "PCS";
  };
  const mergeSet = (base, next) => {
    const a = clean(base);
    const b = clean(next);
    if (!a && !b) return "";
    const set = new Set([
      ...a.split("|").map((x) => x.trim()).filter(Boolean),
      ...b.split("|").map((x) => x.trim()).filter(Boolean),
    ]);
    return [...set].join(" | ");
  };

  for (const line of quotation.lines || []) {
    const article = clean(line.article).toUpperCase();
    if (!article) continue;
    const existing = await Item.findOne({ companyId: req.companyId, article });
    try {
      const payload = {
        companyId: req.companyId,
        article,
        itemName: clean(line.description) || article,
        description: clean(line.description),
        vertical: clean(quotation.vertical),
        engine: clean(quotation.engine),
        model: clean(quotation.model),
        config: clean(quotation.config),
        uom: normalizeUom(line.uom),
        status: "Active",
      };

      if (!existing) {
        await Item.create(payload);
      } else {
        existing.itemName = existing.itemName || payload.itemName;
        existing.description = mergeSet(existing.description, payload.description);
        existing.vertical = mergeSet(existing.vertical, payload.vertical);
        existing.engine = mergeSet(existing.engine, payload.engine);
        existing.model = mergeSet(existing.model, payload.model);
        existing.config = mergeSet(existing.config, payload.config);
        existing.uom = normalizeUom(existing.uom || payload.uom);
        existing.status = "Active";
        await existing.save();
      }

      const technical = await ItemTechnical.findOne({ companyId: req.companyId, article });
      const nextSpn = clean(line.partNumber);
      const nextMaterialCode = clean(line.materialCode);
      const nextEsn = clean(quotation.esn);
      if (!technical) {
        await ItemTechnical.create({
          companyId: req.companyId,
          article,
          spn: nextSpn,
          esn: nextEsn,
          materialCode: nextMaterialCode,
        });
      } else {
        technical.spn = mergeSet(technical.spn, nextSpn);
        technical.esn = mergeSet(technical.esn, nextEsn);
        technical.materialCode = mergeSet(technical.materialCode, nextMaterialCode);
        await technical.save();
      }
    } catch (err) {
      const isDuplicateKey = err?.code === 11000;
      const duplicateArticle = Boolean(err?.keyPattern?.companyId && err?.keyPattern?.article);
      if (isDuplicateKey && duplicateArticle) {
        // Concurrent save of same article is safe to ignore.
        continue;
      }
      throw err;
    }
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
    if (req.query.vertical) {
      filter.vertical = new RegExp(String(req.query.vertical).trim(), "i");
    }
    if (req.query.brand) {
      filter.engine = new RegExp(String(req.query.brand).trim(), "i");
    }
    if (req.query.search) {
      const q = String(req.query.search).trim();
      filter.$or = [
        { quotationNo: new RegExp(q, "i") },
        ...customerDetailSearchOr(q),
        { vertical: new RegExp(q, "i") },
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
    const items = await enrichQuotationsWithDeleteEligibility(req, rows);
    res.json({ items, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getQuotationFacets(req, res) {
  try {
    const norm = (arr = []) =>
      [...new Set((arr || []).map((v) => String(v || "").trim()).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      );
    const [brands, verticals] = await Promise.all([
      Quotation.distinct("engine", withCompany(req, { engine: { $nin: [null, ""] } })),
      Quotation.distinct("vertical", withCompany(req, { vertical: { $nin: [null, ""] } })),
    ]);
    res.json({ brands: norm(brands), verticals: norm(verticals) });
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
    const [enriched] = await enrichQuotationsWithDeleteEligibility(req, [row]);
    res.json(enriched || row);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getNextQuotationNumber(req, res) {
  try {
    const quotationNo = await nextSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "QUOTATION",
      referenceDate: req.query.date || new Date(),
    });
    res.json({ quotationNo });
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
      body.quotationNo = await nextUniqueSalesDocNumber({
        companyId: req.companyId,
        companyCode: req.companyCode,
        docKey: "QUOTATION",
        referenceDate: body.quotationDate || new Date(),
        model: Quotation,
        field: "quotationNo",
      });
    }
    body.quotationNumber = body.quotationNo;
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
    const fromBody = pickCustomerTransactionFieldsFromBody(body);
    const fromMaster = mapCustomerMasterToTransactionDefaults(customer);
    const customerFields = resolveDocumentCustomerFields(
      {
        contactPerson: fromBody.contactPerson,
        attention: fromBody.attention,
        billingAddress: fromBody.billingAddress,
        shippingAddress: fromBody.shippingAddress,
        paymentTerms: fromBody.paymentTerms,
      },
      fromMaster
    );
    body.contactPerson = customerFields.contactPerson;
    body.attention = customerFields.attention;
    body.billingAddress = customerFields.billingAddress;
    body.shippingAddress = customerFields.shippingAddress;
    body.paymentTerms = customerFields.paymentTerms;
    body.customer = buildPartySnapshotFromFields(customer.name, customerFields, customer);
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
    if (doc.status !== "DRAFT") {
      return res.status(400).json({ message: "Only DRAFT quotations can be edited" });
    }
    const beforeSnapshot = doc.toObject();

    const allowed = [
      "quotationNo",
      "customerId",
      "customerName",
      "customerReference",
      "contactPerson",
      "attention",
      "billingAddress",
      "shippingAddress",
      "vertical",
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
      "remarks",
      "termsAndConditions",
      "internalNotes",
      "customer",
      "quotationDate",
      "validityDate",
      "shipmentReference",
      "packingCost",
      "clearanceCost",
      "discountType",
      "discountValue",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) doc[k] = req.body[k];
    }
    const fieldPatch = pickCustomerTransactionFieldsFromBody(req.body);
    Object.assign(doc, fieldPatch);
    if (doc.quotationNo) {
      doc.quotationNumber = doc.quotationNo;
    }
    if (req.body.customerId !== undefined || req.body.customerName !== undefined) {
      const customer = await resolveCustomerFromMaster(req, doc);
      doc.customerId = customer._id;
      doc.customerName = customer.name;
      // Only refresh contact defaults from master when client did not send explicit snapshots.
      const masterDefaults = mapCustomerMasterToTransactionDefaults(customer);
      if (req.body.contactPerson === undefined) doc.contactPerson = masterDefaults.contactPerson;
      if (req.body.attention === undefined) doc.attention = masterDefaults.attention;
      if (req.body.billingAddress === undefined) doc.billingAddress = masterDefaults.billingAddress;
      if (req.body.shippingAddress === undefined) doc.shippingAddress = masterDefaults.shippingAddress;
      if (req.body.paymentTerms === undefined) doc.paymentTerms = masterDefaults.paymentTerms;
      doc.customer = buildPartySnapshotFromFields(
        customer.name,
        {
          contactPerson: doc.contactPerson,
          attention: doc.attention,
          billingAddress: doc.billingAddress,
          shippingAddress: doc.shippingAddress,
        },
        customer
      );
    } else {
      doc.customer = buildPartySnapshotFromFields(
        doc.customerName,
        {
          contactPerson: doc.contactPerson,
          attention: doc.attention,
          billingAddress: doc.billingAddress,
          shippingAddress: doc.shippingAddress,
        },
        doc.customer
      );
    }
    doc.updatedBy = req.user?.email || "";
    recalcQuotationTotals(doc);
    if (!doc.lines.length) {
      return res.status(400).json({ message: "Each line must contain article, description, uom, qty and price" });
    }
    await doc.save();
    await autoCreateItemsFromQuotation({ req, quotation: doc });
    const customerFieldChanges = diffCustomerTransactionFields(beforeSnapshot, doc);
    await writeAudit(req, {
      action: "UPDATE",
      module: "SALES",
      entityType: "QUOTATION",
      entityId: doc._id,
      documentNo: doc.quotationNo || "",
      description: `Quotation ${doc.quotationNo || ""} updated`,
      beforeData: customerTransactionAuditFieldSlice(beforeSnapshot),
      afterData: {
        ...customerTransactionAuditFieldSlice(doc),
        ...(customerFieldChanges ? { customerFieldChanges } : {}),
      },
    });
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
    const existing = await Quotation.findOne(withCompany(req, { _id: id }));
    if (!existing) return res.status(404).json({ message: "Not found" });
    const currentStatus = String(existing.status || "").toUpperCase();
    if (["APPROVED", "CONVERTED", "CANCELLED"].includes(currentStatus)) {
      return res.status(400).json({ message: "Approved, converted, or cancelled quotations cannot be changed" });
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

    await stockService.withTransaction(async (session) => {
      for (const row of lines) {
        const lineId = row.lineId;
        const qty = Number(row.qty);
        if (!lineId) throw new Error("Each line needs lineId");
        if (!Number.isFinite(qty) || qty <= 0) throw new Error("Invalid qty");

        const line = q.lines.id(lineId);
        if (!line) throw new Error(`Invalid lineId ${lineId}`);
        if (qty > (Number(line.qty) || 0)) {
          throw new Error("qty exceeds quotation line qty");
        }

        await stockService.stockAdjustment({
          session,
          companyId: req.companyId,
          article: line.article,
          warehouse,
          qty,
          direction: "Decrease",
          referenceType: "QUOTATION",
          referenceNo: q.quotationNo,
          remarks: row.remarks || "",
          createdBy: userEmail,
          sourceModule: "SALES",
          allowNegative: true,
        });
      }
    });

    res.json({ success: true, quotationId: q._id });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteQuotation(req, res) {
  try {
    if (!isSalesQuotationDeleteAdmin(req)) {
      return res.status(403).json({ message: "Only administrators can delete quotations." });
    }
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Quotation.findOne(withCompany(req, { _id: id }));
    if (!row) return res.status(404).json({ message: "Not found" });

    const linkedOAs = await OrderAcknowledgement.find(
      withCompany(req, { linkedQuotationId: row._id })
    )
      .select("status oaNo")
      .lean();
    const hasActiveOA = linkedOAs.some((oa) => String(oa.status || "").toUpperCase() !== "CANCELLED");
    const blockReason = quotationDeleteBlockReason(row, { hasActiveOA });
    if (blockReason) {
      return res.status(400).json({ message: blockReason });
    }

    await Quotation.deleteOne(withCompany(req, { _id: id }));
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
    const nextNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "QUOTATION",
      model: Quotation,
      field: "quotationNo",
    });
    const doc = await Quotation.create({
      ...src,
      _id: undefined,
      quotationNo: nextNo,
      quotationNumber: nextNo,
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

export async function searchQuotationsForOA(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = buildQuotationSearchFilterForOA(req.companyId, req.query);
    const [rows, total] = await Promise.all([
      Quotation.find(filter)
        .sort({ quotationDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          "quotationNo quotationDate customerName customerReference vertical engine model esn currency grandTotal status"
        )
        .lean(),
      Quotation.countDocuments(filter),
    ]);
    res.json({
      items: rows.map(mapQuotationSearchRowForOA),
      total,
      page,
      limit,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

/** Read-only snapshot for New OA "From Quotation" — never mutates the quotation. */
export async function getQuotationOaSource(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const row = await Quotation.findOne(withCompany(req, { _id: id })).lean();
    if (!row) return res.status(404).json({ message: "Not found" });
    const st = String(row.status || "").toUpperCase();
    if (["CANCELLED", "REJECTED"].includes(st)) {
      return res.status(400).json({ message: `Cannot use quotation with status ${st} as OA source` });
    }
    if (!row.lines?.length) {
      return res.status(400).json({ message: "Quotation has no lines to copy into OA" });
    }
    res.json(await buildOaWorkingCopyFromQuotation(req.companyId, row, { copiedBy: req.user?.email || "" }));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getQuotationConsumption(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const report = await getQuotationConsumptionReport(req.companyId, id);
    res.json(report);
  } catch (err) {
    res.status(err.message === "Quotation not found" ? 404 : 500).json({ message: err.message });
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
