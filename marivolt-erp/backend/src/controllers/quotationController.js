import mongoose from "mongoose";
import Quotation from "../models/Quotation.js";
import Company from "../models/Company.js";
import Customer from "../models/Customer.js";
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import * as stockService from "../services/stockService.js";
import {
  applyManualSalesDocumentNumber,
  mapSalesDocNumberDuplicateError,
  nextUniqueSalesDocNumber,
  peekNextSalesDocumentNumber,
  validateManualSalesDocumentNumber,
} from "../utils/salesDocNumber.js";
import { assertSalesDocumentNumberChangeAllowed } from "../utils/salesDocumentNumberChangeGuard.js";
import {
  isSalesQuotationDeleteAdmin,
  quotationCanBeDeleted,
  quotationDeleteBlockReason,
} from "../utils/salesAdminAccess.js";
import {
  quotationLineTotal,
  redactQuotationForSalesApi,
  roundQuotationMoney,
  sanitizeCustomerQuotationPrint,
} from "../utils/manPriceList.js";
import { assertManEngineWriteAccess } from "../utils/manEngineAccess.js";
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
import { normalizeOaPaymentType } from "../utils/salesFlowSequential.js";
import { preserveQuotationLinesInOrder } from "../utils/quotationDuplicateLines.js";
import {
  applyItemMasterSnapshotsToLines,
  articleFromLine,
  assertActiveArticles,
  assertActiveArticlesForChangedLines,
  isArticleValidationError,
  linesRequiringArticleValidation,
  snapshotQuotationLineFromItem,
} from "../services/articleTransactionValidator.js";
import { snapshotSalesLinePartNumberFields } from "../utils/partNumberTerminology.js";

function jsonQuotationError(res, err) {
  if (isArticleValidationError(err)) return res.status(err.statusCode).json(err.toJSON());
  return res.status(err.statusCode || 400).json({ message: err.message, code: err.code });
}

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
      const price = roundQuotationMoney(Number(line.price ?? line.salePrice ?? line.unitPrice) || 0);
      const totalPrice = quotationLineTotal(price, qty);
      const snapshot = {};
      const salesPn = snapshotSalesLinePartNumberFields({
        customerPartNo: line.customerPartNo != null ? String(line.customerPartNo || "") : String(line.partNumber || line.partNo || ""),
        matchedPartNumber: line.matchedPartNumber != null ? String(line.matchedPartNumber || "") : "",
      });
      snapshot.customerPartNo = salesPn.customerPartNo;
      snapshot.matchedPartNumber = salesPn.matchedPartNumber;
      if (line.sourceRowNumber != null && line.sourceRowNumber !== "") {
        snapshot.sourceRowNumber = Number(line.sourceRowNumber) || null;
      }
      if (line.customerEngineModel != null) snapshot.customerEngineModel = String(line.customerEngineModel || "");
      if (line.engineModel != null) snapshot.engineModel = String(line.engineModel || "");
      if (line.config != null) snapshot.config = String(line.config || "");
      if (line.specifications != null) snapshot.specifications = String(line.specifications || "");
      if (line.modelMatchStatus != null) snapshot.modelMatchStatus = String(line.modelMatchStatus || "").toUpperCase();
      if (line.priceTier != null) snapshot.priceTier = String(line.priceTier || "").toUpperCase();
      if (line.priceListRevision != null) snapshot.priceListRevision = Number(line.priceListRevision) || 0;
      if (line.priceListId) snapshot.priceListId = String(line.priceListId);
      if (line.availabilityCheckedAt) snapshot.availabilityCheckedAt = line.availabilityCheckedAt;
      if (line.sourceType) snapshot.sourceType = String(line.sourceType || "");
      if (line.currency) snapshot.currency = String(line.currency || "");
      if (line.sourceCurrency) snapshot.sourceCurrency = String(line.sourceCurrency || "").trim().toUpperCase();
      if (line.sourceUnitPrice != null && line.sourceUnitPrice !== "") {
        snapshot.sourceUnitPrice = roundQuotationMoney(Number(line.sourceUnitPrice) || 0);
      }
      if (line.conversionRate != null && line.conversionRate !== "") {
        snapshot.conversionRate = Number(line.conversionRate);
      }
      if (line.convertedCurrency) snapshot.convertedCurrency = String(line.convertedCurrency || "").trim().toUpperCase();
      if (line.convertedUnitPrice != null && line.convertedUnitPrice !== "") {
        snapshot.convertedUnitPrice = roundQuotationMoney(Number(line.convertedUnitPrice) || 0);
      }
      return {
        serialNo,
        article: String(line.article || line.itemCode || "").trim().toUpperCase(),
        partNumber: salesPn.partNumber,
        description: String(line.description || ""),
        uom: String(line.uom || line.unit || "PCS").trim() || "PCS",
        qty,
        price,
        totalPrice,
        remarks: String(line.remarks || ""),
        materialCode: String(line.materialCode || "").trim(),
        availability: String(line.availability || "").trim(),
        ...snapshot,
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
  const subTotal = roundQuotationMoney(
    doc.lines.reduce((acc, line) => acc + (Number(line.totalPrice) || 0), 0)
  );
  doc.subTotal = subTotal;
  const discountType = String(doc.discountType || "NONE").toUpperCase();
  const discountValue = Math.max(0, Number(doc.discountValue) || 0);
  doc.discountType = ["PERCENT", "FLAT"].includes(discountType) ? discountType : "NONE";
  doc.discountValue = discountValue;
  if (doc.discountType === "PERCENT") {
    doc.discountTotal = roundQuotationMoney(Math.min(subTotal, (subTotal * discountValue) / 100));
  } else if (doc.discountType === "FLAT") {
    doc.discountTotal = roundQuotationMoney(Math.min(subTotal, discountValue));
  } else {
    doc.discountTotal = 0;
  }
  doc.taxTotal = 0;
  doc.packingCost = roundQuotationMoney(Math.max(0, Number(doc.packingCost) || 0));
  doc.clearanceCost = roundQuotationMoney(Math.max(0, Number(doc.clearanceCost) || 0));
  doc.grandTotal = roundQuotationMoney(
    subTotal - doc.discountTotal + doc.taxTotal + doc.packingCost + doc.clearanceCost
  );
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
    res.json({ items: items.map(redactQuotationForSalesApi), total, page, limit });
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
    const base = redactQuotationForSalesApi(enriched || row);
    const linkedOA = await OrderAcknowledgement.findOne(
      withCompany(req, { linkedQuotationId: row._id, status: { $ne: "CANCELLED" } })
    )
      .select("_id oaNo status paymentType")
      .lean();
    res.json({
      ...base,
      linkedOAId: linkedOA?._id || null,
      linkedOANo: linkedOA?.oaNo || "",
      hasActiveOA: Boolean(linkedOA?._id),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getNextQuotationNumber(req, res) {
  try {
    // Preview only — does not consume the daily counter (P2).
    const quotationNo = await peekNextSalesDocumentNumber({
      companyId: req.companyId,
      documentType: "QT",
      referenceDate: req.query.date || new Date(),
    });
    res.json({ quotationNo });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function persistNewQuotation(req, rawBody = {}, { skipAutoCreateItems = false, session = null } = {}) {
  const body = { ...rawBody };
  const source = String(body.sourceType || "MANUAL").trim() || "MANUAL";
  body.sourceType = source;
  if (source === "MAN_RFQ") {
    const key = String(body.manRfqIdempotencyKey || "").trim();
    if (!key) {
      const e = new Error("MAN RFQ quotations require a populated idempotency key");
      e.statusCode = 400;
      e.code = "MAN_RFQ_KEY_REQUIRED";
      throw e;
    }
    body.manRfqIdempotencyKey = key;
  } else {
    delete body.manRfqIdempotencyKey;
    delete body.manRfqRequestHash;
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    const e = new Error("Quotation must contain at least one line");
    e.statusCode = 400;
    throw e;
  }
  body.lines = preserveQuotationLinesInOrder(body.lines);
  await assertManEngineWriteAccess(req, {
    lines: body.lines,
    header: body,
    sourceType: body.sourceType,
  });
  const customer = await resolveCustomerFromMaster(req, body);
  body.customerId = customer._id;
  body.customerName = customer.name;
  const company = await Company.findById(req.companyId).lean();
  if (!company || !company.isActive) {
    const e = new Error("Active company context required");
    e.statusCode = 403;
    throw e;
  }
  if (String(body.quotationNo || "").trim()) {
    const prepared = await applyManualSalesDocumentNumber({
      companyId: req.companyId,
      documentType: "QT",
      value: body.quotationNo,
      model: Quotation,
      field: "quotationNo",
    });
    body.quotationNo = prepared.number;
  } else {
    body.quotationNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "QUOTATION",
      referenceDate: new Date(),
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
    const e = new Error("Each line must contain article, description, uom, qty and price");
    e.statusCode = 400;
    throw e;
  }
  const itemsByArticle = await assertActiveArticles({
    companyId: req.companyId,
    lines: doc.lines,
    session,
  });
  doc.lines = applyItemMasterSnapshotsToLines(doc.lines, itemsByArticle, "quotation");
  recalcQuotationTotals(doc);
  await doc.save(session ? { session } : undefined);
  void skipAutoCreateItems;
  return doc;
}

export async function createQuotation(req, res) {
  try {
    const doc = await persistNewQuotation(req, req.body);
    res.status(201).json(doc);
  } catch (err) {
    const dup = mapSalesDocNumberDuplicateError(err, {
      documentLabel: "Quotation",
      number: req.body?.quotationNo,
    });
    if (dup) return res.status(dup.statusCode).json({ message: dup.message });
    return jsonQuotationError(res, err);
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
    let numberChange = null;

    if (req.body.quotationNo !== undefined) {
      const previousNo = String(doc.quotationNo || "").trim();
      const validated = validateManualSalesDocumentNumber({
        value: req.body.quotationNo,
        expectedDocumentType: "QT",
      });
      if (validated.number !== previousNo) {
        await assertSalesDocumentNumberChangeAllowed({
          companyId: req.companyId,
          documentType: "QT",
          documentId: doc._id,
        });
        const prepared = await applyManualSalesDocumentNumber({
          companyId: req.companyId,
          documentType: "QT",
          value: req.body.quotationNo,
          model: Quotation,
          field: "quotationNo",
          excludeId: doc._id,
          previousNumber: previousNo,
        });
        numberChange = { oldNumber: previousNo, newNumber: prepared.number };
        doc.quotationNo = prepared.number;
        doc.quotationNumber = prepared.number;
      } else {
        doc.quotationNo = validated.number;
        doc.quotationNumber = validated.number;
      }
    }

    const allowed = [
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
      "vesselPlant",
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
    await assertManEngineWriteAccess(req, {
      lines: doc.lines,
      header: doc,
      sourceType: doc.sourceType,
    });
    if (Array.isArray(req.body.lines)) {
      const previousLines = beforeSnapshot.lines || [];
      const itemsByArticle = await assertActiveArticlesForChangedLines({
        companyId: req.companyId,
        previousLines,
        nextLines: doc.lines,
      });
      const changed = new Set(
        linesRequiringArticleValidation(previousLines, doc.lines).map((row) => row.index)
      );
      doc.lines = doc.lines.map((line, index) => {
        if (!changed.has(index)) return line;
        const item = itemsByArticle.get(articleFromLine(line));
        return item ? snapshotQuotationLineFromItem(line, item) : line;
      });
      recalcQuotationTotals(doc);
    }
    await doc.save();
    const customerFieldChanges = diffCustomerTransactionFields(beforeSnapshot, doc);
    await writeAudit(req, {
      action: "UPDATE",
      module: "SALES",
      entityType: "QUOTATION",
      entityId: doc._id,
      documentNo: doc.quotationNo || "",
      description: numberChange
        ? `Quotation number changed from ${numberChange.oldNumber || "—"} to ${numberChange.newNumber}`
        : `Quotation ${doc.quotationNo || ""} updated`,
      beforeData: {
        ...customerTransactionAuditFieldSlice(beforeSnapshot),
        ...(numberChange ? { quotationNo: numberChange.oldNumber } : {}),
      },
      afterData: {
        ...customerTransactionAuditFieldSlice(doc),
        ...(customerFieldChanges ? { customerFieldChanges } : {}),
        ...(numberChange ? { quotationNo: numberChange.newNumber } : {}),
      },
      metadata: numberChange
        ? {
            documentNumberChanged: true,
            documentType: "QT",
            oldNumber: numberChange.oldNumber,
            newNumber: numberChange.newNumber,
          }
        : null,
    });
    res.json(doc);
  } catch (err) {
    const dup = mapSalesDocNumberDuplicateError(err, {
      documentLabel: "Quotation",
      number: req.body?.quotationNo,
    });
    if (dup) return res.status(dup.statusCode).json({ message: dup.message });
    return jsonQuotationError(res, err);
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
          lineId: String(lineId),
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
    await assertManEngineWriteAccess(req, {
      lines: src.lines,
      header: src,
      sourceType: src.sourceType,
    });
    const itemsByArticle = await assertActiveArticles({
      companyId: req.companyId,
      lines: src.lines,
    });
    const lines = applyItemMasterSnapshotsToLines(src.lines, itemsByArticle, "quotation");
    const nextNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "QUOTATION",
      model: Quotation,
      field: "quotationNo",
    });
    const doc = await Quotation.create({
      ...src,
      lines,
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
    return jsonQuotationError(res, err);
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
    const working = await buildOaWorkingCopyFromQuotation(req.companyId, row, {
      copiedBy: req.user?.email || "",
    });
    working.customerId = row.customerId ? String(row.customerId) : "";
    working.oaSourceType = "FROM_QUOTATION";
    let paymentType = "";
    if (row.customerId) {
      const cust = await Customer.findOne(withCompany(req, { _id: row.customerId }))
        .select("paymentTerms")
        .lean();
      paymentType = normalizeOaPaymentType(cust?.paymentTerms);
    }
    if (!paymentType && String(row.customerName || "").trim()) {
      const custByName = await Customer.findOne({
        companyId: req.companyId,
        name: new RegExp(`^${String(row.customerName).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      })
        .select("paymentTerms")
        .lean();
      paymentType = normalizeOaPaymentType(custByName?.paymentTerms);
    }
    if (paymentType) working.paymentType = paymentType;
    res.json(working);
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
    const quotation = sanitizeCustomerQuotationPrint(row);
    res.json({
      title: "Quotation",
      documentNo: row.quotationNo,
      quotation,
      printGeneratedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
