# Snapshot & OA API Reference

Base URL: `/api`  
All endpoints require ERP authentication (`Authorization: Bearer <token>`) and company context (`x-company-id` header).

---

## Quotation endpoints (snapshot-related)

### Search quotations for OA

| | |
|---|---|
| **Method** | `GET` |
| **Route** | `/api/quotations/search-for-oa` |
| **Permission** | `SALES` → `view` |

**Purpose:** Filter quotations eligible for New OA → From Quotation.

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `quotationNo` | string | Partial match |
| `customerName` | string | Partial match |
| `customerRef` | string | Customer reference partial match |
| `vertical` | string | Partial match |
| `brand` | string | Maps to `engine` field |
| `model` | string | Partial match |
| `esn` | string | Partial match |
| `status` | string | Exact status; omit for valid statuses (excludes CANCELLED, REJECTED, EXPIRED) |
| `dateFrom` | ISO date | `quotationDate >=` |
| `dateTo` | ISO date | `quotationDate <=` end of day |
| `currency` | string | Partial match |
| `page` | number | Default `1` |
| `limit` | number | Default `50`, max `100` |

**Response `200`:**

```json
{
  "items": [
    {
      "_id": "...",
      "quotationNo": "MAR-QTN-0013",
      "quotationDate": "2026-06-01",
      "customerName": "Acme Corp",
      "customerReference": "PO-123",
      "brand": "Caterpillar",
      "vertical": "Mining",
      "model": "D11",
      "esn": "ESN001",
      "currency": "USD",
      "grandTotal": 15000,
      "status": "APPROVED"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 50
}
```

**Errors:** `401` unauthorized, `403` forbidden, `500` server error.

---

### Get quotation OA working copy

| | |
|---|---|
| **Method** | `GET` |
| **Route** | `/api/quotations/:id/oa-source` |
| **Permission** | `SALES` → `view` |

**Purpose:** Build read-only OA working copy from quotation. **Does not modify quotation.**

**Response `200`:** Working copy object including:

- Header fields (`customerName`, `currency`, `discountType`, etc.)
- `oaSourceType: "FROM_QUOTATION"`
- `sourceQuotationId`, `sourceQuotationNo`
- `_sourceMetadata` — audit snapshot
- `consumptionSummary` — linked OA count + per-line consumption
- `consumptionBaseline` — concurrency baseline for save validation
- `lines[]` — with `quotedQty`, `alreadyOrderedQty`, `remainingQty`, `orderedQty`, etc.

**Errors:**

| Status | Condition |
|--------|-----------|
| `400` | Invalid id; quotation CANCELLED/REJECTED; no lines |
| `404` | Quotation not found |
| `401` / `403` | Auth / permission |

---

### Get quotation consumption

| | |
|---|---|
| **Method** | `GET` |
| **Route** | `/api/quotations/:id/consumption` |
| **Permission** | `SALES` → `view` |

**Purpose:** Dynamic remaining quantity report from linked non-cancelled OAs.

**Response `200`:**

```json
{
  "quotationId": "...",
  "quotationNo": "MAR-QTN-0013",
  "linkedOaCount": 2,
  "lines": [
    {
      "quotationLineId": "...",
      "article": "BEARING",
      "partNumber": "P1",
      "quotedQty": 20,
      "alreadyOrderedQty": 12,
      "remainingQty": 8
    }
  ]
}
```

**Errors:** `400` invalid id, `404` not found.

---

## Order Acknowledgement create (enhanced)

### Create OA

| | |
|---|---|
| **Method** | `POST` |
| **Route** | `/api/sales/order-acknowledgements` |
| **Permission** | `SALES` → `create` |

**Purpose:** Create new OA (blank or from working copy).

**Request body (working copy example):**

```json
{
  "oaSourceType": "FROM_QUOTATION",
  "linkedQuotationId": "<quotation ObjectId>",
  "linkedQuotationNo": "MAR-QTN-0013",
  "_sourceMetadata": {
    "sourceDocumentType": "QUOTATION",
    "sourceDocumentId": "...",
    "sourceDocumentNumber": "MAR-QTN-0013",
    "sourceCreatedBy": "user@example.com",
    "sourceCreatedAt": "2026-01-15T00:00:00.000Z"
  },
  "consumptionBaseline": {
    "linkedOaCount": 1,
    "capturedAt": "2026-06-04T10:00:00.000Z",
    "lineRemaining": { "<lineId>": { "remainingQty": 8, "alreadyOrderedQty": 12 } }
  },
  "allowOverOrder": false,
  "allowStaleConsumption": false,
  "customerName": "Acme Corp",
  "oaDate": "2026-06-04",
  "currency": "USD",
  "discountType": "NONE",
  "discountValue": 0,
  "packingCost": 0,
  "clearanceCost": 0,
  "lines": [
    {
      "includeInOA": true,
      "sourceQuotationLineId": "<line ObjectId>",
      "article": "BEARING",
      "partNumber": "P1",
      "description": "Bearing assembly",
      "uom": "PCS",
      "quotedQty": 20,
      "orderedQty": 8,
      "quotedPrice": 100,
      "orderedPrice": 95
    }
  ]
}
```

**Validation (server):**

- `customerName` required
- Lines: non-negative `orderedQty` / `orderedPrice`; article + description + UOM required for included lines
- Duplicate article+part rejected
- Max 500 lines
- Stale consumption check vs `consumptionBaseline` (unless `allowStaleConsumption: true`)
- Over-order check vs live consumption (unless `allowOverOrder: true`)
- Totals recalculated server-side (`computeTotals`)

**Response `201`:** Created `OrderAcknowledgement` document.

**Errors:**

| Status | Code | Description |
|--------|------|-------------|
| `400` | `VALIDATION` | Missing customer, invalid lines, duplicate lines |
| `400` | `OVER_ORDER` | `violations[]` — ordered qty exceeds remaining |
| `409` | `STALE_CONSUMPTION` | `reasons[]` — consumption changed since form opened |
| `400` | — | Mongoose / business rule message |

---

## Document Snapshot endpoints

### List snapshot routes

| | |
|---|---|
| **Method** | `GET` |
| **Route** | `/api/document-snapshot/routes` |
| **Permission** | `SALES` → `view` |

**Response `200`:**

```json
{
  "routes": [
    { "sourceType": "QUOTATION", "destinationType": "ORDER_ACKNOWLEDGEMENT", "status": "active" },
    { "sourceType": "ORDER_ACKNOWLEDGEMENT", "destinationType": "PROFORMA_INVOICE", "status": "planned" }
  ]
}
```

---

### Get document chain

| | |
|---|---|
| **Method** | `GET` |
| **Route** | `/api/document-snapshot/chain/:documentType/:id` |
| **Permission** | `SALES` → `view` |

**Purpose:** Read-only document links for chain navigation UI.

**`:documentType` aliases:** `quotation`, `oa`, `ORDER_ACKNOWLEDGEMENT`, `PROFORMA_INVOICE`, etc.

**Response `200`:**

```json
{
  "documentLinks": {
    "self": { "documentType": "ORDER_ACKNOWLEDGEMENT", "documentId": "...", "documentNumber": "MAR-OA-0001", "status": "ACTIVE" },
    "source": { "documentType": "QUOTATION", "documentId": "...", "documentNumber": "MAR-QTN-0013" },
    "origin": { "documentType": "QUOTATION", "documentId": "...", "documentNumber": "MAR-QTN-0013" },
    "children": [],
    "chain": []
  }
}
```

**Errors:** `400` invalid type/id, `404` document not found.

---

### Get generic working copy

| | |
|---|---|
| **Method** | `GET` |
| **Route** | `/api/document-snapshot/working-copy/:sourceType/:sourceId/:destinationType` |
| **Permission** | `SALES` → `view` |

**Purpose:** Generic `copyDocument()` API. Currently active for `QUOTATION` → `ORDER_ACKNOWLEDGEMENT` only.

**Example:**

```
GET /api/document-snapshot/working-copy/quotation/<id>/ORDER_ACKNOWLEDGEMENT
```

**Errors:** `400` planned route not implemented; `404` source not found.

---

## Legacy endpoint (unchanged)

| Method | Route | Notes |
|--------|-------|-------|
| `POST` | `/api/sales/convert/quotation/:id/to-oa` | Instant conversion; may update quotation status. Not used by New OA UI. |

---

## Authentication summary

All endpoints use:

1. `requireErpAccess` — JWT + company context + ERP role
2. `requirePermission("SALES", "<action>")` — module permission matrix

Company isolation: all queries scoped to `req.companyId`.
