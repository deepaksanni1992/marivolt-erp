import mongoose from "mongoose";
import {
  RECEIVING_PHOTO_CATEGORIES,
  RECEIVING_PHOTO_STATUSES,
} from "../utils/receivingInspectionRules.js";

/**
 * ReceivingUnitPhoto — metadata for one inspection image.
 * Binary lives in AWS S3. Never store image bytes in MongoDB.
 *
 * S3 retention (Phase 3A, intentional, no retention engine):
 * - Wrong photo deleted before RU completion: metadata is soft-deleted, then the S3
 *   object is best-effort deleted. This is a mistaken capture, not inspection evidence.
 * - After the RU result is COMPLETED: delete is blocked; S3 objects are retained.
 */
const receivingUnitPhotoSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    receivingSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReceivingSession",
      required: true,
      index: true,
    },
    receivingSessionUnitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReceivingSessionUnit",
      required: true,
      index: true,
    },
    receivingUnitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReceivingUnit",
      required: true,
      index: true,
    },
    asnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdvanceShipmentNotice",
      required: true,
    },
    asnLineId: { type: mongoose.Schema.Types.ObjectId, required: true },

    category: {
      type: String,
      enum: ["", ...RECEIVING_PHOTO_CATEGORIES],
      default: "",
    },
    remarks: { type: String, default: "", trim: true, maxlength: 500 },

    storageKey: { type: String, required: true, trim: true },
    storageBucket: { type: String, default: "", trim: true },
    storageProvider: { type: String, default: "AWS_S3", trim: true },
    mimeType: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, required: true, min: 1 },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    originalFilename: { type: String, default: "", trim: true },
    clientUploadId: { type: String, default: "", trim: true },

    capturedBy: { type: String, default: "", trim: true },
    capturedAt: { type: Date, default: Date.now },
    uploadedAt: { type: Date, default: Date.now },
    sequence: { type: Number, default: 1, min: 1 },

    status: {
      type: String,
      enum: RECEIVING_PHOTO_STATUSES,
      default: "ACTIVE",
      index: true,
    },
    deletedBy: { type: String, default: "", trim: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "receivingUnitPhotos" }
);

receivingUnitPhotoSchema.index({ companyId: 1, receivingSessionUnitId: 1, sequence: 1 });
receivingUnitPhotoSchema.index(
  { companyId: 1, receivingSessionUnitId: 1, clientUploadId: 1 },
  {
    unique: true,
    partialFilterExpression: { clientUploadId: { $type: "string", $gt: "" } },
    name: "receivingUnitPhotos_retry_idempotency",
  }
);

export default mongoose.model("ReceivingUnitPhoto", receivingUnitPhotoSchema);
