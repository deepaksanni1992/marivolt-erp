import mongoose from "mongoose";

/**
 * Warehouse master — Phase-10.
 *
 * Stock balances are already keyed by (article, warehouse, location)
 * after Phase-3. The Warehouse master exists so the system can:
 *   • offer typeahead / dropdowns instead of free-text warehouse
 *     codes when posting GRN, allocations, transfers
 *   • scope users to one or more warehouses
 *   • generate Warehouse Utilisation reports linked back to a
 *     branch + company
 *
 * Existing rows in `StockLedger` / `StockBalance` keep their plain
 * string `warehouse` field — Warehouse master is purely additive.
 */
const warehouseSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },
    warehouseCode: { type: String, required: true, trim: true, uppercase: true },
    warehouseName: { type: String, required: true, trim: true },
    /** Default location code for opening balance / generic GRN postings. */
    defaultLocation: { type: String, default: "", trim: true, uppercase: true },
    address: { type: String, default: "", trim: true },
    country: { type: String, default: "", trim: true },
    /** Useful for Logistics: source vs in-transit vs bonded. */
    warehouseType: {
      type: String,
      enum: ["MAIN", "BRANCH", "BONDED", "TRANSIT", "VIRTUAL", "OTHER"],
      default: "MAIN",
    },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

warehouseSchema.index({ companyId: 1, warehouseCode: 1 }, { unique: true });
warehouseSchema.index({ companyId: 1, branchId: 1, isActive: 1, warehouseName: 1 });

export default mongoose.model("Warehouse", warehouseSchema);
