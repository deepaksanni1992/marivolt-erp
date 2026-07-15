import Quotation from "../../models/Quotation.js";
import OrderAcknowledgement from "../../models/OrderAcknowledgement.js";
import ProformaInvoice from "../../models/ProformaInvoice.js";
import OrderAllocation from "../../models/OrderAllocation.js";
import StorePacking from "../../models/StorePacking.js";
import SalesInvoice from "../../models/SalesInvoice.js";
import StoreDispatch from "../../models/StoreDispatch.js";
import { DOC_TYPES, copyRouteKey, normalizeDocumentType } from "./documentTypes.js";
import { buildSourceMetadataFromDocument } from "./documentSourceMetadata.js";
import {
  applyConsumptionToWorkingLines,
  computeQuotationConsumption,
} from "./quotationConsumptionService.js";
import { buildConsumptionBaseline } from "./oaCreateValidation.js";

/** Statuses excluded from quotation search when no explicit status filter is provided. */
const SEARCH_EXCLUDED_STATUSES = ["CANCELLED", "REJECTED", "EXPIRED"];

const MODEL_BY_TYPE = {
  [DOC_TYPES.QUOTATION]: Quotation,
  [DOC_TYPES.ORDER_ACKNOWLEDGEMENT]: OrderAcknowledgement,
  [DOC_TYPES.PROFORMA_INVOICE]: ProformaInvoice,
  [DOC_TYPES.ORDER_ALLOCATION]: OrderAllocation,
  [DOC_TYPES.STORE_PACKING]: StorePacking,
  [DOC_TYPES.SALES_INVOICE]: SalesInvoice,
  [DOC_TYPES.STORE_DISPATCH]: StoreDispatch,
};

/**
 * Registry of supported snapshot copy routes.
 * Add new mappings here for future document flows (OA→PI, allocation→packing, etc.).
 */
export const COPY_ROUTE_REGISTRY = {
  [copyRouteKey(DOC_TYPES.QUOTATION, DOC_TYPES.ORDER_ACKNOWLEDGEMENT)]: {
    sourceType: DOC_TYPES.QUOTATION,
    destinationType: DOC_TYPES.ORDER_ACKNOWLEDGEMENT,
    validateSource(source) {
      const st = String(source?.status || "").toUpperCase();
      if (["CANCELLED", "REJECTED"].includes(st)) {
        throw new Error(`Cannot copy quotation with status ${st}`);
      }
      if (!source?.lines?.length) {
        throw new Error("Source quotation has no lines to copy");
      }
    },
    async buildContext(companyId, source) {
      const consumption = await computeQuotationConsumption(companyId, source);
      return { consumption };
    },
    mapHeader(source, context, { copiedBy = "" } = {}) {
      const meta = buildSourceMetadataFromDocument(source, DOC_TYPES.QUOTATION, { copiedBy });
      return {
        oaSourceType: "FROM_QUOTATION",
        sourceQuotationId: String(source._id),
        sourceQuotationNo: source.quotationNo || "",
        linkedQuotationId: source._id,
        linkedQuotationNo: source.quotationNo || "",
        oaDate: new Date().toISOString().slice(0, 10),
        customerName: source.customerName || "",
        customerReference: source.customerReference || "",
        customerPORef: source.customerReference || "",
        contactPerson:
          source.contactPerson || source.customer?.contactPerson || "",
        attention: source.attention || "",
        billingAddress:
          source.billingAddress || source.customer?.billingAddress || "",
        shippingAddress:
          source.shippingAddress || source.customer?.shippingAddress || "",
        paymentTerms: source.paymentTerms || "",
        deliverySchedule: source.deliveryTerms || "",
        incoterm: source.incoterm || "",
        acknowledgementNotes: source.remarks || "",
        termsAndConditions: source.termsAndConditions || "",
        currency: String(source.currency || "USD").toUpperCase(),
        vertical: source.vertical || "",
        engine: source.engine || "",
        model: source.model || "",
        config: source.config || "",
        esn: source.esn || "",
        discountType: source.discountType || "NONE",
        discountValue: Number(source.discountValue) || 0,
        packingCost: Number(source.packingCost) || 0,
        clearanceCost: Number(source.clearanceCost) || 0,
        taxTotal: Number(source.taxTotal) || 0,
        _sourceMetadata: meta,
        consumptionSummary: {
          linkedOaCount: context.consumption?.linkedOaCount ?? 0,
          lines: context.consumption?.lines ?? [],
        },
        consumptionBaseline: buildConsumptionBaseline(context.consumption),
      };
    },
    mapLine(sourceLine, idx, context) {
      const qty = Number(sourceLine.qty) || 0;
      const price = Number(sourceLine.price) || 0;
      const lineId = sourceLine._id ? String(sourceLine._id) : "";
      const c = lineId ? context.consumption?.byLineId?.get(lineId) : null;
      const alreadyOrderedQty = c?.alreadyOrderedQty ?? 0;
      const remainingQty = c?.remainingQty ?? qty;

      return {
        serialNo: idx + 1,
        sourceQuotationLineId: lineId,
        sourceLineId: lineId,
        article: sourceLine.article || "",
        partNumber: sourceLine.partNumber || "",
        description: sourceLine.description || "",
        uom: sourceLine.uom || "PCS",
        quotedQty: qty,
        alreadyOrderedQty,
        remainingQty,
        orderedQty: remainingQty,
        quotedPrice: price,
        orderedPrice: price,
        qty,
        price,
        totalPrice: remainingQty * price,
        discount: 0,
        tax: 0,
        remarks: sourceLine.remarks || "",
        materialCode: sourceLine.materialCode || "",
        material: sourceLine.materialCode || "",
        availability: sourceLine.availability || "",
        supplierInfo: "",
        includeInOA: true,
        isNewLine: false,
        _consumptionApplied: true,
      };
    },
  },

  // Future routes — structure ready; implement mapHeader/mapLine when those flows migrate to snapshot engine.
  [copyRouteKey(DOC_TYPES.ORDER_ACKNOWLEDGEMENT, DOC_TYPES.PROFORMA_INVOICE)]: {
    sourceType: DOC_TYPES.ORDER_ACKNOWLEDGEMENT,
    destinationType: DOC_TYPES.PROFORMA_INVOICE,
    planned: true,
  },
  [copyRouteKey(DOC_TYPES.PROFORMA_INVOICE, DOC_TYPES.ORDER_ALLOCATION)]: {
    sourceType: DOC_TYPES.PROFORMA_INVOICE,
    destinationType: DOC_TYPES.ORDER_ALLOCATION,
    planned: true,
  },
  [copyRouteKey(DOC_TYPES.ORDER_ALLOCATION, DOC_TYPES.STORE_PACKING)]: {
    sourceType: DOC_TYPES.ORDER_ALLOCATION,
    destinationType: DOC_TYPES.STORE_PACKING,
    planned: true,
  },
  [copyRouteKey(DOC_TYPES.STORE_PACKING, DOC_TYPES.SALES_INVOICE)]: {
    sourceType: DOC_TYPES.STORE_PACKING,
    destinationType: DOC_TYPES.SALES_INVOICE,
    planned: true,
  },
};

export function getCopyRoute(sourceType, destinationType) {
  const key = copyRouteKey(normalizeDocumentType(sourceType), normalizeDocumentType(destinationType));
  const route = COPY_ROUTE_REGISTRY[key];
  if (!route) {
    throw new Error(`No snapshot copy route registered for ${key}`);
  }
  if (route.planned) {
    throw new Error(`Snapshot route ${key} is planned but not yet implemented`);
  }
  return route;
}

export async function loadSourceDocument(companyId, sourceType, sourceId) {
  const type = normalizeDocumentType(sourceType);
  const Model = MODEL_BY_TYPE[type];
  if (!Model) throw new Error(`Unsupported source document type: ${sourceType}`);
  const doc = await Model.findOne({ companyId, _id: sourceId }).lean();
  if (!doc) throw new Error("Source document not found");
  return doc;
}

/**
 * Enterprise Document Snapshot Engine — build read-only working copy.
 * Source document is NEVER modified.
 */
export async function copyDocument({
  companyId,
  sourceType,
  destinationType,
  sourceId,
  copiedBy = "",
}) {
  const route = getCopyRoute(sourceType, destinationType);
  const source = await loadSourceDocument(companyId, route.sourceType, sourceId);
  route.validateSource(source);

  const context = route.buildContext ? await route.buildContext(companyId, source) : {};
  const header = route.mapHeader(source, context, { copiedBy });
  let lines = (source.lines || []).map((line, idx) => route.mapLine(line, idx, context));

  if (
    route.sourceType === DOC_TYPES.QUOTATION &&
    route.destinationType === DOC_TYPES.ORDER_ACKNOWLEDGEMENT &&
    context.consumption
  ) {
    lines = applyConsumptionToWorkingLines(lines, context.consumption);
  }

  return {
    ...header,
    lines,
    _snapshot: {
      sourceType: route.sourceType,
      destinationType: route.destinationType,
      sourceId: String(source._id),
      sourceNumber: header.sourceQuotationNo || header._sourceMetadata?.sourceDocumentNumber || "",
      copiedAt: new Date().toISOString(),
    },
  };
}

/** Mongo filter for quotation search used when creating OA from quotation. */
export function buildQuotationSearchFilterForOA(companyId, query = {}) {
  const filter = { companyId };
  if (query.quotationNo) filter.quotationNo = new RegExp(String(query.quotationNo).trim(), "i");
  const customerQ = query.customerName || query.customer;
  if (customerQ) filter.customerName = new RegExp(String(customerQ).trim(), "i");
  const custRef = query.customerRef || query.customerReference;
  if (custRef) filter.customerReference = new RegExp(String(custRef).trim(), "i");
  if (query.vertical) filter.vertical = new RegExp(String(query.vertical).trim(), "i");
  if (query.brand) filter.engine = new RegExp(String(query.brand).trim(), "i");
  if (query.model) filter.model = new RegExp(String(query.model).trim(), "i");
  if (query.esn) filter.esn = new RegExp(String(query.esn).trim(), "i");
  if (query.currency) filter.currency = new RegExp(String(query.currency).trim(), "i");
  if (query.status) {
    filter.status = String(query.status).trim().toUpperCase();
  } else {
    filter.status = { $nin: SEARCH_EXCLUDED_STATUSES };
  }
  if (query.dateFrom || query.dateTo) {
    filter.quotationDate = {};
    if (query.dateFrom) filter.quotationDate.$gte = new Date(query.dateFrom);
    if (query.dateTo) {
      const end = new Date(query.dateTo);
      end.setHours(23, 59, 59, 999);
      filter.quotationDate.$lte = end;
    }
  }
  return filter;
}

export function mapQuotationSearchRowForOA(row) {
  const qd = row.quotationDate != null ? new Date(row.quotationDate).toISOString().slice(0, 10) : "";
  return {
    _id: row._id,
    quotationNo: row.quotationNo || "",
    quotationDate: qd,
    customerName: row.customerName || "",
    customerReference: row.customerReference || "",
    brand: row.engine || "",
    vertical: row.vertical || "",
    model: row.model || "",
    esn: row.esn || "",
    currency: row.currency || "USD",
    grandTotal: Number(row.grandTotal) || 0,
    status: row.status || "",
  };
}
