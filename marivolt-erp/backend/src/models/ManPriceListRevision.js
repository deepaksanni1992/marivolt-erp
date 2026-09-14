import mongoose from "mongoose";

const manPriceListRevisionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    priceListId: { type: mongoose.Schema.Types.ObjectId, ref: "ManPriceList", required: true, index: true },
    article: { type: String, required: true, trim: true, uppercase: true },
    revision: { type: Number, required: true, min: 1 },
    snapshot: { type: mongoose.Schema.Types.Mixed, default: {} },
    source: { type: String, enum: ["MANUAL", "CSV"], default: "MANUAL" },
    importId: { type: mongoose.Schema.Types.ObjectId, ref: "ManPriceListImport", default: null },
    sourceFilename: { type: String, default: "" },
    actorName: { type: String, default: "" },
    actorEmail: { type: String, default: "" },
  },
  { timestamps: true }
);

manPriceListRevisionSchema.index({ companyId: 1, article: 1, revision: -1 });

export default mongoose.model("ManPriceListRevision", manPriceListRevisionSchema);
