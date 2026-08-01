import mongoose from "mongoose";

const rtsLineSchema = new mongoose.Schema(
  {
    serialNo: { type: Number, default: 0, min: 0 },
    allocationLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    article: { type: String, required: true, trim: true, uppercase: true },
    partNumber: { type: String, default: "", trim: true },
    description: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0.0001 },
    uom: { type: String, default: "PCS", trim: true },
    coo: { type: String, default: "Germany", trim: true },
    remarks: { type: String, default: "" },
    materialCode: { type: String, default: "", trim: true },
    availability: { type: String, default: "", trim: true },
    unitWeightKg: { type: Number, default: null },
    totalWeightKg: { type: Number, default: null },
  },
  { _id: true }
);

const rtsPackingBoxSchema = new mongoose.Schema(
  {
    serialNo: { type: Number, default: 0, min: 0 },
    material: { type: String, default: "", trim: true },
    count: { type: Number, default: 1, min: 1 },
    dimensionsMm: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const rtsSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    rtsNo: { type: String, required: true, trim: true },
    rtsDate: { type: Date, default: () => new Date(), index: true },
    linkedOrderAllocationId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderAllocation", required: true, index: true },
    linkedOrderAllocationNo: { type: String, default: "", trim: true },
    linkedSalesInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", index: true, default: null },
    linkedSalesInvoiceNo: { type: String, default: "", trim: true },
    customerName: { type: String, required: true, trim: true, index: true },
    vertical: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    config: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    lines: { type: [rtsLineSchema], default: [] },
    packingDetails: {
      totalWeightKg: { type: Number, default: 0 },
      boxCount: { type: Number, default: 0 },
      boxDimensionsMm: { type: String, default: "", trim: true },
      boxes: { type: [rtsPackingBoxSchema], default: [] },
    },
    status: {
      type: String,
      // APPROVING is an ephemeral in-transaction claim so only one approve request
      // can run stock movement. Failed/aborted transactions must roll it back to DRAFT.
      enum: ["DRAFT", "APPROVING", "APPROVED", "CONVERTED_TO_INVOICE", "CANCELLED"],
      default: "DRAFT",
    },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancellationReason: { type: String, default: "" },
    convertedToInvoiceAt: { type: Date, default: null },
    convertedToInvoiceBy: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

rtsSchema.index({ companyId: 1, rtsNo: 1 }, { unique: true });
rtsSchema.index({ companyId: 1, linkedOrderAllocationId: 1 });

export default mongoose.model("Rts", rtsSchema);

