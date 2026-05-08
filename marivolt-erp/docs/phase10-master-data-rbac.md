# Phase 10 — Master Data, Multi-Company, Roles, Settings & Approvals

This phase prepares the ERP for production-grade administration:
multiple companies, branches, warehouses, role-based permissions,
configurable number series, approval workflow scaffolding, and an
authentication activity log.

Phase 10.1 (this commit) ships the **foundational data + middleware
layer** behind a new **Settings** module in the sidebar. Existing
behaviour is fully preserved — every change is additive.

---

## 1. Schema additions

| Model                    | Purpose                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `Company` (extended)     | Adds `shortName`, `country`, `registrationNo`, `bankDetails[]`, `defaultCurrency`, `timezone`. Backward compatible with the legacy `currency`/`trnNo` fields. |
| `Branch` (new)           | One company → many branches (`branchCode`, `branchName`, address, optional warehouse list). |
| `Warehouse` (new)        | Master record for stock warehouses. Existing `StockBalance` / `StockLedger` `warehouse` strings continue to work. |
| `Role` (new)             | Custom roles per company with a `permissions[{module, actions[]}]` matrix. System role codes are reserved and not stored as Role docs by default. |
| `User` (extended)        | Adds `roleIds[]`, `allowedBranches[]`, `allowedWarehouses[]`, per-user `permissionOverrides[]`, `lastLoginAt/Ip/Agent`, and `isActive`. The legacy `role` enum is preserved. |
| `UserActivity` (new)     | Auth-level event stream (LOGIN_SUCCESS / LOGIN_FAILED / LOGOUT / COMPANY_SELECT / COMPANY_SWITCH). Indexed by `(companyId, userId, action)`. |
| `Setting` (new)          | Generic per-company key/value store namespaced under `COMPANY / TAX / CURRENCY / APPROVAL / WAREHOUSE / NUMBERING / OTHER`. Branch-scoped variant supported. |
| `NumberSeriesConfig` (new) | Per-(company, branch, docKey) configurable numbering with format tokens `{COMPANY}{BRANCH}{YYYY}{YY}{YYMMDD}{YYYYMMDD}{MM}{DD}{SEQ}`. |
| `ApprovalRule` (new)     | Defines whether a (module, actionKey) needs approval, with optional currency/amount threshold and approver roles. |
| `ApprovalRequest` (new)  | Request lifecycle (`PENDING / APPROVED / REJECTED / CANCELLED`) with audit history. |

All schemas remain additive — old documents validate unchanged.

---

## 2. Permission engine

`backend/src/services/roleService.js`:

```js
import { resolvePermissions, hasPermission } from "../services/roleService.js";

const matrix = await resolvePermissions(req);
const ok    = await hasPermission(req, "SALES", "cancel");
```

System role defaults (`SUPER_ADMIN`, `ADMIN`, `SALES`, `PURCHASE`,
`STORE`, `LOGISTICS`, `ACCOUNTS`, `VIEW_ONLY`) are wired in. Legacy
enum codes (`super_admin`, `staff`, `purchase_sales`,
`accounts_logistics`, `company_admin`) are mapped through to the
new system roles so existing users keep working.

`backend/src/middleware/permissions.js` exposes `requirePermission`:

```js
import { requirePermission } from "../middleware/permissions.js";

router.post(
  "/order-allocations/:id/cancel",
  ...requireErpAccess,
  requirePermission("SALES", "cancel"),
  flow.cancelOrderAllocation,
);
```

Phase 10.1 ships the engine and exposes it on `/api/admin/me/permissions`
and `/api/admin/roles`. Phase 10.2 will wire `requirePermission(...)`
into route mounts module-by-module.

---

## 3. New API surface

All under `/api/admin` (protected by `requireErpAccess` + admin role
where applicable).

| Method | Path                                         | Description |
| ------ | -------------------------------------------- | ----------- |
| GET    | `/admin/me/permissions`                      | Resolved permission matrix for the current user. |
| GET    | `/admin/companies`                           | List companies (no company context required). |
| POST   | `/admin/companies`                           | Create company (super_admin only). |
| PUT    | `/admin/companies/:id`                       | Update company. |
| GET / POST / PUT / DELETE | `/admin/branches`             | CRUD branches scoped to active company. |
| GET / POST / PUT / DELETE | `/admin/warehouses`           | CRUD warehouses (links to branches). |
| GET / POST / PUT / DELETE | `/admin/roles`                | CRUD custom roles with permission matrix. System roles are read-only. |
| GET / POST / DELETE       | `/admin/settings`             | Generic key/value settings. |
| GET / POST / DELETE       | `/admin/number-series`        | Configurable numbering per docKey. |
| GET / POST / PUT / DELETE | `/admin/approval-rules`       | Threshold-based approval rules. |
| GET                       | `/admin/approval-requests`    | Approval queue. |
| PATCH                     | `/admin/approval-requests/:id/decide` | Approve / reject / cancel. |
| GET                       | `/admin/activity`             | Auth event log (admin only). |

The auth flow now records:

| Event          | Trigger                                                  |
| -------------- | -------------------------------------------------------- |
| LOGIN_SUCCESS  | `/auth/login` returns a token directly.                  |
| LOGIN_FAILED   | Wrong password or user not found.                        |
| LOGOUT         | `POST /api/auth/logout`.                                 |
| COMPANY_SELECT | `/auth/select-company` after multi-company picker.       |
| COMPANY_SWITCH | `/auth/switch-company` while logged in.                  |

`User.lastLoginAt / lastLoginIp / lastLoginAgent` are also updated.

---

## 4. Number series engine

`backend/src/services/numberSeriesService.js` exposes `nextNumber(...)`.

When a `NumberSeriesConfig` row exists for `(companyId, branchId,
docKey)`, the new generator composes the document number using the
configured format tokens. Otherwise the legacy
`nextSalesDocNumber` / `nextSequentialNumber` paths continue to
work unchanged.

The `DocCounter` collection is shared with the legacy generator,
but Phase-10 sequences are stored under the prefix `NS:` so they do
not clash with existing counters.

Default formats:

| docKey                                          | format                       |
| ----------------------------------------------- | ---------------------------- |
| QUOTATION / ORDER_ACK / PROFORMA / ORDER_ALLOCATION / RTS / SALES_INVOICE / SALES_DISPATCH / SALES_RETURN / CIPL / PAYMENT_RECEIPT | `{COMPANY}/{YYMMDD}.{SEQ}`    |
| GRN                                             | `GRN-{YYYYMMDD}-{SEQ}`        |
| STOCK_ADJUSTMENT                                | `ADJ-{YYYYMMDD}-{SEQ}`        |
| STOCK_TRANSFER                                  | `TRF-{YYYYMMDD}-{SEQ}`        |

---

## 5. Approval workflow scaffolding

`approvalService` exposes:

```js
import { findMatchingRule, requestApproval, decideApproval } from "../services/approvalService.js";

const rule = await findMatchingRule({ companyId, module, actionKey, amount, currency });
const request = await requestApproval(req, { companyId, module, actionKey, ... });
await decideApproval(req, { id, decision, note });
```

Phase 10.1 only ships the storage + admin UI. Phase 10.4 will hook
`requestApproval(...)` into:

* `salesFlowController.cancelSalesInvoice` (`SALES.invoice_cancel`)
* `paymentReceiptController.cancelPaymentReceipt` (`ACCOUNTS.payment_cancel`)
* `stockController.postAdjustment` (`STORE.adjustment_post`)
* `logisticsController.updateShipment` close (`LOGISTICS.dispatch_close`)

so postings block until an admin approves the request via the new
queue.

---

## 6. Frontend Settings page

`/settings` (sidebar entry: **Settings**) contains tabs:

* **Companies** — list + create/edit Company master.
* **Branches** — CRUD branches for the active company.
* **Warehouses** — CRUD warehouses, optionally linked to a branch.
* **Roles & Permissions** — system roles plus custom role builder
  with a checkbox matrix (modules × actions).
* **Number Series** — per-docKey configurable formats.
* **Approval Rules** — threshold-based approval definitions.
* **Approval Queue** — pending / decided requests with one-click
  Approve / Reject (with notes).
* **User Activity** — filterable login / logout / failed-login log.

All admin tabs respect the existing role enum: `super_admin`,
`company_admin`, and `admin` can mutate; everyone else can read where
allowed.

---

## 7. Phase 10.2 route-level permission gating

Phase 10.2 mounts `requirePermission(module, action)` on ERP route
groups module by module. Login, company selection, and health-check
routes are intentionally untouched.

Permission action rules:

* `GET` list/detail routes require `module:view`.
* `POST` create routes require `module:create`.
* `PUT` / general `PATCH` edit routes require `module:edit`.
* Cancel routes require `module:cancel`.
* Approval/post/execute routes require `module:approve`.
* Print/download/export routes require `module:export`.
* Delete routes require `module:delete`.

Bypass rule:

* `SUPER_ADMIN` hard-bypasses permission checks.
* `ADMIN` and `COMPANY_ADMIN` no longer hard-bypass the middleware;
  they pass through the configured/default permission matrix. The
  shipped default matrix still grants them full access.

Module mapping:

* **Sales** — `/api/sales`, `/api/quotations`
* **Store** — `/api/store`, `/api/stock`, `/api/grn`, `/api/inventory`
* **Accounts** — `/api/accounts`, `/api/payment-receipts`
* **Logistics** — `/api/shipments`
* **Reports** — sales/purchase/accounts/logistics report endpoints
  and documents where treated as exported report artifacts.
* **Item Master** — `/api/items`, `/api/boms`, `/api/kitting`,
  `/api/dekitting`
* **Purchase** — `/api/purchase-orders`, `/api/suppliers`,
  `/api/purchase-returns`
* **Settings** — `/api/admin` master-data, roles, number series,
  approval rules, and approval queue endpoints
* **Audit** — `/api/audit-logs` and `/api/admin/activity`

Manual module verification checklist:

1. **Sales** — create a role with only `SALES.view`; confirm Sales
   lists open, create/update/cancel/convert calls return 403 with
   `PERMISSION_DENIED`.
2. **Store** — create a role with only `STORE.view`; confirm Stock
   View/Ledger loads and GRN post, adjustment post, transfer post and
   location mutation routes return 403.
3. **Accounts** — create a role with only `ACCOUNTS.view`; confirm
   ledgers/invoices load and payment create/cancel, bank detail
   mutation, manual ledger deletes return 403.
4. **Logistics** — create a role with only `LOGISTICS.view`; confirm
   shipments/dashboard load and create/update/delete/tracking/document
   updates return 403.
5. **Reports** — remove `REPORTS.view`; confirm Sales/Purchase/
   Accounts/Logistics report endpoints return 403 while normal module
   list routes still follow their own module permission.
6. **Item Master** — create a role with only `ITEM_MASTER.view`;
   confirm item/BOM/kitting lists load and import/create/update/delete/
   execute/cancel routes return 403.
7. **Purchase** — create a role with only `PURCHASE.view`; confirm PO,
   supplier and purchase-return lists load and create/edit/approve/
   receive/delete routes return 403.
8. **Settings** — create a role with only `SETTINGS.view`; confirm
   Settings lists load and role/branch/warehouse/number-series/
   approval-rule mutations return 403.
9. **SUPER_ADMIN** — confirm the same restricted routes still succeed
   for a `super_admin` user.
10. **Auth and health** — confirm `/api/auth/login`,
    `/api/auth/select-company`, `/api/auth/switch-company`, and
    `/api/health` remain callable without permission gating changes.

---

## 8. Phase 10.3 company isolation audit

Phase 10.3 hardens company isolation around the new admin surfaces
without changing API response shapes.

Audit scope:

* Controller and route calls using `findById`, `findByIdAndDelete`,
  `findOneAndUpdate`, `updateOne`, `deleteOne`, and `aggregate`.
* Admin user list/delete APIs.
* Master-data branch/warehouse relation updates.
* Approval decision service lookup.

Patches applied:

* `/api/auth/users` now requires active company context and lists only
  users whose `allowedCompanies` includes the selected company, except
  `super_admin` who can still view all users.
* `/api/auth/users/:id` deletion now requires active company context
  and deletes only a user visible inside the selected company, except
  `super_admin`.
* Branch deletion now uses a company-scoped delete filter.
* Warehouse deletion and branch relation updates now include
  `companyId` in update/delete filters.
* Role deletion now includes `companyId` and `isSystem:false` in the
  final delete filter.
* Approval decisions now re-read the `ApprovalRequest` by both `_id`
  and `req.companyId` before writing the decision.
* Backend `npm run verify` now syntax-checks `authRoutes.js` alongside
  all other route files touched by RBAC/company-scope work.

Manual company-isolation checklist:

1. Log in to Marivolt and call `/api/auth/users`; confirm users are
   limited to users assigned to Marivolt unless the user is
   `super_admin`.
2. Switch to Okeanos and repeat `/api/auth/users`; confirm the result
   follows Okeanos `allowedCompanies`.
3. Attempt to delete a user not assigned to the active company; confirm
   `404 User not found`.
4. Create Branch/Warehouse data in one company and attempt to update or
   delete those IDs while switched to another company; confirm `404` or
   no mutation.
5. Create an approval request in one company and attempt to decide it
   from another company; confirm the request is not found.

Deferred to the next isolation pass:

* Branch/warehouse row-level filtering inside high-volume business
  controllers after `allowedBranches[]` and `allowedWarehouses[]` are
  actively assigned to users.
* A dedicated automated integration test suite for cross-company CRUD
  leakage once a test database harness is introduced.

---

## 9. Backward compatibility

* All previous APIs and schemas remain unchanged.
* Existing JWT tokens continue to work (`User.role` enum extended,
  not replaced).
* Old `Company` documents validate against the new schema (every new
  field has a default).
* Number series fall back to the legacy `nextSalesDocNumber` /
  `nextSequentialNumber` helpers when no config row exists.
* `CustomerLedger`, `StockBalance`, `AuditLog`, `Shipment` and all
  Phase-1..9 collections remain untouched.

---

## 10. Verification checklist

Backend:

```
cd marivolt-erp/backend
npm run verify          # node --check across all controllers/services/routes
```

Frontend:

```
cd marivolt-erp
npm run build
```

Manual:

1. **Companies** — open `Settings → Companies`, edit Marivolt and
   add `shortName`, `country`, `defaultCurrency`. Save and confirm
   the row reflects the new fields.
2. **Branches** — create a branch (e.g. DXB / "Dubai HQ"). Confirm
   it appears under the active company only.
3. **Warehouses** — create a warehouse linked to the branch above.
   Confirm the branch's warehouse count increases.
4. **Roles** — create a custom role with `SALES.view + SALES.export`
   only. Confirm the matrix saves and the row shows "SALES" in the
   modules column.
5. **Number Series** — add a config for `SALES_INVOICE` with
   `{COMPANY}/{YYMMDD}.{SEQ}` and padding 4. Confirm save and
   delete behaviour.
6. **Approval Rule** — define `SALES.invoice_cancel` with
   `minAmount=0` and `approverRoles=admin,super_admin`.
7. **Approval Queue** — empty by default; once Phase 10.4 wires the
   gate it will populate when applicable.
8. **User Activity** — log in / log out / fail a login and confirm
   rows appear with IP, browser, OS detection.

Files added / changed:

```
backend/src/models/Company.js              (extended)
backend/src/models/User.js                 (extended)
backend/src/models/Branch.js               (new)
backend/src/models/Warehouse.js            (new)
backend/src/models/Role.js                 (new)
backend/src/models/UserActivity.js         (new)
backend/src/models/Setting.js              (new)
backend/src/models/NumberSeriesConfig.js   (new)
backend/src/models/ApprovalRule.js         (new)
backend/src/models/ApprovalRequest.js      (new)
backend/src/services/roleService.js        (new)
backend/src/services/userActivityService.js(new)
backend/src/services/numberSeriesService.js(new)
backend/src/services/approvalService.js    (new)
backend/src/middleware/permissions.js      (new)
backend/src/controllers/masterDataController.js  (new)
backend/src/controllers/rolesController.js       (new)
backend/src/controllers/settingsController.js    (new)
backend/src/controllers/approvalController.js    (new)
backend/src/controllers/userActivityController.js(new)
backend/src/routes/adminRoutes.js          (new)
backend/src/routes/authRoutes.js           (activity logging)
backend/src/server.js                      (mount /api/admin)
backend/package.json                       (verify script)
src/pages/Settings.jsx                     (new)
src/App.jsx                                (route)
src/components/Sidebar.jsx                 (link)
docs/phase10-master-data-rbac.md           (this file)
```
