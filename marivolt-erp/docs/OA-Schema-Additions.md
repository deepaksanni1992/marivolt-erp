# OA Schema Additions

Additive fields introduced for the Enterprise Document Snapshot Engine and enhanced OA workflow.

**No migration required.** Existing documents without these fields continue to work with schema defaults.

---

## Order Acknowledgement — header fields

### `oaSourceType`

| | |
|---|---|
| **Purpose** | How the OA was created (manual vs quotation snapshot) |
| **Type** | `String` enum: `BLANK`, `FROM_QUOTATION` |
| **Required** | No |
| **Default** | `BLANK` |
| **Backward compatibility** | Old OAs behave as `BLANK` |

### `attention`

| | |
|---|---|
| **Purpose** | Attention / contact line copied from quotation |
| **Type** | `String` |
| **Required** | No |
| **Default** | `""` |
| **Backward compatibility** | Empty on old records |

### `discountType`

| | |
|---|---|
| **Purpose** | Header discount calculation type (aligned with quotation) |
| **Type** | `String` enum: `NONE`, `PERCENT`, `FLAT` |
| **Required** | No |
| **Default** | `NONE` |
| **Backward compatibility** | Existing `discountTotal` still used |

### `discountValue`

| | |
|---|---|
| **Purpose** | Percent or flat discount input value |
| **Type** | `Number` |
| **Required** | No |
| **Default** | `0` |
| **Backward compatibility** | Ignored when `discountType` is `NONE` |

### `sourceDocumentType`

| | |
|---|---|
| **Purpose** | Canonical type of document copied from (audit) |
| **Type** | `String` (e.g. `QUOTATION`) |
| **Required** | No |
| **Default** | `""` |
| **Backward compatibility** | Absent on old OAs; UI falls back to `linkedQuotationNo` |

### `sourceDocumentId`

| | |
|---|---|
| **Purpose** | ObjectId of source document |
| **Type** | `ObjectId` |
| **Required** | No |
| **Default** | `null` |
| **Backward compatibility** | Use `linkedQuotationId` for old quotation-linked OAs |

### `sourceDocumentNumber`

| | |
|---|---|
| **Purpose** | Human-readable source document number (e.g. `MAR-QTN-0013`) |
| **Type** | `String` |
| **Required** | No |
| **Default** | `""` |
| **Backward compatibility** | Mirrors `linkedQuotationNo` when from quotation |

### `sourceDocumentRevision`

| | |
|---|---|
| **Purpose** | Source document revision at copy time |
| **Type** | `Number` |
| **Required** | No |
| **Default** | `null` (treated as `1` when built from quotation) |
| **Backward compatibility** | N/A for old records |

### `sourceCreatedBy`

| | |
|---|---|
| **Purpose** | Original source document creator email |
| **Type** | `String` |
| **Required** | No |
| **Default** | `""` |
| **Backward compatibility** | N/A on old records |

### `sourceCreatedAt`

| | |
|---|---|
| **Purpose** | Original source document creation timestamp |
| **Type** | `Date` |
| **Required** | No |
| **Default** | `null` |
| **Backward compatibility** | N/A on old records |

### `copiedBy`

| | |
|---|---|
| **Purpose** | User who created this snapshot OA |
| **Type** | `String` |
| **Required** | No |
| **Default** | `""` |
| **Backward compatibility** | Use `createdBy` on old records |

### `copiedAt`

| | |
|---|---|
| **Purpose** | When snapshot OA was created from source |
| **Type** | `Date` |
| **Required** | No |
| **Default** | `null` |
| **Backward compatibility** | Use `createdAt` on old records |

### Existing fields (unchanged, still used)

| Field | Purpose |
|-------|---------|
| `linkedQuotationId` | Reference to source quotation |
| `linkedQuotationNo` | Quotation number for display / reports |
| `createdBy` / `updatedBy` | Standard audit |
| `createdAt` / `updatedAt` | Mongoose timestamps |

---

## Order Acknowledgement — line fields

Downstream flows (PI, allocation, packing, invoice) continue to use **`qty`** and **`price`** as the ordered values.

### `sourceQuotationLineId`

| | |
|---|---|
| **Purpose** | Link to quotation line for consumption tracking |
| **Type** | `ObjectId` |
| **Required** | No |
| **Default** | `null` |
| **Backward compatibility** | Consumption falls back to article+part match |

### `quotedQty`

| | |
|---|---|
| **Purpose** | Original quotation quantity (reference only) |
| **Type** | `Number` |
| **Required** | No |
| **Default** | `null` |
| **Backward compatibility** | Absent on old lines |

### `orderedQty`

| | |
|---|---|
| **Purpose** | OA ordered quantity snapshot; mirrors `qty` on save |
| **Type** | `Number` |
| **Required** | No |
| **Default** | `null` |
| **Backward compatibility** | Use `qty` when null |

### `quotedPrice`

| | |
|---|---|
| **Purpose** | Original quotation unit price (reference only) |
| **Type** | `Number` |
| **Required** | No |
| **Default** | `null` |
| **Backward compatibility** | Absent on old lines |

### `orderedPrice`

| | |
|---|---|
| **Purpose** | OA ordered price snapshot; mirrors `price` on save |
| **Type** | `Number` |
| **Required** | No |
| **Default** | `null` |
| **Backward compatibility** | Use `price` when null |

### `lineDiscount`

| | |
|---|---|
| **Purpose** | Line-level discount amount/percent storage |
| **Type** | `Number` |
| **Required** | No |
| **Default** | `0` |
| **Backward compatibility** | Safe default |

### `lineTax`

| | |
|---|---|
| **Purpose** | Line-level tax reference |
| **Type** | `Number` |
| **Required** | No |
| **Default** | `0` |
| **Backward compatibility** | Safe default |

### `includeInOA`

| | |
|---|---|
| **Purpose** | Whether line is included in OA totals (working copy concept; persisted lines are included only) |
| **Type** | `Boolean` |
| **Required** | No |
| **Default** | `true` |
| **Backward compatibility** | All old lines treated as included |

### `supplierInfo`

| | |
|---|---|
| **Purpose** | Optional supplier reference on line |
| **Type** | `String` |
| **Required** | No |
| **Default** | `""` |
| **Backward compatibility** | Empty on old lines |

---

## Working-copy payload fields (not persisted)

These appear in API requests/responses only:

| Field | Purpose |
|-------|---------|
| `consumptionBaseline` | Concurrency snapshot at form open |
| `consumptionSummary` | UI display of linked OA count + line consumption |
| `_sourceMetadata` | Echoed metadata for persist |
| `allowOverOrder` | Override over-order validation |
| `allowStaleConsumption` | Override stale consumption validation |

---

## Quotation model

**No schema changes.** Consumption is computed dynamically from linked OAs at read time.
