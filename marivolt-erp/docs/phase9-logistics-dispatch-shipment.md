# Phase 9 — Logistics, Dispatch, Packing List & Shipment Tracking

## Scope Implemented In This Chunk

This chunk connects the existing RTS/Sales Invoice/Sales Dispatch flow to
the Logistics shipment module without deleting historical dispatch or
shipment data.

## Dispatch Lifecycle

`SalesDispatch.status` now supports:

- `DRAFT`
- `READY`
- `DISPATCHED`
- `IN_TRANSIT`
- `DELIVERED`
- `CLOSED` (legacy, retained)
- `CANCELLED`

The existing `DRAFT -> DISPATCHED -> CLOSED` behavior remains supported.
New transitions added through `patchSalesDispatch`:

- `DRAFT -> READY`
- `READY/DRAFT -> DISPATCHED`
- `DISPATCHED -> IN_TRANSIT`
- `DISPATCHED/IN_TRANSIT -> DELIVERED`
- `DISPATCHED/IN_TRANSIT/DELIVERED -> CLOSED`
- non-final statuses -> `CANCELLED`

Each transition writes a Logistics audit event through the existing audit
service.

## Partial Dispatch

`convertSalesInvoiceToSalesDispatch` no longer blocks all follow-up
dispatches for the same Sales Invoice. It calculates already-dispatched
quantities by invoice line/article and allows another dispatch for the
remaining pending quantity.

Request body may include `lines[]` with `sourceLineId`/`article` and
`qty` to dispatch a partial quantity. If omitted, the controller attempts
to dispatch all remaining quantity.

`SalesDispatch` stores:

- `totalQty`
- `dispatchedQty`
- `pendingQty`
- line-level `sourceLineId`, `dispatchedQty`, `pendingQty`

## Packing List

`GET /api/shipments/dispatches/:dispatchId/packing-list` returns a
packing-list projection from the dispatch, linked Sales Invoice, and
linked RTS.

Packing-list fields include:

- Customer
- Invoice No
- RTS No
- Article
- Description
- Qty
- UOM
- Weight
- Dimensions
- Package Count
- Marks & Numbers
- Country of Origin

The Logistics UI adds a `Packing List` print action on each dispatch row.

## Shipment Details

`Shipment` and `SalesDispatch` now support:

- AWB No
- BL No
- Courier
- Shipping Line
- Vessel
- Voyage
- Container No
- ETD
- ETA
- Tracking URL

The existing legacy fields (`vesselOrFlight`, `voyageOrFlightNo`,
`blAwbNo`) are preserved.

## Multi-Package Support

Both `Shipment` and `SalesDispatch` now have a `packages[]` array:

- package no
- package type
- weight
- dimensions
- marks/remarks

The current UI stores shipment-level fields and the backend is ready for
a package editor in the next UI refinement.

## Tracking

Manual tracking statuses:

- `booked`
- `picked_up`
- `customs`
- `in_transit`
- `delivered`

`PATCH /api/shipments/:id/tracking` appends tracking history and mirrors
the status onto the linked dispatch when available.

The Logistics UI exposes quick `Transit` and `Delivered` actions for
shipments and opens `trackingUrl` when provided.

## Logistics Dashboard

`GET /api/shipments/dashboard` returns:

- pending dispatch
- in transit
- delayed shipments
- delivered
- backorders

`src/pages/Logistics.jsx` renders these as dashboard widgets.

## Exports

Implemented in this chunk:

- Packing List print/PDF via browser print.
- Shipment Report CSV export from Logistics.

Remaining follow-up:

- Dispatch Summary CSV/PDF export.
- Dedicated Shipment Report PDF template.

## Files Changed

- `backend/src/models/SalesDispatch.js`
- `backend/src/models/Shipment.js`
- `backend/src/controllers/logisticsController.js`
- `backend/src/controllers/salesFlowController.js`
- `backend/src/routes/logisticsRoutes.js`
- `src/pages/Logistics.jsx`

## Verification Checklist

- RTS approved becomes visible as pending dispatch dashboard count.
- Sales Invoice converts to Sales Dispatch as `READY`.
- A second dispatch can be created for the same invoice if quantity
  remains pending.
- Packing List print opens and includes invoice/RTS/customer/item fields.
- Shipment can be created from a dispatch row.
- Shipment can store AWB/BL/courier/shipping-line/vessel/voyage/container
  and tracking URL.
- `Transit` updates shipment and linked dispatch to in-transit.
- `Delivered` marks shipment and linked dispatch delivered.
- Shipment CSV export downloads current shipment rows.
- Audit Trail records dispatch create/status changes and shipment updates.
