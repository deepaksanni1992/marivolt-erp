import mongoose from "mongoose";
import { RU_STATUSES } from "../utils/receivingUnitRules.js";

/**
 * Receiving Unit — permanent physical identity for one labelled inbound package.
 *
 * Phase 2 persists identity + plannedQty + label print telemetry only.
 * plannedQty is logistics, not stock.
 *
 * Phase 3 (do not implement here):
 *   tablet scan → GET /receiving-units/by-barcode/:barcode (company + barcodeValue)
 *   lookup returns active/current vs CANCELLED/SUPERSEDED (never as a normal active RU)
 *   photos live in a separate collection keyed by receivingUnitId (never binaries on this doc)
 *   actualQty / inspection / GRN linkage are additive future fields
 *   image pipeline (not implemented): camera → EXIF/orientation → client resize/compress → S3
 *   Phase 3 backend still validates MIME, size, and authorization; one RU may have many photos
 *   recommended later config (do not hard-code as Phase 2 constants): long edge ≈ 1800px, quality ≈ 0.80
 *
 * Phase 3A implements receiving inspection in ReceivingSession / ReceivingSessionUnit /
 * ReceivingUnitPhoto. This RU document still has no actualQty or photos fields.
 */
const receivingUnitSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    ruNo: { type: String, required: true, trim: true, uppercase: true },
    barcodeValue: { type: String, required: true, trim: true, uppercase: true },

    asnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdvanceShipmentNotice",
      required: true,
      index: true,
    },
    asnNo: { type: String, required: true, trim: true, uppercase: true },
    asnLineId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    sourcePoId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },
    sourcePoLineId: { type: mongoose.Schema.Types.ObjectId, default: null },

    article: { type: String, default: "", trim: true, uppercase: true },
    description: { type: String, default: "", trim: true },
    partNo: { type: String, default: "", trim: true },
    spn: { type: String, default: "", trim: true },
    uom: { type: String, default: "PCS", trim: true },

    plannedQty: { type: Number, required: true, min: 0 },

    status: {
      type: String,
      enum: RU_STATUSES,
      default: "PLANNED",
      index: true,
    },
    // PLANNED: minted, not yet a confirmed physical label
    // PRINTED: barcode was successfully printed
    // SUPERSEDED: printed (or physically issued) identity replaced by a newer planBatchId
    // CANCELLED: never became a valid physical warehouse identity

    planBatchId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    labelPrintedAt: { type: Date, default: null },
    labelPrintedBy: { type: String, default: "", trim: true },
    lastLabelJobId: { type: mongoose.Schema.Types.ObjectId, ref: "LabelPrintJob", default: null },
    staleLabelJobId: { type: mongoose.Schema.Types.ObjectId, ref: "LabelPrintJob", default: null },
    staleLabelPrintedAt: { type: Date, default: null },
    staleLabelPrintedBy: { type: String, default: "", trim: true },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "", trim: true },
    cancelReason: { type: String, default: "", trim: true },
    supersededAt: { type: Date, default: null },
    supersededByPlanBatchId: { type: mongoose.Schema.Types.ObjectId, default: null },

    createdBy: { type: String, default: "", trim: true },
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, collection: "receivingUnits" }
);

receivingUnitSchema.index({ companyId: 1, ruNo: 1 }, { unique: true });
receivingUnitSchema.index({ companyId: 1, barcodeValue: 1 }, { unique: true });
receivingUnitSchema.index({ companyId: 1, asnId: 1, asnLineId: 1, status: 1 });
receivingUnitSchema.index({ companyId: 1, asnId: 1, status: 1, createdAt: 1 });

export default mongoose.model("ReceivingUnit", receivingUnitSchema);
