import mongoose from "mongoose";

/**
 * Parent Customs BOE / shipment economics.
 * One CustomsBoe → many CustomsLots (one per GRN) → CustomsLotItems.
 *
 * Legal identity (Phase 1 P0):
 *   companyId + normalizedBoeNumber
 * where normalizedBoeNumber = trim(boeNumber).toUpperCase()
 *
 * Unique index is created ONLY by:
 *   npm run migrate:customs-boe-identity-indexes -- --execute
 * after backfill + collision audit. Boot verifies; does not auto-create.
 *
 * CANCELLED parents remain in the unique set — the number is never freed.
 */
const customsBoeSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    companyCode: { type: String, default: "", trim: true, uppercase: true, index: true },
    customsBoeRef: { type: String, required: true, trim: true, uppercase: true },
    boeNumber: { type: String, default: "", trim: true, index: true },
    /**
     * Server-set legal identity key. Client must not author this field.
     * Immutable with boeNumber after create under normal GRN operations.
     */
    normalizedBoeNumber: { type: String, default: "", trim: true, uppercase: true },
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
/**
 * Unique legal identity — NOT registered via Mongoose autoIndex / syncIndexes.
 * Spec + create: src/utils/customsBoeIdentityIndexes.js
 * Migration: scripts/migrate-customs-boe-identity-indexes.mjs
 * Name: customsBoe_company_normalizedBoeNumber_unique
 * Keys: { companyId: 1, normalizedBoeNumber: 1 } unique
 * partialFilterExpression: { normalizedBoeNumber: { $type: "string", $gt: "" } }
 * CANCELLED included (no status filter).
 */

export default mongoose.model("CustomsBoe", customsBoeSchema);
