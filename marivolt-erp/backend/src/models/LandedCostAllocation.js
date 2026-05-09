import mongoose from "mongoose";

const landedCostComponentSchema = new mongoose.Schema(
  {
    componentType: {
      type: String,
      enum: ["FREIGHT", "CUSTOMS_DUTY", "TRUCKING", "INSURANCE", "HANDLING", "CLEARANCE", "MISC_CHARGES"],
      required: true,
    },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    exchangeRate: { type: Number, default: 1, min: 0 },
    baseAmount: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const landedCostLineSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, trim: true, uppercase: true },
    location: { type: String, required: true, trim: true, uppercase: true },
    batchNo: { type: String, default: "", trim: true },
    serialNo: { type: String, default: "", trim: true },
    receivedQty: { type: Number, required: true, min: 0 },
    baseUnitCost: { type: Number, default: 0, min: 0 },
    baseLineCost: { type: Number, default: 0, min: 0 },
    weight: { type: Number, default: 0, min: 0 },
    volume: { type: Number, default: 0, min: 0 },
    allocatedCost: { type: Number, default: 0, min: 0 },
    finalUnitCost: { type: Number, default: 0, min: 0 },
    valuationDelta: { type: Number, default: 0 },
    oldCost: { type: Number, default: 0, min: 0 },
    newCost: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const landedCostAllocationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    allocationNo: { type: String, required: true, trim: true, index: true },
    grnId: { type: mongoose.Schema.Types.ObjectId, ref: "GRN", required: true, index: true },
    grnNo: { type: String, required: true, trim: true, index: true },
    supplierName: { type: String, default: "", trim: true },
    purchaseInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseInvoice", default: null, index: true },
    purchaseInvoiceNo: { type: String, default: "", trim: true, index: true },
    shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Shipment", default: null, index: true },
    shipmentRef: { type: String, default: "", trim: true, index: true },
    containerNo: { type: String, default: "", trim: true },
    allocationMethod: { type: String, enum: ["QUANTITY", "LINE_VALUE", "WEIGHT", "VOLUME"], default: "LINE_VALUE" },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    exchangeRate: { type: Number, default: 1, min: 0 },
    remarks: { type: String, default: "", trim: true },
    components: { type: [landedCostComponentSchema], default: [] },
    totalLandedCost: { type: Number, default: 0, min: 0 },
    lines: { type: [landedCostLineSchema], default: [] },
    status: { type: String, enum: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "APPLIED", "CANCELLED"], default: "DRAFT", index: true },
    approvalStatus: { type: String, enum: ["NOT_REQUIRED", "PENDING_APPLY", "APPROVED", "REJECTED"], default: "NOT_REQUIRED" },
    appliedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

landedCostAllocationSchema.index({ companyId: 1, allocationNo: 1 }, { unique: true });

export default mongoose.model("LandedCostAllocation", landedCostAllocationSchema);
