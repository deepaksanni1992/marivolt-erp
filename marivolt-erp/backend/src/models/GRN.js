import mongoose from "mongoose";

const grnItemSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    receivedQty: { type: Number, required: true, min: 0 },
    acceptedQty: { type: Number, required: true, min: 0 },
    rejectedQty: { type: Number, default: 0, min: 0 },
    unitCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    location: { type: String, default: "", trim: true, uppercase: true },
    batchNo: { type: String, default: "", trim: true },
    serialNo: { type: String, default: "", trim: true },
    poNo: String,
    remarks: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const grnSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    grnNo: { type: String, required: true },
    grnDate: { type: Date, required: true },
    supplierName: { type: String, default: "", trim: true },
    supplierInvoiceNo: { type: String, default: "", trim: true },
    poNo: String,
    remarks: { type: String, default: "", trim: true },
    status: { type: String, enum: ["Draft", "Posted", "Cancelled"], default: "Draft" },
    items: [grnItemSchema],
    createdBy: String,
    postedAt: Date,
    cancelledAt: Date,
  },
  { timestamps: true }
);

grnSchema.index({ companyId: 1, grnNo: 1 }, { unique: true });

export default mongoose.model("GRN", grnSchema);
