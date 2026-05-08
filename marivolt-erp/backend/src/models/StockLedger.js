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
  "RTS",
  "SALES_INVOICE",
  "SALES_INVOICE_CANCEL",
  "RTS_CANCEL",
  "ORDER_ALLOCATION_CANCEL",
  "STOCK_ADJUSTMENT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
];

/**
 * Unified Phase-3 vocabulary. We accept this set on the new
 * `movementType` field. Historical entries may have it null.
 */
const UNIFIED_MOVEMENT_TYPES = [
  "GRN_IN",
  "ALLOCATION",
  "ALLOCATION_CANCEL",
  "RTS_TRANSFER",
  "RTS_CANCEL",
  "SALES_INVOICE_OUT",
  "SALES_INVOICE_CANCEL",
  "STOCK_TRANSFER_OUT",
  "STOCK_TRANSFER_IN",
  "STOCK_ADJUSTMENT",
  "OPENING_BALANCE",
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
    rtsAfter: { type: Number, default: null },
    availableAfter: { type: Number, default: null },
    isNegativeAllocation: { type: Boolean, default: false },
  },
  { timestamps: true }
);

stockLedgerSchema.index({ companyId: 1, transactionDate: -1, article: 1 });
stockLedgerSchema.index({ companyId: 1, referenceNo: 1, transactionType: 1 });
stockLedgerSchema.index({ companyId: 1, movementType: 1, createdAt: -1 });
stockLedgerSchema.index({ companyId: 1, customerName: 1, createdAt: -1 });

export { TX_TYPES, UNIFIED_MOVEMENT_TYPES };
export default mongoose.model("StockLedger", stockLedgerSchema);
