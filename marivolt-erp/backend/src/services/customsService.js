import mongoose from "mongoose";
import CustomsLot from "../models/CustomsLot.js";
import CustomsLotItem from "../models/CustomsLotItem.js";
import CustomsMovement from "../models/CustomsMovement.js";
import StockBalance from "../models/StockBalance.js";
import { isCustomsEnabled } from "../config/customsConfig.js";
import { nextCustomsLotRef } from "../services/customsNumberService.js";
import { writeAudit } from "./auditService.js";
import {
  CustomsGrnValidationError,
  buildLineOverrideMap,
  isCustomsCaptureActive,
  normalizeCustomsHeaderDefaults,
  resolveCustomsAllowances,
  resolveCustomsLineEffective,
  toPersistedGrnLineCustoms,
  validateCustomsCaptureForGrn,
} from "../utils/customsGrnFieldModel.js";
import {
  CUSTOMS_VALUATION_BOE_AVERAGE,
  roundCustomsMoney,
  roundCustomsQty,
  buildCustomsLotStockGroup,
  buildCustomsBoeStockGroup,
  computeLotItemCustomsEconomics,
  resolveValuationMethod,
  resolveCustomsLotItemProvenance,
} from "../utils/customsBoeAverage.js";
import {
  compareCustomsFifoOrder,
  sortCustomsLotsForFifo,
  allocateQtyAcrossLotsFifo,
  CUSTOMS_FIFO_ORDER_KEYS,
} from "../utils/customsFifo.js";
import { hasPermission } from "./roleService.js";
import GRN from "../models/GRN.js";
import {
  createCustomsBoe,
  getCustomsBoeByIdOrRef,
  reserveLinkedCustomsQty,
  releaseLinkedCustomsQty,
  mapBoeEconomicsToLotSnapshot,
} from "./customsBoeService.js";
import CustomsBoe from "../models/CustomsBoe.js";

export { isCustomsEnabled };
export { CustomsGrnValidationError };
export {
  compareCustomsFifoOrder,
  sortCustomsLotsForFifo,
  allocateQtyAcrossLotsFifo,
  CUSTOMS_FIFO_ORDER_KEYS,
};

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function withCompanyId(companyId, filter = {}) {
  const cid = companyId;
  if (cid == null || cid === "") return { ...filter };
  const s = String(cid).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    if (!Object.keys(filter).length) {
      return { $or: [{ companyId: oid }, { companyId: s }] };
    }
    return { $and: [{ ...filter }, { $or: [{ companyId: oid }, { companyId: s }] }] };
  }
  return { ...filter, companyId: cid };
}

function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function resolveDocumentId(value) {
  if (value == null) return null;
  if (typeof value === "object") {
    const id = t(value._id || value.id);
    return mongoose.Types.ObjectId.isValid(id) ? id : null;
  }
  const id = t(value);
  return mongoose.Types.ObjectId.isValid(id) ? id : null;
}

function hasCustomsDocuments(customs = {}) {
  const docs = customs?.documents;
  if (!docs || typeof docs !== "object") return false;
  if (
    resolveDocumentId(docs.blDocumentId) ||
    resolveDocumentId(docs.blCopy) ||
    resolveDocumentId(docs.supplierInvoiceDocumentId) ||
    resolveDocumentId(docs.supplierInvoiceCopy) ||
    resolveDocumentId(docs.packingListDocumentId) ||
    resolveDocumentId(docs.packingListCopy)
  ) {
    return true;
  }
  const otherLists = [docs.otherDocumentIds, docs.otherDocuments];
  for (const list of otherLists) {
    if (!Array.isArray(list)) continue;
    if (list.some((entry) => resolveDocumentId(entry))) return true;
  }
  return false;
}

/**
 * True when optional customs payload contains at least one identifying field.
 * Auto-filled Received Date and default Customs UOM PCS do not activate capture.
 */
export function hasCustomsPayload(body = {}) {
  const customs = body?.customs && typeof body.customs === "object" ? body.customs : body;
  const header = {
    ...customs,
    boeNumber: customs?.boeNumber || customs?.customsDocRef || body?.boeNumber || body?.customsDocRef,
    blNumber: customs?.blNumber || body?.blNumber || body?.blAwbNo,
    awbNumber: customs?.awbNumber || body?.awbNumber,
    supplierInvoiceNumber:
      customs?.supplierInvoiceNumber || customs?.supplierInvoiceNo || body?.supplierInvoiceNumber || body?.supplierInvoiceNo,
    customsCurrency: customs?.customsCurrency || customs?.currency,
    customsRemarks: customs?.customsRemarks || customs?.remarks,
  };
  if (hasCustomsDocuments(customs)) return true;
  return isCustomsCaptureActive({
    header,
    lineOverrides: customs?.lineOverrides || [],
    documents: customs?.documents,
  });
}

export function normalizeCustomsPayload(body = {}, grn = {}) {
  const customs = body?.customs && typeof body.customs === "object" ? body.customs : body;
  if (!hasCustomsPayload(body)) return null;

  const header = normalizeCustomsHeaderDefaults({
    ...customs,
    blNumber: t(customs.blNumber) || t(grn.blAwbNo),
    awbNumber: t(customs.awbNumber),
    boeNumber: t(customs.boeNumber) || t(customs.customsDocRef) || t(grn.customsDocRef),
    supplierInvoiceNumber:
      t(customs.supplierInvoiceNumber) || t(customs.supplierInvoiceNo) || t(grn.supplierInvoiceNo),
    receivedDate: customs.receivedDate || grn.grnDate || "",
  });

  const docSrc = customs.documents && typeof customs.documents === "object" ? customs.documents : {};
  const otherDocumentIds = [
    ...(Array.isArray(docSrc.otherDocumentIds) ? docSrc.otherDocumentIds : []),
    ...(Array.isArray(docSrc.otherDocuments) ? docSrc.otherDocuments : []),
    ...(Array.isArray(customs.otherDocumentIds) ? customs.otherDocumentIds : []),
    ...(Array.isArray(customs.otherDocuments) ? customs.otherDocuments : []),
  ]
    .map((entry) => resolveDocumentId(entry))
    .filter(Boolean);

  const documents = {
    blDocumentId:
      resolveDocumentId(docSrc.blDocumentId) ||
      resolveDocumentId(docSrc.blCopy) ||
      resolveDocumentId(customs.blDocumentId) ||
      null,
    supplierInvoiceDocumentId:
      resolveDocumentId(docSrc.supplierInvoiceDocumentId) ||
      resolveDocumentId(docSrc.supplierInvoiceCopy) ||
      resolveDocumentId(customs.supplierInvoiceDocumentId) ||
      null,
    packingListDocumentId:
      resolveDocumentId(docSrc.packingListDocumentId) ||
      resolveDocumentId(docSrc.packingListCopy) ||
      resolveDocumentId(customs.packingListDocumentId) ||
      null,
    otherDocumentIds: [...new Set(otherDocumentIds.map(String))],
  };

  const requestedAllowances = {
    allowBoeBeforePoDate: Boolean(
      customs.allowBoeBeforePoDate || body.allowBoeBeforePoDate || customs.dateOverrides?.allowBoeBeforePoDate
    ),
    allowInvoiceAfterReceivedDate: Boolean(
      customs.allowInvoiceAfterReceivedDate ||
        body.allowInvoiceAfterReceivedDate ||
        customs.dateOverrides?.allowInvoiceAfterReceivedDate
    ),
    allowFutureReceivedDate: Boolean(
      customs.allowFutureReceivedDate ||
        body.allowFutureReceivedDate ||
        customs.dateOverrides?.allowFutureReceivedDate
    ),
    allowTotalWeightOverride: Boolean(
      customs.allowTotalWeightOverride ||
        body.allowTotalWeightOverride ||
        customs.dateOverrides?.allowTotalWeightOverride
    ),
  };

  return {
    header,
    documents,
    lineOverrides: buildLineOverrideMap(customs),
    requestedAllowances,
    // legacy convenience mirrors (first-line/header snapshot for lot header)
    boeNumber: header.boeNumber,
    blNumber: header.blNumber,
    awbNumber: header.awbNumber,
    supplierInvoiceNumber: header.supplierInvoiceNumber,
    countryOfOrigin: upper(header.countryOfOrigin),
    hsCode: upper(header.hsCode),
    currency: upper(header.customsCurrency || "USD"),
    remarks: header.customsRemarks,
  };
}

/**
 * Validate customs capture and stamp resolved effective values onto GRN lines.
 * Call inside the GRN post transaction before/while creating the customs lot.
 * Date/weight overrides require STORE approve permission — client checkboxes alone are ignored.
 */
export async function applyResolvedCustomsToGrnLines({
  grn,
  body = {},
  poDate = null,
  req = null,
  session = null,
} = {}) {
  const payload = normalizeCustomsPayload(body, grn);
  if (!payload) return null;

  const permissionGranted = req ? await hasPermission(req, "STORE", "approve") : false;
  const allowances = resolveCustomsAllowances({
    requested: payload.requestedAllowances || {},
    permissionGranted,
  });
  payload.allowances = allowances;

  // Resolve existing parent BOE when selecting by id/ref (company-scoped).
  let parentBoe = null;
  const boeMode = String(payload.header.boeMode || "").toUpperCase();
  const selectRef = payload.header.customsBoeId || payload.header.customsBoeRef;
  if (selectRef && boeMode !== "CREATE") {
    parentBoe = await getCustomsBoeByIdOrRef({
      companyId: req?.companyId,
      idOrRef: selectRef,
      session,
    });
    if (!parentBoe) {
      throw new CustomsGrnValidationError([
        {
          line: "HEADER",
          article: "",
          messages: [`Customs BOE not found for this company: ${selectRef}`],
        },
      ]);
    }
  }

  const lines = (grn.items || []).filter((ln) => (Number(ln.acceptedQty ?? ln.receivedQty) || 0) > 0);
  const result = validateCustomsCaptureForGrn({
    header: payload.header,
    lineOverrides: payload.lineOverrides,
    lines,
    poDate,
    allowances,
    parentBoe: parentBoe ? parentBoe.toObject?.() || parentBoe : null,
  });
  if (!result.ok) throw new CustomsGrnValidationError(result.errors);

  payload.valuationMethod = result.valuationMethod || CUSTOMS_VALUATION_BOE_AVERAGE;
  payload.customsUnitValue = result.customsUnitValue;
  payload.boeDeclaredQty = result.boeDeclaredQty;
  payload.boeDeclaredValue = result.boeDeclaredValue;
  payload.lineCustomsQty = result.lineCustomsQty;
  payload.thisGrnCustomsQty = result.thisGrnCustomsQty || 0;
  payload.parentBoe = parentBoe;
  payload.boeMode = parentBoe ? "SELECT" : "CREATE";
  // Stamp frozen parent economics onto header for lot persistence
  if (parentBoe) {
    payload.header = {
      ...payload.header,
      boeNumber: parentBoe.boeNumber,
      boeDate: parentBoe.boeDate,
      blNumber: parentBoe.blNumber,
      awbNumber: parentBoe.awbNumber,
      boeDeclaredQty: parentBoe.boeDeclaredQty,
      boeDeclaredValue: parentBoe.boeDeclaredValue,
      customsUom: parentBoe.customsUom,
      customsCurrency: parentBoe.customsCurrency,
      exchangeRateToAED: parentBoe.exchangeRateToAED,
      grossWeightKg: parentBoe.grossWeightKg,
      netWeightKg: parentBoe.netWeightKg,
      customsBoeId: String(parentBoe._id),
      customsBoeRef: parentBoe.customsBoeRef,
    };
  }

  for (const line of grn.items || []) {
    const qty = Number(line.acceptedQty ?? line.receivedQty) || 0;
    if (qty <= 0) {
      line.customsCapture = undefined;
      continue;
    }
    const key = String(line.poLineId ?? "");
    const override = payload.lineOverrides.get(key) || {};
    const mapped = result.lineCustomsQty?.get(key);
    const effective = resolveCustomsLineEffective({
      header: payload.header,
      override,
      quantity: qty,
      allowances,
      customsUnitValue: result.customsUnitValue,
      customsQty: mapped?.customsQty,
      valuationMethod: result.valuationMethod,
    });
    if (mapped) {
      effective.customsTotalPrice = mapped.customsTotalPrice;
      effective.customsQty = mapped.customsQty;
      const rate = effective.exchangeRateToAED;
      effective.customsValueAED =
        rate != null ? roundCustomsMoney(effective.customsTotalPrice * rate) : 0;
    }
    line.customsCapture = toPersistedGrnLineCustoms(effective);
  }

  return payload;
}

function deriveItemStatus(qtyAvailable, qtyImported) {
  if (qtyAvailable <= 0.000001) return "CONSUMED";
  if (qtyAvailable + 0.000001 < qtyImported) return "PARTIAL";
  return "IN_STOCK";
}

function deriveLotStatus(items = []) {
  if (!items.length) return "OPEN";
  const active = items.filter((i) => i.status !== "CANCELLED");
  if (!active.length) return "CANCELLED";
  if (active.every((i) => Number(i.qtyAvailable) <= 0.000001)) return "CONSUMED";
  if (active.some((i) => Number(i.qtyConsumed) > 0)) return "PARTIAL";
  return "OPEN";
}

/**
 * Create customs lot, items, and inbound movements from a posted GRN.
 * Expects GRN lines to already carry `customsCapture` effective snapshots when capture is active.
 * Creates or links a parent CustomsBoe and freezes unit value from the parent.
 */
export async function createCustomsLotFromGrn({ session, req, grn, body = {}, poDate = null }) {
  if (!isCustomsEnabled()) return null;
  if (!grn?._id) throw new Error("GRN is required for customs lot creation");

  const payload = await applyResolvedCustomsToGrnLines({ grn, body, poDate, req, session });
  if (!payload) return null;

  const existing = await CustomsLot.findOne(
    withCompanyId(req.companyId, { grnId: grn._id }),
  ).session(session);
  if (existing) return existing;

  const thisGrnCustomsQty = roundCustomsQty(
    payload.thisGrnCustomsQty ||
      [...(payload.lineCustomsQty?.values?.() || [])].reduce(
        (s, r) => s + (Number(r.customsQty) || 0),
        0,
      ),
  );
  if (!(thisGrnCustomsQty > 0)) {
    throw new Error("This GRN customs qty must be greater than zero");
  }

  let parentBoe = payload.parentBoe;
  if (!parentBoe) {
    const created = await createCustomsBoe({
      session,
      req,
      header: payload.header,
      warnDuplicates: false,
    });
    parentBoe = created.boe;
  }

  // Atomic over-link protection (idempotent with unique grnId lot — only reached once per GRN).
  parentBoe = await reserveLinkedCustomsQty({
    session,
    companyId: req.companyId,
    customsBoeId: parentBoe._id,
    delta: thisGrnCustomsQty,
    updatedBy: req.user?.email || "",
  });

  const customsLotRef = await nextCustomsLotRef({
    companyId: req.companyId,
    companyCode: req.companyCode,
  });

  const boeSnap = mapBoeEconomicsToLotSnapshot(parentBoe);
  const firstCapture = (grn.items || []).find((ln) => ln.customsCapture)?.customsCapture || {};
  const valuationMethod = boeSnap.valuationMethod || CUSTOMS_VALUATION_BOE_AVERAGE;
  const customsUnitValue = Number(boeSnap.customsUnitValue) || 0;
  const lockedAt = boeSnap.valuationLockedAt || new Date();

  const lotRows = await CustomsLot.create(
    [
      {
        companyId: req.companyId,
        companyCode: upper(req.companyCode || "CMP"),
        customsLotRef,
        customsBoeId: boeSnap.customsBoeId,
        customsBoeRef: boeSnap.customsBoeRef,
        grnId: grn._id,
        grnNo: grn.grnNo,
        poId: grn.poId || null,
        poNo: grn.poNo || "",
        supplierId: grn.supplierId || null,
        supplierName: grn.supplierName || "",
        boeNumber: boeSnap.boeNumber,
        boeDate: boeSnap.boeDate,
        blNumber: boeSnap.blNumber,
        awbNumber: boeSnap.awbNumber,
        supplierInvoiceNumber: firstCapture.supplierInvoiceNumber || payload.header.supplierInvoiceNumber,
        supplierInvoiceDate: firstCapture.supplierInvoiceDate || null,
        receivedDate: firstCapture.receivedDate || null,
        countryOfOrigin: firstCapture.countryOfOrigin || upper(payload.header.countryOfOrigin),
        hsCode: firstCapture.hsCode || upper(payload.header.hsCode),
        unitWeightKg: Number(firstCapture.unitWeightKg) || 0,
        customsUnitPrice: customsUnitValue,
        currency: boeSnap.currency,
        exchangeRateToAED: boeSnap.exchangeRateToAED,
        valuationMethod,
        boeDeclaredQty: boeSnap.boeDeclaredQty,
        customsUom: boeSnap.customsUom,
        boeDeclaredValue: boeSnap.boeDeclaredValue,
        customsUnitValue,
        grossWeightKg: boeSnap.grossWeightKg,
        netWeightKg: boeSnap.netWeightKg,
        valuationLockedAt: lockedAt,
        status: "OPEN",
        remarks: firstCapture.customsRemarks || payload.header.customsRemarks,
        documents: payload.documents,
        createdBy: req.user?.email || "",
        updatedBy: req.user?.email || "",
      },
    ],
    { session },
  );
  const lot = lotRows[0];
  const createdItems = [];

  for (const line of grn.items || []) {
    const qty = Number(line.acceptedQty ?? line.receivedQty) || 0;
    if (qty <= 0) continue;

    const key = String(line.poLineId ?? "");
    const mapped = payload.lineCustomsQty?.get(key);
    const cap =
      line.customsCapture ||
      toPersistedGrnLineCustoms(
        resolveCustomsLineEffective({
          header: payload.header,
          override: payload.lineOverrides.get(key) || {},
          quantity: qty,
          allowances: payload.allowances || {},
          customsUnitValue,
          customsQty: mapped?.customsQty,
          valuationMethod,
        }),
      );

    const unitValue = customsUnitValue;
    const customsQtyImported = roundCustomsQty(cap.customsQty || mapped?.customsQty || qty);
    const lineTotal =
      mapped?.customsTotalPrice != null
        ? Number(mapped.customsTotalPrice)
        : Number(cap.customsTotalPrice) || roundCustomsMoney(customsQtyImported * unitValue);

    const itemRows = await CustomsLotItem.create(
      [
        {
          companyId: req.companyId,
          companyCode: lot.companyCode,
          customsLotId: lot._id,
          customsLotRef: lot.customsLotRef,
          grnId: grn._id,
          grnNo: grn.grnNo,
          grnLineId: line.poLineId ?? null,
          articleNumber: upper(line.article),
          partNumber: upper(line.partNumber || line.spn || ""),
          partName: line.description || "",
          description: line.description || "",
          hsCode: upper(cap.hsCode || ""),
          currency: boeSnap.currency,
          unitPrice: unitValue,
          customsUnitValue: unitValue,
          customsQtyImported,
          valuationMethod,
          qtyImported: qty,
          qtyAvailable: qty,
          qtyConsumed: 0,
          weightKg: Number(cap.unitWeightKg) || 0,
          unitWeightKg: Number(cap.unitWeightKg) || 0,
          totalWeightKg: Number(cap.totalWeightKg) || 0,
          totalValue: lineTotal,
          exchangeRateToAED: boeSnap.exchangeRateToAED,
          customsValueAED: Number(cap.customsValueAED) || roundCustomsMoney(lineTotal * (boeSnap.exchangeRateToAED || 0)),
          customStock: qty,
          customStockBalance: qty,
          supplierInvoiceNumber: cap.supplierInvoiceNumber || "",
          supplierInvoiceDate: cap.supplierInvoiceDate || null,
          receivedDate: cap.receivedDate || null,
          boeNumber: boeSnap.boeNumber,
          boeDate: boeSnap.boeDate,
          blNumber: boeSnap.blNumber,
          awbNumber: boeSnap.awbNumber,
          countryOfOrigin: upper(cap.countryOfOrigin || ""),
          status: "IN_STOCK",
          remarks1: t(line.remarks),
          remarks2: "",
          customsRemarks: cap.customsRemarks || "",
        },
      ],
      { session },
    );
    const item = itemRows[0];
    createdItems.push(item);

    await createCustomsMovement({
      session,
      req,
      movementType: "INBOUND",
      customsLotId: lot._id,
      customsLotItemId: item._id,
      articleNumber: item.articleNumber,
      partNumber: item.partNumber,
      qty,
      customsUnitValue: unitValue,
      customsValue: lineTotal,
      currency: item.currency,
      valuationMethod,
      referenceType: "GRN",
      referenceId: grn._id,
      referenceNumber: grn.grnNo,
      movementDate: cap.receivedDate || grn.grnDate || new Date(),
      remarks: `Inbound from GRN ${grn.grnNo}`,
    });
  }

  grn.markModified?.("items");
  await grn.save({ session });

  lot.status = deriveLotStatus(createdItems);
  lot.updatedBy = req.user?.email || "";
  await lot.save({ session });

  await writeAudit(req, {
    action: "CREATE",
    module: "CUSTOMS",
    entityType: "CUSTOMS_LOT",
    entityId: lot._id,
    documentNo: lot.customsLotRef,
    description: `Customs lot ${lot.customsLotRef} created from GRN ${grn.grnNo} under ${lot.customsBoeRef}`,
    metadata: {
      grnNo: grn.grnNo,
      customsBoeId: lot.customsBoeId,
      customsBoeRef: lot.customsBoeRef,
      boeNumber: lot.boeNumber,
      blNumber: lot.blNumber,
      awbNumber: lot.awbNumber,
      supplierInvoiceNumber: lot.supplierInvoiceNumber,
      thisGrnCustomsQty,
      linkedCustomsQty: parentBoe.linkedCustomsQty,
    },
  });

  return lot;
}

/**
 * Block GRN cancel when outbound customs movements have consumed stock.
 */
export async function assertGrnCancelAllowed({ companyId, grnId, grnNo, session = null }) {
  if (!isCustomsEnabled()) return;
  if (!grnId) return;

  const q = CustomsLotItem.findOne(
    withCompanyId(companyId, {
      grnId,
      qtyConsumed: { $gt: 0 },
      status: { $ne: "CANCELLED" },
    }),
  ).select("_id qtyConsumed articleNumber");
  if (session) q.session(session);
  const consumed = await q.lean();
  if (consumed) {
    throw new Error(
      `Cannot cancel GRN ${grnNo}: customs stock for article ${consumed.articleNumber} has outbound movements (qty consumed: ${consumed.qtyConsumed}).`,
    );
  }
}

/**
 * Reverse inbound customs lot when GRN is cancelled (only if nothing was consumed).
 */
export async function reverseCustomsLotForCancelledGrn({ session, req, grn }) {
  if (!isCustomsEnabled()) return null;
  if (!grn?._id) return null;

  await assertGrnCancelAllowed({
    companyId: req.companyId,
    grnId: grn._id,
    grnNo: grn.grnNo,
    session,
  });

  const lot = await CustomsLot.findOne(withCompanyId(req.companyId, { grnId: grn._id })).session(
    session,
  );
  if (!lot) return null;

  const items = await CustomsLotItem.find(
    withCompanyId(req.companyId, { customsLotId: lot._id, status: { $ne: "CANCELLED" } }),
  ).session(session);

  const linkedReleaseQty = roundCustomsQty(
    items.reduce((s, it) => s + (Number(it.customsQtyImported) || Number(it.qtyImported) || 0), 0),
  );

  for (const item of items) {
    const qty = Number(item.qtyAvailable) || 0;
    if (qty > 0) {
      const unitValue = Number(item.customsUnitValue ?? item.unitPrice) || 0;
      const customsQtyImported = Number(item.customsQtyImported) || Number(item.qtyImported) || 0;
      const qtyImported = Number(item.qtyImported) || 0;
      const customsQtyMoved =
        qtyImported > 0
          ? roundCustomsQty((qty / qtyImported) * (customsQtyImported || qtyImported))
          : roundCustomsQty(qty);
      const customsValue =
        item.totalValue != null && qtyImported > 0 && Math.abs(qty - qtyImported) < 1e-9
          ? roundCustomsMoney(item.totalValue)
          : roundCustomsMoney(customsQtyMoved * unitValue);

      await createCustomsMovement({
        session,
        req,
        movementType: "REVERSAL",
        customsLotId: lot._id,
        customsLotItemId: item._id,
        articleNumber: item.articleNumber,
        partNumber: item.partNumber,
        qty,
        customsUnitValue: unitValue || null,
        customsValue: unitValue > 0 || item.totalValue != null ? customsValue : null,
        currency: item.currency || "",
        valuationMethod: item.valuationMethod || "",
        referenceType: "GRN",
        referenceId: grn._id,
        referenceNumber: grn.grnNo,
        movementDate: new Date(),
        remarks: `GRN ${grn.grnNo} cancelled — reverse inbound customs stock`,
      });
    }
    item.qtyAvailable = 0;
    item.customStockBalance = 0;
    item.status = "CANCELLED";
    await item.save({ session });
  }

  lot.status = "CANCELLED";
  lot.updatedBy = req.user?.email || "";
  await lot.save({ session });

  if (lot.customsBoeId && linkedReleaseQty > 0) {
    await releaseLinkedCustomsQty({
      session,
      companyId: req.companyId,
      customsBoeId: lot.customsBoeId,
      delta: linkedReleaseQty,
      updatedBy: req.user?.email || "",
    });
  }

  await writeAudit(req, {
    action: "REVERSAL",
    module: "CUSTOMS",
    entityType: "CUSTOMS_LOT",
    entityId: lot._id,
    documentNo: lot.customsLotRef,
    description: `Customs lot ${lot.customsLotRef} reversed for cancelled GRN ${grn.grnNo}`,
    metadata: {
      grnNo: grn.grnNo,
      customsBoeId: lot.customsBoeId,
      customsBoeRef: lot.customsBoeRef,
      linkedReleaseQty,
    },
  });

  return lot;
}

export async function createCustomsMovement({
  session = null,
  req,
  movementType,
  customsLotId,
  customsLotItemId,
  articleNumber,
  partNumber = "",
  qty,
  customsUnitValue = null,
  customsValue = null,
  currency = "",
  valuationMethod = "",
  referenceType,
  referenceId = null,
  referenceNumber = "",
  movementDate = new Date(),
  remarks = "",
}) {
  const rows = await CustomsMovement.create(
    [
      {
        companyId: req.companyId,
        companyCode: upper(req.companyCode || "CMP"),
        movementType,
        customsLotId,
        customsLotItemId,
        articleNumber: upper(articleNumber),
        partNumber: upper(partNumber),
        qty: Number(qty) || 0,
        customsUnitValue: customsUnitValue == null ? null : Number(customsUnitValue),
        customsValue: customsValue == null ? null : Number(customsValue),
        currency: upper(currency || ""),
        valuationMethod: valuationMethod || "",
        referenceType,
        referenceId,
        referenceNumber: t(referenceNumber),
        movementDate: movementDate || new Date(),
        remarks: t(remarks),
        createdBy: req.user?.email || "",
      },
    ],
    session ? { session } : undefined,
  );
  return rows[0];
}

/**
 * Resolve frozen customs value for a physical qty movement against a lot item.
 * Uses BOE unit value × proportional customs qty; never re-averages remaining stock.
 */
export function resolveMovementCustomsValueSnapshot({ item, qty } = {}) {
  const physicalQty = Number(qty) || 0;
  const unitValue = Number(item?.customsUnitValue ?? item?.unitPrice) || 0;
  const qtyImported = Number(item?.qtyImported) || 0;
  const customsQtyImported = Number(item?.customsQtyImported) || qtyImported;
  const currency = upper(item?.currency || "");
  const valuationMethod = item?.valuationMethod || "";

  if (!(physicalQty > 0)) {
    return {
      customsUnitValue: unitValue || null,
      customsValue: null,
      currency,
      valuationMethod,
      customsQtyMoved: 0,
    };
  }

  const customsQtyMoved =
    qtyImported > 0
      ? roundCustomsQty((physicalQty / qtyImported) * (customsQtyImported || qtyImported))
      : roundCustomsQty(physicalQty);

  return {
    customsUnitValue: unitValue || null,
    customsValue: unitValue ? roundCustomsMoney(customsQtyMoved * unitValue) : null,
    currency,
    valuationMethod,
    customsQtyMoved,
  };
}

/**
 * List available customs lot items for an article (CG2 FIFO order).
 * Enriches rows with lot/GRN dates required by customsFifo comparator.
 */
export async function getAvailableCustomsLots({
  companyId,
  articleNumber,
  partNumber = "",
  limit = 100,
  session = null,
}) {
  const filter = withCompanyId(companyId, {
    articleNumber: upper(articleNumber),
    qtyAvailable: { $gt: 0 },
    status: { $in: ["IN_STOCK", "PARTIAL"] },
  });
  if (partNumber) filter.partNumber = upper(partNumber);

  const cap = Math.min(Number(limit) || 100, 500);
  const q = CustomsLotItem.find(filter).limit(cap);
  if (session) q.session(session);
  const rows = await q.lean();
  if (!rows.length) return [];

  const lotIds = [...new Set(rows.map((r) => String(r.customsLotId)).filter(Boolean))];
  const grnIds = [...new Set(rows.map((r) => String(r.grnId || "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];

  const [lots, grns] = await Promise.all([
    lotIds.length
      ? CustomsLot.find({ _id: { $in: lotIds } })
          .select("boeNumber boeDate supplierInvoiceDate receivedDate status")
          .lean()
      : [],
    grnIds.length
      ? GRN.find({ _id: { $in: grnIds } })
          .select("createdAt")
          .lean()
      : [],
  ]);

  const lotMap = new Map(lots.map((l) => [String(l._id), l]));
  const grnMap = new Map(grns.map((g) => [String(g._id), g]));

  const enriched = rows.map((item) => {
    const lot = lotMap.get(String(item.customsLotId)) || {};
    const grn = grnMap.get(String(item.grnId || "")) || {};
    return {
      ...item,
      boeDate: item.boeDate || lot.boeDate || null,
      supplierInvoiceDate: item.supplierInvoiceDate || lot.supplierInvoiceDate || null,
      receivedDate: item.receivedDate || lot.receivedDate || null,
      grnCreatedAt: grn.createdAt || item.createdAt || null,
      customsLotItemId: item._id,
      lotStatus: lot.status || "",
    };
  });

  // Exclude closed / cancelled parent lots from outbound FIFO pool
  const open = enriched.filter((item) => {
    const st = String(item.lotStatus || "").toUpperCase();
    return st !== "CLOSED" && st !== "CANCELLED";
  });

  return sortCustomsLotsForFifo(open);
}

/**
 * Allocate customs stock using CG2 FIFO (split across BOEs as needed).
 */
export async function allocateCustomsStockFIFO({
  companyId,
  articleNumber,
  qty,
  partNumber = "",
  session = null,
}) {
  const need = Number(qty) || 0;
  if (need <= 0) return [];

  const items = await getAvailableCustomsLots({
    companyId,
    articleNumber,
    partNumber,
    limit: 500,
    session,
  });

  const { allocations, shortfall } = allocateQtyAcrossLotsFifo(items, need);
  if (shortfall > 0.000001) {
    throw new Error(
      `Insufficient customs stock for ${upper(articleNumber)} (short by ${shortfall.toFixed(4)})`,
    );
  }

  return allocations;
}

function parseStockDateRange(dateFrom, dateTo) {
  const range = {};
  const from = parseDate(dateFrom);
  const to = parseDate(dateTo);
  if (from) {
    from.setHours(0, 0, 0, 0);
    range.$gte = from;
  }
  if (to) {
    to.setHours(23, 59, 59, 999);
    range.$lte = to;
  }
  return Object.keys(range).length ? range : null;
}

async function buildCustomsStockItemQuery(companyId, filters = {}) {
  const base = {};
  if (filters.articleNumber) base.articleNumber = upper(filters.articleNumber);
  if (filters.partNumber) base.partNumber = upper(filters.partNumber);
  if (filters.status) base.status = String(filters.status).toUpperCase();
  if (filters.countryOfOrigin) base.countryOfOrigin = upper(filters.countryOfOrigin);

  const dateRange = parseStockDateRange(filters.dateFrom, filters.dateTo);
  if (dateRange) base.supplierInvoiceDate = dateRange;

  if (filters.supplier) {
    const lots = await CustomsLot.find(
      withCompanyId(companyId, {
        supplierName: new RegExp(t(filters.supplier), "i"),
      }),
    )
      .select("_id")
      .lean();
    const lotIds = lots.map((l) => l._id);
    base.customsLotId = lotIds.length ? { $in: lotIds } : { $in: [] };
  }

  if (filters.companyCode) {
    base.companyCode = upper(filters.companyCode);
  }

  if (filters.search) {
    const s = t(filters.search);
    base.$or = [
      { boeNumber: new RegExp(s, "i") },
      { blNumber: new RegExp(s, "i") },
      { awbNumber: new RegExp(s, "i") },
      { supplierInvoiceNumber: new RegExp(s, "i") },
      { articleNumber: new RegExp(s, "i") },
      { partNumber: new RegExp(s, "i") },
      { partName: new RegExp(s, "i") },
      { grnNo: new RegExp(s, "i") },
      { hsCode: new RegExp(s, "i") },
      { countryOfOrigin: new RegExp(s, "i") },
    ];
  }

  return withCompanyId(companyId, base);
}

export function mapCustomsStockRow(item, lot, srNo) {
  const eco = computeLotItemCustomsEconomics(item);
  const valuationMethod = resolveValuationMethod(item.valuationMethod || lot?.valuationMethod);
  const unitPrice = eco.customsUnitValue;

  return {
    srNo,
    _id: item._id,
    customsLotId: item.customsLotId,
    customsLotRef: item.customsLotRef || lot?.customsLotRef || "",
    companyCode: item.companyCode || lot?.companyCode || "",
    boeNumber: item.boeNumber || lot?.boeNumber || "",
    boeDate: item.boeDate || lot?.boeDate || null,
    awbNumber: item.awbNumber || lot?.awbNumber || "",
    blNumber: item.blNumber || lot?.blNumber || "",
    date: item.supplierInvoiceDate || lot?.supplierInvoiceDate || null,
    supplier: lot?.supplierName || "",
    invoiceNo: item.supplierInvoiceNumber || lot?.supplierInvoiceNumber || "",
    countryOfOrigin: item.countryOfOrigin || lot?.countryOfOrigin || "",
    articleNumber: item.articleNumber || "",
    partName: item.partName || item.description || "",
    partNumber: item.partNumber || "",
    hsCode: item.hsCode || "",
    currency: item.currency || lot?.currency || "USD",
    unitPrice,
    customsUnitValue: unitPrice,
    valuationMethod,
    boeDeclaredQty: Number(lot?.boeDeclaredQty) || 0,
    boeDeclaredValue: Number(lot?.boeDeclaredValue) || 0,
    customsUom: lot?.customsUom || "",
    grossWeightKg: Number(lot?.grossWeightKg) || 0,
    netWeightKg: Number(lot?.netWeightKg) || 0,
    customsQtyImported: eco.customsQtyImported,
    remainingCustomsQty: eco.remainingCustomsQty,
    exportedCustomsQty: eco.exportedCustomsQty,
    qtyImported: eco.physicalQtyImported,
    qtyConsumed: eco.physicalQtyExported,
    qtyAvailable: eco.physicalQtyRemaining,
    exportedQty: eco.physicalQtyExported,
    remainingQty: eco.physicalQtyRemaining,
    importedCustomsValue: eco.importedCustomsValue,
    consumedCustomsValue: eco.consumedCustomsValue,
    remainingCustomsValue: eco.remainingCustomsValue,
    weightKg: Number(item.weightKg) || 0,
    totalValue: eco.importedCustomsValue,
    customsStock: eco.physicalQtyImported,
    customsStockBalance: eco.physicalQtyRemaining,
    remarks1: item.remarks1 || "",
    remarks2: item.remarks2 || "",
    status: item.status || "IN_STOCK",
    grnId: item.grnId || lot?.grnId || null,
    grnNo: item.grnNo || lot?.grnNo || "",
    ...resolveCustomsLotItemProvenance(item, lot || {}),
    documents: {
      blDocumentId: lot?.documents?.blDocumentId || null,
      supplierInvoiceDocumentId: lot?.documents?.supplierInvoiceDocumentId || null,
    },
  };
}

/** Paginated customs stock list with lot metadata for UI / export. */
export async function listCustomsStockPage(companyId, filters = {}, paging = {}) {
  const page = Math.max(1, Number(paging.page) || 1);
  const limit = Math.min(Number(paging.limit) || 50, Number(paging.maxLimit) || 200);
  const skip = (page - 1) * limit;
  const query = await buildCustomsStockItemQuery(companyId, filters);

  const [items, total] = await Promise.all([
    CustomsLotItem.find(query)
      .sort({ supplierInvoiceDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CustomsLotItem.countDocuments(query),
  ]);

  const lotIds = [...new Set(items.map((row) => String(row.customsLotId)).filter(Boolean))];
  const lots = lotIds.length
    ? await CustomsLot.find({ _id: { $in: lotIds } })
        .select(
          "supplierName supplierInvoiceNumber supplierInvoiceDate countryOfOrigin currency boeNumber boeDate blNumber awbNumber grnId grnNo customsLotRef companyCode documents valuationMethod boeDeclaredQty boeDeclaredValue customsUnitValue customsUom grossWeightKg netWeightKg status receivedDate"
        )
        .lean()
    : [];
  const lotMap = new Map(lots.map((lot) => [String(lot._id), lot]));

  return {
    items: items.map((row, index) => mapCustomsStockRow(row, lotMap.get(String(row.customsLotId)), skip + index + 1)),
    total,
    page,
    limit,
    view: "article",
  };
}

/**
 * Paginated Customs Stock grouped by CustomsBoe (new) or CustomsLot (legacy).
 * Never merges solely by external BOE number string.
 */
export async function listCustomsStockGroupedPage(companyId, filters = {}, paging = {}) {
  const page = Math.max(1, Number(paging.page) || 1);
  const limit = Math.min(Number(paging.limit) || 50, Number(paging.maxLimit) || 200);
  const skip = (page - 1) * limit;

  const itemQuery = await buildCustomsStockItemQuery(companyId, {
    ...filters,
    status:
      ["OPEN", "CLOSED", "RECONCILED"].includes(String(filters.status || "").toUpperCase())
        ? undefined
        : filters.status,
  });

  const matchingLotIds = await CustomsLotItem.distinct("customsLotId", itemQuery);
  if (!matchingLotIds.length) {
    return { groups: [], items: [], total: 0, page, limit, view: "boe" };
  }

  const lotFilter = withCompanyId(companyId, { _id: { $in: matchingLotIds } });
  if (filters.companyCode) lotFilter.companyCode = upper(filters.companyCode);

  const groupStatus = String(filters.status || "").toUpperCase();
  const allLots = await CustomsLot.find(lotFilter)
    .sort({ boeDate: -1, supplierInvoiceDate: -1, createdAt: -1 })
    .lean();
  const allLotIds = allLots.map((l) => l._id);
  const allItems = allLotIds.length
    ? await CustomsLotItem.find(withCompanyId(companyId, { customsLotId: { $in: allLotIds } })).lean()
    : [];
  const byLot = new Map();
  for (const it of allItems) {
    const k = String(it.customsLotId);
    if (!byLot.has(k)) byLot.set(k, []);
    byLot.get(k).push(it);
  }

  const matchHint = t(filters.articleNumber || filters.search);
  const lotGroups = allLots.map((lot, idx) =>
    buildCustomsLotStockGroup(lot, byLot.get(String(lot._id)) || [], {
      srNo: idx + 1,
      matchArticle: matchHint,
    }),
  );

  // Parent BOE merge
  const boeIds = [
    ...new Set(allLots.map((l) => (l.customsBoeId ? String(l.customsBoeId) : "")).filter(Boolean)),
  ];
  const boeDocs = boeIds.length
    ? await CustomsBoe.find(withCompanyId(companyId, { _id: { $in: boeIds } })).lean()
    : [];
  const boeMap = new Map(boeDocs.map((b) => [String(b._id), b]));

  const parentBuckets = new Map(); // boeId -> lot groups
  const legacyGroups = [];
  for (const g of lotGroups) {
    const bid = g.customsBoeId ? String(g.customsBoeId) : "";
    if (bid) {
      if (!parentBuckets.has(bid)) parentBuckets.set(bid, []);
      parentBuckets.get(bid).push(g);
    } else {
      legacyGroups.push(g);
    }
  }

  let groups = [
    ...[...parentBuckets.entries()].map(([bid, lots]) =>
      buildCustomsBoeStockGroup(boeMap.get(bid) || { _id: bid }, lots, { srNo: 1 }),
    ),
    ...legacyGroups,
  ];

  // Stable sort: boeDate desc then ref
  groups.sort((a, b) => {
    const da = a.boeDate ? new Date(a.boeDate).getTime() : 0;
    const db = b.boeDate ? new Date(b.boeDate).getTime() : 0;
    if (db !== da) return db - da;
    return String(b.customsBoeRef || b.customsLotRef || "").localeCompare(
      String(a.customsBoeRef || a.customsLotRef || ""),
    );
  });

  if (groupStatus === "CANCELLED") {
    groups = groups.filter((g) => g.status === "CANCELLED");
  } else if (groupStatus === "OPEN") {
    groups = groups.filter((g) => g.status === "OPEN");
  } else if (groupStatus === "CLOSED") {
    groups = groups.filter((g) => g.status === "CLOSED");
  } else if (groupStatus === "RECONCILED") {
    groups = groups.filter((g) => g.status === "RECONCILED");
  }

  const total = groups.length;
  const pageGroups = groups.slice(skip, skip + limit).map((g, i) => ({ ...g, srNo: skip + i + 1 }));
  return {
    groups: pageGroups,
    items: pageGroups.flatMap((g) =>
      (g.articles || []).map((a) => ({
        ...a,
        customsLotId: a.customsLotId || g.customsLotId,
        customsBoeId: g.customsBoeId,
        customsBoeRef: g.customsBoeRef,
        boeNumber: g.boeNumber,
        supplier: g.supplier,
        valuationMethod: g.valuationMethod,
        currency: g.currency,
        boeDeclaredQty: g.boeSummary?.declaredQty,
        boeDeclaredValue: g.boeSummary?.declaredValue,
        customsUnitValue: a.customsUnitValue ?? g.boeSummary?.customsUnitValue,
        documents: g.documents,
      })),
    ),
    total,
    page,
    limit,
    view: "boe",
  };
}

/** @deprecated Use listCustomsStockPage — kept for internal callers expecting full list. */
export async function listCustomsStockRows(companyId, filters = {}) {
  const { items } = await listCustomsStockPage(companyId, filters, {
    page: 1,
    limit: 5000,
    maxLimit: 5000,
  });
  return items;
}

function deriveQtyInOut(movement = {}) {
  const qty = Number(movement.qty) || 0;
  const type = String(movement.movementType || "").toUpperCase();
  if (type === "INBOUND") return { qtyIn: qty, qtyOut: 0 };
  if (type === "OUTBOUND" || type === "REVERSAL") return { qtyIn: 0, qtyOut: qty };
  if (type === "ADJUSTMENT") {
    if (qty < 0) return { qtyIn: 0, qtyOut: Math.abs(qty) };
    return { qtyIn: qty, qtyOut: 0 };
  }
  return { qtyIn: 0, qtyOut: 0 };
}

async function buildCustomsLedgerQuery(companyId, filters = {}) {
  const base = {};
  if (filters.articleNumber) base.articleNumber = upper(filters.articleNumber);
  if (filters.partNumber) base.partNumber = upper(filters.partNumber);
  if (filters.movementType) base.movementType = upper(filters.movementType);
  if (filters.referenceType) base.referenceType = upper(filters.referenceType);

  const dateRange = parseStockDateRange(filters.dateFrom, filters.dateTo);
  if (dateRange) base.movementDate = dateRange;

  const lotPredicates = [];
  if (filters.supplier) lotPredicates.push({ supplierName: new RegExp(t(filters.supplier), "i") });
  if (filters.boeNumber) lotPredicates.push({ boeNumber: new RegExp(t(filters.boeNumber), "i") });
  if (filters.blNumber) lotPredicates.push({ blNumber: new RegExp(t(filters.blNumber), "i") });
  if (filters.awbNumber) lotPredicates.push({ awbNumber: new RegExp(t(filters.awbNumber), "i") });

  if (lotPredicates.length) {
    const lotFilter = withCompanyId(companyId, lotPredicates.length === 1 ? lotPredicates[0] : { $and: lotPredicates });
    const lots = await CustomsLot.find(lotFilter).select("_id").lean();
    base.customsLotId = { $in: lots.map((l) => l._id) };
    if (!lots.length) base.customsLotId = { $in: [] };
  }

  if (filters.search) {
    const s = t(filters.search);
    base.$or = [
      { referenceNumber: new RegExp(s, "i") },
      { articleNumber: new RegExp(s, "i") },
      { partNumber: new RegExp(s, "i") },
      { remarks: new RegExp(s, "i") },
      { createdBy: new RegExp(s, "i") },
    ];
  }

  return withCompanyId(companyId, base);
}

async function computeOpeningBalances(companyId, filters = {}, beforeDate) {
  const q = await buildCustomsLedgerQuery(companyId, {
    ...filters,
    dateFrom: undefined,
    dateTo: undefined,
  });
  const cutoff = parseDate(beforeDate);
  if (cutoff) {
    cutoff.setHours(0, 0, 0, 0);
    q.movementDate = { ...(q.movementDate || {}), $lt: cutoff };
  }
  const prior = await CustomsMovement.find(q).sort({ movementDate: 1, createdAt: 1 }).lean();
  const balances = new Map();
  for (const movement of prior) {
    const key = String(movement.customsLotItemId || "");
    const { qtyIn, qtyOut } = deriveQtyInOut(movement);
    balances.set(key, (Number(balances.get(key)) || 0) + qtyIn - qtyOut);
  }
  return balances;
}

export function mapCustomsLedgerRow(movement, lot, item, balanceAfter, srNo) {
  const { qtyIn, qtyOut } = deriveQtyInOut(movement);
  return {
    srNo,
    _id: movement._id,
    date: movement.movementDate || movement.createdAt,
    movementType: movement.movementType,
    company: movement.companyCode || lot?.companyCode || item?.companyCode || "",
    articleNumber: movement.articleNumber || item?.articleNumber || "",
    partNumber: movement.partNumber || item?.partNumber || "",
    partName: item?.partName || item?.description || "",
    boeNumber: item?.boeNumber || lot?.boeNumber || "",
    blNumber: item?.blNumber || lot?.blNumber || "",
    awbNumber: item?.awbNumber || lot?.awbNumber || "",
    supplierInvoiceNumber: item?.supplierInvoiceNumber || lot?.supplierInvoiceNumber || "",
    supplier: lot?.supplierName || "",
    qty: Number(movement.qty) || 0,
    qtyIn,
    qtyOut,
    balance: balanceAfter,
    customsUnitValue: movement.customsUnitValue != null ? Number(movement.customsUnitValue) : null,
    customsValue: movement.customsValue != null ? Number(movement.customsValue) : null,
    currency: movement.currency || item?.currency || lot?.currency || "",
    valuationMethod: movement.valuationMethod || item?.valuationMethod || "",
    referenceType: movement.referenceType,
    referenceNumber: movement.referenceNumber || "",
    referenceId: movement.referenceId || null,
    user: movement.createdBy || "",
    remarks: movement.remarks || "",
    customsLotItemId: movement.customsLotItemId,
    customsLotId: movement.customsLotId,
    grnNo: item?.grnNo || lot?.grnNo || "",
  };
}

/** Paginated customs stock ledger from CustomsMovement with running balance per lot item. */
export async function listCustomsLedgerPage(companyId, filters = {}, paging = {}) {
  const page = Math.max(1, Number(paging.page) || 1);
  const limit = Math.min(Number(paging.limit) || 50, Number(paging.maxLimit) || 200);
  const query = await buildCustomsLedgerQuery(companyId, filters);

  const movements = await CustomsMovement.find(query)
    .sort({ movementDate: 1, createdAt: 1 })
    .lean();

  const lotIds = [...new Set(movements.map((m) => String(m.customsLotId)).filter(Boolean))];
  const itemIds = [...new Set(movements.map((m) => String(m.customsLotItemId)).filter(Boolean))];

  const [lots, items] = await Promise.all([
    lotIds.length
      ? CustomsLot.find({ _id: { $in: lotIds } })
          .select(
            "supplierName supplierInvoiceNumber boeNumber blNumber awbNumber companyCode grnNo customsLotRef",
          )
          .lean()
      : [],
    itemIds.length
      ? CustomsLotItem.find({ _id: { $in: itemIds } })
          .select("articleNumber partNumber partName description boeNumber blNumber awbNumber supplierInvoiceNumber companyCode")
          .lean()
      : [],
  ]);

  const lotMap = new Map(lots.map((lot) => [String(lot._id), lot]));
  const itemMap = new Map(items.map((item) => [String(item._id), item]));
  const balanceByItem = filters.dateFrom
    ? await computeOpeningBalances(companyId, filters, filters.dateFrom)
    : new Map();

  const enriched = movements.map((movement, index) => {
    const itemKey = String(movement.customsLotItemId || "");
    const lot = lotMap.get(String(movement.customsLotId));
    const item = itemMap.get(itemKey);
    const { qtyIn, qtyOut } = deriveQtyInOut(movement);
    const prev = Number(balanceByItem.get(itemKey)) || 0;
    const nextBalance = prev + qtyIn - qtyOut;
    balanceByItem.set(itemKey, nextBalance);
    return mapCustomsLedgerRow(movement, lot, item, nextBalance, index + 1);
  });

  enriched.sort((a, b) => {
    const da = new Date(a.date).getTime();
    const db = new Date(b.date).getTime();
    if (db !== da) return db - da;
    return String(b._id).localeCompare(String(a._id));
  });

  enriched.forEach((row, idx) => {
    row.srNo = idx + 1;
  });

  const total = enriched.length;
  const skip = (page - 1) * limit;
  const pageItems = enriched.slice(skip, skip + limit);

  return { items: pageItems, total, page, limit };
}

export { buildCustomsReconciliation } from "./customsReconciliationService.js";

export { withCompanyId as customsWithCompanyId };
