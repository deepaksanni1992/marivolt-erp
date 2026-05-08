# Phase 9.2 — Advanced Logistics & Commercial Shipping Controls

## Scope

This chunk extends the Phase 9 shipment layer with commercial document
controls, shipment costing, container management, delivery status safety,
delay monitoring, customer tracking projections, and logistics reports.

## Commercial Invoice / Packing List Link

Dispatch rows already link to Sales Invoice and RTS. Phase 9.2 keeps
that link and adds document status tracking on `Shipment.exportDocuments`
for:

- `COMMERCIAL_INVOICE`
- `PACKING_LIST`
- `COO`
- `WEIGHT_LIST`
- `CONTAINER_LOAD_PLAN`
- `EXPORT_CHECKLIST`

Each document tracks `PENDING`, `GENERATED`, or `UPLOADED`.

## Container Management

New model: `ShipmentContainer`

Fields:

- `containerNo`
- `containerType`
- `sealNo`
- `grossWeight`
- `netWeight`
- `cbm`
- `packageCount`
- `invoices[]`

This prepares the system for multiple invoices/packages per container.

## Shipment Costing

`Shipment` now tracks both top-level cost buckets and detailed
`expenses[]`:

- freight
- customs
- trucking
- handling
- courier
- insurance

## Delivery Status Engine

`Shipment.status` supports:

- `READY`
- `BOOKED`
- `PICKED_UP`
- `CUSTOMS_CLEARANCE`
- `IN_TRANSIT`
- `ARRIVED`
- `DELIVERED`
- `CLOSED`

Legacy `PLANNED` and `CANCELLED` remain for compatibility.

## ETA Monitoring

New fields:

- `plannedEta`
- `actualEta`
- `delayedDays`

Dashboard delay count and delay report use `plannedEta` and current date
unless the shipment is delivered/closed/cancelled.

## Customer Tracking API

`GET /api/shipments/customer-tracking/:ref`

Searches by shipment ref, AWB, BL, or legacy BL/AWB and returns a safe
customer-facing projection:

- shipment status
- tracking status
- AWB / BL
- ETA / actual ETA
- delayed days
- tracking URL
- linked dispatch/invoice numbers
- export document statuses
- tracking updates

## Dispatch Safety Rules

Implemented:

- Delivered/closed shipments cannot be edited.
- Delivered shipments may only be moved to `CLOSED`.
- Duplicate shipment close is blocked.
- Deleting a shipment now uses a controlled `CANCELLED` status instead
  of hard delete, and delivered/closed shipments cannot be deleted.

Existing Phase 9 partial-dispatch validation ensures a new dispatch only
uses pending Sales Invoice quantity. The full RTS quantity guard remains
the next refinement because the current dispatch document is invoice-led
and RTS is linked through invoice/reference data.

## Reports

New endpoints:

- `GET /api/shipments/reports/shipment-summary`
- `GET /api/shipments/reports/delivery-delay`
- `GET /api/shipments/reports/container-utilization`
- `GET /api/shipments/reports/pending-dispatch`

## UI

`Logistics.jsx` now includes:

- shipment status/customer/AWB/BL/delayed filters
- status badges
- delayed-day indicators
- status timeline hint
- shipment and dispatch CSV exports
- commercial cost fields
- export document status controls

## Verification Checklist

- Create shipment linked to dispatch and Sales Invoice.
- Add AWB/BL, ETA, planned ETA, and tracking URL.
- Mark shipment in transit, then delivered.
- Attempt to edit delivered shipment: should be blocked unless closing.
- Attempt duplicate close: should be blocked.
- Mark export documents generated/uploaded.
- Create container linked to shipment with multiple invoice references.
- Confirm delayed shipments appear on dashboard and delay report.
- Confirm customer tracking endpoint returns safe status/ETA/docs.
- Export shipment and dispatch CSV from Logistics page.
