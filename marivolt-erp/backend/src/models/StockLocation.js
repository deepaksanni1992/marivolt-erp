import mongoose from "mongoose";

const stockLocationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    locationCode: { type: String, required: true, trim: true, uppercase: true },
    locationName: { type: String, default: "", trim: true },
    warehouse: { type: String, default: "", trim: true },
    rack: { type: String, default: "", trim: true },
    bin: { type: String, default: "", trim: true },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
  },
  { timestamps: true }
);

stockLocationSchema.index({ companyId: 1, locationCode: 1 }, { unique: true });

export default mongoose.model("StockLocation", stockLocationSchema);
