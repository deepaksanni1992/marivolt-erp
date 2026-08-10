import { isCustomsEnabled } from "../config/customsConfig.js";
import * as svc from "../services/customsInvoiceService.js";

function disabled(res) {
  return res.status(404).json({
    message: "Customs module is disabled. Set CUSTOMS_ENABLED=true to enable.",
    enabled: false,
  });
}

function parsePaging(req) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const exportAll = String(req.query.exportAll || "").toLowerCase() === "true";
  const cap = exportAll ? 5000 : 200;
  const limit = Math.min(cap, Math.max(1, Number(req.query.limit) || 50));
  return { page, limit };
}

export async function listCustomsInvoices(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const paging = parsePaging(req);
    const result = await svc.listCustomsInvoices(req.companyId, {
      page: paging.page,
      limit: paging.limit,
      search: req.query.search,
      status: req.query.status,
    });
    res.json({ enabled: true, ...result });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to list customs invoices" });
  }
}

export async function getCustomsInvoice(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const doc = await svc.getCustomsInvoiceById(req.companyId, req.params.id);
    const canOverride = await svc.userHasBoeOverridePermission(req);
    res.json({ enabled: true, item: doc, canOverride });
  } catch (err) {
    res.status(404).json({ message: err.message || "Not found" });
  }
}

export async function getCustomsInvoiceBySalesInvoice(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const doc = await svc.getCustomsInvoiceBySalesInvoiceId(req.companyId, req.params.salesInvoiceId);
    res.json({ enabled: true, item: doc });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load customs invoice" });
  }
}

export async function previewFromSalesInvoice(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const preview = await svc.previewCustomsAllocationFromSalesInvoice(
      req,
      req.params.salesInvoiceId,
      req.body || {}
    );
    res.json({ enabled: true, ...preview });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to preview customs allocation" });
  }
}

export async function createFromSalesInvoice(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const doc = await svc.createCustomsInvoiceFromSalesInvoice(req, req.params.salesInvoiceId, req.body || {});
    res.status(201).json({ enabled: true, item: doc });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to create customs invoice" });
  }
}

export async function updateCustomsInvoice(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const doc = await svc.updateCustomsInvoiceDraft(req, req.params.id, req.body || {});
    res.json({ enabled: true, item: doc });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to update customs invoice" });
  }
}

export async function finalizeCustomsInvoice(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const doc = await svc.finalizeCustomsInvoice(req, req.params.id, req.body || {});
    res.json({ enabled: true, item: doc });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to finalize customs invoice" });
  }
}

export async function cancelCustomsInvoice(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const reason = req.body?.reason || req.body?.cancellationReason || "";
    const doc = await svc.cancelCustomsInvoice(req, req.params.id, reason);
    res.json({ enabled: true, item: doc });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to cancel customs invoice" });
  }
}

export async function listAvailableLots(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const items = await svc.listAvailableCustomsLots(req.companyId, {
      articleNumber: req.query.articleNumber || req.query.article,
      partNumber: req.query.partNumber,
    });
    res.json({ enabled: true, items });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to load available lots" });
  }
}

export async function getCustomsInvoicePrint(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const doc = await svc.getCustomsInvoiceById(req.companyId, req.params.id);
    const rows = svc.buildCustomsInvoicePrintRows(doc);
    res.json({
      enabled: true,
      header: {
        customsInvoiceNumber: doc.customsInvoiceNumber,
        salesInvoiceNumber: doc.salesInvoiceNumber,
        customerName: doc.customerName,
        invoiceDate: doc.invoiceDate,
        status: doc.status,
        companyCode: doc.companyCode,
      },
      rows,
      item: doc,
    });
  } catch (err) {
    res.status(404).json({ message: err.message || "Not found" });
  }
}

export async function checkSalesInvoiceEligibility(req, res) {
  try {
    if (!isCustomsEnabled()) return disabled(res);
    const existing = await svc.getCustomsInvoiceBySalesInvoiceId(req.companyId, req.params.salesInvoiceId);
    res.json({
      enabled: true,
      hasCustomsInvoice: !!existing,
      customsInvoice: existing,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || "Failed to check eligibility" });
  }
}
