import mongoose from "mongoose";

const salesItemSchema = new mongoose.Schema(
  {
    sku: { type: String, default: "" },
    description: { type: String, default: "" },
    spn: { type: String, default: "" },
    uom: { type: String, default: "" },
    qty: { type: Number, default: 0 },
    unitPrice: { type: Number, default: 0 },
    currency: { type: String, default: "" },
    total: { type: Number, default: 0 },
    unitWeight: { type: Number, default: 0 },
    oeRemarks: { type: String, default: "" },
    availability: { type: String, default: "" },
    materialCode: { type: String, default: "" },
  },
  { _id: false }
);

const packedItemSchema = new mongoose.Schema(
  {
    sku: { type: String, default: "" },
    qty: { type: Number, default: 0 },
  },
  { _id: false }
);

const salesDocSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: [
        "QUOTATION",
        "ORDER_CONFIRMATION",
        "PROFORMA_INVOICE",
        "PTG",
        "INVOICE",
        "CIPL",
      ],
      required: true,
    },
    docNo: { type: String, required: true, unique: true },
    status: { type: String, default: "OPEN" },
    refDocId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDoc" },

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    customerName: { type: String, default: "" },
    paymentTerms: { type: String, default: "CREDIT" },

    items: [salesItemSchema],
    subTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },
    paidAmount: { type: Number, default: 0 },
    paidDate: { type: Date },
    notes: { type: String, default: "" },

    packing: {
      dimensions: { type: String, default: "" },
      weight: { type: String, default: "" },
      notes: { type: String, default: "" },
      packedItems: [packedItemSchema],
    },
  },
  { timestamps: true }
);

export default mongoose.model("SalesDoc", salesDocSchema);
