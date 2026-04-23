import mongoose from "mongoose";

const poLineSchema = new mongoose.Schema(
  {
    articleNo: { type: String, default: "", trim: true },
    itemCode: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "" },
    partNo: { type: String, default: "", trim: true },
    qty: { type: Number, required: true, min: 0 },
    uom: { type: String, default: "PCS", trim: true },
    unitPrice: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true },
    lineTotal: { type: Number, default: 0, min: 0 },
    expectedDeliveryDate: { type: Date },
    receivedQty: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "" },
  },
  { _id: true }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    poNumber: { type: String, required: true, trim: true },
    orderDate: { type: Date, default: () => new Date() },

    buyerLegalName: { type: String, default: "Marivolt FZE", trim: true },
    buyerAddressLine: {
      type: String,
      default: "LV09B, Hamriyah freezone phase 2, Sharjah, UAE",
      trim: true,
    },
    buyerPhone: { type: String, default: "+971-543053047", trim: true },
    buyerEmail: { type: String, default: "sales@marivolt.co", trim: true },
    buyerWeb: { type: String, default: "www.marivolt.co", trim: true },

    supplierName: { type: String, required: true, trim: true },
    supplierAddress: { type: String, default: "", trim: true },
    supplierPhone: { type: String, default: "", trim: true },
    supplierEmail: { type: String, default: "", trim: true },

    ref: { type: String, default: "", trim: true },
    intRef: { type: String, default: "", trim: true },
    contactPerson: { type: String, default: "", trim: true },
    supplierReference: { type: String, default: "", trim: true },
    offerDate: { type: String, default: "", trim: true },

    currency: { type: String, default: "USD", trim: true },
    lines: { type: [poLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    delivery: { type: String, default: "Ex-Works", trim: true },
    insurance: { type: String, default: "On buyers account", trim: true },
    packing: { type: String, default: "Inclusive", trim: true },
    freight: { type: String, default: "On buyers account", trim: true },
    taxes: { type: String, default: "N.A.", trim: true },
    payment: { type: String, default: "100% against delivery", trim: true },

    specialRemarks: { type: String, default: "-" },
    termsAndConditions: { type: String, default: "" },
    closingNote: {
      type: String,
      default:
        "Kindly send us the Order Acknowledgement and Proforma Invoice, with current status of delivery.",
    },

    status: {
      type: String,
      enum: ["DRAFT", "SAVED", "SENT", "PARTIAL_RECEIVED", "RECEIVED", "CANCELLED"],
      default: "DRAFT",
    },
    remarks: { type: String, default: "" },
    createdBy: { type: String, default: "" },
  },
  { timestamps: true }
);

purchaseOrderSchema.index({ companyId: 1, poNumber: 1 }, { unique: true });

export default mongoose.model("PurchaseOrder", purchaseOrderSchema);
