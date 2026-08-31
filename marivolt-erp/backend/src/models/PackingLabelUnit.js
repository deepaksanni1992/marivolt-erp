import mongoose from "mongoose";

/**
 * Permanent packing-label identity. One physical first-print face = one unit.
 * Do not reuse ReceivingUnit (ASN/inbound semantics).
 *
 * Phase 2 statuses: PLANNED | PRINTED | CANCELLED | SUPERSEDED.
 * PACKED is reserved for Phase 3 scan-to-pack and is not in this enum.
 */
export const PACKING_LABEL_UNIT_STATUSES = Object.freeze([
  "PLANNED",
  "PRINTED",
  "CANCELLED",
  "SUPERSEDED",
]);

export const PACKING_LABEL_UNIT_SOURCE_TYPES = Object.freeze([
  "PRE_PACKING",
  "POSTED_PACKING",
]);

export const PACKING_LABEL_NO_PATTERN = /^MAR-PL-[0-9]{1,8}$/;

const packingLabelUnitSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
    },
    warehouse: { type: String, default: "", trim: true, uppercase: true },
    labelNo: { type: String, required: true, trim: true, uppercase: true },
    barcodeValue: { type: String, required: true, trim: true, uppercase: true },
    qrVersion: { type: String, default: "MAR1", trim: true, uppercase: true },
    signingKeyId: { type: String, required: true, trim: true, uppercase: true },

    sourceType: {
      type: String,
      enum: PACKING_LABEL_UNIT_SOURCE_TYPES,
      required: true,
    },
    allocationId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    allocationLineId: { type: String, default: "", trim: true },
    packingId: { type: mongoose.Schema.Types.ObjectId, default: null },
    packageId: { type: String, default: "", trim: true },

    article: { type: String, default: "", trim: true, uppercase: true },
    labelQty: { type: Number, required: true, min: 0 },
    orderQtySnapshot: { type: Number, default: 0, min: 0 },
    sequence: { type: Number, required: true, min: 1 },
    sequenceTotal: { type: Number, required: true, min: 1 },

    customerNameSnapshot: { type: String, default: "", trim: true },
    customerPoSnapshot: { type: String, default: "", trim: true },
    mvRefSnapshot: { type: String, default: "", trim: true },
    vesselPlantSnapshot: { type: String, default: "", trim: true },
    brandSnapshot: { type: String, default: "", trim: true },
    modelSnapshot: { type: String, default: "", trim: true },
    descriptionSnapshot: { type: String, default: "", trim: true },
    partNoSnapshot: { type: String, default: "", trim: true },
    /** Reserved for a later Customer Master link. Not required in Phase 2. */
    customerId: { type: mongoose.Schema.Types.ObjectId, default: null },

    status: {
      type: String,
      enum: PACKING_LABEL_UNIT_STATUSES,
      default: "PLANNED",
      index: true,
    },
    originKey: { type: String, required: true, trim: true },

    firstPrintJobId: { type: mongoose.Schema.Types.ObjectId, ref: "LabelPrintJob", default: null },
    printJobIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    printedAt: { type: Date, default: null },

    /** Phase 3 scan-to-pack. Do not set in Phase 2. */
    packedPackageId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** Future split/replacement. Do not set in Phase 2. */
    parentLabelUnitId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededByIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    createdBy: { type: String, default: "", trim: true },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, collection: "packingLabelUnits" }
);

packingLabelUnitSchema.index({ companyId: 1, labelNo: 1 }, { unique: true });
packingLabelUnitSchema.index({ companyId: 1, barcodeValue: 1 }, { unique: true });
packingLabelUnitSchema.index({ companyId: 1, originKey: 1 }, { unique: true });
packingLabelUnitSchema.index({ companyId: 1, allocationId: 1, status: 1 });
packingLabelUnitSchema.index({ companyId: 1, packingId: 1, status: 1 });
packingLabelUnitSchema.index({ companyId: 1, firstPrintJobId: 1 });

export default mongoose.model("PackingLabelUnit", packingLabelUnitSchema);
