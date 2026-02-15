import mongoose from "mongoose";

const priceListSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, unique: true, trim: true },
    unitPrice: { type: Number, default: 0 },
    minimumPrice: { type: Number, default: 0 },
    euro2Price: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model("PriceList", priceListSchema);
