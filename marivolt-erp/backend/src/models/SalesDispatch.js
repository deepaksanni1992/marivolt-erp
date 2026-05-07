import mongoose from "mongoose";

const salesDispatchLineSchema = new mongoose.Schema(
  {
    serialNo: { type: Number, default: 0, min: 0 },
    article: { type: String, required: true, trim: true, uppercase: true },
    partNumber: { type: String, default: "", trim: true },
    description: { type: String, default: "" },
    qty: { type: Number, required: true, min: 0.0001 },
    uom: { type: String, default: "PCS", trim: true },
    price: { type: Number, default: 0, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "" },
    materialCode: { type: String, default: "", trim: true },
    availability: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const salesDispatchSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    dispatchNo: { type: String, required: true, trim: true },
    dispatchDate: { type: Date, default: () => new Date(), index: true },
    linkedSalesInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", required: true, index: true },
    linkedSalesInvoiceNo: { type: String, default: "", trim: true },
    customerName: { type: String, required: true, trim: true, index: true },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    lines: { type: [salesDispatchLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    packingCost: { type: Number, default: 0, min: 0 },
    clearanceCost: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, default: 0 },
    status: { type: String, enum: ["DRAFT", "DISPATCHED", "CLOSED", "CANCELLED"], default: "DRAFT" },
    remarks: { type: String, default: "" },
    closedAt: { type: Date, default: null },
    closedBy: { type: String, default: "" },
    /** Customer ledger credit row when closing with postCustomerLedgerCredit (optional). */
    ledgerCloseEntryId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerLedgerEntry", default: null },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

salesDispatchSchema.index({ companyId: 1, dispatchNo: 1 }, { unique: true });
salesDispatchSchema.index({ companyId: 1, linkedSalesInvoiceId: 1 }, { unique: true });

export default mongoose.model("SalesDispatch", salesDispatchSchema);

