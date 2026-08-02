/**
 * S2 — Canonical Sales Dispatch HTTP handlers (user-facing API).
 * Physical stock posting is delegated to StoreDispatch internals.
 */
import mongoose from "mongoose";
import SalesDispatch from "../models/SalesDispatch.js";
import {
  createCanonicalSalesDispatch,
  updateCanonicalSalesDispatch,
  postCanonicalSalesDispatch,
  cancelCanonicalSalesDispatch,
} from "../services/canonicalSalesDispatchService.js";

function withCompany(req, filter = {}) {
  return { ...filter, companyId: req.companyId };
}

export async function createSalesDispatch(req, res) {
  try {
    const doc = await createCanonicalSalesDispatch(req, req.body || {});
    res.status(201).json(doc);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message, code: err.code || undefined });
  }
}

export async function updateSalesDispatch(req, res) {
  try {
    const doc = await updateCanonicalSalesDispatch(req, req.params.id, req.body || {});
    res.json(doc);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message, code: err.code || undefined });
  }
}

export async function postSalesDispatch(req, res) {
  try {
    const result = await postCanonicalSalesDispatch(req, req.params.id);
    res.status(result.alreadyPosted ? 200 : 200).json({
      success: true,
      alreadyPosted: Boolean(result.alreadyPosted),
      item: result.salesDispatch,
      linkedStoreDispatchId: result.storeDispatchId,
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({
      message: err.message,
      code: err.code || undefined,
      details: err.details || undefined,
    });
  }
}

export async function cancelSalesDispatch(req, res) {
  try {
    const result = await cancelCanonicalSalesDispatch(req, req.params.id, req.body?.reason || "");
    res.json({
      success: true,
      alreadyCancelled: Boolean(result.alreadyCancelled),
      item: result.salesDispatch,
    });
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message, code: err.code || undefined });
  }
}

/** Pending issued invoices eligible for Sales Dispatch creation. */
export async function listPendingSalesDispatchInvoices(req, res) {
  try {
    // Reuse Store outbound pending list (same eligibility / packing rules).
    const { listPendingDispatchInvoices } = await import("./storeOutboundController.js");
    return listPendingDispatchInvoices(req, res);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getSalesDispatchPreviewFromInvoice(req, res) {
  try {
    const { getDispatchFromInvoice } = await import("./storeOutboundController.js");
    return getDispatchFromInvoice(req, res);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function enrichCanonicalListItem(companyId, doc) {
  if (!doc) return doc;
  const lean = doc.toObject?.() || doc;
  return {
    ...lean,
    postingStatus: lean.postingStatus || "NOT_POSTED",
    isLegacyLogisticsOnly: Boolean(lean.isLegacyLogisticsOnly),
  };
}

export async function listCanonicalSalesDispatches(req, res) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    const skip = (page - 1) * limit;
    const filter = withCompany(req);
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.postingStatus) filter.postingStatus = String(req.query.postingStatus).toUpperCase();
    const q = String(req.query.search || "").trim();
    if (q) {
      const re = new RegExp(q, "i");
      filter.$or = [{ dispatchNo: re }, { customerName: re }, { linkedSalesInvoiceNo: re }, { awbNo: re }];
    }
    const [items, total] = await Promise.all([
      SalesDispatch.find(filter).sort({ dispatchDate: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      SalesDispatch.countDocuments(filter),
    ]);
    res.json({
      items: items.map((d) => ({
        ...d,
        postingStatus: d.postingStatus || "NOT_POSTED",
        isLegacyLogisticsOnly: Boolean(d.isLegacyLogisticsOnly),
      })),
      total,
      page,
      limit,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}
