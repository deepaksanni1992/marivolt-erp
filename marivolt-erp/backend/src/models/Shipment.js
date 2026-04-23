import mongoose from "mongoose";

const shipmentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    shipmentRef: { type: String, required: true, trim: true },
    direction: {
      type: String,
      enum: ["IMPORT", "EXPORT", "LOCAL"],
      default: "EXPORT",
    },
    mode: {
      type: String,
      enum: ["SEA", "AIR", "ROAD", "COURIER"],
      default: "SEA",
    },
    status: {
      type: String,
      enum: ["PLANNED", "BOOKED", "IN_TRANSIT", "ARRIVED", "DELIVERED", "CLOSED", "CANCELLED"],
      default: "PLANNED",
    },

    customerName: { type: String, default: "" },
    supplierName: { type: String, default: "" },
    docType: { type: String, default: "" },
    docNo: { type: String, default: "" },

    linkedPoNumber: { type: String, default: "" },
    linkedQuotationNumber: { type: String, default: "" },
    linkedSalesInvoiceNumber: { type: String, default: "" },
    linkedPurchaseInvoiceNumber: { type: String, default: "" },

    incoterm: { type: String, default: "" },
    vesselOrFlight: { type: String, default: "" },
    voyageOrFlightNo: { type: String, default: "" },
    blAwbNo: { type: String, default: "" },
    containerNo: { type: String, default: "" },
    origin: { type: String, default: "" },
    destination: { type: String, default: "" },
    etd: { type: Date },
    eta: { type: Date },

    weightKg: { type: Number, default: 0 },
    freightCost: { type: Number, default: 0 },
    insuranceCost: { type: Number, default: 0 },
    dutyCost: { type: Number, default: 0 },
    otherCharges: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },

    remarks: { type: String, default: "" },
  },
  { timestamps: true }
);

shipmentSchema.index({ companyId: 1, shipmentRef: 1 }, { unique: true });

export default mongoose.model("Shipment", shipmentSchema);
