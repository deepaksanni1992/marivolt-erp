import mongoose from "mongoose";

const packageSchema = new mongoose.Schema(
  {
    packageNo: { type: String, default: "", trim: true },
    packageType: { type: String, default: "", trim: true },
    weightKg: { type: Number, default: 0, min: 0 },
    dimensions: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const trackingUpdateSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["booked", "picked_up", "customs", "in_transit", "delivered"],
      default: "booked",
    },
    note: { type: String, default: "", trim: true },
    updatedAt: { type: Date, default: () => new Date() },
    updatedBy: { type: String, default: "" },
  },
  { _id: true }
);

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
    linkedDispatchId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDispatch", default: null, index: true },
    linkedDispatchNo: { type: String, default: "", trim: true },
    linkedRtsId: { type: mongoose.Schema.Types.ObjectId, ref: "Rts", default: null, index: true },
    linkedRtsNo: { type: String, default: "", trim: true },
    linkedSalesInvoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null, index: true },

    linkedPoNumber: { type: String, default: "" },
    linkedQuotationNumber: { type: String, default: "" },
    linkedSalesInvoiceNumber: { type: String, default: "" },
    linkedPurchaseInvoiceNumber: { type: String, default: "" },

    incoterm: { type: String, default: "" },
    vesselOrFlight: { type: String, default: "" },
    voyageOrFlightNo: { type: String, default: "" },
    blAwbNo: { type: String, default: "" },
    awbNo: { type: String, default: "", trim: true },
    blNo: { type: String, default: "", trim: true },
    courier: { type: String, default: "", trim: true },
    shippingLine: { type: String, default: "", trim: true },
    vessel: { type: String, default: "", trim: true },
    voyage: { type: String, default: "", trim: true },
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
    trackingUrl: { type: String, default: "", trim: true },
    trackingStatus: {
      type: String,
      enum: ["booked", "picked_up", "customs", "in_transit", "delivered"],
      default: "booked",
      index: true,
    },
    packages: { type: [packageSchema], default: [] },
    trackingUpdates: { type: [trackingUpdateSchema], default: [] },
    deliveredAt: { type: Date, default: null },
    deliveredBy: { type: String, default: "" },

    remarks: { type: String, default: "" },
  },
  { timestamps: true }
);

shipmentSchema.index({ companyId: 1, shipmentRef: 1 }, { unique: true });
shipmentSchema.index({ companyId: 1, linkedDispatchId: 1 });
shipmentSchema.index({ companyId: 1, trackingStatus: 1, eta: 1 });
shipmentSchema.index({ companyId: 1, status: 1, eta: 1 });

export default mongoose.model("Shipment", shipmentSchema);
