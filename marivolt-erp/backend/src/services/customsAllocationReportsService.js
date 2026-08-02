/**
 * CG2 — Customs allocation reports (read-only aggregates).
 */
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsInvoice from "../models/CustomsInvoice.js";
import CustomsMovement from "../models/CustomsMovement.js";
import { customsWithCompanyId } from "./customsService.js";

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

/** BOE Balance — remaining qty/value by BOE number. */
export async function reportBoeBalance(companyId, { search = "", articleNumber = "" } = {}) {
  const filter = customsWithCompanyId(companyId, {
    status: { $ne: "CANCELLED" },
  });
  if (articleNumber) filter.articleNumber = upper(articleNumber);

  const items = await CustomsLotItem.find(filter)
    .select(
      "boeNumber boeDate articleNumber partNumber qtyImported qtyAvailable qtyConsumed unitPrice customsValueAED totalValue unitWeightKg totalWeightKg supplierInvoiceNumber supplierInvoiceDate countryOfOrigin hsCode customsLotRef grnNo"
    )
    .lean();

  const byBoe = new Map();
  const q = upper(search);
  for (const it of items) {
    const boe = t(it.boeNumber) || "(NO BOE)";
    if (q && !upper(boe).includes(q) && !upper(it.articleNumber).includes(q)) continue;
    if (!byBoe.has(boe)) {
      byBoe.set(boe, {
        boeNumber: boe,
        boeDate: it.boeDate || null,
        articles: new Set(),
        qtyImported: 0,
        qtyAvailable: 0,
        qtyConsumed: 0,
        customsValueAED: 0,
        lines: [],
      });
    }
    const row = byBoe.get(boe);
    row.articles.add(it.articleNumber);
    row.qtyImported += Number(it.qtyImported) || 0;
    row.qtyAvailable += Number(it.qtyAvailable) || 0;
    row.qtyConsumed += Number(it.qtyConsumed) || 0;
    const remainingShare =
      Number(it.qtyImported) > 0
        ? (Number(it.qtyAvailable) / Number(it.qtyImported)) * (Number(it.customsValueAED) || Number(it.totalValue) || 0)
        : 0;
    row.customsValueAED += remainingShare;
    row.lines.push({
      articleNumber: it.articleNumber,
      partNumber: it.partNumber,
      qtyAvailable: it.qtyAvailable,
      qtyConsumed: it.qtyConsumed,
      customsLotRef: it.customsLotRef,
      grnNo: it.grnNo,
      hsCode: it.hsCode,
      countryOfOrigin: it.countryOfOrigin,
    });
    if (!row.boeDate && it.boeDate) row.boeDate = it.boeDate;
  }

  return {
    items: [...byBoe.values()].map((r) => ({
      ...r,
      articleCount: r.articles.size,
      articles: undefined,
    })),
  };
}

/** Customs Lot Balance — per lot item remaining. */
export async function reportLotBalance(companyId, { search = "", status = "" } = {}) {
  const filter = customsWithCompanyId(companyId, {});
  if (status) filter.status = upper(status);
  else filter.status = { $ne: "CANCELLED" };

  const q = t(search);
  if (q) {
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ articleNumber: re }, { boeNumber: re }, { customsLotRef: re }, { grnNo: re }];
  }

  const items = await CustomsLotItem.find(filter)
    .sort({ articleNumber: 1, boeDate: 1 })
    .limit(2000)
    .lean();

  return {
    items: items.map((it) => ({
      customsLotRef: it.customsLotRef,
      customsLotItemId: it._id,
      articleNumber: it.articleNumber,
      partNumber: it.partNumber,
      boeNumber: it.boeNumber,
      boeDate: it.boeDate,
      supplierInvoiceNumber: it.supplierInvoiceNumber,
      supplierInvoiceDate: it.supplierInvoiceDate,
      receivedDate: it.receivedDate,
      qtyImported: it.qtyImported,
      qtyAvailable: it.qtyAvailable,
      qtyConsumed: it.qtyConsumed,
      status: it.status,
      countryOfOrigin: it.countryOfOrigin,
      hsCode: it.hsCode,
      unitPrice: it.unitPrice,
      customsValueAED: it.customsValueAED,
      grnNo: it.grnNo,
    })),
  };
}

/** Customs Consumption — OUTBOUND movements / posted invoice allocations. */
export async function reportCustomsConsumption(companyId, { dateFrom = "", dateTo = "", articleNumber = "" } = {}) {
  const filter = customsWithCompanyId(companyId, {
    movementType: "OUTBOUND",
    referenceType: "CUSTOMS_INVOICE",
  });
  if (articleNumber) filter.articleNumber = upper(articleNumber);
  if (dateFrom || dateTo) {
    filter.movementDate = {};
    if (dateFrom) filter.movementDate.$gte = new Date(dateFrom);
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      filter.movementDate.$lte = end;
    }
  }

  const movements = await CustomsMovement.find(filter).sort({ movementDate: -1 }).limit(2000).lean();
  const itemIds = [...new Set(movements.map((m) => String(m.customsLotItemId)).filter(Boolean))];
  const items = itemIds.length
    ? await CustomsLotItem.find({ _id: { $in: itemIds } })
        .select("boeNumber boeDate supplierInvoiceNumber hsCode countryOfOrigin")
        .lean()
    : [];
  const itemMap = new Map(items.map((i) => [String(i._id), i]));

  return {
    items: movements.map((m) => {
      const it = itemMap.get(String(m.customsLotItemId)) || {};
      return {
        movementDate: m.movementDate,
        articleNumber: m.articleNumber,
        partNumber: m.partNumber,
        qty: m.qty,
        customsInvoiceNumber: m.referenceNumber,
        boeNumber: it.boeNumber || "",
        boeDate: it.boeDate || null,
        supplierInvoiceNumber: it.supplierInvoiceNumber || "",
        countryOfOrigin: it.countryOfOrigin || "",
        hsCode: it.hsCode || "",
      };
    }),
  };
}

/**
 * Traceability:
 * - article → BOE history
 * - BOE → customer history (via posted customs invoices)
 */
export async function reportCustomsTraceability(companyId, { articleNumber = "", boeNumber = "" } = {}) {
  const article = upper(articleNumber);
  const boe = t(boeNumber);

  let articleToBoe = [];
  if (article) {
    const lots = await CustomsLotItem.find(
      customsWithCompanyId(companyId, { articleNumber: article, status: { $ne: "CANCELLED" } }),
    )
      .select("boeNumber boeDate qtyImported qtyAvailable qtyConsumed grnNo customsLotRef supplierInvoiceNumber")
      .lean();
    articleToBoe = lots.map((l) => ({
      articleNumber: article,
      boeNumber: l.boeNumber,
      boeDate: l.boeDate,
      qtyImported: l.qtyImported,
      qtyAvailable: l.qtyAvailable,
      qtyConsumed: l.qtyConsumed,
      grnNo: l.grnNo,
      customsLotRef: l.customsLotRef,
      supplierInvoiceNumber: l.supplierInvoiceNumber,
    }));
  }

  let boeToCustomer = [];
  if (boe) {
    const invoices = await CustomsInvoice.find(
      customsWithCompanyId(companyId, {
        status: "POSTED",
        "items.allocations.boeNumber": new RegExp(`^${boe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      }),
    )
      .select("customsInvoiceNumber salesInvoiceNumber customerName invoiceDate items")
      .lean();

    for (const inv of invoices) {
      for (const line of inv.items || []) {
        for (const alloc of line.allocations || []) {
          if (upper(alloc.boeNumber) !== upper(boe)) continue;
          boeToCustomer.push({
            boeNumber: alloc.boeNumber,
            boeDate: alloc.boeDate,
            customerName: inv.customerName,
            customsInvoiceNumber: inv.customsInvoiceNumber,
            salesInvoiceNumber: inv.salesInvoiceNumber,
            invoiceDate: inv.invoiceDate,
            articleNumber: line.articleNumber,
            qty: alloc.qty,
          });
        }
      }
    }
  }

  return { articleToBoe, boeToCustomer };
}
