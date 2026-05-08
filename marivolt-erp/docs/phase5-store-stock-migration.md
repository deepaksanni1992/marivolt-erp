# Phase-5 — Store-flow migration to `stockService`

## What changed

`grnController.js`, `stockController.js`, and `inventoryController.js`
no longer call `stockLedgerService.postLedgerMovement` or the
deleted `applyStockIn / applyStockOut / applyAdjustment` helpers.
Every Store-side stock movement now drives a single `stockService`
call which:

1. Mutates `StockBalance` atomically inside the surrounding transaction.
2. Captures a warehouse-level post-mutation snapshot (`onHandAfter`,
   `allocatedAfter`, `rtsAfter`, `availableAfter`) by aggregating
   across batch / serial sub-rows.
3. Writes a unified `StockLedger` row with the full Phase-3 schema
   populated.

| Endpoint                          | Old call                    | New call                        |
| --------------------------------- | --------------------------- | ------------------------------- |
| `grnController.postGrn`           | `postLedgerMovement (GRN)`  | `stockService.grnReceive`       |
| `grnController.cancelGrn`         | `postLedgerMovement (ADJ)`  | `stockService.cancelGrn`        |
| `stockController.postAdjustment`  | `postLedgerMovement (ADJ)`  | `stockService.stockAdjustment`  |
| `stockController.postTransfer`    | `postLedgerMovement (TX_OUT/IN)` | `stockService.stockTransfer` |
| `inventoryController.postStockIn`  | `applyStockIn` (deleted)   | `stockService.grnReceive`       |
| `inventoryController.postStockOut` | `applyStockOut` (deleted)  | `stockService.stockAdjustment` (Decrease) |
| `inventoryController.postAdjustment` | `applyAdjustment` (deleted) | `stockService.stockAdjustment` |
| `inventoryController.postOpening` | direct `InventoryLedger.create` | `stockService.openingBalance` |

The legacy `services/stockLedgerService.js` module is no longer
imported anywhere; it is left in the repo for reference but is dead
code from the controller perspective. (It can be removed in a future
cleanup commit once we are confident no out-of-tree script depends
on it.)

## stockService additions

- New `cancelGrn` function: mirrors `grnReceive` but decrements
  on-hand. Atomically guards against negative on-hand AND negative
  available stock (matching the old controller's pre-check, but
  inside the transaction so it's race-free).
- `grnReceive` now accepts optional `batchNo`, `serialNo`,
  `transactionDate`. Batched GRNs continue to write to per-batch
  `StockBalance` rows; their ledger entry's `*After` columns
  reflect the aggregated warehouse total (not the per-batch sub-row).
- `stockTransfer` and `stockAdjustment` now accept
  `transactionDate` so the ledger row carries the document date
  instead of "now".
- Internal `bumpBuckets` was widened to filter by the StockBalance
  unique key `(article, location, batchNo, serialNo)` instead of
  the legacy `(itemCode, warehouse)` alias pair, so it consistently
  finds rows written by any earlier code path.
- Internal `snapshotAfter` aggregates across batch/serial sub-rows
  for the same (article, warehouse) so the `*After` snapshot always
  represents the warehouse-level running balance, no matter which
  sub-row was just mutated.

## Behavioural parity / improvements

- API request and response shapes are unchanged.
- The "Insufficient available quantity for transfer" pre-check that
  used to live in the controller is gone — the same condition is now
  enforced atomically by the `stockTransfer` guard. Error message is
  now `stockTransfer: insufficient available qty in <wh> for <art>.`.
  (Same HTTP 400 shape.)
- Cancelling a GRN previously required loading the StockBalance
  row, checking `availableQty`, then running a separate update. Now
  it's a single guarded `findOneAndUpdate`, which is race-free if
  two cancellations were attempted in parallel.
- Inventory module routes (`/api/inventory/stock-in`,
  `/api/inventory/stock-out`, `/api/inventory/adjust`) were broken
  since Phase-3.2 removed the `applyStockIn / applyStockOut /
  applyAdjustment` helpers from `stockService`. They now work
  again, write to `StockLedger`, and persist Phase-3 `*After`
  snapshots.

## Manual verification checklist

Each scenario should be exercised against a fresh test article
(`ART-VFY-1` / `ART-VFY-2`). After every step, open
**Store → Stock View** to read bucket totals and **Store → Stock
Ledger** to confirm the new row.

### 1. GRN receive

1. Create GRN draft for `ART-VFY-1` × 100 to warehouse `MAIN`,
   supplier `Acme Inc`. Post the GRN.

**Expected (Stock View, MAIN):** On Hand = 100, Allocated = 0,
RTS = 0, Available = 100.

**Expected (Stock Ledger, newest row):**

- `Movement Type` = `GRN_IN`.
- `Reference Type` = `GRN`, `Reference No` = the GRN number.
- `Customer` empty, `Supplier` = `Acme Inc`.
- `From → To` = `→ MAIN`.
- `Qty In` = 100, `Qty Out` = 0.
- `On Hand After` = 100, `Allocated After` = 0, `RTS After` = 0,
  `Available After` = 100.
- `Source` = `StockLedger`.

### 2. GRN cancel (no allocations against it)

1. Create GRN for `ART-VFY-1` × 30, post it. (Stock View: On Hand 130.)
2. Cancel the GRN.

**Expected (Stock View):** On Hand = 100 again.

**Expected (Stock Ledger):**

- `Movement Type` = `STOCK_ADJUSTMENT`.
- `Reference Type` = `GRN_CANCEL`, `Reference No` = the cancelled
  GRN number.
- `From → To` = `MAIN →`.
- `Qty Out` = 30, `On Hand After` = 100, `Available After` = 100.

### 3. GRN cancel blocked when stock already allocated

1. Reset to On Hand 100 from Step 1.
2. Allocate 60 to a customer via Order Allocation.
3. Try to cancel the original GRN-100.

**Expected:** HTTP 400 with message `cancelGrn: cannot reduce
ART-VFY-1 by 100 in MAIN — stock already allocated/sold.`. Stock
View unchanged.

### 4. Stock Adjustment +

1. Open Store > Stock Adjustment for `ART-VFY-1`, MAIN, +20,
   reason "cycle count fix". Post it.

**Expected:** On Hand 100 → 120.

**Stock Ledger row:** `Movement Type` = `STOCK_ADJUSTMENT`,
`Qty In` = 20, `Qty Out` = 0, `On Hand After` = 120, `Available
After` = 60 (because 60 are still allocated).

### 5. Stock Adjustment −

1. Same form, this time `−10` ("damage write-off"). Post.

**Expected:** On Hand 120 → 110, `Qty Out` = 10, `On Hand After`
= 110. Ledger row carries the same reference-type tag.

### 6. Stock Transfer (MAIN → WH-2)

1. Make sure `WH-2` is an Active Location.
2. Create transfer for `ART-VFY-1` 25 from MAIN → WH-2. Post.

**Expected (Stock View):** Two rows, MAIN On Hand = 85 and WH-2
On Hand = 25.

**Expected (Stock Ledger):** Two new rows for the same `Reference
No`:

- `STOCK_TRANSFER_OUT`: `From → To` = `MAIN → WH-2`,
  `Qty Out` = 25, `On Hand After` = 85 (MAIN snapshot),
  `Source Model` = `StockLedger`.
- `STOCK_TRANSFER_IN`: `From → To` = `MAIN → WH-2`,
  `Qty In` = 25, `On Hand After` = 25 (WH-2 snapshot).

### 7. Negative allocation improved by GRN receive

1. Use a fresh `ART-VFY-2`. Create a Proforma → Order Allocation for
   50 units; confirm the negative-allocation modal so it succeeds
   with `Available = -50`.
2. Confirm `Negative Allocation Report` lists `ART-VFY-2`.
3. Now post a GRN for `ART-VFY-2` × 30 to MAIN.

**Expected (Stock View):** On Hand = 30, Allocated = 50, Available
= -20 (still negative but improved by 30).

**Expected (Stock Ledger):** the new `GRN_IN` row carries
`Available After = -20` and `Allocated After = 50`. Negative
Allocation Report still lists the article but with the smaller
deficit.

### 8. Cross-cutting checks

- Filter Stock Ledger by `Reference No = <GRN no>` — both the
  GRN_IN row and (later) the GRN_CANCEL row should appear.
- Source filter "StockLedger only" shows all Phase-5 movements;
  switching to "InventoryLedger only" shows historical sales rows
  from before Phase 4.
- Customer + Supplier filter combinations behave correctly.
- The Stock View "View Allocation" drill-down on `ART-VFY-2` lists
  the negative allocation, with `Available After` = -20 once the
  GRN row appears.

## Rollback plan

If a regression is caught, revert this commit. The previous commit
(`f5c2a45`) had the controllers calling `postLedgerMovement` and the
broken `applyStockIn / applyStockOut / applyAdjustment` imports.
Restoring it switches Store writes back to InventoryLedger / direct
StockLedger writes via the legacy service. Schema is unchanged so no
data migration is needed in either direction.
