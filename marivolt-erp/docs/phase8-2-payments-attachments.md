# Phase 8.2 — Payment Buckets, Partial Payments & S3 Attachments

This phase formalises the payment lifecycle on top of the existing
`PaymentReceipt` infrastructure that was wired up in earlier phases. It
makes Sales Invoices first-class for payment tracking, adds an
overpayment guard, and surfaces a richer payments UI.

## 1. Data model

### `PaymentReceipt` (already existed)

Fields aligned to the Phase-8.2 spec:

- `companyId`, `customerId`, `customerName`
- `sourceType` (`PROFORMA_INVOICE`, `SALES_INVOICE`, `ADVANCE_PAYMENT`, `MULTIPLE_INVOICE`)
- `proformaInvoiceId/No`, `salesInvoiceId/No`
- `amountReceived`, `allocatedAmount`, `unallocatedAmount`, `currency`
- `paymentMode` (`BANK_TRANSFER`, `CASH`, `CHEQUE`, `CARD`, `OTHER`)
- `bankCashAccountId/Name`, `paymentReference`, `remarks`
- `attachmentBucket`, `attachmentKey`, `attachmentOriginalName`,
  `attachmentMimeType`, `attachmentSize`, `attachmentUploadedAt`
- `allocations[]` — per-document allocations with `targetType`,
  `targetId`, `targetNo`, `invoiceTotal`, `allocatedAmount`
- `status` (`POSTED`, `PARTIALLY_ALLOCATED`, `FULLY_ALLOCATED`,
  `CANCELLED`)
- `journalEntryId`, `linkedCustomerLedgerEntryId`,
  `linkedCashBankEntryId`, `linkedReverseCustomerLedgerEntryId`,
  `linkedReverseCashBankEntryId`
- `createdBy`, `cancelledAt/By/Reason`

### `ProformaInvoice` (already had buckets)

`totalReceivedAmount`, `balanceAmount`, `paymentStatus`
(`UNPAID/PARTIALLY_PAID/PAID`).

### `SalesInvoice` (Phase-8.2 — new persisted buckets)

```
totalReceivedAmount: Number
balanceAmount: Number
paymentStatus: "UNPAID" | "PARTIAL" | "PAID"
```

Index: `{ companyId, paymentStatus, invoiceDate: -1 }`.

## 2. Partial payment logic

Across all non-cancelled `PaymentReceipt` rows, sum
`allocations[].allocatedAmount` for each target document:

```
receivedAmount = sum(allocations.allocatedAmount where status != CANCELLED
                     and target == this document)
balanceAmount  = max(0, grandTotal - receivedAmount)
```

The recalculation runs after every receipt **create** and **cancel**:

- `recalcProformaPaymentState(req, proformaId)` — Proforma side.
- `recalcSalesInvoicePaymentState(req, salesInvoiceId)` — Sales-Invoice
  side. Rewritten in Phase-8.2 to also persist
  `totalReceivedAmount`, `balanceAmount`, `paymentStatus`.

## 3. Payment status engine

| Received vs Total      | `paymentStatus` |
| ---------------------- | --------------- |
| 0                      | `UNPAID`        |
| 0 < received < total   | `PARTIAL`       |
| received >= total > 0  | `PAID`          |

Document `status` continues to follow the lifecycle defined by
`docLifecycle.js` (e.g. SI: `ISSUED → PARTIALLY_PAID → PAID`).
`paymentStatus` and `status` are independent fields so reports can use
the canonical bucket without coupling to lifecycle states.

## 4. S3 attachments

S3 upload is delegated to `services/awsS3.js`
(`uploadFileToS3`, `getSignedFileUrl`, `buildDatedS3Key`). Already
operational. Attachment metadata persisted on the receipt:
`attachmentBucket`, `attachmentKey`, `attachmentOriginalName`,
`attachmentMimeType`, `attachmentSize`, `attachmentUploadedAt`.

The frontend can request a fresh **signed URL** at any time via
`GET /api/payment-receipts/:id/attachment-url?inline=1` (preview) or
without `inline` (download). Each request now writes an
`ATTACHMENT/preview|download` audit row.

Allowed MIME types: `application/pdf`, `image/jpeg`, `image/png`. Max
size: 5 MB.

## 5. Posting flow (unchanged but now also enriches SI)

1. Validate body (date, amount, mode, account, file).
2. Determine `sourceType`, gather `allocations[]`.
3. Run **per-document overpayment guard** (Phase-8.2 — see § 7).
4. Create `PaymentReceipt`.
5. Create `JournalEntry` (Cash/Bank Dr; AR Cr; Customer Advance Cr if
   unallocated).
6. Create `CustomerLedgerEntry` (credit) and `CashBankEntry` (debit).
7. **Recalc** linked PI and SI buckets — writes
   `totalReceivedAmount`, `balanceAmount`, `paymentStatus` and updates
   document `status` for non-cancelled invoices.
8. `writeAudit({action: "PAYMENT", ...})` plus a separate
   `ATTACHMENT/upload` audit row when a slip was attached.

## 6. Cancellation

`PATCH /api/payment-receipts/:id/cancel` keeps the original receipt
row, sets `status = CANCELLED`, and records:

- Reverse `CustomerLedgerEntry` (debit) and `CashBankEntry` (credit).
- Reversal `JournalEntry` (`reversedFromEntryId`).
- Recalc PI + SI buckets — `paymentStatus` rolls back to `PARTIAL`/
  `UNPAID` and `balanceAmount` increases.
- Audit row `action=PAYMENT, fromStatus=POSTED→toStatus=CANCELLED`.

## 7. Overpayment guard (new in Phase-8.2)

For every entry in `allocations[]` we sum existing non-cancelled
allocations targeting the same document and reject when the projected
total would exceed the document `grandTotal` (with a tiny ε):

```
HTTP 409
{
  "code": "OVERPAYMENT",
  "message": "Overpayment detected for ...",
  "details": [{ targetType, targetNo, invoiceTotal, existing,
                attempted, wouldBecome, overBy }]
}
```

Bypass paths (any of these allows the receipt to be created):

- `req.body.allowOverpayment === true` (explicit confirm-and-continue
  from the UI dialog).
- `req.body.adminOverride === true` (existing admin override).
- The caller has an admin role allowed to override amounts.

The Sales UI catches `code === "OVERPAYMENT"`, shows a
`window.confirm` listing each over-paid document, and re-submits with
`allowOverpayment=true` if the user confirms. The admin override path
remains available on the dialog.

Audit metadata records `allowedOverpayment: true|false` for every
payment so reviewers can find them.

## 8. UI

### Sales > Sales Invoice list (Phase-8.2)

New columns: `Payment` (badge — UNPAID / PARTIAL / PAID), `Received`,
`Balance`. The `Receive Payment` button is disabled when
`paymentStatus === "PAID"` and pre-fills the dialog with the current
`balanceAmount`.

### Accounts > Payment Receipts (Phase-8.2)

- New `Export CSV` button on the filter bar.
- Status pill replaced with the standard ERP badge.
- New `Preview` and `Download` actions for the S3 attachment (signed
  URLs); each click writes an `ATTACHMENT` audit row.

### Sales > Proforma Invoices

Existing `Receive Payment` flow unchanged; both PI and SI now share the
same overpayment confirm-and-continue handler.

## 9. Accounting integration

Unchanged from earlier phases; documented here for reference:

- `JournalEntry` lines: Cash/Bank Dr, AR Cr (allocated portion),
  Customer Advance Cr (unallocated portion).
- `CustomerLedgerEntry` credits the customer when posted, debits on
  cancel.
- `CashBankEntry` reflects cash/bank movement.
- All four are written inside the same handler so the AR view stays in
  lock-step with the receipt list.

## 10. Audit events emitted

- `PAYMENT / POSTED` — receipt created.
- `PAYMENT / CANCELLED` — receipt cancelled.
- `ATTACHMENT / upload` — slip uploaded with the receipt.
- `ATTACHMENT / preview` — signed URL fetched for inline view.
- `ATTACHMENT / download` — signed URL fetched for download.

All carry `documentNo = receiptNo` so the per-document audit-trail page
shows the full lifecycle.

## 11. Files changed

- `backend/src/models/SalesInvoice.js` — new payment buckets + index.
- `backend/src/controllers/paymentReceiptController.js` —
  `recalcSalesInvoicePaymentState` writes buckets;
  `createPaymentReceipt` adds overpayment guard +
  attachment-upload audit;
  `getPaymentReceiptAttachmentUrl` writes preview/download audit.
- `backend/src/controllers/salesFlowController.js` —
  `listSalesInvoices` and `getSalesInvoice` enrich with live payment
  buckets; new `paymentStatus` filter param.
- `src/pages/Accounts.jsx` — CSV export hook for Payment Receipts;
  `onDownloadSlip` wired through.
- `src/components/accounts/PaymentReceiptsTab.jsx` — Status badge,
  Preview / Download buttons, Export CSV.
- `src/pages/Sales.jsx` — SI list payment columns, overpayment
  confirm-and-continue, balance pre-fill, badge palette includes
  `UNPAID`/`PARTIAL`.
- `src/lib/api.js` — already preserves `err.code` / `err.details`
  (Phase-8.1).

## 12. Verification checklist

| # | Scenario                                         | Expected                                         |
| - | ------------------------------------------------ | ------------------------------------------------ |
| 1 | Single full payment vs PI                        | PI `paymentStatus = PAID`, balance = 0           |
| 2 | Single full payment vs SI                        | SI `paymentStatus = PAID`, balance = 0           |
| 3 | Two partial payments vs SI                       | SI `paymentStatus = PARTIAL` then `PAID`         |
| 4 | Cancel last payment                              | SI `paymentStatus` rolls back; AR re-opens       |
| 5 | Overpayment without `allowOverpayment`           | 409 `code=OVERPAYMENT` returned                  |
| 6 | Overpayment with confirm dialog → resend         | Receipt posts; audit `allowedOverpayment=true`   |
| 7 | Upload slip on payment                           | `attachmentKey` saved; `ATTACHMENT/upload` audit |
| 8 | Preview slip                                     | Signed URL opens; `ATTACHMENT/preview` audit     |
| 9 | Download slip                                    | Signed URL downloads; `ATTACHMENT/download` audit|
| 10 | Customer ledger after payment                   | Credit posted; balance reduced                   |
| 11 | Customer ledger after cancellation              | Reverse debit posted; balance restored           |
| 12 | CSV export of Payment Receipts                  | Includes mode, ref, status, has-attachment       |
