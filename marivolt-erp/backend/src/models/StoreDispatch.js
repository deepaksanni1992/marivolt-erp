import mongoose from "mongoose";

const dispatchAttachmentSchema = new mongoose.Schema(
  {
    documentId: { type: mongoose.Schema.Types.ObjectId, ref: "Document", default: null },
    fileName: { type: String, default: "" },
    uploadedAt: { type: Date, default: null },
    remarks: { type: String, default: "" },
  },
  { _id: true }
);

const storeDispatchLineSchema = new mongoose.Schema(
  {
    packingLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    article: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "" },
    spn: { type: String, default: "", trim: true },
    materialCode: { type: String, default: "", trim: true },
    packedQty: { type: Number, default: 0, min: 0 },
    dispatchQty: { type: Number, required: true, min: 0 },
    uom: { type: String, default: "PCS", trim: true },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const storeDispatchSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch", default: null, index: true },
    dispatchNo: { type: String, required: true, trim: true, index: true },
    dispatchDate: { type: Date, default: () => new Date(), index: true },
    warehouse: { type: String, default: "MAIN", trim: true, uppercase: true },
    packingId: { type: mongoose.Schema.Types.ObjectId, ref: "StorePacking", required: true, index: true },
    packingNo: { type: String, default: "", trim: true, index: true },
    allocationId: { type: mongoose.Schema.Types.ObjectId, ref: "OrderAllocation", default: null, index: true },
    allocationNo: { type: String, default: "", trim: true },
    linkedOANo: { type: String, default: "", trim: true },
    linkedProformaNo: { type: String, default: "", trim: true },
    customerName: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    courier: { type: String, default: "", trim: true },
    awbNo: { type: String, default: "", trim: true },
    blNo: { type: String, default: "", trim: true },
    lrNo: { type: String, default: "", trim: true },
    vehicleNo: { type: String, default: "", trim: true },
    driverName: { type: String, default: "", trim: true },
    driverPhone: { type: String, default: "", trim: true },
    deliveryNote: { type: String, default: "", trim: true },
    shipmentMode: { type: String, default: "", trim: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    lines: { type: [storeDispatchLineSchema], default: [] },
    attachments: { type: [dispatchAttachmentSchema], default: [] },
    remarks: { type: String, default: "", trim: true },
    status: {
      type: String,
      enum: ["DRAFT", "POSTED", "CANCELLED"],
      default: "DRAFT",
      index: true,
    },
    postedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: "", trim: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

storeDispatchSchema.index({ companyId: 1, dispatchNo: 1 }, { unique: true });
storeDispatchSchema.index({ companyId: 1, packingId: 1, status: 1 });

export default mongoose.model("StoreDispatch", storeDispatchSchema);
