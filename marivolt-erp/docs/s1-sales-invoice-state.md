# Phase S1 — Sales Invoice state separation

## State model

| Field | Values | Authority |
| --- | --- | --- |
| `documentStatus` | DRAFT / ISSUED / CANCELLED | Sales Invoice lifecycle (create/issue/cancel) |
| `paymentStatus` | UNPAID / PARTIALLY_PAID / PAID (`PARTIAL` legacy read alias) | Payment Receipt post/cancel only |
| `dispatchStatus` | NOT_DISPATCHED / PARTIALLY_DISPATCHED / FULLY_DISPATCHED | Store Dispatch post/cancel qty only |

Legacy `status` remains for read compatibility. After S1 writes, it only mirrors document lifecycle (`DRAFT` / `ISSUED` / `CANCELLED`). Remove it in a later phase once all clients filter on the three fields.

## Ownership

- **Payment Receipt** may write `paymentStatus`, `totalReceivedAmount`, `balanceAmount`.
- **Store Dispatch** may write `dispatchStatus` and Store-Dispatch link fields.
- **Sales Invoice lifecycle** may write `documentStatus` (+ legacy `status` compat).
- **SalesDispatch (logistics)** may write `linkedSalesDispatchId/No` only; must not overwrite payment/document/dispatchStatus.

## Migration

```bash
npm --prefix backend run migrate:si-states-s1          # dry-run
npm --prefix backend run migrate:si-states-s1 -- --execute
```

Evidence-driven. SalesDispatch-only invoices are reported as ambiguous and get `dispatchStatus=NOT_DISPATCHED` (no physical Store Dispatch evidence).

## S2 recommendation (not implemented)

Resolve dual SalesDispatch vs StoreDispatch: one physical authority, one logistics document, stop sharing `linkedSalesDispatchId` for both collections.
