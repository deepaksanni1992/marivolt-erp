# ERP Foundation Architecture (Phase-10.6)

This document is the stabilization baseline before Procurement Phase-11.
It captures the current module interactions, company isolation rules, and
numbering/approval controls that all new work must preserve.

## Module Map

- Sales: quotations, order acknowledgements, proforma, allocations, RTS, invoices, dispatch, returns.
- Store: GRN, stock balances, stock ledger, locations, transfers, adjustments, inventory movement.
- Accounts: sales/purchase invoices, receipts, ledgers, cash/bank, ageing/outstanding, journals.
- Logistics: shipments, container management, tracking, export document status, dispatch linkage.
- Reports: reporting endpoints across sales, purchase, accounts, logistics, and document exports.
- Audit: immutable business-event trail via `AuditLog` and activity tracking via `UserActivity`.
- Settings: companies, branches, warehouses, roles/permissions, number series, approval rules/queue.

## Stock Flow

1. Purchase and GRN increase stock (`STORE` posting paths).
2. Sales allocation reserves stock by warehouse.
3. RTS confirms release readiness from allocated quantities.
4. Sales invoice posting consumes stock from allocation warehouse.
5. Cancellation/reversal paths restore stock and record audit state transitions.

## Accounts Flow

1. Sales/Purchase invoices generate receivable/payable positions.
2. Payment receipts allocate against invoice targets.
3. Customer/Supplier/Cash-Bank ledgers keep running balances.
4. Outstanding and ageing reports compute overdue exposure from scoped invoice/payment data.

## Logistics Flow

1. Dispatch references link logistics to invoiced commercial quantities.
2. Shipment tracks status lifecycle (`READY` -> `DELIVERED` -> `CLOSED`) with approval gate on close.
3. Tracking, documents, and containers enrich shipment execution traceability.
4. Dashboard/report APIs are company scoped and support warehouse-aware dashboard filtering.

## RBAC Flow

1. JWT auth sets `req.user`; company context is resolved to `req.companyId`.
2. ERP routes pass through `requireErpAccess` (`requireAuth` + `requireCompanyContext` + allowed roles).
3. `requirePermission(module, action)` enforces module/action-level authorization.
4. Super admin remains a controlled global bypass; company/admin roles resolve via permission matrix.

## Approval Flow

1. Sensitive actions call approval service with module/action/document context.
2. Matching active rules produce `ApprovalRequest` (`PENDING`) and block execution.
3. Approvers decide in Settings approval queue.
4. Original action retries with approved request ID and resumes transaction safely.

## Company Isolation Rules

- Every business query/mutation must include `companyId` filter derived from auth context.
- Cross-company header mismatch is rejected by `requireCompanyContext`.
- Aggregations and joins must stay scoped to active company IDs.
- Export/report endpoints must apply company scope before date/status/customer filters.
- Admin masters are global only where explicitly intended (for super-admin company bootstrap).

## Numbering Series Rules

- Numbering uses company-aware doc series (`NumberSeriesConfig`) when configured.
- Fallback legacy sequence generators are still company-prefixed/scoped.
- Counters remain monotonic per company/doc-key series context.
- Manual edits to posted document numbers are disallowed in business flows.

## Stabilization Verification Checklist

- [ ] Multi-company: switching company isolates all business lists and mutations.
- [ ] Warehouse restriction: stock/sales/logistics behavior respects selected warehouse scope.
- [ ] Role restriction: unauthorized module/action calls return permission denied.
- [ ] Approval flow: gated actions return `APPROVAL_REQUIRED` until approved.
- [ ] Stock flow: reserve/post/cancel paths maintain correct stock balances and ledgers.
- [ ] Receivable flow: invoice/payment updates adjust balance and ageing correctly.
- [ ] Dispatch flow: dispatch/shipment linkage preserves quantities and status integrity.
