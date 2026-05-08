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

const exportDocumentSchema = new mongoose.Schema(
  {
    documentType: {
      type: String,
      enum: ["COO", "WEIGHT_LIST", "CONTAINER_LOAD_PLAN", "EXPORT_CHECKLIST", "COMMERCIAL_INVOICE", "PACKING_LIST"],
      required: true,
    },
    status: { type: String, enum: ["PENDING", "GENERATED", "UPLOADED"], default: "PENDING" },
    documentId: { type: mongoose.Schema.Types.ObjectId, default: null },
    documentNo: { type: String, default: "", trim: true },
    fileUrl: { type: String, default: "", trim: true },
    uploadedAt: { type: Date, default: null },
    generatedAt: { type: Date, default: null },
    remarks: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const shipmentExpenseSchema = new mongoose.Schema(
  {
    expenseType: {
      type: String,
      enum: ["freight", "customs", "trucking", "handling", "courier", "insurance"],
      required: true,
    },
    amount: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    vendorName: { type: String, default: "", trim: true },
    invoiceNo: { type: String, default: "", trim: true },
    remarks: { type: String, default: "", trim: true },
    createdAt: { type: Date, default: () => new Date() },
    createdBy: { type: String, default: "" },
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
      enum: ["PLANNED", "READY", "BOOKED", "PICKED_UP", "CUSTOMS_CLEARANCE", "IN_TRANSIT", "ARRIVED", "DELIVERED", "CLOSED", "CANCELLED"],
      default: "READY",
      index: true,
    },

    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
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
    linkedSalesInvoices: {
      type: [
        {
          invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null },
          invoiceNo: { type: String, default: "", trim: true },
        },
      ],
      default: [],
    },
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
    plannedEta: { type: Date, default: null, index: true },
    actualEta: { type: Date, default: null },
    delayedDays: { type: Number, default: 0, min: 0, index: true },

    weightKg: { type: Number, default: 0 },
    freightCost: { type: Number, default: 0 },
    customsCost: { type: Number, default: 0 },
    truckingCost: { type: Number, default: 0 },
    handlingCost: { type: Number, default: 0 },
    courierCost: { type: Number, default: 0 },
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
    containers: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "ShipmentContainer" }], default: [] },
    exportDocuments: { type: [exportDocumentSchema], default: [] },
    expenses: { type: [shipmentExpenseSchema], default: [] },
    trackingUpdates: { type: [trackingUpdateSchema], default: [] },
    deliveredAt: { type: Date, default: null },
    deliveredBy: { type: String, default: "" },

    remarks: { type: String, default: "" },
  },
  { timestamps: true }
);

shipmentSchema.index({ companyId: 1, shipmentRef: 1 }, { unique: true });
shipmentSchema.index({ companyId: 1, awbNo: 1 });
shipmentSchema.index({ companyId: 1, blNo: 1 });
shipmentSchema.index({ companyId: 1, customerId: 1, status: 1 });
shipmentSchema.index({ companyId: 1, linkedDispatchId: 1 });
shipmentSchema.index({ companyId: 1, trackingStatus: 1, eta: 1 });
shipmentSchema.index({ companyId: 1, status: 1, eta: 1 });
shipmentSchema.index({ companyId: 1, plannedEta: 1, status: 1 });

export default mongoose.model("Shipment", shipmentSchema);
