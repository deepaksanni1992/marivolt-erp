import mongoose from "mongoose";

const customsMovementSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    companyCode: { type: String, default: "", trim: true, uppercase: true, index: true },
    movementType: {
      type: String,
      enum: ["INBOUND", "OUTBOUND", "ADJUSTMENT", "REVERSAL"],
      required: true,
      index: true,
    },
    customsLotId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomsLot", required: true, index: true },
    customsLotItemId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomsLotItem", required: true, index: true },
    articleNumber: { type: String, default: "", trim: true, uppercase: true, index: true },
    partNumber: { type: String, default: "", trim: true, uppercase: true },
    qty: { type: Number, required: true, min: 0 },
    referenceType: {
      type: String,
      enum: ["GRN", "SALES_INVOICE", "CUSTOMS_INVOICE", "MANUAL_ADJUSTMENT"],
      required: true,
      index: true,
    },
    referenceId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    referenceNumber: { type: String, default: "", trim: true, index: true },
    movementDate: { type: Date, default: Date.now, index: true },
    remarks: { type: String, default: "", trim: true },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

customsMovementSchema.index({ companyId: 1, movementDate: -1 });
customsMovementSchema.index({ companyId: 1, referenceType: 1, referenceNumber: 1 });

export default mongoose.model("CustomsMovement", customsMovementSchema);
