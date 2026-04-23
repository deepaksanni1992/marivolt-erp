import mongoose from "mongoose";

const grnItemSchema = new mongoose.Schema(
  {
    sku: String,
    name: String,
    qty: Number,
    uom: String,
    poNo: String,
  },
  { _id: false }
);

const grnSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    grnNo: { type: String, required: true },
    supplier: String,
    poNo: String,
    items: [grnItemSchema],
    note: String,
    createdBy: String,
  },
  { timestamps: true }
);

grnSchema.index({ companyId: 1, grnNo: 1 }, { unique: true });

export default mongoose.model("GRN", grnSchema);
