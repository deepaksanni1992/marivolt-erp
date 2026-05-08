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

## 7. Backward compatibility

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

## 8. Verification checklist

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
