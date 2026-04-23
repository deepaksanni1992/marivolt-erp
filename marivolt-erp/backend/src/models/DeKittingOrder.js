import mongoose from "mongoose";

const dekitLineSnapshotSchema = new mongoose.Schema(
  {
    componentItemCode: { type: String, required: true, trim: true, uppercase: true },
    qtyPerKit: { type: Number, required: true, min: 0 },
    description: { type: String, default: "" },
  },
  { _id: false }
);

const deKittingOrderSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    dekitNumber: { type: String, required: true, trim: true },
    parentItemCode: { type: String, required: true, trim: true, uppercase: true },
    warehouse: { type: String, required: true, trim: true, default: "MAIN" },
    quantity: { type: Number, required: true, min: 0.0001 },
    bomId: { type: mongoose.Schema.Types.ObjectId, ref: "BOM", required: true },
    status: {
      type: String,
      enum: ["DRAFT", "COMPLETED", "CANCELLED"],
      default: "DRAFT",
    },
    linesSnapshot: { type: [dekitLineSnapshotSchema], default: [] },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

deKittingOrderSchema.index({ companyId: 1, dekitNumber: 1 }, { unique: true });
deKittingOrderSchema.index({ companyId: 1, parentItemCode: 1, createdAt: -1 });
deKittingOrderSchema.index({ status: 1 });

export default mongoose.model("DeKittingOrder", deKittingOrderSchema);
