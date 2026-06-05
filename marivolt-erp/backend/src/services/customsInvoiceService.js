import mongoose from "mongoose";
import CustomsInvoice from "../models/CustomsInvoice.js";
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import SalesInvoice from "../models/SalesInvoice.js";
import {
  allocateCustomsStockFIFO,
  createCustomsMovement,
  customsWithCompanyId,
  isCustomsEnabled,
} from "./customsService.js";
import { nextCustomsInvoiceNumber } from "./customsNumberService.js";
import { hasPermission } from "./roleService.js";
import { writeAudit } from "./auditService.js";

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

const ELIGIBLE_SALES_INVOICE_STATUSES = new Set(["ISSUED", "DISPATCHED", "PARTIALLY_PAID", "PAID"]);

export function isSalesInvoiceEligibleForCustoms(invoice) {
  const st = upper(invoice?.status);
  return ELIGIBLE_SALES_INVOICE_STATUSES.has(st);
}

async function userCanOverride(req) {
  return hasPermission(req, "CUSTOMS", "override");
}

async function loadSalesInvoice(companyId, salesInvoiceId) {
  if (!mongoose.Types.ObjectId.isValid(String(salesInvoiceId))) {
    throw new Error("Invalid sales invoice id");
  }
  const inv = await SalesInvoice.findOne(customsWithCompanyId(companyId, { _id: salesInvoiceId })).lean();
  if (!inv) throw new Error("Sales invoice not found");
  if (!isSalesInvoiceEligibleForCustoms(inv)) {
    throw new Error(`Sales invoice must be issued/posted (status: ${inv.status})`);
  }
  return inv;
}

async function assertNoActiveCustomsInvoice(companyId, salesInvoiceId, excludeId = null) {
  const filter = customsWithCompanyId(companyId, {
    salesInvoiceId,
    status: { $ne: "CANCELLED" },
  });
  if (excludeId) filter._id = { $ne: excludeId };
  const existing = await CustomsInvoice.findOne(filter).select("_id customsInvoiceNumber status").lean();
  if (existing) {
    throw new Error(
      `Sales invoice already has customs invoice ${existing.customsInvoiceNumber} (${existing.status})`,
    );
  }
}

async function loadLotMaps(lotItemIds) {
  const ids = [...new Set(lotItemIds.filter(Boolean))];
  if (!ids.length) return { lotMap: new Map(), itemMap: new Map() };

  const items = await CustomsLotItem.find({ _id: { $in: ids } }).lean();
  const lotIds = [...new Set(items.map((i) => String(i.customsLotId)))];
  const lots = lotIds.length
    ? await CustomsLot.find({ _id: { $in: lotIds } }).select("supplierName documents boeNumber blNumber awbNumber supplierInvoiceNumber supplierInvoiceDate countryOfOrigin currency").lean()
    : [];

  return {
    itemMap: new Map(items.map((i) => [String(i._id), i])),
    lotMap: new Map(lots.map((l) => [String(l._id), l])),
  };
}

function buildAllocationRecord({ item, lot, qty, mode, override = {} }) {
  const unitPrice = Number(override.unitPrice ?? item?.unitPrice) || 0;
  const weightKg = Number(override.weightKg ?? item?.weightKg) || 0;
  const q = Number(qty) || 0;
  const docs = lot?.documents || {};
  const documentLinks = [docs.blDocumentId, docs.supplierInvoiceDocumentId].filter(Boolean);

  return {
    customsLotItemId: item?._id || null,
    qty: q,
    boeNumber: t(override.boeNumber || item?.boeNumber || lot?.boeNumber),
    blNumber: t(override.blNumber || item?.blNumber || lot?.blNumber),
    awbNumber: t(override.awbNumber || item?.awbNumber || lot?.awbNumber),
    supplierInvoiceNumber: t(
      override.supplierInvoiceNumber || item?.supplierInvoiceNumber || lot?.supplierInvoiceNumber,
    ),
    supplierInvoiceDate:
      override.supplierInvoiceDate || item?.supplierInvoiceDate || lot?.supplierInvoiceDate || null,
    supplierName: t(override.supplierName || lot?.supplierName),
    countryOfOrigin: upper(override.countryOfOrigin || item?.countryOfOrigin || lot?.countryOfOrigin),
    hsCode: upper(override.hsCode || item?.hsCode),
    currency: upper(override.currency || item?.currency || lot?.currency || "USD"),
    unitPrice,
    weightKg,
    totalValue: q * unitPrice,
    allocationMode: mode,
    overrideReason: t(override.overrideReason),
    documentLinks,
  };
}

async function fifoAllocateLine({ companyId, articleNumber, partNumber, qty, session }) {
  if (partNumber) {
    try {
      return await allocateCustomsStockFIFO({
        companyId,
        articleNumber,
        qty,
        partNumber,
        session,
      });
    } catch {
      /* retry article-only */
    }
  }
  return allocateCustomsStockFIFO({
    companyId,
    articleNumber,
    qty,
    partNumber: "",
    session,
  });
}

function mapFifoToAllocations(fifoRows, lotMap, itemMap) {
  return fifoRows.map(({ qty, item, customsLotItemId }) => {
    const lot = lotMap.get(String(item?.customsLotId)) || lotMap.get(String(item?.customsLotId?._id));
    const lotItem = itemMap.get(String(customsLotItemId || item?._id)) || item;
    return buildAllocationRecord({
      item: lotItem,
      lot,
      qty,
      mode: "AUTO_FIFO",
    });
  });
}

async function buildItemsFromSalesInvoice(salesInvoice, { companyId, session, allowOverride, overrideLines }) {
  const overrideMap = new Map();
  for (const row of overrideLines || []) {
    const key = String(row.salesInvoiceLineId || row.lineId || "");
    if (key) overrideMap.set(key, row);
  }

  const items = [];
  for (const line of salesInvoice.lines || []) {
    const lineId = line._id;
    const qtyExported = Number(line.qty) || 0;
    if (qtyExported <= 0) continue;

    const articleNumber = upper(line.article);
    const partNumber = upper(line.partNumber);
    const overrideRow = overrideMap.get(String(lineId));

    let allocations = [];
    if (overrideRow?.allocations?.length) {
      const lotItemIds = overrideRow.allocations.map((a) => a.customsLotItemId).filter(Boolean);
      const { lotMap, itemMap } = await loadLotMaps(lotItemIds);
      for (const alloc of overrideRow.allocations) {
        const mode = alloc.allocationMode || (alloc.overrideReason ? "OVERRIDE_DUMMY" : "MANUAL");
        if (mode === "OVERRIDE_DUMMY" || !alloc.customsLotItemId) {
          allocations.push(
            buildAllocationRecord({
              item: null,
              lot: null,
              qty: Number(alloc.qty) || 0,
              mode: "OVERRIDE_DUMMY",
              override: alloc,
            }),
          );
          continue;
        }
        const item = itemMap.get(String(alloc.customsLotItemId));
        const lot = lotMap.get(String(item?.customsLotId));
        if (!item) throw new Error(`Customs lot item not found for allocation`);
        const take = Number(alloc.qty) || 0;
        if (take > Number(item.qtyAvailable) + 1e-6) {
          if (!allowOverride) {
            throw new Error(
              `Insufficient customs stock for ${articleNumber} on lot item (need ${take}, available ${item.qtyAvailable})`,
            );
          }
        }
        allocations.push(
          buildAllocationRecord({
            item,
            lot,
            qty: take,
            mode: mode === "OVERRIDE_DUMMY" ? "OVERRIDE_DUMMY" : "MANUAL",
            override: alloc,
          }),
        );
      }
    } else {
      try {
        const fifo = await fifoAllocateLine({
          companyId,
          articleNumber,
          partNumber,
          qty: qtyExported,
          session,
        });
        const lotItemIds = fifo.map((f) => f.customsLotItemId);
        const { lotMap, itemMap } = await loadLotMaps(lotItemIds);
        allocations = mapFifoToAllocations(fifo, lotMap, itemMap);
      } catch (err) {
        if (!allowOverride) throw err;
        allocations = [
          buildAllocationRecord({
            item: null,
            lot: null,
            qty: qtyExported,
            mode: "OVERRIDE_DUMMY",
            override: { overrideReason: overrideRow?.overrideReason || "Override — insufficient customs stock" },
          }),
        ];
      }
    }

    const allocSum = allocations.reduce((s, a) => s + (Number(a.qty) || 0), 0);
    if (Math.abs(allocSum - qtyExported) > 1e-6) {
      throw new Error(
        `Allocations for article ${articleNumber} must total ${qtyExported} (got ${allocSum})`,
      );
    }

    items.push({
      salesInvoiceLineId: lineId,
      articleNumber,
      partNumber,
      partName: line.description || "",
      description: line.description || "",
      qtyExported,
      allocations,
    });
  }

  return items;
}

export async function listAvailableCustomsLots(companyId, { articleNumber, partNumber = "" } = {}) {
  if (!articleNumber) throw new Error("articleNumber is required");

  const filter = customsWithCompanyId(companyId, {
    articleNumber: upper(articleNumber),
    qtyAvailable: { $gt: 0 },
    status: { $in: ["IN_STOCK", "PARTIAL"] },
  });
  if (partNumber) filter.partNumber = upper(partNumber);

  const items = await CustomsLotItem.find(filter)
    .sort({ supplierInvoiceDate: 1, createdAt: 1 })
    .lean();

  const lotIds = [...new Set(items.map((i) => String(i.customsLotId)))];
  const lots = lotIds.length
    ? await CustomsLot.find({ _id: { $in: lotIds } })
        .select("supplierName supplierInvoiceNumber supplierInvoiceDate countryOfOrigin documents boeNumber blNumber awbNumber")
        .lean()
    : [];
  const lotMap = new Map(lots.map((l) => [String(l._id), l]));

  return items.map((item) => {
    const lot = lotMap.get(String(item.customsLotId)) || {};
    return {
      customsLotItemId: item._id,
      customsLotId: item.customsLotId,
      boeNumber: item.boeNumber || lot.boeNumber || "",
      blNumber: item.blNumber || lot.blNumber || "",
      awbNumber: item.awbNumber || lot.awbNumber || "",
      supplierInvoiceNumber: item.supplierInvoiceNumber || lot.supplierInvoiceNumber || "",
      supplierInvoiceDate: item.supplierInvoiceDate || lot.supplierInvoiceDate || null,
      supplierName: lot.supplierName || "",
      qtyImported: item.qtyImported,
      qtyAvailable: item.qtyAvailable,
      countryOfOrigin: item.countryOfOrigin || lot.countryOfOrigin || "",
      articleNumber: item.articleNumber,
      partNumber: item.partNumber,
      documents: lot.documents || {},
    };
  });
}

export async function createCustomsInvoiceFromSalesInvoice(req, salesInvoiceId, body = {}) {
  if (!isCustomsEnabled()) throw new Error("Customs module is disabled");

  const salesInvoice = await loadSalesInvoice(req.companyId, salesInvoiceId);
  await assertNoActiveCustomsInvoice(req.companyId, salesInvoiceId);

  const allowOverride = await userCanOverride(req);
  const items = await buildItemsFromSalesInvoice(salesInvoice, {
    companyId: req.companyId,
    session: null,
    allowOverride,
    overrideLines: body.items,
  });

  const customsInvoiceNumber = await nextCustomsInvoiceNumber({
    companyId: req.companyId,
    companyCode: req.companyCode,
  });

  const [doc] = await CustomsInvoice.create([
    {
      companyId: req.companyId,
      companyCode: upper(req.companyCode || "CMP"),
      customsInvoiceNumber,
      salesInvoiceId: salesInvoice._id,
      salesInvoiceNumber: salesInvoice.invoiceNo || salesInvoice.invoiceNumber,
      customerName: salesInvoice.customerName || "",
      invoiceDate: body.invoiceDate ? new Date(body.invoiceDate) : new Date(),
      status: "DRAFT",
      remarks: t(body.remarks),
      items,
      createdBy: req.user?.email || "",
      updatedBy: req.user?.email || "",
    },
  ]);

  await writeAudit(req, {
    action: "CREATE",
    module: "CUSTOMS",
    entityType: "CUSTOMS_INVOICE",
    entityId: doc._id,
    documentNo: doc.customsInvoiceNumber,
    description: `Customs invoice ${doc.customsInvoiceNumber} created from sales invoice ${doc.salesInvoiceNumber}`,
    metadata: { salesInvoiceId: salesInvoice._id, allocation: "AUTO_FIFO" },
  });

  return doc.toObject();
}

export async function updateCustomsInvoiceDraft(req, customsInvoiceId, body = {}) {
  if (!isCustomsEnabled()) throw new Error("Customs module is disabled");
  if (!mongoose.Types.ObjectId.isValid(String(customsInvoiceId))) throw new Error("Invalid customs invoice id");

  const doc = await CustomsInvoice.findOne(
    customsWithCompanyId(req.companyId, { _id: customsInvoiceId }),
  );
  if (!doc) throw new Error("Customs invoice not found");
  if (doc.status !== "DRAFT") throw new Error("Only DRAFT customs invoices can be edited");

  const salesInvoice = await loadSalesInvoice(req.companyId, doc.salesInvoiceId);
  const allowOverride = await userCanOverride(req);

  if (Array.isArray(body.items) && body.items.length) {
    doc.items = await buildItemsFromSalesInvoice(salesInvoice, {
      companyId: req.companyId,
      session: null,
      allowOverride,
      overrideLines: body.items,
    });
  }

  if (body.remarks != null) doc.remarks = t(body.remarks);
  if (body.invoiceDate) doc.invoiceDate = new Date(body.invoiceDate);
  doc.updatedBy = req.user?.email || "";
  await doc.save();

  await writeAudit(req, {
    action: "UPDATE",
    module: "CUSTOMS",
    entityType: "CUSTOMS_INVOICE",
    entityId: doc._id,
    documentNo: doc.customsInvoiceNumber,
    description: `Customs invoice ${doc.customsInvoiceNumber} updated (manual/override allocation)`,
    metadata: { manual: true },
  });

  return doc.toObject();
}

function deriveItemStatus(qtyAvailable, qtyImported) {
  if (qtyAvailable <= 0.000001) return "CONSUMED";
  if (qtyAvailable + 0.000001 < qtyImported) return "PARTIAL";
  return "IN_STOCK";
}

export async function finalizeCustomsInvoice(req, customsInvoiceId) {
  if (!isCustomsEnabled()) throw new Error("Customs module is disabled");

  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const doc = await CustomsInvoice.findOne(
        customsWithCompanyId(req.companyId, { _id: customsInvoiceId }),
      ).session(session);
      if (!doc) throw new Error("Customs invoice not found");
      if (doc.status !== "DRAFT") throw new Error("Only DRAFT customs invoices can be finalized");

      const allowOverride = await userCanOverride(req);

      for (const line of doc.items || []) {
        for (const alloc of line.allocations || []) {
          const qty = Number(alloc.qty) || 0;
          if (qty <= 0) continue;

          if (alloc.allocationMode === "OVERRIDE_DUMMY" || !alloc.customsLotItemId) {
            if (!allowOverride && alloc.allocationMode === "OVERRIDE_DUMMY") {
              throw new Error("Override allocation requires CUSTOMS.override permission");
            }
            continue;
          }

          const item = await CustomsLotItem.findOne(
            customsWithCompanyId(req.companyId, { _id: alloc.customsLotItemId }),
          ).session(session);
          if (!item) throw new Error("Customs lot item not found during finalize");

          if (qty > Number(item.qtyAvailable) + 1e-6 && !allowOverride) {
            throw new Error(
              `Insufficient customs stock for ${item.articleNumber} (need ${qty}, available ${item.qtyAvailable})`,
            );
          }

          item.qtyAvailable = Math.max(0, Number(item.qtyAvailable) - qty);
          item.qtyConsumed = (Number(item.qtyConsumed) || 0) + qty;
          item.customStockBalance = item.qtyAvailable;
          item.status = deriveItemStatus(item.qtyAvailable, item.qtyImported);
          await item.save({ session });

          await createCustomsMovement({
            session,
            req,
            movementType: "OUTBOUND",
            customsLotId: item.customsLotId,
            customsLotItemId: item._id,
            articleNumber: item.articleNumber,
            partNumber: item.partNumber,
            qty,
            referenceType: "CUSTOMS_INVOICE",
            referenceId: doc._id,
            referenceNumber: doc.customsInvoiceNumber,
            movementDate: doc.invoiceDate || new Date(),
            remarks: `Outbound for customs invoice ${doc.customsInvoiceNumber} / sales ${doc.salesInvoiceNumber}`,
          });
        }
      }

      doc.status = "POSTED";
      doc.updatedBy = req.user?.email || "";
      await doc.save({ session });
      result = doc.toObject();
    });

    await writeAudit(req, {
      action: "POST",
      module: "CUSTOMS",
      entityType: "CUSTOMS_INVOICE",
      entityId: customsInvoiceId,
      documentNo: result?.customsInvoiceNumber,
      toStatus: "POSTED",
      description: `Customs invoice ${result?.customsInvoiceNumber} finalized — stock reduced`,
    });

    return result;
  } finally {
    await session.endSession();
  }
}

export async function cancelCustomsInvoice(req, customsInvoiceId, reason = "") {
  if (!isCustomsEnabled()) throw new Error("Customs module is disabled");

  const session = await mongoose.startSession();
  let result = null;
  try {
    await session.withTransaction(async () => {
      const doc = await CustomsInvoice.findOne(
        customsWithCompanyId(req.companyId, { _id: customsInvoiceId }),
      ).session(session);
      if (!doc) throw new Error("Customs invoice not found");
      if (doc.status === "CANCELLED") throw new Error("Customs invoice already cancelled");

      if (doc.status === "POSTED") {
        for (const line of doc.items || []) {
          for (const alloc of line.allocations || []) {
            const qty = Number(alloc.qty) || 0;
            if (qty <= 0 || !alloc.customsLotItemId) continue;

            const item = await CustomsLotItem.findOne(
              customsWithCompanyId(req.companyId, { _id: alloc.customsLotItemId }),
            ).session(session);
            if (!item) continue;

            item.qtyAvailable = (Number(item.qtyAvailable) || 0) + qty;
            item.qtyConsumed = Math.max(0, (Number(item.qtyConsumed) || 0) - qty);
            item.customStockBalance = item.qtyAvailable;
            item.status = deriveItemStatus(item.qtyAvailable, item.qtyImported);
            await item.save({ session });

            await createCustomsMovement({
              session,
              req,
              movementType: "REVERSAL",
              customsLotId: item.customsLotId,
              customsLotItemId: item._id,
              articleNumber: item.articleNumber,
              partNumber: item.partNumber,
              qty,
              referenceType: "CUSTOMS_INVOICE",
              referenceId: doc._id,
              referenceNumber: doc.customsInvoiceNumber,
              movementDate: new Date(),
              remarks: t(reason) || `Customs invoice ${doc.customsInvoiceNumber} cancelled — restore stock`,
            });
          }
        }
      }

      doc.status = "CANCELLED";
      doc.updatedBy = req.user?.email || "";
      doc.remarks = doc.remarks
        ? `${doc.remarks}\nCancelled: ${t(reason)}`
        : t(reason) || "Cancelled";
      await doc.save({ session });
      result = doc.toObject();
    });

    await writeAudit(req, {
      action: "CANCEL",
      module: "CUSTOMS",
      entityType: "CUSTOMS_INVOICE",
      entityId: customsInvoiceId,
      documentNo: result?.customsInvoiceNumber,
      toStatus: "CANCELLED",
      description: `Customs invoice ${result?.customsInvoiceNumber} cancelled`,
      metadata: { reason: t(reason) },
    });

    return result;
  } finally {
    await session.endSession();
  }
}

export async function getCustomsInvoiceById(companyId, id) {
  if (!mongoose.Types.ObjectId.isValid(String(id))) throw new Error("Invalid id");
  const doc = await CustomsInvoice.findOne(customsWithCompanyId(companyId, { _id: id })).lean();
  if (!doc) throw new Error("Customs invoice not found");
  return doc;
}

export async function getCustomsInvoiceBySalesInvoiceId(companyId, salesInvoiceId) {
  if (!mongoose.Types.ObjectId.isValid(String(salesInvoiceId))) return null;
  return CustomsInvoice.findOne(
    customsWithCompanyId(companyId, {
      salesInvoiceId,
      status: { $ne: "CANCELLED" },
    }),
  )
    .sort({ createdAt: -1 })
    .lean();
}

export async function listCustomsInvoices(companyId, { page = 1, limit = 50, search, status } = {}) {
  const filter = customsWithCompanyId(companyId, {});
  if (status) filter.status = upper(status);
  if (search) {
    const s = t(search);
    filter.$or = [
      { customsInvoiceNumber: new RegExp(s, "i") },
      { salesInvoiceNumber: new RegExp(s, "i") },
      { customerName: new RegExp(s, "i") },
    ];
  }

  const skip = (Math.max(1, page) - 1) * limit;
  const [items, total] = await Promise.all([
    CustomsInvoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    CustomsInvoice.countDocuments(filter),
  ]);

  return { items, total, page, limit };
}

export function buildCustomsInvoicePrintRows(invoice) {
  const rows = [];
  for (const line of invoice?.items || []) {
    for (const alloc of line.allocations || []) {
      rows.push({
        articleNumber: line.articleNumber,
        partNumber: line.partNumber,
        description: line.description || line.partName,
        qty: alloc.qty,
        boeNumber: alloc.boeNumber,
        blNumber: alloc.blNumber,
        awbNumber: alloc.awbNumber,
        supplierInvoiceNumber: alloc.supplierInvoiceNumber,
        countryOfOrigin: alloc.countryOfOrigin,
        hsCode: alloc.hsCode,
      });
    }
  }
  return rows;
}
