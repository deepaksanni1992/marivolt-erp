import mongoose from "mongoose";

const TX_TYPES = [
  "OPENING",
  "GRN",
  "SALES_ALLOCATION",
  "RTS",
  "SALES_INVOICE",
  "SALES_INVOICE_CANCEL",
  "RTS_CANCEL",
  "ORDER_ALLOCATION_CANCEL",
  "STOCK_ADJUSTMENT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
];

const stockLedgerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    transactionDate: { type: Date, required: true },
    transactionType: { type: String, enum: TX_TYPES, required: true },
    referenceType: { type: String, default: "", trim: true },
    referenceNo: { type: String, default: "", trim: true },
    article: { type: String, required: true, ref: "ItemMaster", trim: true, uppercase: true },
    location: { type: String, default: "", trim: true, uppercase: true },
    batchNo: { type: String, default: "", trim: true },
    serialNo: { type: String, default: "", trim: true },
    qtyIn: { type: Number, default: 0, min: 0 },
    qtyOut: { type: Number, default: 0, min: 0 },
    balanceQty: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    remarks: { type: String, default: "", trim: true },
    createdBy: { type: String, default: "", trim: true },
  },
  { timestamps: true }
);

stockLedgerSchema.index({ companyId: 1, transactionDate: -1, article: 1 });
stockLedgerSchema.index({ companyId: 1, referenceNo: 1, transactionType: 1 });

export { TX_TYPES };
export default mongoose.model("StockLedger", stockLedgerSchema);
