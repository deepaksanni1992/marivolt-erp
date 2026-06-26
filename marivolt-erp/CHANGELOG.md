# Changelog

All notable changes to Marivolt ERP. Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### New Features

- **Enterprise Document Snapshot Engine** — Registry-based `copyDocument()` framework for creating independent downstream documents without mutating sources (`backend/src/services/documentSnapshot/`).
- **New OA → From Quotation** — Working-copy workflow with quotation search, line snapshot, and partial order support (`OaCreateModal.jsx`).
- **New OA → Blank OA** — Manual OA creation preserved with improved line validation.
- **Quotation search for OA** — `GET /api/quotations/search-for-oa` with filters (customer, brand, model, ESN, dates, currency, status).
- **Quotation consumption tracking** — Dynamic remaining quantity from linked non-cancelled OAs (`GET /api/quotations/:id/consumption`).
- **Partial order support** — Quoted vs ordered qty/price columns; default ordered qty = remaining qty.
- **Over-order warning** — Client and server validation with explicit override (`allowOverOrder`).
- **Stale consumption detection** — Concurrency warning when another user creates OA on same quotation (`STALE_CONSUMPTION`, `allowStaleConsumption`).
- **CSV export/import** — Working line export; import with preview/confirm modal (2 MB / 1000 row limits).
- **Source document metadata** — `sourceDocumentType`, `sourceDocumentId`, `sourceDocumentNumber`, `copiedBy`, `copiedAt`, and related audit fields on new OAs.
- **Document chain foundation** — `GET /api/document-snapshot/chain/:documentType/:id` for navigation data structure.
- **Convert to OA UX** — Quotation detail button opens snapshot working form instead of instant legacy conversion.

### Architecture Improvements

- Replaced quotation-specific copy logic with reusable snapshot registry and service layer.
- `oaFromQuotationService.js` retained as backward-compatible facade.
- Centralized server validation in `oaCreateValidation.js`.
- Unit test suite: `backend/scripts/documentSnapshotEngine.test.js` (11 tests).

### Performance

- Quotation search uses field projection, pagination (max 100/page), and indexed `quotationDate` sort.
- Consumption computed with single OA query per quotation (no N+1).

### Security

- Server-side validation for qty, price, article, duplicate lines (max 500 lines).
- CSV upload size and row limits.
- ObjectId validation on snapshot API routes.
- Company-scoped queries on all new endpoints.
- Totals always recalculated server-side; frontend totals not trusted.

### Backward Compatibility

- **No destructive database migration.**
- All new schema fields optional with safe defaults.
- Existing `qty` / `price` remain downstream fields for PI, allocation, packing, invoice.
- `linkedQuotationId` / `linkedQuotationNo` unchanged.
- Legacy `POST /api/sales/convert/quotation/:id/to-oa` unchanged.
- Old quotations, OAs, PIs, allocations, packing, invoices, dispatch, customs, reports, print/PDF continue to work.

### Breaking Changes

**NONE**

### Documentation

- `docs/Enterprise-Document-Snapshot-Engine.md`
- `docs/OA-Workflow.md`
- `docs/Snapshot-OA-API.md`
- `docs/OA-Schema-Additions.md`
- `docs/Future-Enhancements.md`
