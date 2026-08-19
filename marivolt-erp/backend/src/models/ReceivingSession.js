import mongoose from "mongoose";
import { RECEIVING_SESSION_STATUSES } from "../utils/receivingInspectionRules.js";

/**
 * ReceivingSession — one warehouse receiving exercise against an ASN.
 * Statuses: DRAFT | IN_PROGRESS | COMPLETED | CANCELLED
 * COMPLETED means physical inspection is complete. It does not post stock or GRN.
 */
const receivingSessionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    sessionNo: { type: String, required: true, trim: true, uppercase: true },

    asnId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdvanceShipmentNotice",
      required: true,
      index: true,
    },
    asnNo: { type: String, required: true, trim: true, uppercase: true },

    status: {
      type: String,
      enum: RECEIVING_SESSION_STATUSES,
      default: "DRAFT",
      index: true,
    },

    startedBy: { type: String, default: "", trim: true },
    startedAt: { type: Date, default: Date.now },
    lastActivityBy: { type: String, default: "", trim: true },
    lastActivityAt: { type: Date, default: Date.now },
    completedBy: { type: String, default: "", trim: true },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "receivingSessions" }
);

receivingSessionSchema.index({ companyId: 1, sessionNo: 1 }, { unique: true, name: "receivingSessions_company_sessionNo" });
receivingSessionSchema.index(
  { companyId: 1, asnId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["DRAFT", "IN_PROGRESS"] } },
    name: "receivingSessions_one_active_per_asn",
  }
);

export default mongoose.model("ReceivingSession", receivingSessionSchema);
