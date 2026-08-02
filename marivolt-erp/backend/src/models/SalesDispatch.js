import mongoose from "mongoose";

const salesDispatchLineSchema = new mongoose.Schema(
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
    sourceLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    dispatchedQty: { type: Number, default: 0, min: 0 },
    pendingQty: { type: Number, default: 0, min: 0 },
    weightKg: { type: Number, default: 0, min: 0 },
    dimensions: { type: String, default: "", trim: true },
    packageCount: { type: Number, default: 0, min: 0 },
    marksAndNumbers: { type: String, default: "", trim: true },
    countryOfOrigin: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const dispatchPackageSchema = new mongoose.Schema(
  {
    packageNo: { type: String, default: "", trim: true },
    packageType: { type: String, default: "", trim: true },
    weightKg: { type: Number, default: 0, min: 0 },
    dimensions: { type: String, default: "", trim: true },
    marksAndNumbers: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const dispatchTrackingSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["booked", "picked_up", "customs", "in_transit", "delivered"],
      default: "booked",
    },
    note: { type: String, default: "", trim: true },
    updatedAt: { type: Date, default: () => new Date() },
    updatedBy: { type: String, default: "" },
  },
  { _id: true }
);

const salesDispatchSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    dispatchNo: { type: String, required: true, trim: true },
    dispatchDate: { type: Date, default: () => new Date(), index: true },
    linkedSalesInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", required: true, index: true },
    linkedSalesInvoiceNo: { type: String, default: "", trim: true },
    /** S2 — packing / internal StoreDispatch stock document (users never create StoreDispatch). */
    linkedStorePackingId: { type: mongoose.Schema.Types.ObjectId, ref: "StorePacking", default: null, index: true },
    linkedStorePackingNo: { type: String, default: "", trim: true },
    linkedStoreDispatchId: { type: mongoose.Schema.Types.ObjectId, ref: "StoreDispatch", default: null, index: true },
    linkedStoreDispatchNo: { type: String, default: "", trim: true },
    customerName: { type: String, required: true, trim: true, index: true },
    transporter: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    vertical: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    config: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    lines: { type: [salesDispatchLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    packingCost: { type: Number, default: 0, min: 0 },
    clearanceCost: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, default: 0 },
    /**
     * Logistics / document lifecycle (user-facing).
     * Stock posting is tracked separately in postingStatus + linkedStoreDispatchId.
     */
    status: {
      type: String,
      enum: ["DRAFT", "READY", "DISPATCHED", "IN_TRANSIT", "DELIVERED", "CLOSED", "CANCELLED"],
      default: "DRAFT",
      index: true,
    },
    /**
     * S2 — physical stock posting state (driven by internal StoreDispatch P0.5B).
     * NOT_POSTED: draft / logistics-only (incl. pre-S2 historical).
     */
    postingStatus: {
      type: String,
      enum: ["NOT_POSTED", "POSTING", "POSTED", "CANCELLED"],
      default: "NOT_POSTED",
      index: true,
    },
    postedAt: { type: Date, default: null },
    postedBy: { type: String, default: "" },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancellationReason: { type: String, default: "", trim: true },
    /**
     * Pre-S2 logistics SalesDispatch with no StoreDispatch / DISPATCH_OUT evidence.
     * Must never fabricate stock on post.
     */
    isLegacyLogisticsOnly: { type: Boolean, default: false, index: true },
    totalQty: { type: Number, default: 0, min: 0 },
    dispatchedQty: { type: Number, default: 0, min: 0 },
    pendingQty: { type: Number, default: 0, min: 0 },
    packingListNo: { type: String, default: "", trim: true, index: true },
    packingListGeneratedAt: { type: Date, default: null },
    packages: { type: [dispatchPackageSchema], default: [] },
    awbNo: { type: String, default: "", trim: true },
    blNo: { type: String, default: "", trim: true },
    courier: { type: String, default: "", trim: true },
    shippingLine: { type: String, default: "", trim: true },
    vessel: { type: String, default: "", trim: true },
    voyage: { type: String, default: "", trim: true },
    containerNo: { type: String, default: "", trim: true },
    etd: { type: Date, default: null },
    eta: { type: Date, default: null },
    trackingUrl: { type: String, default: "", trim: true },
    trackingStatus: {
      type: String,
      enum: ["booked", "picked_up", "customs", "in_transit", "delivered"],
      default: "booked",
      index: true,
    },
    trackingUpdates: { type: [dispatchTrackingSchema], default: [] },
    deliveredAt: { type: Date, default: null },
    deliveredBy: { type: String, default: "" },
    remarks: { type: String, default: "" },
    closedAt: { type: Date, default: null },
    closedBy: { type: String, default: "" },
    /** Customer ledger credit row when closing with postCustomerLedgerCredit (optional). */
    ledgerCloseEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerLedgerEntry", default: null },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

salesDispatchSchema.index({ companyId: 1, dispatchNo: 1 }, { unique: true });
salesDispatchSchema.index({ companyId: 1, linkedSalesInvoiceId: 1 });
salesDispatchSchema.index({ companyId: 1, status: 1, dispatchDate: -1 });
salesDispatchSchema.index({ companyId: 1, eta: 1, status: 1 });

export default mongoose.model("SalesDispatch", salesDispatchSchema);

