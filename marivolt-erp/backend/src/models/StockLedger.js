import mongoose from "mongoose";

/**
 * Legacy `transactionType` enum. Kept as-is so historical rows continue
 * to validate. New writes through `services/stockService.js` populate
 * the broader `movementType` field with the unified vocabulary.
 */
const TX_TYPES = [
  "OPENING",
  "GRN",
  "SALES_ALLOCATION",
  "SALES_INVOICE",
  "SALES_INVOICE_CANCEL",
  "ORDER_ALLOCATION_CANCEL",
  "STOCK_ADJUSTMENT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "PACKED",
  "UNPACKED",
  "DISPATCH_OUT",
  "DISPATCH_CANCEL",
];

/**
 * Unified Phase-3 vocabulary. We accept this set on the new
 * `movementType` field. Historical entries may have it null.
 */
const UNIFIED_MOVEMENT_TYPES = [
  "GRN_IN",
  "LANDED_COST_ADJUSTMENT",
  "KIT_ASSEMBLY_OUT",
  "KIT_ASSEMBLY_IN",
  "DEKIT_OUT",
  "DEKIT_IN",
  "ALLOCATION",
  "ALLOCATION_CANCEL",
  "SALES_INVOICE_OUT",
  "SALES_INVOICE_CANCEL",
  "STOCK_TRANSFER_OUT",
  "STOCK_TRANSFER_IN",
  "STOCK_ADJUSTMENT",
  "OPENING_BALANCE",
  "PACKED",
  "UNPACKED",
  "DISPATCH_OUT",
  "DISPATCH_CANCEL",
  "ARTICLE_CONVERSION_OUT",
  "ARTICLE_CONVERSION_IN",
  "ARTICLE_CONVERSION_REVERSAL_OUT",
  "ARTICLE_CONVERSION_REVERSAL_IN",
];

const stockLedgerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    transactionDate: { type: Date, required: true },
    transactionType: { type: String, enum: TX_TYPES, required: true },
    referenceType: { type: String, default: "", trim: true },
    referenceNo: { type: String, default: "", trim: true },
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    location: { type: String, default: "", trim: true, uppercase: true },
    batchNo: { type: String, default: "", trim: true },
    serialNo: { type: String, default: "", trim: true },
    qtyIn: { type: Number, default: 0, min: 0 },
    qtyOut: { type: Number, default: 0, min: 0 },
    balanceQty: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0, min: 0 },
    oldCost: { type: Number, default: null },
    newCost: { type: Number, default: null },
    valuationDelta: { type: Number, default: null },
    allocationId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    remarks: { type: String, default: "", trim: true },
    createdBy: { type: String, default: "", trim: true },

    /* ---------- Phase-3 unified projection fields ----------
     * All optional (default null) so historical rows continue
     * to validate. Populated on new writes via stockService.
     */
    movementType: {
      type: String,
      enum: [...UNIFIED_MOVEMENT_TYPES, null],
      default: null,
    },
    sourceModule: { type: String, default: "", trim: true },
    warehouse: { type: String, default: "", trim: true, uppercase: true },
    locationFrom: { type: String, default: "", trim: true, uppercase: true },
    locationTo: { type: String, default: "", trim: true, uppercase: true },
    customerName: { type: String, default: "", trim: true },
    supplierName: { type: String, default: "", trim: true },
    onHandAfter: { type: Number, default: null },
    allocatedAfter: { type: Number, default: null },
    /** Qty in posted Store Packing (not yet dispatched). */
    packedAfter: { type: Number, default: null },
    /** Cumulative qty dispatched through Store Dispatch. */
    dispatchedAfter: { type: Number, default: null },
    availableAfter: { type: Number, default: null },
    isNegativeAllocation: { type: Boolean, default: false },

    /* ---------- P0.5A Packing source-effect identity (additive) ----------
     * Legacy rows leave these null/empty so they do not collide with the
     * partial unique index on effectKey.
     */
    sourceDocumentType: { type: String, default: "", trim: true },
    sourceDocumentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    sourceLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceAllocationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceAllocationLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** P0.5B — Dispatch source lineage (additive; packing leaves these null). */
    sourcePackingId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourcePackingLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceSalesInvoiceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceSalesInvoiceLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    postingOperationId: { type: String, default: "", trim: true },
    cancellationOperationId: { type: String, default: "", trim: true },
    effectKey: { type: String, default: "", trim: true },
    originalEffectKey: { type: String, default: "", trim: true },
    reversedFromLedgerId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

stockLedgerSchema.index({ companyId: 1, transactionDate: -1, article: 1 });
stockLedgerSchema.index({ companyId: 1, referenceNo: 1, transactionType: 1 });
stockLedgerSchema.index({ companyId: 1, movementType: 1, createdAt: -1 });
stockLedgerSchema.index({ companyId: 1, customerName: 1, createdAt: -1 });
stockLedgerSchema.index({ companyId: 1, article: 1, warehouse: 1, location: 1, transactionDate: -1 });
stockLedgerSchema.index({ companyId: 1, warehouse: 1, location: 1, transactionDate: -1 });
stockLedgerSchema.index({ companyId: 1, referenceNo: 1, createdAt: -1 });
/**
 * P0.5A/P0.5B — one stock effect per deterministic effectKey (Packing + Dispatch).
 * Name retains packing prefix; filter is generic for every non-empty effectKey.
 * Created by scripts/migrate-packing-ledger-effect-unique-index.mjs;
 * verified for Dispatch by scripts/migrate-dispatch-ledger-effect-unique-index.mjs.
 */
stockLedgerSchema.index(
  { effectKey: 1 },
  {
    name: "uniq_stockledger_packing_effect_key",
    unique: true,
    partialFilterExpression: { effectKey: { $type: "string", $gt: "" } },
  }
);

export { TX_TYPES, UNIFIED_MOVEMENT_TYPES };
export default mongoose.model("StockLedger", stockLedgerSchema);
