# Phase-8 Chunk 1 — Document Status Engine + Reservation Locking + Audit Trail

This chunk delivers Parts 1, 2, 7, 8 of the Phase-8 spec.

## What's new

### 1. Document lifecycle state machine
**File:** `backend/src/services/docLifecycle.js`

A pure (no DB) module that defines the canonical Phase-8 statuses and
allowed transitions for every sales document type:

| Doc | Canonical statuses |
|---|---|
| Quotation | `DRAFT` → `SENT` → `APPROVED` → `CANCELLED` |
| Proforma | `DRAFT` → `PENDING_PAYMENT` → `PARTIAL_PAYMENT` → `PAID` → `CANCELLED` |
| Order Allocation | `ALLOCATED` → `PARTIAL_RTS` → `RTS_COMPLETE` → `INVOICED` → `CANCELLED` |
| RTS | `PENDING` → `APPROVED` → `DISPATCHED` → `CANCELLED` |
| Sales Invoice | `DRAFT` → `POSTED` → `PARTIAL_PAYMENT` → `PAID` → `CANCELLED` |

Schema enums on the existing Mongoose models are **kept
backward-compatible** (so legacy rows still validate). The state
machine maintains an `aliases` map that translates legacy values
(`ISSUED`, `OPEN`, `CONVERTED`, `PAID_PENDING_SHIPMENT`, …) to their
canonical Phase-8 forms before any transition check.

#### API

```js
import { DOC_TYPES, assertTransition, blockTransition, canonicalStatus } from "../services/docLifecycle.js";

assertTransition(DOC_TYPES.SALES_INVOICE, prev, "CANCELLED", { documentNo: inv.invoiceNo });
// throws { code: "INVALID_TRANSITION", statusCode: 409, details: { from, to, allowed, documentNo } }

const canon = canonicalStatus(DOC_TYPES.SALES_INVOICE, "PARTIALLY_PAID"); // "PARTIAL_PAYMENT"
```

`assertTransition` throws a structured error that the controller
returns as a 409 with `code: INVALID_TRANSITION`. The frontend's
axios interceptor (`marivolt-erp/src/lib/api.js`) preserves the code
and details so toasts/banners can be friendly.

### 2. Wired transition rules
| Site | Rule enforced |
|---|---|
| `convertProformaToOrderAllocation` | logs `CREATE → ALLOCATED` audit row, includes `hasNegativeAllocation` flag |
| `convertOAToOrderAllocation` | same, plus reads source OA reference |
| `approveRts` | `PENDING → APPROVED` lifecycle assertion |
| `cancelRtsDocument` | `→ CANCELLED` assertion (covers both DRAFT and APPROVED entry points) |
| `cancelOrderAllocation` | `→ CANCELLED` assertion + already enforces "no active RTS / SI" |
| `cancelOA` | `→ CANCELLED` assertion |
| `cancelSalesInvoice` | **`→ CANCELLED` assertion** + new "no payment received" rule (rejects with `INVALID_TRANSITION` if `sum(allocations[].allocatedAmount) > 0`) |
| `updateSalesInvoice` | rejects edits to any field other than `status`/`remarks` once the invoice has progressed past DRAFT |

Each successful transition also writes an `AuditLog` row via
`writeStatusChange(req, …)`.

### 3. Audit Trail
**Model:** `backend/src/models/AuditLog.js` (replacing the unused stub)
**Service:** `backend/src/services/auditService.js`
**API:**
- `GET /api/audit-logs?module=&action=&documentNo=&userEmail=&from=&to=`
- `GET /api/audit-logs/document/:documentNo`

Captured today:
- Sales lifecycle transitions (allocations, RTS, invoices, cancellations)
- Edits on posted invoices
- GRN post / cancel
- Stock adjustment + transfer postings
- Payment receipt create + cancel

The audit row carries: `companyId`, `userId/Email/Name`, `action`,
`module`, `entityType`, `entityId`, `documentNo`, `fromStatus`,
`toStatus`, `description`, `beforeData`, `afterData`, `metadata`,
`ip`, `userAgent`.

Indexes:
- `(companyId, module, createdAt: -1)`
- `(companyId, documentNo, createdAt: -1)`
- `(companyId, userId, createdAt: -1)`

> Audit writes are **best-effort**: any failure is `console.warn`'d
> and never blocks the user's transaction.

### 4. Reservation locking
Already in place from Phase 4 / 5 — every stock-mutating sales call
(`allocateStock`, `cancelAllocation`, `moveAllocationToRTS`, `cancelRTS`,
`invoiceFromRTS`, `cancelInvoice`) runs inside
`stockService.withTransaction(...)` with `findOneAndUpdate` guards
on the relevant buckets. No additional locking work was required for
Phase-8.1; the chunk simply audits the call graph and confirms no
stock-mutating sales path bypasses transactions.

### 5. Frontend
- **New page:** `Sidebar → Audit Trail` (route `/audit`).
- Filters: module, action, document no, user email, from, to.
- Sticky-header table with action badges (color-coded), `from → to`
  status pair, `metadata` rendered as compact JSON inspector.
- Pagination: 100 rows per page.
- Errors thrown by lifecycle assertions are surfaced because the
  axios interceptor preserves `err.code` and `err.details`.

## Files changed

- `backend/src/services/docLifecycle.js` *(new)*
- `backend/src/services/auditService.js` *(new)*
- `backend/src/controllers/auditLogController.js` *(new)*
- `backend/src/routes/auditRoutes.js` *(new)*
- `backend/src/models/AuditLog.js` *(rewritten — additive schema)*
- `backend/src/server.js` *(mount `/api/audit-logs`)*
- `backend/src/controllers/salesFlowController.js` *(transitions + audit)*
- `backend/src/controllers/grnController.js` *(audit on post/cancel)*
- `backend/src/controllers/stockController.js` *(audit on adjust/transfer)*
- `backend/src/controllers/paymentReceiptController.js` *(audit on create/cancel)*
- `src/pages/AuditTrail.jsx` *(new)*
- `src/App.jsx` *(route)*
- `src/components/Sidebar.jsx` *(menu)*

## Verification

- Backend `npm run verify` — PASS
- Frontend `npm run build` — PASS
- Lints — clean
- Manual:
  1. Convert a PI to OA → audit row `CREATE / ORDER_ALLOCATION` appears.
  2. Approve RTS → row `STATUS_CHANGE / PENDING → APPROVED` appears.
  3. Try to cancel a paid SI → 409 with `code: INVALID_TRANSITION`,
     toast in UI; audit row **not** written.
  4. Edit a POSTED SI's `paymentTerms` field → 409 with
     `attemptedField: "paymentTerms"` in `details`.
  5. Open `/audit` and filter by `documentNo: <SI no>` →
     full lifecycle is visible chronologically.

## Next

Chunk 8.2 — Payment buckets + Partial payments + S3 attachments
(Parts 4, 5, 6 of the spec).
