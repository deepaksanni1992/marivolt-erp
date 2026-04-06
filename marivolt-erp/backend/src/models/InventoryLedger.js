import mongoose from "mongoose";

const inventoryLedgerSchema = new mongoose.Schema(
  {
    itemCode: { type: String, required: true, trim: true, uppercase: true },
    warehouse: { type: String, required: true, trim: true, default: "MAIN" },
    movementType: {
      type: String,
      enum: [
        "IN_PURCHASE",
        "OUT_SALE",
        "ADJUSTMENT",
        "IN_RETURN",
        "OUT_RETURN",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "OPENING",
        "KIT_COMPONENT_OUT",
        "KIT_PARENT_IN",
        "DEKIT_PARENT_OUT",
        "DEKIT_COMPONENT_IN",
      ],
      required: true,
    },
    qtyDelta: { type: Number, required: true },
    referenceType: { type: String, default: "" },
    referenceId: { type: String, default: "" },
    referenceNumber: { type: String, default: "" },
    unitCost: { type: Number, default: 0 },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

inventoryLedgerSchema.index({ itemCode: 1, warehouse: 1, createdAt: -1 });
inventoryLedgerSchema.index({ referenceType: 1, referenceId: 1 });

export default mongoose.model("InventoryLedger", inventoryLedgerSchema);
