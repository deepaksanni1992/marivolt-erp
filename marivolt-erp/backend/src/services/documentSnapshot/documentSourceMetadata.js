import mongoose from "mongoose";

/**
 * Optional source-document metadata for downstream snapshots.
 * All fields default safely — existing documents without them are unaffected.
 */
export const documentSourceMetadataFields = {
  sourceDocumentType: { type: String, default: "", trim: true, index: true },
  sourceDocumentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  sourceDocumentNumber: { type: String, default: "", trim: true },
  sourceDocumentRevision: { type: Number, default: null },
  sourceCreatedBy: { type: String, default: "", trim: true },
  sourceCreatedAt: { type: Date, default: null },
  copiedBy: { type: String, default: "", trim: true },
  copiedAt: { type: Date, default: null },
};

/**
 * Build metadata from a loaded source document (read-only — never mutates source).
 */
export function buildSourceMetadataFromDocument(sourceDoc, sourceType, { copiedBy = "" } = {}) {
  if (!sourceDoc) return {};
  const numberField = documentNumberFieldForType(sourceType);
  return {
    sourceDocumentType: String(sourceType || "").toUpperCase(),
    sourceDocumentId: sourceDoc._id || null,
    sourceDocumentNumber: String(sourceDoc[numberField] || "").trim(),
    sourceDocumentRevision: sourceDoc.revision != null ? Number(sourceDoc.revision) : 1,
    sourceCreatedBy: String(sourceDoc.createdBy || "").trim(),
    sourceCreatedAt: sourceDoc.createdAt ? new Date(sourceDoc.createdAt) : null,
    copiedBy: String(copiedBy || "").trim(),
    copiedAt: new Date(),
  };
}

/** Merge metadata from working-copy payload when persisting a new downstream document. */
export function resolvePersistedSourceMetadata(body = {}, user = {}) {
  const copiedBy = String(body.copiedBy || user?.email || "").trim();
  const meta = body._sourceMetadata || body.sourceMetadata || {};
  const out = {
    sourceDocumentType: String(
      meta.sourceDocumentType || body.sourceDocumentType || ""
    ).toUpperCase(),
    sourceDocumentId: mongoose.Types.ObjectId.isValid(String(meta.sourceDocumentId || body.sourceDocumentId || ""))
      ? new mongoose.Types.ObjectId(String(meta.sourceDocumentId || body.sourceDocumentId))
      : null,
    sourceDocumentNumber: String(meta.sourceDocumentNumber || body.sourceDocumentNumber || "").trim(),
    sourceDocumentRevision:
      meta.sourceDocumentRevision != null
        ? Number(meta.sourceDocumentRevision)
        : body.sourceDocumentRevision != null
          ? Number(body.sourceDocumentRevision)
          : null,
    sourceCreatedBy: String(meta.sourceCreatedBy || body.sourceCreatedBy || "").trim(),
    sourceCreatedAt:
      meta.sourceCreatedAt || body.sourceCreatedAt
        ? new Date(meta.sourceCreatedAt || body.sourceCreatedAt)
        : null,
    copiedBy,
    copiedAt: meta.copiedAt || body.copiedAt ? new Date(meta.copiedAt || body.copiedAt) : new Date(),
  };
  if (!out.sourceDocumentType && (body.linkedQuotationId || body.sourceQuotationId)) {
    out.sourceDocumentType = "QUOTATION";
    const qid = body.linkedQuotationId || body.sourceQuotationId;
    if (mongoose.Types.ObjectId.isValid(String(qid || ""))) {
      out.sourceDocumentId = new mongoose.Types.ObjectId(String(qid));
    }
    out.sourceDocumentNumber = String(
      body.linkedQuotationNo || body.sourceQuotationNo || out.sourceDocumentNumber || ""
    ).trim();
  }
  if (!out.sourceDocumentType) {
    delete out.sourceDocumentType;
  }
  return out;
}

export function getDocumentNumberField(sourceType) {
  return documentNumberFieldForType(sourceType);
}

function documentNumberFieldForType(sourceType) {
  switch (String(sourceType || "").toUpperCase()) {
    case "QUOTATION":
      return "quotationNo";
    case "ORDER_ACKNOWLEDGEMENT":
      return "oaNo";
    case "PROFORMA_INVOICE":
      return "proformaNo";
    case "ORDER_ALLOCATION":
      return "allocationNo";
    case "STORE_PACKING":
      return "packingNo";
    case "SALES_INVOICE":
      return "invoiceNo";
    case "STORE_DISPATCH":
      return "dispatchNo";
    case "SALES_RETURN":
      return "returnNo";
    case "CIPL":
      return "ciplNo";
    default:
      return "documentNo";
  }
}
