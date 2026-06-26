# Future Enhancements

Recommended improvements for the Document Snapshot Engine and Sales module.  
**Not implemented** — documentation only.

---

## Document chain & navigation

### Document timeline UI

Visual breadcrumb/timeline in OA, PI, and Invoice detail views using `GET /document-snapshot/chain/:type/:id`.

```mermaid
flowchart LR
  QTN[Quotation] --> OA[OA] --> PI[PI] --> ALC[Allocation] --> PKG[Packing] --> SI[Invoice]
```

### Revision history

Track document revisions (`sourceDocumentRevision`, diff between versions) when quotations or OAs are amended.

---

## Snapshot engine expansion

Implement planned registry routes using the same `copyDocument()` pattern:

| Flow | Priority |
|------|----------|
| OA → Proforma Invoice | High |
| Proforma → Order Allocation | High |
| Allocation → Store Packing | Medium |
| Packing → Sales Invoice | Medium |
| Sales Invoice → Sales Return | Medium |

### Version control

Immutable snapshot versions when a working copy is saved as draft, then finalized.

---

## Partial order & logistics

### Split shipments

One OA → multiple packing/dispatch records with qty allocation per shipment.

### Split invoices

Invoice partial quantities against packing lines with running balance.

### Multiple PI from one OA

Several proforma invoices linked to a single OA (milestone billing).

---

## Customer & approval

### Customer portal

Customers view quotation, submit partial PO quantities, and track OA/PI status.

### Approval workflow

OA from quotation above threshold requires manager approval before `ACTIVE` status.

### Digital signature

OA PDF with e-sign integration for customer acknowledgement.

---

## Audit & reporting

### Audit dashboard

Dedicated view for snapshot metadata: source type, copied by/at, consumption history per quotation.

### Quotation fulfilment report

Per quotation line: quoted vs ordered vs shipped vs invoiced quantities.

---

## Performance

### Search optimization

Text index on `quotationNo`, `customerName` for 10k+ quotation datasets.

### Consumption cache

Short-lived cache of consumption per quotation (invalidate on OA create/cancel).

---

## Integration

### ERP-wide snapshot metadata

Apply `documentSourceMetadataFields` to PI, Allocation, Packing, Invoice models as those flows migrate to the snapshot engine.

### Webhook events

`oa.created.from_quotation` event for external systems (accounting, CRM).

---

## Related

- [Enterprise Document Snapshot Engine](./Enterprise-Document-Snapshot-Engine.md)
- [OA Workflow](./OA-Workflow.md)
