import mongoose from "mongoose";

/**
 * Legacy movement-type vocabulary. We keep the existing values and
 * additively allow the unified Phase-3 vocabulary so callers can use
 * either without breaking historical writes/reads.
 */
const LEGACY_MOVEMENT_TYPES = [
  "IN_PURCHASE",
  "OUT_SALE",
  "ADJUSTMENT",
  "IN_RETURN",
  "OUT_RETURN",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "OPENING",
  "KIT_COMPONENT_OUT",
  "KIT_PARENT_IN",
  "DEKIT_PARENT_OUT",
  "DEKIT_COMPONENT_IN",
  "SALES_RESERVE",
  "SALES_RESERVE_RELEASE",
  "SALES_RESERVED_TO_RTS",
  "SALES_RTS_TO_RESERVED",
  "SALES_INVOICE_OUT",
  "SALES_INVOICE_CANCEL_RESTORE",
];

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

const ALL_MOVEMENT_TYPES = [...new Set([...LEGACY_MOVEMENT_TYPES, ...UNIFIED_MOVEMENT_TYPES])];

const inventoryLedgerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    itemCode: { type: String, required: true, trim: true, uppercase: true },
    warehouse: { type: String, required: true, trim: true, default: "MAIN" },
    movementType: { type: String, enum: ALL_MOVEMENT_TYPES, required: true },
    qtyDelta: { type: Number, required: true },
    referenceType: { type: String, default: "" },
    referenceId: { type: String, default: "" },
    referenceNumber: { type: String, default: "" },
    unitCost: { type: Number, default: 0 },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },

    /* ---------- Phase-3 unified projection fields ----------
     * All optional (default null/empty) so historical rows
     * continue to validate. Populated on new writes via the
     * salesStockService writeLedger helper or stockService.
     */
    sourceModule: { type: String, default: "", trim: true },
    referenceNo: { type: String, default: "", trim: true },
    customerName: { type: String, default: "", trim: true },
    supplierName: { type: String, default: "", trim: true },
    locationFrom: { type: String, default: "", trim: true, uppercase: true },
    locationTo: { type: String, default: "", trim: true, uppercase: true },
    qtyIn: { type: Number, default: null },
    qtyOut: { type: Number, default: null },
    onHandAfter: { type: Number, default: null },
    allocatedAfter: { type: Number, default: null },
    rtsAfter: { type: Number, default: null },
    availableAfter: { type: Number, default: null },
    isNegativeAllocation: { type: Boolean, default: false },
  },
  { timestamps: true }
);

inventoryLedgerSchema.index({ companyId: 1, itemCode: 1, warehouse: 1, createdAt: -1 });
inventoryLedgerSchema.index({ companyId: 1, referenceType: 1, referenceId: 1 });
inventoryLedgerSchema.index({ companyId: 1, movementType: 1, createdAt: -1 });
inventoryLedgerSchema.index({ companyId: 1, customerName: 1, createdAt: -1 });

export { LEGACY_MOVEMENT_TYPES, UNIFIED_MOVEMENT_TYPES, ALL_MOVEMENT_TYPES };
export default mongoose.model("InventoryLedger", inventoryLedgerSchema);
