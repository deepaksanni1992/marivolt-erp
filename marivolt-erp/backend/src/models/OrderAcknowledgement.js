import mongoose from "mongoose";
import { documentSourceMetadataFields } from "../services/documentSnapshot/documentSourceMetadata.js";

const oaLineSchema = new mongoose.Schema(
  {
    serialNo: { type: Number, default: 0, min: 0 },
    /** Reference-only link to quotation line when OA created from quotation snapshot. */
    sourceQuotationLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    article: { type: String, required: true, trim: true, uppercase: true },
    partNumber: { type: String, default: "", trim: true },
    description: { type: String, default: "" },
    /** Ordered quantity (persisted as qty for downstream compatibility). */
    qty: { type: Number, required: true, min: 0.0001 },
    quotedQty: { type: Number, default: null, min: 0 },
    orderedQty: { type: Number, default: null, min: 0 },
    uom: { type: String, default: "PCS", trim: true },
    price: { type: Number, default: 0, min: 0 },
    quotedPrice: { type: Number, default: null, min: 0 },
    orderedPrice: { type: Number, default: null, min: 0 },
    totalPrice: { type: Number, default: 0, min: 0 },
    lineDiscount: { type: Number, default: 0, min: 0 },
    lineTax: { type: Number, default: 0, min: 0 },
    remarks: { type: String, default: "" },
    materialCode: { type: String, default: "", trim: true },
    availability: { type: String, default: "", trim: true },
    /** When false, line is excluded from OA totals (reference-only rows). */
    includeInOA: { type: Boolean, default: true },
    supplierInfo: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const orderAcknowledgementSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    oaNo: { type: String, required: true, trim: true },
    oaDate: { type: Date, default: () => new Date() },
    linkedQuotationId: { type: mongoose.Schema.Types.ObjectId, ref: "Quotation", index: true },
    linkedQuotationNo: { type: String, default: "", trim: true },
    oaSourceType: { type: String, enum: ["BLANK", "FROM_QUOTATION"], default: "BLANK", trim: true },
    ...documentSourceMetadataFields,
    contactPerson: { type: String, default: "", trim: true },
    attention: { type: String, default: "", trim: true },
    billingAddress: { type: String, default: "", trim: true },
    shippingAddress: { type: String, default: "", trim: true },
    customerName: { type: String, required: true, trim: true, index: true },
    customerPORef: { type: String, default: "", trim: true },
    customerPODate: { type: Date, default: null },
    acknowledgementNotes: { type: String, default: "" },
    termsAndConditions: { type: String, default: "" },
    deliverySchedule: { type: String, default: "" },
    paymentTerms: { type: String, default: "" },
    incoterm: { type: String, default: "" },
    dispatchTerms: { type: String, default: "" },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    vertical: { type: String, default: "", trim: true },
    engine: { type: String, default: "", trim: true },
    model: { type: String, default: "", trim: true },
    config: { type: String, default: "", trim: true },
    esn: { type: String, default: "", trim: true },
    lines: { type: [oaLineSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    discountType: { type: String, enum: ["NONE", "PERCENT", "FLAT"], default: "NONE", trim: true },
    discountValue: { type: Number, default: 0, min: 0 },
    discountTotal: { type: Number, default: 0 },
    taxTotal: { type: Number, default: 0 },
    packingCost: { type: Number, default: 0, min: 0 },
    clearanceCost: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["DRAFT", "ACTIVE", "CONFIRMED", "APPROVED", "CONVERTED", "CLOSED", "CANCELLED"],
      default: "DRAFT",
    },
    convertedTo: [{ type: String, default: "", trim: true }],
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancellationReason: { type: String, default: "" },
    cancelReason: { type: String, default: "" },
    releasedQuotationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Quotation",
      default: null,
      index: true,
    },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

orderAcknowledgementSchema.index({ companyId: 1, oaNo: 1 }, { unique: true });
orderAcknowledgementSchema.index({ companyId: 1, oaDate: -1 });

export default mongoose.model("OrderAcknowledgement", orderAcknowledgementSchema);
