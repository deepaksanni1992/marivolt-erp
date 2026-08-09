/**
 * S2 — Canonical Sales Dispatch orchestration.
 *
 * User-facing document: SalesDispatch (logistics + posting state).
 * Physical stock: existing StoreDispatch P0.5B create/post/cancel cores (untouched algorithm).
 * Historical logistics-only SalesDispatch (isLegacyLogisticsOnly) must never fabricate DISPATCH_OUT.
 */
import mongoose from "mongoose";
import SalesDispatch from "../models/SalesDispatch.js";
import SalesInvoice from "../models/SalesInvoice.js";
import StoreDispatch from "../models/StoreDispatch.js";
import {
  createStoreDispatchDraftCore,
  postStoreDispatch,
  cancelStoreDispatch,
} from "../controllers/storeOutboundController.js";
import { writeAudit } from "./auditService.js";
import {
  applyManualSalesDocumentNumber,
  nextUniqueSalesDocNumber,
} from "../utils/salesDocNumber.js";
import { isInvoiceDispatchEligible } from "../utils/salesInvoiceState.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

function t(v) {
  return String(v ?? "").trim();
}

function httpish(handler, req, { params = {}, body = {} } = {}) {
  return new Promise((resolve, reject) => {
    const fakeReq = {
      ...req,
      params: { ...(req.params || {}), ...params },
      body: { ...(req.body || {}), ...body },
    };
    const fakeRes = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, payload });
      },
    };
    Promise.resolve(handler(fakeReq, fakeRes)).catch(reject);
  });
}

function normalizeCanonicalLines(invoice, bodyLines = []) {
  const invoiceLines = invoice.lines || [];
  if (Array.isArray(bodyLines) && bodyLines.length) {
    return bodyLines
      .map((ln) => {
        const sourceLineId = ln.sourceLineId || ln.invoiceLineId || ln._id || null;
        const match = sourceLineId
          ? invoiceLines.find((x) => String(x._id) === String(sourceLineId))
          : null;
        const qty = Math.max(0, Number(ln.qty ?? ln.dispatchQty) || 0);
        if (!(qty > 0)) return null;
        return {
          serialNo: Number(ln.serialNo || match?.serialNo) || 0,
          article: String(ln.article || match?.article || "").trim().toUpperCase(),
          partNumber: t(ln.partNumber || match?.partNumber),
          description: t(ln.description || match?.description),
          qty,
          uom: t(ln.uom || match?.uom || "PCS") || "PCS",
          price: Number(ln.price ?? match?.price) || 0,
          totalPrice: qty * (Number(ln.price ?? match?.price) || 0),
          remarks: t(ln.remarks),
          materialCode: t(ln.materialCode || match?.materialCode),
          sourceLineId: match?._id || sourceLineId,
          dispatchedQty: qty,
          pendingQty: 0,
        };
      })
      .filter((ln) => ln && ln.article);
  }
  return invoiceLines.map((ln, idx) => {
    const qty = Number(ln.qty) || 0;
    return {
      serialNo: ln.serialNo ?? idx + 1,
      article: ln.article,
      partNumber: ln.partNumber || "",
      description: ln.description || "",
      qty,
      uom: ln.uom || "PCS",
      price: Number(ln.price) || 0,
      totalPrice: qty * (Number(ln.price) || 0),
      remarks: ln.remarks || "",
      materialCode: ln.materialCode || "",
      sourceLineId: ln._id,
      dispatchedQty: qty,
      pendingQty: 0,
    };
  });
}

export async function createCanonicalSalesDispatch(req, body = {}) {
  const invoiceId = body.salesInvoiceId || body.linkedSalesInvoiceId || body.invoiceId;
  if (!mongoose.Types.ObjectId.isValid(String(invoiceId || ""))) {
    const err = new Error("salesInvoiceId is required");
    err.statusCode = 400;
    throw err;
  }
  const invoice = await SalesInvoice.findOne(withCompany(req, { _id: invoiceId }));
  if (!invoice) {
    const err = new Error("Sales Invoice not found");
    err.statusCode = 404;
    throw err;
  }
  if (!isInvoiceDispatchEligible(invoice)) {
    const err = new Error("Sales invoice must be issued (non-cancelled) before creating Sales Dispatch");
    err.statusCode = 400;
    throw err;
  }
  if (!invoice.linkedStorePackingId) {
    const err = new Error("Cannot create Sales Dispatch without invoice linked to packing");
    err.statusCode = 400;
    throw err;
  }

  const lines = normalizeCanonicalLines(invoice, body.lines);
  if (!lines.length) {
    const err = new Error("Sales Dispatch requires at least one line quantity");
    err.statusCode = 400;
    throw err;
  }
  const qtyTotal = lines.reduce((s, ln) => s + (Number(ln.qty) || 0), 0);
  let dispatchNo;
  if (t(body.dispatchNo)) {
    const prepared = await applyManualSalesDocumentNumber({
      companyId: req.companyId,
      documentType: "SD",
      value: body.dispatchNo,
      model: SalesDispatch,
      field: "dispatchNo",
    });
    dispatchNo = prepared.number;
  } else {
    dispatchNo = await nextUniqueSalesDocNumber({
      companyId: req.companyId,
      companyCode: req.companyCode,
      docKey: "SALES_DISPATCH",
      model: SalesDispatch,
      field: "dispatchNo",
    });
  }

  const doc = await SalesDispatch.create({
    companyId: req.companyId,
    dispatchNo,
    dispatchDate: body.dispatchDate || new Date(),
    linkedSalesInvoiceId: invoice._id,
    linkedSalesInvoiceNo: invoice.invoiceNo,
    linkedStorePackingId: invoice.linkedStorePackingId,
    linkedStorePackingNo: invoice.linkedStorePackingNo || "",
    customerName: invoice.customerName,
    currency: invoice.currency || "USD",
    vertical: invoice.vertical || "",
    engine: invoice.engine || "",
    model: invoice.model || "",
    config: invoice.config || "",
    esn: invoice.esn || "",
    transporter: t(body.transporter || body.courier),
    courier: t(body.courier || body.transporter),
    awbNo: t(body.awbNo),
    blNo: t(body.blNo),
    trackingUrl: t(body.trackingUrl),
    containerNo: t(body.containerNo),
    shippingLine: t(body.shippingLine),
    vessel: t(body.vessel),
    voyage: t(body.voyage),
    etd: body.etd || null,
    eta: body.eta || null,
    remarks: t(body.remarks || invoice.remarks),
    lines,
    subTotal: lines.reduce((s, ln) => s + (Number(ln.totalPrice) || 0), 0),
    grandTotal: lines.reduce((s, ln) => s + (Number(ln.totalPrice) || 0), 0),
    totalQty: qtyTotal,
    dispatchedQty: 0,
    pendingQty: qtyTotal,
    packingListNo: `${dispatchNo}-PL`,
    packingListGeneratedAt: new Date(),
    status: "DRAFT",
    postingStatus: "NOT_POSTED",
    isLegacyLogisticsOnly: false,
    createdBy: req.user?.email || "",
    updatedBy: req.user?.email || "",
  });

  invoice.linkedSalesDispatchId = doc._id;
  invoice.linkedSalesDispatchNo = doc.dispatchNo;
  invoice.updatedBy = req.user?.email || "";
  await invoice.save();

  await writeAudit(req, {
    action: "CREATE",
    module: "SALES",
    entityType: "SALES_DISPATCH",
    entityId: doc._id,
    documentNo: doc.dispatchNo,
    toStatus: doc.status,
    description: `Sales Dispatch ${doc.dispatchNo} draft created from invoice ${invoice.invoiceNo}`,
    metadata: { postingStatus: doc.postingStatus },
  });
  return doc;
}

const LOGISTICS_EDITABLE = [
  "dispatchDate",
  "transporter",
  "courier",
  "awbNo",
  "blNo",
  "trackingUrl",
  "trackingStatus",
  "containerNo",
  "shippingLine",
  "vessel",
  "voyage",
  "etd",
  "eta",
  "remarks",
  "packages",
];

export async function updateCanonicalSalesDispatch(req, id, body = {}) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid sales dispatch id");
    err.statusCode = 400;
    throw err;
  }
  const doc = await SalesDispatch.findOne(withCompany(req, { _id: id }));
  if (!doc) {
    const err = new Error("Sales Dispatch not found");
    err.statusCode = 404;
    throw err;
  }
  if (String(doc.postingStatus || "").toUpperCase() === "POSTED") {
    // Logistics-only edits still allowed after stock post for tracking fields.
    const allowedAfterPost = ["awbNo", "blNo", "trackingUrl", "trackingStatus", "courier", "transporter", "eta", "etd", "remarks", "containerNo"];
    for (const key of allowedAfterPost) {
      if (body[key] !== undefined) doc[key] = body[key];
    }
  } else if (String(doc.status || "").toUpperCase() === "CANCELLED" || String(doc.postingStatus) === "CANCELLED") {
    const err = new Error("Cancelled Sales Dispatch cannot be edited");
    err.statusCode = 400;
    throw err;
  } else {
    for (const key of LOGISTICS_EDITABLE) {
      if (body[key] !== undefined) doc[key] = body[key];
    }
    if (Array.isArray(body.lines) && body.lines.length && String(doc.postingStatus) === "NOT_POSTED") {
      const invoice = await SalesInvoice.findOne(withCompany(req, { _id: doc.linkedSalesInvoiceId }));
      if (invoice) {
        doc.lines = normalizeCanonicalLines(invoice, body.lines);
        doc.totalQty = doc.lines.reduce((s, ln) => s + (Number(ln.qty) || 0), 0);
        doc.pendingQty = doc.totalQty;
        doc.subTotal = doc.lines.reduce((s, ln) => s + (Number(ln.totalPrice) || 0), 0);
        doc.grandTotal = doc.subTotal;
      }
    }
  }
  doc.updatedBy = req.user?.email || "";
  await doc.save();
  await writeAudit(req, {
    action: "UPDATE",
    module: "SALES",
    entityType: "SALES_DISPATCH",
    entityId: doc._id,
    documentNo: doc.dispatchNo,
    description: `Sales Dispatch ${doc.dispatchNo} updated`,
  });
  return doc;
}

export async function postCanonicalSalesDispatch(req, id) {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid sales dispatch id");
    err.statusCode = 400;
    throw err;
  }
  const doc = await SalesDispatch.findOne(withCompany(req, { _id: id }));
  if (!doc) {
    const err = new Error("Sales Dispatch not found");
    err.statusCode = 404;
    throw err;
  }
  if (doc.isLegacyLogisticsOnly) {
    const err = new Error(
      "This historical Sales Dispatch is logistics-only and has no Store Dispatch stock evidence. Posting would fabricate DISPATCH_OUT and is blocked."
    );
    err.statusCode = 409;
    err.code = "LEGACY_LOGISTICS_ONLY_NO_STOCK_POST";
    throw err;
  }
  if (String(doc.status || "").toUpperCase() === "CANCELLED" || String(doc.postingStatus) === "CANCELLED") {
    const err = new Error("Cannot post a cancelled Sales Dispatch");
    err.statusCode = 400;
    throw err;
  }

  // Idempotent: already posted with linked StoreDispatch
  if (String(doc.postingStatus) === "POSTED" && doc.linkedStoreDispatchId) {
    const replay = await httpish(postStoreDispatch, req, { params: { id: String(doc.linkedStoreDispatchId) } });
    if (replay.statusCode >= 400) {
      const err = new Error(replay.payload?.message || "Store Dispatch post failed");
      err.statusCode = replay.statusCode;
      err.code = replay.payload?.code;
      throw err;
    }
    return {
      salesDispatch: doc,
      alreadyPosted: true,
      storeDispatchId: doc.linkedStoreDispatchId,
    };
  }

  doc.postingStatus = "POSTING";
  doc.updatedBy = req.user?.email || "";
  await doc.save();

  try {
    let storeDoc = null;
    if (doc.linkedStoreDispatchId) {
      storeDoc = await StoreDispatch.findOne(withCompany(req, { _id: doc.linkedStoreDispatchId }));
    }
    if (!storeDoc || String(storeDoc.status).toUpperCase() === "CANCELLED") {
      const storeLines = (doc.lines || []).map((ln) => ({
        invoiceLineId: ln.sourceLineId,
        article: ln.article,
        dispatchQty: Number(ln.qty) || 0,
        remarks: ln.remarks || "",
      }));
      storeDoc = await createStoreDispatchDraftCore(req, {
        salesInvoiceId: doc.linkedSalesInvoiceId,
        dispatchDate: doc.dispatchDate,
        transporter: doc.transporter || doc.courier,
        courier: doc.courier || doc.transporter,
        awbNo: doc.awbNo,
        blNo: doc.blNo,
        containerNo: doc.containerNo,
        remarks: doc.remarks,
        lines: storeLines,
        canonicalSalesDispatchId: doc._id,
        canonicalSalesDispatchNo: doc.dispatchNo,
      });
      doc.linkedStoreDispatchId = storeDoc._id;
      doc.linkedStoreDispatchNo = storeDoc.dispatchNo;
      await doc.save();
    } else if (!storeDoc.canonicalSalesDispatchId) {
      storeDoc.canonicalSalesDispatchId = doc._id;
      storeDoc.canonicalSalesDispatchNo = doc.dispatchNo;
      await storeDoc.save();
    }

    const posted = await httpish(postStoreDispatch, req, { params: { id: String(storeDoc._id) } });
    if (posted.statusCode >= 400) {
      doc.postingStatus = "NOT_POSTED";
      await doc.save();
      const err = new Error(posted.payload?.message || "Store Dispatch post failed");
      err.statusCode = posted.statusCode;
      err.code = posted.payload?.code;
      err.details = posted.payload?.details;
      throw err;
    }

    doc.postingStatus = "POSTED";
    doc.postedAt = new Date();
    doc.postedBy = req.user?.email || "";
    if (["DRAFT", "READY"].includes(String(doc.status || "").toUpperCase())) {
      doc.status = "DISPATCHED";
    }
    doc.dispatchedQty = doc.totalQty;
    doc.pendingQty = 0;
    doc.updatedBy = req.user?.email || "";
    await doc.save();

    await writeAudit(req, {
      action: "POST",
      module: "SALES",
      entityType: "SALES_DISPATCH",
      entityId: doc._id,
      documentNo: doc.dispatchNo,
      toStatus: doc.status,
      description: `Sales Dispatch ${doc.dispatchNo} posted (internal Store Dispatch ${storeDoc.dispatchNo})`,
      metadata: {
        linkedStoreDispatchId: String(storeDoc._id),
        alreadyPosted: Boolean(posted.payload?.alreadyPosted),
      },
    });

    return {
      salesDispatch: doc,
      alreadyPosted: Boolean(posted.payload?.alreadyPosted),
      storeDispatchId: storeDoc._id,
    };
  } catch (err) {
    if (String(doc.postingStatus) === "POSTING") {
      doc.postingStatus = "NOT_POSTED";
      await doc.save().catch(() => {});
    }
    throw err;
  }
}

export async function cancelCanonicalSalesDispatch(req, id, reason = "") {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const err = new Error("Invalid sales dispatch id");
    err.statusCode = 400;
    throw err;
  }
  const doc = await SalesDispatch.findOne(withCompany(req, { _id: id }));
  if (!doc) {
    const err = new Error("Sales Dispatch not found");
    err.statusCode = 404;
    throw err;
  }
  if (String(doc.status || "").toUpperCase() === "CANCELLED" && String(doc.postingStatus) === "CANCELLED") {
    return { salesDispatch: doc, alreadyCancelled: true };
  }

  if (doc.linkedStoreDispatchId && String(doc.postingStatus) === "POSTED") {
    const cancelled = await httpish(cancelStoreDispatch, req, {
      params: { id: String(doc.linkedStoreDispatchId) },
      body: { reason },
    });
    if (cancelled.statusCode >= 400) {
      const err = new Error(cancelled.payload?.message || "Store Dispatch cancel failed");
      err.statusCode = cancelled.statusCode;
      err.code = cancelled.payload?.code;
      throw err;
    }
  } else if (doc.linkedStoreDispatchId) {
    const storeDoc = await StoreDispatch.findOne(withCompany(req, { _id: doc.linkedStoreDispatchId }));
    if (storeDoc && String(storeDoc.status).toUpperCase() === "DRAFT") {
      await httpish(cancelStoreDispatch, req, {
        params: { id: String(doc.linkedStoreDispatchId) },
        body: { reason },
      });
    }
  }

  doc.status = "CANCELLED";
  doc.postingStatus = "CANCELLED";
  doc.cancelledAt = new Date();
  doc.cancelledBy = req.user?.email || "";
  doc.cancellationReason = t(reason);
  doc.updatedBy = req.user?.email || "";
  await doc.save();

  await writeAudit(req, {
    action: "CANCEL",
    module: "SALES",
    entityType: "SALES_DISPATCH",
    entityId: doc._id,
    documentNo: doc.dispatchNo,
    toStatus: "CANCELLED",
    description: `Sales Dispatch ${doc.dispatchNo} cancelled`,
    metadata: { reason: t(reason), linkedStoreDispatchId: doc.linkedStoreDispatchId ? String(doc.linkedStoreDispatchId) : null },
  });

  return { salesDispatch: doc, alreadyCancelled: false };
}
