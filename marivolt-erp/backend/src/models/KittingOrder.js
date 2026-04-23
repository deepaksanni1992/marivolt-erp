import mongoose from "mongoose";

const kitLineSnapshotSchema = new mongoose.Schema(
  {
    componentItemCode: { type: String, required: true, trim: true, uppercase: true },
    qtyPerKit: { type: Number, required: true, min: 0 },
    description: { type: String, default: "" },
  },
  { _id: false }
);

const kittingOrderSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    kitNumber: { type: String, required: true, trim: true },
    parentItemCode: { type: String, required: true, trim: true, uppercase: true },
    warehouse: { type: String, required: true, trim: true, default: "MAIN" },
    quantity: { type: Number, required: true, min: 0.0001 },
    bomId: { type: mongoose.Schema.Types.ObjectId, ref: "BOM", required: true },
    status: {
      type: String,
      enum: ["DRAFT", "COMPLETED", "CANCELLED"],
      default: "DRAFT",
    },
    /** Filled when the order is completed (BOM lines at execution time). */
    linesSnapshot: { type: [kitLineSnapshotSchema], default: [] },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

kittingOrderSchema.index({ companyId: 1, kitNumber: 1 }, { unique: true });
kittingOrderSchema.index({ companyId: 1, parentItemCode: 1, createdAt: -1 });
kittingOrderSchema.index({ status: 1 });

export default mongoose.model("KittingOrder", kittingOrderSchema);
