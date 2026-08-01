import mongoose from "mongoose";
import {
  ACTIVE_ALLOCATION_OA_INDEX,
  ACTIVE_ALLOCATION_PI_INDEX,
  activeAllocationPartialFilter,
} from "../utils/allocationUniqueness.js";

const orderAllocationLineSchema = new mongoose.Schema(
  {
    serialNo: { type: Number, default: 0, min: 0 },
    article: { type: String, required: true, trim: true, uppercase: true },
    partNumber: { type: String, default: "", trim: true },
    description: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0.0001 },
    uom: { type: String, default: "PCS", trim: true },
    price: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "" },
    materialCode: { type: String, default: "", trim: true },
    availability: { type: String, default: "", trim: true },
    unitWeightKg: { type: Number, default: null },
    /** True when this line was reserved while available stock was below 0 (backorder). */
    isNegativeAllocation: { type: Boolean, default: false },
  },
  { _id: true }
);

const orderAllocationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    allocationNo: { type: String, required: true, trim: true },
    allocationDate: { type: Date, default: () => new Date(), index: true },
    linkedQuotationId: { type: mongoose.Schema.Types.ObjectId, ref: "Quotation", index: true, default: null },
    linkedQuotationNo: { type: String, default: "", trim: true },
    linkedOAId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderAcknowledgement", index: true, default: null },
    linkedOANo: { type: String, default: "", trim: true },
    linkedProformaId: { type: mongoose.Schema.Types.ObjectId, ref: "ProformaInvoice", index: true, default: null },
    linkedProformaNo: { type: String, default: "", trim: true },
    linkedSalesInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", index: true, default: null },
    linkedSalesInvoiceNo: { type: String, default: "", trim: true },
    /** Warehouse used for reservation / packing / invoice stock buckets (default MAIN). */
    warehouse: { type: String, default: "MAIN", trim: true, uppercase: true },
    customerName: { type: String, required: true, trim: true, index: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    vertical: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    config: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    lines: { type: [orderAllocationLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    packingCost: { type: Number, default: 0, min: 0 },
    clearanceCost: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["OPEN", "PARTIALLY_PACKED", "FULLY_PACKED", "APPROVED", "CLOSED", "CANCELLED"],
      default: "OPEN",
    },
    packingStatus: {
      type: String,
      enum: ["NOT_PACKED", "PARTIALLY_PACKED", "FULLY_PACKED"],
      default: "NOT_PACKED",
      index: true,
    },
    invoiceStatus: {
      type: String,
      enum: ["NOT_INVOICED", "PARTIALLY_INVOICED", "FULLY_INVOICED"],
      default: "NOT_INVOICED",
      index: true,
    },
    dispatchStatus: {
      type: String,
      enum: ["NOT_DISPATCHED", "PARTIALLY_DISPATCHED", "DISPATCHED"],
      default: "NOT_DISPATCHED",
      index: true,
    },
    /** Set when SALES_RESERVE was applied for this allocation (legacy rows may be null). */
    stockReservedAt: { type: Date, default: null },
    /** True when at least one line was reserved while available stock was below 0. */
    hasNegativeAllocation: { type: Boolean, default: false, index: true },
    /** Audit trail captured when an admin approved overriding negative stock at allocation time. */
    negativeAllocationReason: { type: String, default: "" },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancellationReason: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

orderAllocationSchema.index({ companyId: 1, allocationNo: 1 }, { unique: true });
orderAllocationSchema.index({ companyId: 1, allocationDate: -1 });

/**
 * P0.3 — one active allocation per OA / per PI (cancelled excluded).
 * Created/verified by scripts/migrate-active-allocation-unique-indexes.mjs.
 * Do not rely on mongoose autoIndex in production; run the migration.
 */
orderAllocationSchema.index(
  { companyId: 1, linkedOAId: 1 },
  {
    name: ACTIVE_ALLOCATION_OA_INDEX,
    unique: true,
    partialFilterExpression: activeAllocationPartialFilter("linkedOAId"),
  }
);
orderAllocationSchema.index(
  { companyId: 1, linkedProformaId: 1 },
  {
    name: ACTIVE_ALLOCATION_PI_INDEX,
    unique: true,
    partialFilterExpression: activeAllocationPartialFilter("linkedProformaId"),
  }
);

export default mongoose.model("OrderAllocation", orderAllocationSchema);

