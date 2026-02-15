import mongoose from "mongoose";

const itemSchema = new mongoose.Schema(
  {
    sku: { type: String, default: "" },
    name: { type: String, required: true },
    vendor: { type: String, default: "" },
    engine: { type: String, default: "" },
    compatibility: {
      type: [
        {
          engine: { type: String, default: "" },
          model: { type: String, default: "" },
          config: { type: String, default: "" },
        },
      ],
      default: () => [],
    },
    cCode: { type: String, default: "" },
    article: { type: String, default: "" },
    mpn: { type: String, default: "" },
    description: { type: String, default: "" },
    spn: { type: String, default: "" },
    materialCode: { type: String, default: "" },
    drawingNumber: { type: String, default: "" },
    rev: { type: String, default: "" },
    qty: { type: Number, default: 0 },
    oeRemarks: { type: String, default: "" },
    internalRemarks: { type: String, default: "" },
    oeMarking: { type: String, default: "" },
    supplier1: { type: String, default: "" },
    supplier1Spn: { type: String, default: "" },
    supplier1UnitPrice: { type: Number, default: 0 },
    supplier1Cur: { type: String, default: "" },
    supplier2: { type: String, default: "" },
    supplier2Spn: { type: String, default: "" },
    supplier3: { type: String, default: "" },
    supplier3Pw: { type: String, default: "" },
    supplier3OePrice: { type: String, default: "" },
    uom: { type: String, default: "pcs" },
    unitWeight: { type: Number, default: 0 },
    category: { type: String, default: "General" },
    minStock: { type: Number, default: 0 },
    location: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("Item", itemSchema);
