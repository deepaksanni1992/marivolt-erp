import mongoose from "mongoose";

export const ARTICLE_CONVERSION_STATUSES = Object.freeze([
  "DRAFT",
  "POSTING",
  "POSTED",
  "REVERSING",
  "REVERSED",
  "CANCELLED",
]);

export const ARTICLE_CONVERSION_REASON_CODES = Object.freeze([
  "EQUIVALENT_ARTICLE_NUMBER",
  "SUPPLIER_PART_TO_OEM",
  "SUPERSEDED_ARTICLE",
  "CUSTOMER_ARTICLE_MAPPING",
  "ITEM_MASTER_CORRECTION",
  "REPACKING_REBRANDING",
  "OTHER",
]);

const lotLayerSchema = new mongoose.Schema(
  {
    customsLotId: { type: mongoose.Schema.Types.ObjectId, default: null },
    customsLotItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetCustomsLotItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    customsLotRef: { type: String, default: "", trim: true, uppercase: true },
    grnId: { type: mongoose.Schema.Types.ObjectId, default: null },
    grnNo: { type: String, default: "", trim: true, uppercase: true },
    poNo: { type: String, default: "", trim: true, uppercase: true },
    boeNumber: { type: String, default: "", trim: true },
    blNumber: { type: String, default: "", trim: true },
    awbNumber: { type: String, default: "", trim: true },
    supplierInvoiceNumber: { type: String, default: "", trim: true },
    sourceQty: { type: Number, default: 0, min: 0 },
    targetQty: { type: Number, default: 0, min: 0 },
    unitCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    exchangeRateToAED: { type: Number, default: 0, min: 0 },
    sourceStockValue: { type: Number, default: 0 },
    targetStockValue: { type: Number, default: 0 },
  },
  { _id: false }
);

const articleStockConversionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, default: null },
    conversionNo: { type: String, required: true, trim: true, uppercase: true },
    conversionDate: { type: Date, required: true, default: Date.now },
    warehouse: { type: String, required: true, trim: true, uppercase: true, default: "MAIN" },
    sourceLocation: { type: String, default: "", trim: true, uppercase: true },
    targetLocation: { type: String, default: "", trim: true, uppercase: true },

    sourceArticle: { type: String, required: true, trim: true, uppercase: true, index: true },
    sourceDescription: { type: String, default: "", trim: true },
    sourceUom: { type: String, default: "PCS", trim: true, uppercase: true },
    targetArticle: { type: String, required: true, trim: true, uppercase: true, index: true },
    targetDescription: { type: String, default: "", trim: true },
    targetUom: { type: String, default: "PCS", trim: true, uppercase: true },

    sourceQty: { type: Number, required: true, min: 0 },
    targetQty: { type: Number, required: true, min: 0 },
    conversionRatio: { type: Number, required: true, min: 0, default: 1 },

    reasonCode: {
      type: String,
      enum: ARTICLE_CONVERSION_REASON_CODES,
      required: true,
    },
    remarks: { type: String, required: true, trim: true },

    selectedCustomsLotItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    lotLayers: { type: [lotLayerSchema], default: [] },

    sourceUnitCost: { type: Number, default: 0, min: 0 },
    targetUnitCost: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "USD", trim: true, uppercase: true },
    exchangeRate: { type: Number, default: 1, min: 0 },
    sourceStockValue: { type: Number, default: 0 },
    targetStockValue: { type: Number, default: 0 },
    aedValue: { type: Number, default: 0 },

    equivalenceMappingId: { type: mongoose.Schema.Types.ObjectId, ref: "ArticleEquivalenceMapping", default: null },
    mappingApproved: { type: Boolean, default: false },
    requiresAdminApproval: { type: Boolean, default: false },
    approvalStatus: {
      type: String,
      enum: ["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED"],
      default: "NOT_REQUIRED",
    },
    approvedBy: { type: String, default: "", trim: true },
    approvedAt: { type: Date, default: null },

    attachments: { type: [mongoose.Schema.Types.Mixed], default: [] },

    status: {
      type: String,
      enum: ARTICLE_CONVERSION_STATUSES,
      default: "DRAFT",
      index: true,
    },
    createdBy: { type: String, default: "", trim: true },
    updatedBy: { type: String, default: "", trim: true },
    postedBy: { type: String, default: "", trim: true },
    postedAt: { type: Date, default: null },
    postingOperationId: { type: String, default: "", trim: true },
    reversedBy: { type: String, default: "", trim: true },
    reversedAt: { type: Date, default: null },
    reversalReason: { type: String, default: "", trim: true },
    reversalOperationId: { type: String, default: "", trim: true },
    cancelledBy: { type: String, default: "", trim: true },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, default: "", trim: true },

    outLedgerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    inLedgerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    reversalOutLedgerId: { type: mongoose.Schema.Types.ObjectId, default: null },
    reversalInLedgerId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

articleStockConversionSchema.index({ companyId: 1, conversionNo: 1 }, { unique: true });
articleStockConversionSchema.index({ companyId: 1, status: 1, conversionDate: -1 });
articleStockConversionSchema.index({ companyId: 1, sourceArticle: 1, conversionDate: -1 });
articleStockConversionSchema.index({ companyId: 1, targetArticle: 1, conversionDate: -1 });

export default mongoose.model("ArticleStockConversion", articleStockConversionSchema);
