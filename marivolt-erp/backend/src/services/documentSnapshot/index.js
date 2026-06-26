/**
 * Enterprise Document Snapshot Engine — public API barrel.
 * Source documents are never modified; downstream docs are independent snapshots.
 */
export { DOC_TYPES, normalizeDocumentType, copyRouteKey } from "./documentTypes.js";
export {
  documentSourceMetadataFields,
  buildSourceMetadataFromDocument,
  resolvePersistedSourceMetadata,
  getDocumentNumberField,
} from "./documentSourceMetadata.js";
export {
  COPY_ROUTE_REGISTRY,
  getCopyRoute,
  loadSourceDocument,
  copyDocument,
  buildQuotationSearchFilterForOA,
  mapQuotationSearchRowForOA,
} from "./documentSnapshotRegistry.js";
export {
  normalizeOALinesFromWorkingCopy,
  isOaWorkingCopyPayload,
  validateOaWorkingCopyBeforeSave,
  buildOaSourceMetadataForPersist,
  buildOaWorkingCopyFromQuotation,
} from "./documentSnapshotService.js";
export {
  lineArticlePartKey,
  computeQuotationConsumption,
  applyConsumptionToWorkingLines,
  findOverOrderViolations,
} from "./quotationConsumptionService.js";
export {
  validateOaLineFields,
  buildConsumptionBaseline,
  detectStaleConsumption,
  MAX_OA_LINES,
} from "./oaCreateValidation.js";
export { getDocumentLinks, getQuotationConsumptionReport } from "./documentChainService.js";
