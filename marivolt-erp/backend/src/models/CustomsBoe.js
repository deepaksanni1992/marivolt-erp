import mongoose from "mongoose";

/**
 * Parent Customs BOE / shipment economics.
 * One CustomsBoe → many CustomsLots (one per GRN) → CustomsLotItems.
 * External boeNumber is searchable but NOT unique.
 */
const customsBoeSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    companyCode: { type: String, default: "", trim: true, uppercase: true, index: true },
    customsBoeRef: { type: String, required: true, trim: true, uppercase: true },
    boeNumber: { type: String, default: "", trim: true, index: true },
    boeDate: { type: Date, default: null, index: true },
    blNumber: { type: String, default: "", trim: true, index: true },
    awbNumber: { type: String, default: "", trim: true, index: true },
    boeDeclaredQty: { type: Number, required: true, min: 0 },
    customsUom: { type: String, default: "PCS", trim: true, uppercase: true },
    boeDeclaredValue: { type: Number, required: true, min: 0 },
    customsCurrency: { type: String, default: "USD", trim: true, uppercase: true },
    exchangeRateToAED: { type: Number, default: 0, min: 0 },
    /** Frozen once at creation: roundMoney(boeDeclaredValue / boeDeclaredQty). */
    customsUnitValue: { type: Number, required: true, min: 0 },
    grossWeightKg: { type: Number, default: 0, min: 0 },
    netWeightKg: { type: Number, default: 0, min: 0 },
    valuationMethod: {
      type: String,
      enum: ["BOE_AVERAGE"],
      default: "BOE_AVERAGE",
      index: true,
    },
    valuationLockedAt: { type: Date, default: null },
    /** Sum of active GRN customs qty linked under this BOE. */
    linkedCustomsQty: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["OPEN", "RECONCILED", "CLOSED", "CANCELLED"],
      default: "OPEN",
      index: true,
    },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

customsBoeSchema.index({ companyId: 1, customsBoeRef: 1 }, { unique: true });
customsBoeSchema.index({ companyId: 1, boeNumber: 1 });
customsBoeSchema.index({ companyId: 1, blNumber: 1 });

export default mongoose.model("CustomsBoe", customsBoeSchema);
