import mongoose from "mongoose";
import Quotation from "../../models/Quotation.js";
import OrderAcknowledgement from "../../models/OrderAcknowledgement.js";
import ProformaInvoice from "../../models/ProformaInvoice.js";
import OrderAllocation from "../../models/OrderAllocation.js";
import StorePacking from "../../models/StorePacking.js";
import SalesInvoice from "../../models/SalesInvoice.js";
import StoreDispatch from "../../models/StoreDispatch.js";
import { DOC_TYPES, normalizeDocumentType } from "./documentTypes.js";
import { getDocumentNumberField } from "./documentSourceMetadata.js";
import { computeQuotationConsumption } from "./quotationConsumptionService.js";

const CHAIN_CONFIG = {
  [DOC_TYPES.QUOTATION]: {
    model: Quotation,
    numberField: "quotationNo",
    children: [
      {
        type: DOC_TYPES.ORDER_ACKNOWLEDGEMENT,
        model: OrderAcknowledgement,
        foreignKey: "linkedQuotationId",
        numberField: "oaNo",
      },
      {
        type: DOC_TYPES.PROFORMA_INVOICE,
        model: ProformaInvoice,
        foreignKey: "linkedQuotationId",
        numberField: "proformaNo",
      },
    ],
    parent: null,
  },
  [DOC_TYPES.ORDER_ACKNOWLEDGEMENT]: {
    model: OrderAcknowledgement,
    numberField: "oaNo",
    parent: {
      type: DOC_TYPES.QUOTATION,
      idField: "linkedQuotationId",
      numberField: "linkedQuotationNo",
    },
    children: [
      {
        type: DOC_TYPES.PROFORMA_INVOICE,
        model: ProformaInvoice,
        foreignKey: "linkedOAId",
        numberField: "proformaNo",
      },
    ],
  },
  [DOC_TYPES.PROFORMA_INVOICE]: {
    model: ProformaInvoice,
    numberField: "proformaNo",
    parent: {
      type: DOC_TYPES.ORDER_ACKNOWLEDGEMENT,
      idField: "linkedOAId",
      numberField: "linkedOANo",
      altParent: {
        type: DOC_TYPES.QUOTATION,
        idField: "linkedQuotationId",
        numberField: "linkedQuotationNo",
      },
    },
    children: [
      {
        type: DOC_TYPES.ORDER_ALLOCATION,
        model: OrderAllocation,
        foreignKey: "linkedProformaId",
        numberField: "allocationNo",
      },
    ],
  },
  [DOC_TYPES.ORDER_ALLOCATION]: {
    model: OrderAllocation,
    numberField: "allocationNo",
    parent: {
      type: DOC_TYPES.PROFORMA_INVOICE,
      idField: "linkedProformaId",
      numberField: "linkedProformaNo",
    },
    children: [
      {
        type: DOC_TYPES.STORE_PACKING,
        model: StorePacking,
        foreignKey: "sourceDocumentId",
        foreignType: DOC_TYPES.ORDER_ALLOCATION,
        numberField: "packingNo",
      },
    ],
  },
  [DOC_TYPES.STORE_PACKING]: {
    model: StorePacking,
    numberField: "packingNo",
    parent: {
      type: DOC_TYPES.ORDER_ALLOCATION,
      idField: "sourceDocumentId",
      numberField: "linkedAllocationNo",
      matchType: DOC_TYPES.ORDER_ALLOCATION,
    },
    children: [
      {
        type: DOC_TYPES.SALES_INVOICE,
        model: SalesInvoice,
        foreignKey: "linkedStorePackingId",
        numberField: "invoiceNo",
      },
    ],
  },
  [DOC_TYPES.SALES_INVOICE]: {
    model: SalesInvoice,
    numberField: "invoiceNo",
    parent: {
      type: DOC_TYPES.STORE_PACKING,
      idField: "linkedStorePackingId",
      numberField: "linkedStorePackingNo",
    },
    children: [
      {
        type: DOC_TYPES.STORE_DISPATCH,
        model: StoreDispatch,
        foreignKey: "sourceDocumentId",
        foreignType: DOC_TYPES.SALES_INVOICE,
        numberField: "dispatchNo",
      },
    ],
  },
};

function docRef(doc, type, numberField) {
  if (!doc) return null;
  return {
    documentType: type,
    documentId: String(doc._id),
    documentNumber: doc[numberField] || "",
    status: doc.status || "",
    date: doc.createdAt || doc.oaDate || doc.quotationDate || null,
  };
}

async function findChildren(companyId, config, docId) {
  const out = [];
  for (const child of config.children || []) {
    const filter = { companyId, [child.foreignKey]: docId };
    if (child.foreignType) {
      filter.sourceDocumentType = child.foreignType;
    }
    const rows = await child.model
      .find(filter)
      .select(`${child.numberField} status createdAt`)
      .sort({ createdAt: 1 })
      .lean();
    for (const row of rows) {
      out.push(docRef(row, child.type, child.numberField));
    }
  }
  return out.filter(Boolean);
}

async function resolveParent(companyId, config, doc) {
  const p = config.parent;
  if (!p) return null;
  const parentId = doc[p.idField];
  if (!parentId) {
    if (p.altParent && doc[p.altParent.idField]) {
      const alt = p.altParent;
      const ParentModel = CHAIN_CONFIG[alt.type]?.model;
      if (!ParentModel) return null;
      const parentDoc = await ParentModel.findOne({ companyId, _id: doc[alt.idField] }).lean();
      return docRef(parentDoc, alt.type, getDocumentNumberField(alt.type));
    }
    return null;
  }
  if (p.matchType && doc.sourceDocumentType && doc.sourceDocumentType !== p.matchType) {
    return null;
  }
  const ParentModel = CHAIN_CONFIG[p.type]?.model;
  if (!ParentModel) return null;
  const parentDoc = await ParentModel.findOne({ companyId, _id: parentId }).lean();
  return docRef(parentDoc, p.type, p.numberField || getDocumentNumberField(p.type));
}

async function resolveOrigin(companyId, docType, doc) {
  if (docType === DOC_TYPES.QUOTATION) {
    return docRef(doc, DOC_TYPES.QUOTATION, "quotationNo");
  }
  if (doc.linkedQuotationId) {
    const q = await Quotation.findOne({ companyId, _id: doc.linkedQuotationId }).lean();
    if (q) return docRef(q, DOC_TYPES.QUOTATION, "quotationNo");
  }
  const parent = await resolveParent(companyId, CHAIN_CONFIG[docType], doc);
  if (parent?.documentType === DOC_TYPES.QUOTATION) return parent;
  if (parent) {
    const ParentModel = CHAIN_CONFIG[parent.documentType]?.model;
    if (ParentModel) {
      const parentDoc = await ParentModel.findOne({ companyId, _id: parent.documentId }).lean();
      if (parentDoc) return resolveOrigin(companyId, parent.documentType, parentDoc);
    }
  }
  return null;
}

/**
 * Reusable document chain structure for navigation UI.
 * Read-only — does not modify any documents.
 */
export async function getDocumentLinks(companyId, documentType, documentId) {
  const type = normalizeDocumentType(documentType);
  const config = CHAIN_CONFIG[type];
  if (!config) {
    throw new Error(`Document chain not configured for type: ${documentType}`);
  }
  if (!mongoose.Types.ObjectId.isValid(String(documentId))) {
    throw new Error("Invalid document id");
  }

  const doc = await config.model.findOne({ companyId, _id: documentId }).lean();
  if (!doc) throw new Error("Document not found");

  const self = docRef(doc, type, config.numberField);
  const source = await resolveParent(companyId, config, doc);
  const origin = await resolveOrigin(companyId, type, doc);
  const children = await findChildren(companyId, config, doc._id);

  const chain = [];
  if (origin) chain.push(origin);
  if (source && (!origin || source.documentId !== origin.documentId)) chain.push(source);
  chain.push(self);

  return {
    documentLinks: {
      self,
      source,
      origin,
      children,
      chain,
    },
  };
}

export async function getQuotationConsumptionReport(companyId, quotationId) {
  const q = await Quotation.findOne({ companyId, _id: quotationId }).lean();
  if (!q) throw new Error("Quotation not found");
  return computeQuotationConsumption(companyId, q);
}
