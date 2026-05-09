# Phase-10.6 Stabilization Checkpoint

Purpose: hardening pass before Procurement Phase-11.

## 1) Company Scope Verification

Modules checked:

- Sales
- Store
- Accounts
- Logistics
- Reports
- Audit
- Settings

Result:

- Route-level ERP modules use `requireErpAccess` (`requireAuth` + `requireCompanyContext`).
- Controllers in these modules primarily apply company filters through `withCompany(...)` patterns.
- Data models for major transactions include `companyId` and indexed company-aware keys.

## 2) Route Guard Verification

Result:

- ERP route groups consistently mount `router.use(...requireErpAccess)`.
- Permission guards are mapped with `requirePermission(module, action)` for view/create/edit/approve/cancel/export/delete paths.
- Auth/bootstrap paths intentionally keep selective guards (`/auth/login`, company selection/switch) and are excluded from permission gating by design.

## 3) Hardcoded Pattern Scan

Scanned for:

- MAIN warehouse defaults
- hardcoded company IDs
- admin bypasses
- sequential numbering assumptions

Result:

- No hardcoded company-ID literals found in runtime business code.
- No ad-hoc "admin bypass" patterns found outside the centralized permission/middleware strategy.
- Sequential numbering is centralized in numbering services/utilities.
- `MAIN` warehouse defaults still exist in multiple legacy models/controllers/UI forms. These remain functional but are documented as cleanup debt for future warehouse profile initialization work.

## 4) Major Transaction Integrity

Checked for:

- audit logging
- `companyId`
- `createdBy`
- timestamps

Result:

- Core transactional collections (sales, store, logistics, accounts) include `timestamps`.
- Business records are company-scoped and generally capture creator/updater metadata.
- Audit logging is present across critical status-changing/posting flows. Remaining low-risk create/update paths without explicit audit detail should be folded into the next audit enrichment pass.

## 5) Export Scope Verification

Result:

- Export/report endpoints are permission-protected (`REPORTS`/module export actions) and company-filtered before rendering response payloads.
- Logistics/export reporting remains company-scoped and now supports warehouse-aware dashboard filtering.

## 6) Dashboard Warehouse Awareness

Hardening applied:

- Added warehouse-scoped dashboard filtering for logistics KPI endpoint (`/api/shipments/dashboard?warehouse=...`).
- Added warehouse input on logistics page to drive scoped dashboard metrics.

## 7) Architecture Baseline

Primary architecture reference created:

- `docs/erp-foundation-architecture.md`

It includes:

- module map
- stock/accounts/logistics/RBAC/approval flows
- company isolation rules
- numbering series rules
- multi-company/warehouse/role/approval/stock/receivable/dispatch checklist

## 8) Command Verification

Required commands for this checkpoint:

- backend verify
- frontend build
- lint scan
- dead import scan

Run these before tagging Phase-10.6 as complete and before starting Phase-11.
