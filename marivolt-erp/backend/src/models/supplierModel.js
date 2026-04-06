/**
 * Per-article supplier offers (bulk import).
 * Distinct from the Supplier master collection (`Supplier` model).
 */
import mongoose from "mongoose";

const itemSupplierOfferSchema = new mongoose.Schema(
  {
    article: { type: String, required: true, trim: true, uppercase: true, index: true },
    supplierName: { type: String, required: true, trim: true },
    supplierPartNumber: { type: String, default: "", trim: true },
    unitPrice: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

itemSupplierOfferSchema.index({ article: 1, supplierName: 1 });

export default mongoose.model("ItemSupplierOffer", itemSupplierOfferSchema);
