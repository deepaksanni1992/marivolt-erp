import mongoose from "mongoose";

const containerInvoiceSchema = new mongoose.Schema(
  {
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesInvoice", default: null },
    invoiceNo: { type: String, default: "", trim: true },
    dispatchId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesDispatch", default: null },
    dispatchNo: { type: String, default: "", trim: true },
    packageCount: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const shipmentContainerSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Shipment", default: null, index: true },
    shipmentRef: { type: String, default: "", trim: true, index: true },
    containerNo: { type: String, required: true, trim: true, index: true },
    containerType: { type: String, default: "", trim: true },
    sealNo: { type: String, default: "", trim: true },
    grossWeight: { type: Number, default: 0, min: 0 },
    netWeight: { type: Number, default: 0, min: 0 },
    cbm: { type: Number, default: 0, min: 0 },
    packageCount: { type: Number, default: 0, min: 0 },
    invoices: { type: [containerInvoiceSchema], default: [] },
    remarks: { type: String, default: "" },
    status: { type: String, enum: ["ACTIVE", "CANCELLED"], default: "ACTIVE", index: true },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

shipmentContainerSchema.index({ companyId: 1, containerNo: 1 }, { unique: true });
shipmentContainerSchema.index({ companyId: 1, shipmentId: 1, status: 1 });

export default mongoose.model("ShipmentContainer", shipmentContainerSchema);
