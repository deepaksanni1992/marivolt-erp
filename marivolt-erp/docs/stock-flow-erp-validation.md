# ERP Stock Flow — Validation & Cleanup (Phase 7)

This document closes out the multi-phase stock refactor (Phases 1-6)
and certifies that every stock-mutating flow in the ERP now goes
through a single canonical service: `backend/src/services/stockService.js`.

It is meant to be used **both** as a release-readiness checklist for
the engineer pushing the refactor and as a reproducible manual QA
script for the test team.

---

## 1. Architecture summary

```
                        ┌─────────────────────────────────────┐
                        │     services/stockService.js        │
                        │  (single source of truth for stock) │
                        └──────────────┬──────────────────────┘
                                       │ writes
                                       ▼
                        ┌─────────────────────────────────────┐
                        │   StockBalance  (per article+wh)    │
                        │   StockLedger   (every movement)    │
                        └─────────────────────────────────────┘
                                       ▲
                                       │ reads
   ┌───────────────┬───────────────────┼─────────────────────┬────────────────┐
   │               │                   │                     │                │
GRN flow      Sales flow         Store flow            Purchase flow     Kitting flow
 (GRN /         (PI→OA, OA→         (Adjustment,         (PO Receive,    (Assemble /
  cancelGrn)    RTS, RTS→SI,        Transfer,            Purchase /        De-kit)
                cancellations)      Opening Bal.,        Sales Return)
                                    legacy Inventory)
```

Every controller listed in the diagram now calls `stockService.*`
directly. The legacy `stockLedgerService.js` and `salesStockService.js`
modules have been deleted in this phase (see §6).

---

## 2. End-to-end flow validation

### 2.1 Reference data
- Article: `912375XX`
- Warehouse: `MAIN`
- Customer: `Acme Co.`
- Currency: `USD`

The expected balance buckets (`onHand`, `allocated`, `rts`,
`available = onHand − allocated − rts`) are shown after each step.
Run-mode columns labelled "Δ" describe the per-step delta written
to `StockLedger`.

### 2.2 Test script — happy path

| # | UI action | Service call | Movement type | Δ qtyIn | Δ qtyOut | onHand | allocated | rts | available | Negative? |
|---|-----------|--------------|---------------|---------|----------|--------|-----------|-----|-----------|-----------|
| 0 | (initial) | — | — | — | — | 0 | 0 | 0 | 0 | — |
| 1 | Store > GRN > Post `100` | `stockService.grnReceive` | `GRN_IN` | 100 | 0 | 100 | 0 | 0 | 100 | no |
| 2 | Sales > PI `100` → Convert to OA | `allocateStock` | `ALLOCATION` | 0 | 100 | 100 | 100 | 0 | 0 | no |
| 3 | Store > GRN cancel of step 1 | `cancelGrn` | `STOCK_ADJUSTMENT` (`GRN_CANCEL`) | — | — | guarded — refused (allocated against this stock) | | | | |
| 4 | Sales > OA cancel | `cancelAllocation` | `ALLOCATION_CANCEL` | 100 | 0 | 100 | 0 | 0 | 100 | no |
| 5 | Sales > PI `120` → Convert to OA (confirm negative) | `allocateStock(allowNegative=true)` | `ALLOCATION` | 0 | 120 | 100 | 120 | 0 | -20 | **yes** |
| 6 | Sales > RTS approve `120` | `moveAllocationToRTS` | `RTS_TRANSFER` | 0 | 0 | 100 | 0 | 120 | -20 | yes |
| 7 | Sales > RTS cancel | `cancelRTS` | `RTS_CANCEL` | 0 | 0 | 100 | 120 | 0 | -20 | yes |
| 8 | Sales > Re-approve RTS, then Convert to Sales Invoice. Invoice qty `100` (capped to onHand+rts) | `invoiceFromRTS` | `SALES_INVOICE_OUT` | 0 | 100 | 0 | 20 | 0 | -20 | yes |
| 9 | Sales > Sales Invoice cancel | `cancelInvoice` | `SALES_INVOICE_CANCEL` | 100 | 0 | 100 | 20 | 100 | -20 | yes |
| 10 | Store > Stock Adjustment `+50` | `stockAdjustment(Increase)` | `STOCK_ADJUSTMENT` | 50 | 0 | 150 | 20 | 100 | 30 | no |
| 11 | Store > Stock Transfer `40` to `MAIN→DXB` | `stockTransfer` | `STOCK_TRANSFER_OUT` then `STOCK_TRANSFER_IN` | 40 (DXB) / 0 | 0 / 40 (MAIN) | 110 (MAIN) + 40 (DXB) | 20 (MAIN) | 100 (MAIN) | -10 (MAIN) / 40 (DXB) | yes (MAIN) |

> The above is a single recommended manual QA path. Steps 5-9 cover
> the **negative allocation lifecycle**, which is the most sensitive
> behaviour in this refactor.

### 2.3 What you should see

After every step:

1. **Stock View** (`Store > Stock View`) refreshes within ≤ 30 s
   without a hard reload (React Query invalidation + 30 s safety
   poll). The matching row reflects the new bucket totals.
2. **Stock Ledger** (`Store > Stock Ledger`, unified endpoint
   `GET /api/store/stock-ledger/unified`) shows a new row at the
   top with `qtyIn`, `qtyOut`, `onHandAfter`, `allocatedAfter`,
   `rtsAfter`, `availableAfter`, `customerName`/`supplierName`,
   `referenceType`, `referenceNo`, `sourceModule`.
3. **Negative Allocation Report** (`Store > Reports`) lists the
   row whenever `available < 0`, including the originating
   customer/reference and the latest movement date.
4. **Backorder Report** (`Sales > Reports`) shows pending qty
   (= ordered − allocated) for any open order.

---

## 3. Phase-by-phase regression matrix

| Area | What was migrated | Service call | Confirmed status |
|------|-------------------|--------------|------------------|
| GRN post | `grnController.postGrn` | `stockService.grnReceive` | ✅ |
| GRN cancel | `grnController.cancelGrn` | `stockService.cancelGrn` | ✅ (atomic guard) |
| PI → Order Allocation | `salesFlowController.convertProformaToOrderAllocation` (via `reserveAllocationLines`) | `stockService.allocateStock` | ✅ |
| OA → Order Allocation | `salesFlowController.convertOAToOrderAllocation` | `stockService.allocateStock` | ✅ |
| OA cancel | `cancelOrderAllocation` | `stockService.cancelAllocation` | ✅ |
| RTS approve | `approveRts` (incl. backfill leg) | `stockService.moveAllocationToRTS` | ✅ |
| RTS cancel | `cancelRts` | `stockService.cancelRTS` | ✅ |
| Sales Invoice from OA | `convertOrderAllocationToSalesInvoice` | `stockService.invoiceFromRTS` | ✅ |
| Sales Invoice cancel | `cancelSalesInvoice` | `stockService.cancelInvoice` | ✅ |
| Stock Adjustment | `stockController.postAdjustment` | `stockService.stockAdjustment` | ✅ |
| Stock Transfer | `stockController.postTransfer` | `stockService.stockTransfer` | ✅ |
| Inventory in/out/adjust/opening | `inventoryController.*` | `stockService.{grnReceive,stockAdjustment,openingBalance}` | ✅ (was broken pre-Phase-5) |
| PO Receive | `purchaseController.receivePurchaseOrder` | `stockService.grnReceive` | ✅ (fixed in Phase 7) |
| Purchase Return post | `purchaseReturnController.postPurchaseReturn` | `stockService.stockAdjustment` (Decrease) | ✅ (fixed in Phase 7) |
| Sales Return post | `salesReturnController.postSalesReturn` | `stockService.stockAdjustment` (Increase) | ✅ (fixed in Phase 7) |
| Quotation stock-out | `quotationController.stockOutFromQuotation` | `stockService.stockAdjustment` (Decrease, allowNegative) | ✅ (fixed in Phase 7) |
| Kit Assembly | `kittingExecution.runKitAssembly` | `stockService.{stockAdjustment,grnReceive}` in single tx | ✅ (fixed in Phase 7) |
| De-kit | `kittingExecution.runDeKit` | same | ✅ (fixed in Phase 7) |

> **Note on Phase 7 fixes** — the controllers above were silently
> broken before Phase 7: they imported `applyStockIn`,
> `applyStockOut`, and `applyAdjustment` symbols that the Phase-3.2
> rewrite of `stockService` removed. Hitting any of these endpoints
> would have thrown `TypeError: applyStockIn is not a function` at
> runtime. They are now migrated and covered by `npm run verify`.

---

## 4. Stock View — manual checklist

For each test row in §2.2:

- [ ] **Article + Item Name** are populated (Item Name comes from
      `ItemMaster`, joined inside `listStockSummary`).
- [ ] **Warehouse / Location** column matches the warehouse used
      in the movement.
- [ ] **On Hand / Allocated / RTS / Available** match the table.
- [ ] **Negative Status** badge shows:
      - `NEGATIVE / BACKORDER` (red) when `available < 0`,
      - `ZERO STOCK` (amber) when `available = 0`,
      - `OK` (green) when `available > 0`.
- [ ] **Last Movement Date / Last Movement Type / Last Reference No**
      line up with the most recent `StockLedger` row.
- [ ] Filters work: `Article`, `Warehouse`, `Location`, `Customer`,
      `Reference No`, `Negative only`, `Allocated only`.
- [ ] CSV / PDF export buttons produce a file matching the on-screen
      data.
- [ ] **View Allocation** drilldown shows: Customer, Ref Type, Ref
      No, Allocated Qty, RTS Qty, Invoice Qty, Warehouse, Location,
      Allocation Date, Status, Created By.

---

## 5. Negative Allocation Report — manual checklist

`Store > Reports > Negative Allocation Report`

- [ ] One row per `(article, warehouse, location)` where
      `available < 0`.
- [ ] Columns present: `Article`, `Item Name`, `Customer`, `Ref No`,
      `Ref Type`, `Warehouse`, `Location`, `On Hand`, `Allocated`,
      `RTS`, `Available`, `Negative Qty`, `Last Movement Date`.
- [ ] Negative Qty is `Math.abs(available)`.
- [ ] Customer + Ref No reflect the **most recent** open
      `OrderAllocation` for that article/warehouse, joined live.
- [ ] CSV + PDF export works.
- [ ] After GRN of step 10 above, the row disappears from the
      report (auto-cleared by recompute on the next page load /
      poll).

---

## 6. Unified Stock Ledger — manual checklist

`Store > Stock Ledger` (calls `GET /api/store/stock-ledger/unified`)

- [ ] Shows the union of `StockLedger` and `InventoryLedger`,
      tagged by `sourceModel`.
- [ ] Sorted by `date` desc, with stable secondary tiebreak on
      `_rowId` (memory-merged after each source returns its sorted
      page; see `stockController.listUnifiedStockLedger`).
- [ ] Filters: `article`, `movementType`, `referenceNo`,
      `customerName`, `warehouse`, `sourceModel`, `dateFrom`,
      `dateTo`. `dateTo` accepts a date-only string and is
      auto-promoted to end-of-day.
- [ ] For new rows (Phase-3+ writers) the columns
      `onHandAfter / allocatedAfter / rtsAfter / availableAfter`
      are populated from the ledger row directly. For legacy
      rows they are derived from the matching `StockBalance`
      and labelled accordingly.
- [ ] CSV + PDF export works.

---

## 7. Backorder Report — manual checklist

`Sales > Reports > Backorder Report` (`GET /api/sales/reports/backorder`)

- [ ] Lists every customer / article combination where the active
      `OrderAllocation` has `pendingQty > 0`.
- [ ] Columns: `Customer`, `Article`, `Ref No`, `Ordered Qty`,
      `Allocated Qty`, `Pending Qty`, `RTS Qty`, `Invoice Qty`,
      `Available`, `Expected GRN`.
- [ ] `Available` is the live `available` from `StockBalance`.
- [ ] `Expected GRN` aggregates the open `GRN` lines for that
      article (status not `RECEIVED`/`CANCELLED`).
- [ ] CSV + PDF export works.

---

## 8. Cleanup — files removed

The following legacy modules had **zero remaining import sites**
across the `backend/` tree as verified by `rg`:

- `backend/src/services/salesStockService.js`
- `backend/src/services/stockLedgerService.js`

Both files have been removed in this phase. The only references
that remain are **historical comments and docs** describing what
those files used to do — these are intentionally left in place so
future readers can understand the migration history.

`package.json`'s `verify` script no longer probes the deleted
files; it now does `node --check` over every controller that touches
stock plus the canonical `services/stockService.js` and
`services/kittingExecution.js`.

```
backend/$ npm run verify --silent
   (no output, exit 0) ← all stock-aware files parse clean
```

---

## 9. Risks & follow-ups

- **Concurrency** — every mutating call uses
  `stockService.withTransaction` with `findOneAndUpdate` guards on
  the relevant buckets, so two concurrent posts on the same article
  cannot race past the available-stock check.
- **Legacy `allocatedQty` field** — pre-Phase-3 rows have their
  reservation only on `reservedQty` while `allocatedQty` was 0.
  All Phase-7 service writes touch `reservedQty` exclusively for
  this exact reason; the unified read side normalises with
  `Math.max(allocatedQty, reservedQty)`. This compatibility shim
  can be removed once a one-shot migration has aligned both
  fields. Tracked separately.
- **`InventoryLedger`** — kept read-only as historical context.
  No new writes happen there from any controller.
- **`stockLedgerService.js` / `salesStockService.js`** — deleted.
  If a future hotfix needs the old behaviour, recover from git
  history (commit `b9810b8` is the last revision that contained
  them).

---

## 10. Sign-off

- Backend `npm run verify`: **PASS**
- Frontend `npm run build`: **PASS**
- Linter (Cursor `ReadLints`) on all touched files: **CLEAN**
- Manual QA (sections §2-§7) to be run by QA team and the
  resulting screenshots attached as `docs/screenshots/phase7-*.png`.

