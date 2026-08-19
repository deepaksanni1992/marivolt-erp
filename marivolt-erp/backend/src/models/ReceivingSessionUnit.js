import mongoose from "mongoose";
import {
  RECEIVING_CONDITIONS,
  RECEIVING_UNIT_RESULT_STATUSES,
} from "../utils/receivingInspectionRules.js";

/**
 * ReceivingSessionUnit — mutable inspection/count for one Receiving Unit in a session.
 * Identity (ruNo, article, plannedQty, …) is snapshotted from the persisted RU.
 */
const receivingSessionUnitSchema = new mongoose.Schema(
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
    asnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdvanceShipmentNotice",
      required: true,
      index: true,
    },
    asnLineId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    receivingUnitId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReceivingUnit",
      required: true,
      index: true,
    },

    ruNo: { type: String, required: true, trim: true, uppercase: true },
    article: { type: String, default: "", trim: true, uppercase: true },
    partNo: { type: String, default: "", trim: true },
    description: { type: String, default: "", trim: true },
    uom: { type: String, default: "PCS", trim: true },
    plannedQty: { type: Number, required: true, min: 0 },

    actualQty: { type: Number, default: null },
    condition: {
      type: String,
      enum: ["", ...RECEIVING_CONDITIONS],
      default: "",
    },
    remarks: { type: String, default: "", trim: true, maxlength: 2000 },
    qtyConfirmed: { type: Boolean, default: false },

    status: {
      type: String,
      enum: RECEIVING_UNIT_RESULT_STATUSES,
      default: "NOT_STARTED",
      index: true,
    },

    version: { type: Number, default: 0, min: 0 },

    startedBy: { type: String, default: "", trim: true },
    startedAt: { type: Date, default: null },
    completedBy: { type: String, default: "", trim: true },
    completedAt: { type: Date, default: null },
    lastSavedBy: { type: String, default: "", trim: true },
    lastSavedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "receivingSessionUnits" }
);

receivingSessionUnitSchema.index(
  { companyId: 1, receivingSessionId: 1, receivingUnitId: 1 },
  { unique: true, name: "receivingSessionUnits_one_ru_per_session" }
);
receivingSessionUnitSchema.index({ companyId: 1, receivingUnitId: 1, status: 1 });
receivingSessionUnitSchema.index({ companyId: 1, asnId: 1, status: 1 });

export default mongoose.model("ReceivingSessionUnit", receivingSessionUnitSchema);
