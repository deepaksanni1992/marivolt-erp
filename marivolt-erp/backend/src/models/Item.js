import mongoose from "mongoose";

const itemSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    uom: { type: String, default: "pcs" },
    category: { type: String, default: "General" },
    minStock: { type: Number, default: 0 },
    location: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("Item", itemSchema);
