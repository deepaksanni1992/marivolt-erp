# Phase-6 — Stock View, Negative Allocation, Drilldown, Backorder

## What Changed

- Store Stock View now reads `GET /api/store/stock-summary`.
- The summary is based on persisted `StockBalance` rows and only looks up latest `StockLedger` movement dates for the current page, not the full ledger.
- Stock View now shows Article, Item Name, Warehouse, Location, On Hand, Allocated, RTS, Available, UOM, Negative Status, Last Movement Date.
- Negative status values:
  - `NEGATIVE / BACKORDER` when Available < 0.
  - `ZERO STOCK` when Available = 0.
  - `OK` when Available > 0.
- Customer Allocation drilldown now includes Allocated Qty, RTS Qty, Invoice Qty, Warehouse, Location, Allocation Date, Status.
- Store Negative Allocation Report now includes Warehouse, Location, On Hand, Allocated, RTS, Available, Negative Qty, Last Movement Date.
- Sales Reports now include `Backorder Report`.
- Store Stock View polls every 30 seconds while open and Sales/Store stock mutations invalidate stock summary, ledger, negative allocation, and drilldown queries.

## Backend Endpoints

- `GET /api/store/stock-summary`
  - Filters: `article`, `warehouse`, `location`, `negativeOnly`, `allocatedOnly`, `customer`, `referenceNo`, `search`.
- `GET /api/store/customer-allocations`
  - Existing route, now returns RTS and invoice quantities.
- `GET /api/store/negative-allocations`
  - Existing route, now returns warehouse-aware shortage fields.
- `GET /api/sales/reports/backorder`
  - Sales > Reports > Backorder Report.

## Manual Verification

### 1. Stock View Summary

1. Open Store > Stock View.
2. Search an article that has GRN stock and sales allocations.
3. Confirm columns show Warehouse, Location, On Hand, Allocated, RTS, Available, UOM, Negative Status, Last Movement Date.
4. Confirm `Available = On Hand - Allocated - RTS`.

Expected: Values match Store > Stock Ledger latest `*After` columns for the article/warehouse.

### 2. Negative and Zero Badges

1. Allocate an article with zero stock using the negative-allocation confirmation.
2. Open Store > Stock View.

Expected: Row is red-tinted and shows `NEGATIVE / BACKORDER`.

3. Bring another article to exactly zero available.

Expected: Row is amber-tinted and shows `ZERO STOCK`.

### 3. Customer Allocation Drilldown

1. On a Stock View row with allocation, click View Allocation.

Expected modal columns:

- Customer
- Reference
- Type
- Allocated Qty
- RTS Qty
- Invoice Qty
- Warehouse
- Location
- Date
- Status
- Backorder
- Created By

Export CSV/PDF should include the same quantities.

### 4. Stock Summary Filters

Use Store > Stock View filters:

- Article
- Warehouse
- Location
- Customer
- Reference No
- Negative only
- Allocated only

Expected: Filters narrow rows without hard reload. Customer/reference filters only return article+warehouse pairs with matching active allocations.

### 5. Negative Allocation Report

1. Open Store > Negative Allocation Report.
2. Filter by article, warehouse, and customer.

Expected columns:

- Article
- Item Name
- Customer
- Ref No
- Ref Type
- Warehouse
- Location
- On Hand
- Allocated
- RTS
- Available
- Negative Qty
- Last Movement Date

CSV and PDF exports should include these columns.

### 6. Sales Backorder Report

1. Open Sales > Reports.
2. Select Backorder Report under Order Confirmation Reports.

Expected columns:

- Customer
- Article
- Ref No
- Ordered Qty
- Allocated Qty
- Pending Qty
- RTS Qty
- Invoice Qty
- Available
- Expected GRN

Expected behavior: Rows appear only when pending quantity remains after RTS and invoice quantities are considered.

### 7. Fast Live Update

With Store > Stock View open:

1. Post a GRN.
2. Post a Stock Adjustment.
3. Post a Stock Transfer.
4. Create/cancel an allocation or invoice from Sales.

Expected: Stock View refreshes via invalidation when the action is performed in-app, or within 30 seconds via polling while the tab is open.

### 8. Negative Allocation Improved by GRN

1. Create negative allocation for an article: On Hand 0, Allocated 70, RTS 0, Available -70.
2. Post GRN for 30.

Expected:

- Stock View shows On Hand 30, Allocated 70, RTS 0, Available -40.
- Negative Allocation Report still shows the article, but Negative Qty improves from 70 to 40.
- Latest Stock Ledger `GRN_IN` row shows `availableAfter = -40`.

## Performance Notes

- Stock View does not aggregate full ledger history.
- It aggregates current `StockBalance` rows by article + warehouse + location and looks up latest ledger movement only for the displayed rows.
- New indexes were added on `StockBalance` and `StockLedger` for article, warehouse/location, movement date, reference, and customer lookups.
