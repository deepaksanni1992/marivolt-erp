# Phase-4 — Sales-flow migration to `stockService`

## What changed

`salesFlowController.js` no longer calls the legacy `salesStockService.apply*`
helpers. Every stock-touching sales endpoint now drives a single `stockService`
call (per article, per movement) which:

1. Mutates `StockBalance` atomically inside the surrounding transaction.
2. Captures the post-mutation balance snapshot (`onHandAfter`,
   `allocatedAfter`, `rtsAfter`, `availableAfter`).
3. Writes a unified `StockLedger` row with all Phase-3 fields populated
   (`movementType`, `customerName`, `referenceNo`, `referenceType`, `warehouse`,
   `sourceModule`, after-balances, `isNegativeAllocation`).

| Sales endpoint                          | Old call                            | New call                            |
| --------------------------------------- | ----------------------------------- | ----------------------------------- |
| `convertOAToOrderAllocation`            | `applySalesReserve`                 | `stockService.allocateStock`        |
| `convertProformaToOrderAllocation`      | `applySalesReserve`                 | `stockService.allocateStock`        |
| `cancelOrderAllocation`                 | `applySalesReleaseReserve`          | `stockService.cancelAllocation`     |
| `approveRts` (legacy backfill reserve)  | `applySalesReserve`                 | `stockService.allocateStock` (allowNegative) |
| `approveRts` (RTS move)                 | `applyReservedToRts`                | `stockService.moveAllocationToRTS`  |
| `cancelRts`                             | `applyRtsToReserved`                | `stockService.cancelRTS`            |
| `convertOrderAllocationToSalesInvoice`  | `applySalesInvoiceOut`              | `stockService.invoiceFromRTS`       |
| `cancelSalesInvoice`                    | `applySalesInvoiceCancelRestore`    | `stockService.cancelInvoice`        |

`salesStockService.js` is left in the repo as **read-only legacy** for any
historical InventoryLedger rows it produced before this migration. No new
writes go through it.

The `withTransaction(fn)` wrapper used by the controllers is now imported
from `stockService` (the function it points to is identical).

## Behavioural parity / improvements

- API request and response shapes are unchanged.
- Allocation still allows negative available stock when `allowNegative: true`
  is passed; `STOCK_INSUFFICIENT` 409 error is preserved otherwise.
- `OrderAllocation.lines[i].isNegativeAllocation` and `hasNegativeAllocation`
  continue to be set the same way (the `negativeArticles` Set returned by the
  helper drives this).
- `StockBalance` writes now keep `quantity`/`onHandQty` in lockstep on the
  invoice paths (the old path only decremented `quantity`; this is a strict
  improvement and affects no API surface).
- `allocatedQty` is intentionally NOT mutated by the new code — only
  `reservedQty` is touched, exactly like the legacy path. The unified read
  derives `allocatedAfter = max(allocatedQty, reservedQty)` so legacy rows
  with `allocatedQty=0, reservedQty=N` continue to display correctly.

## Manual verification checklist

Run each scenario with two articles: one positive-stock, one zero-stock.
After each step, open **Store → Stock Ledger** and confirm the new row
appears with the indicated columns populated. Open **Store → Stock View**
to confirm the bucket math.

### 1. Proforma → Order Allocation (positive stock)

1. Create an Item, GRN-in 100 units of `ART-A` to warehouse `MAIN`.
2. Open a Quotation → Order Acknowledgement → Proforma Invoice for 30
   units of `ART-A`. Pay it fully so it reaches `PAID_PENDING_SHIPMENT`.
3. Click **Convert to Order Allocation**.

**Expected:** the conversion succeeds. Stock Ledger shows one
`ALLOCATION` row with:

- `customerName` = the customer.
- `referenceNo` = the Order Allocation number, `referenceType` = `ORDER_ALLOCATION`.
- `qtyOut` = 30, `qtyIn` = 0 (allocation drains Available).
- `onHandAfter` = 100, `allocatedAfter` = 30, `rtsAfter` = 0,
  `availableAfter` = 70.
- `sourceModel` = `StockLedger`, `movementType` = `ALLOCATION`.

### 2. Proforma → Order Allocation (zero stock, negative allocation)

1. Use a fresh `ART-B` with zero on-hand.
2. Create a Proforma for 50 units, mark it `PAID`, click **Convert to Order Allocation**.
3. The frontend shows the **insufficient stock** confirm modal. Enter a
   reason and click **Continue with negative allocation**.

**Expected:** the Order Allocation is created, `hasNegativeAllocation: true`,
`negativeAllocationReason` saved. Stock Ledger shows an `ALLOCATION` row
with `availableAfter = -50`, `isNegativeAllocation = true`,
`remarks` containing `[NEGATIVE: available -50]`.

### 3. Order Allocation cancellation

1. Cancel the Order Allocation from Sales > Order Allocation tab.

**Expected:** Stock Ledger shows an `ALLOCATION_CANCEL` row with
`qtyIn = 50`, `referenceNo` = the allocation number,
`referenceType` = `ORDER_ALLOCATION_CANCEL`. Stock View `allocatedQty`
returns to its pre-allocation value.

### 4. RTS approval

1. From an OPEN Order Allocation, create an RTS document, then approve it.

**Expected:** Stock Ledger shows one `RTS_TRANSFER` row per article with
`referenceType = RTS_APPROVED`, `referenceNo = <RTS no>`,
`customerName` populated, `qtyIn = 0`, `qtyOut = 0` (no Available change),
`allocatedAfter` decreased by qty, `rtsAfter` increased by qty,
`onHandAfter` unchanged.

### 5. RTS cancellation

1. Cancel an APPROVED RTS.

**Expected:** Stock Ledger shows `RTS_CANCEL` row with the inverse
bucket movement: `rtsAfter` decreases, `allocatedAfter` increases.

### 6. Sales Invoice creation

1. Convert an Order Allocation (with at least one APPROVED RTS) to a
   Sales Invoice. Approve the invoice (post stock).

**Expected:** Stock Ledger shows one `SALES_INVOICE_OUT` row per article
with `referenceType = SALES_INVOICE`, `referenceNo = <invoice no>`,
`qtyOut = invoice qty`, `onHandAfter` decreased, `rtsAfter` decreased
(by min(invoice qty, RTS bucket)), and any remainder taken from
`allocatedAfter`.

### 7. Sales Invoice cancellation

1. Cancel the posted Sales Invoice.

**Expected:** Stock Ledger shows `SALES_INVOICE_CANCEL` row with
`qtyIn = invoice qty`, `onHandAfter` restored, `rtsAfter` increased by
invoice qty (cancellation pushes goods one step back into RTS, not all
the way back to Allocated — matches existing reverse-flow contract).

### 8. Cross-cutting checks

- `Customer / Supplier` filter on Stock Ledger filters to a customer correctly.
- `Source` filter shows only `StockLedger` for new sales movements;
  toggling to `InventoryLedger` shows historical rows from before this
  migration.
- `Negative Allocation Report` (Store > Negative Allocation Report)
  picks up new negative allocations.
- `Stock View → View Allocation` button on a negative-available row
  lists the customer allocations contributing to the backorder.

## Rollback plan

If a regression is caught, revert this commit. The previous commit
(`b1bbb0a`) had `salesFlowController.js` calling `applySales*` directly;
restoring it switches the writes back to InventoryLedger without
schema migration since the schema expansion is fully backward-compatible.
