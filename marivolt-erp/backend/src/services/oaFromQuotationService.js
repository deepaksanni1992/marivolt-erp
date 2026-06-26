/**
 * Backward-compatible facade — delegates to Enterprise Document Snapshot Engine.
 * @deprecated Import from `documentSnapshot/documentSnapshotService.js` for new code.
 */
export {
  buildQuotationSearchFilterForOA,
  mapQuotationSearchRowForOA,
  normalizeOALinesFromWorkingCopy,
  isOaWorkingCopyPayload,
  buildOaWorkingCopyFromQuotation,
  validateOaWorkingCopyBeforeSave,
  buildOaSourceMetadataForPersist,
  copyDocument,
} from "./documentSnapshot/documentSnapshotService.js";

export { computeQuotationConsumption, findOverOrderViolations } from "./documentSnapshot/quotationConsumptionService.js";

export { getDocumentLinks, getQuotationConsumptionReport } from "./documentSnapshot/documentChainService.js";

export { DOC_TYPES, normalizeDocumentType } from "./documentSnapshot/documentTypes.js";

export { documentSourceMetadataFields } from "./documentSnapshot/documentSourceMetadata.js";
