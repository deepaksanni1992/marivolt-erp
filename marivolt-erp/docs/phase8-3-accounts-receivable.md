# Phase 8.3 — Accounts Integration & Customer Receivable Engine

## Scope

Phase 8.3 introduces a persisted customer receivable ledger that records
every AR movement with a running balance. New reports read from Sales
Invoice/payment buckets and the new `CustomerLedger` collection instead
of calculating balances from the legacy customer ledger at page load.

## Customer Ledger

New model: `backend/src/models/CustomerLedger.js`

Movement types:

- `SALES_INVOICE`
- `PAYMENT_RECEIPT`
- `CREDIT_NOTE`
- `DEBIT_NOTE`
- `INVOICE_CANCEL`
- `PAYMENT_CANCEL`
- `OPENING_BALANCE`
- `JOURNAL`

Core fields:

- `companyId`, `customerId`, `customerName`
- `documentType`, `documentId`, `documentNo`
- `movementType`
- `debitAmount`, `creditAmount`, `runningBalance`
- `currency`, `transactionDate`, `remarks`
- `linkedPaymentId`, `linkedInvoiceId`
- `status`, `createdBy`, timestamps

Indexes were added for customer, document number, transaction date,
movement type, linked invoice, and linked payment.

## Receivable Service

New service: `backend/src/services/customerReceivableService.js`

Functions:

- `writeCustomerLedgerEntry`
- `latestCustomerBalance`
- `postSalesInvoiceReceivable`
- `reverseSalesInvoiceReceivable`
- `postPaymentReceiptReceivable`
- `reversePaymentReceiptReceivable`

Running balance is persisted by reading the latest balance for the same
company + customer + currency and appending the new debit/credit. The
service does not aggregate the full ledger for normal writes.

## Posting Rules

Sales Invoice posted:

- Writes `CustomerLedger` movement `SALES_INVOICE`
- Debit = invoice `grandTotal`
- Linked to `linkedInvoiceId`

Payment receipt posted:

- Writes `CustomerLedger` movement `PAYMENT_RECEIPT`
- Credit = allocated amount, falling back to received amount
- Linked to `linkedPaymentId` and, when available, `linkedInvoiceId`

Sales Invoice cancelled:

- Writes `CustomerLedger` movement `INVOICE_CANCEL`
- Credit = original invoice debit
- Links back to the original ledger row

Payment receipt cancelled:

- Writes `CustomerLedger` movement `PAYMENT_CANCEL`
- Debit = original payment credit
- Links back to the original payment ledger row

## API Changes

Accounts routes:

- `GET /api/accounts/customer-ledger`
  - Reads new `CustomerLedger` rows first.
  - Falls back to legacy `CustomerLedgerEntry` rows for historical data.

- `GET /api/accounts/customer-statement`
  - Query filters: `customerName`, `customerId`, `fromDate`, `toDate`, `currency`
  - Returns persisted ledger rows with `closingBalance`.

- `GET /api/accounts/outstanding`
  - Now uses Sales Invoices and payment allocations.
  - Returns customer, invoice total, received, balance, overdue,
    latest payment date, and ageing bucket.

- `GET /api/accounts/aging`
  - Now uses Sales Invoice due dates.
  - Buckets: `Current`, `0-30`, `31-60`, `61-90`, `90+`.

Payment routes:

- `GET /api/payment-receipts/by-sales-invoice/:salesInvoiceId`
  - Supports Sales Invoice payment history and attachment drilldown.

## UI Changes

Accounts:

- New tab: `Customer Statement`
- Filters: customer, from date, to date, currency
- Columns: date, document no, movement type, debit, credit, running
  balance, remarks
- Actions: invoice drilldown, payment drilldown, attachment preview
- Exports: CSV and print/PDF via browser print

Outstanding Report:

- Columns now match Phase 8.3: customer, total invoice, received,
  balance, overdue, latest payment date, ageing bucket, invoice no.

Ageing Report:

- Renamed `Not Due` to `Current`.
- Uses Sales Invoice due date buckets.

Sales Invoice detail:

- Shows invoice amount, received amount, outstanding amount, payment
  status, ageing bucket, and payment history.
- Payment history includes receipt no, date, amount, mode, reference,
  status, and attachment preview.

## Safety Rules

- Posted Sales Invoices cannot be deleted from Accounts. Users must
  cancel/reverse instead.
- Posted customer ledger rows linked to a source document cannot be
  deleted. Users must post a reversing entry instead.
- Payment receipts already use cancellation/reversal rather than delete.

## Compatibility Notes

The legacy `CustomerLedgerEntry` collection is not deleted. The
`/accounts/customer-ledger` endpoint reads the new `CustomerLedger`
first and falls back to legacy rows when no new rows exist for the
customer. This preserves historical views while all new financial
movements write to the unified ledger.

## Verification Checklist

- Create/post Sales Invoice: `CustomerLedger` gets `SALES_INVOICE`
  debit and running balance increases.
- Partial payment: `PAYMENT_RECEIPT` credit is written and running
  balance decreases.
- Full payment: invoice balance reaches zero and payment status becomes
  `PAID`.
- Payment cancellation: `PAYMENT_CANCEL` debit is written and running
  balance restores.
- Invoice cancellation after reversing payments: `INVOICE_CANCEL`
  credit is written and running balance reverses invoice receivable.
- Customer Statement filters by customer/date/currency and prints/exports
  the persisted running balance.
- Outstanding Report shows Sales Invoice balance, overdue flag, latest
  payment date, and ageing bucket.
- Ageing Report totals outstanding invoices into Current/0-30/31-60/
  61-90/90+ buckets.
- Sales Invoice detail shows payment history and slip preview.
