import mongoose from "mongoose";

const nullableNumber = { type: Number, default: null };

const manPriceListSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    itemMasterId: { type: mongoose.Schema.Types.ObjectId, ref: "ItemMaster", required: true, index: true },
    article: { type: String, required: true, trim: true, uppercase: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    sellPrice: nullableNumber,
    sellIi: nullableNumber,
    minm: nullableNumber,
    rock: nullableNumber,
    buy: nullableNumber,
    nextBuy: nullableNumber,
    leadTime: { type: String, default: "", trim: true },
    isActive: { type: Boolean, default: true, index: true },
    revision: { type: Number, default: 1, min: 1 },
    contentHash: { type: String, default: "", trim: true },
    source: { type: String, enum: ["MANUAL", "CSV"], default: "MANUAL" },
    lastImportId: { type: mongoose.Schema.Types.ObjectId, ref: "ManPriceListImport", default: null },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

manPriceListSchema.index({ companyId: 1, article: 1 }, { unique: true });
manPriceListSchema.index({ companyId: 1, itemMasterId: 1 }, { unique: true });

export default mongoose.model("ManPriceList", manPriceListSchema);
