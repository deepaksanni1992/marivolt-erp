import mongoose from "mongoose";

/**
 * Persisted Reservation Integrity findings.
 * Source of truth for Admin → Inventory → Integrity → Reservation Integrity.
 * Rows are upserted by reservationIntegrityService.validate*; never trust StockBalance alone.
 */
export const RESERVATION_ISSUE_TYPES = Object.freeze([
  "ORPHAN_RESERVED_QTY",
  "RESERVED_QTY_MISMATCH",
  "PACKED_QTY_MISMATCH",
  "AVAILABLE_QTY_MISMATCH",
  "NEGATIVE_RESERVED",
  "NEGATIVE_PACKED",
  "ALLOCATED_WITHOUT_DOCUMENT",
  "PACKED_WITHOUT_DOCUMENT",
]);

export const RESERVATION_ISSUE_SEVERITIES = Object.freeze([
  "Critical",
  "Major",
  "Minor",
  "Info",
]);

export const RESERVATION_ISSUE_STATUSES = Object.freeze([
  "OPEN",
  "RESOLVED",
  "IGNORED",
]);

const reservationIntegrityIssueSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    companyCode: { type: String, default: "", index: true },
    warehouse: { type: String, default: "MAIN", index: true },
    article: { type: String, required: true, index: true },
    stockBalanceId: { type: String, default: "" },

    issueType: {
      type: String,
      enum: RESERVATION_ISSUE_TYPES,
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: RESERVATION_ISSUE_SEVERITIES,
      default: "Major",
      index: true,
    },
    status: {
      type: String,
      enum: RESERVATION_ISSUE_STATUSES,
      default: "OPEN",
      index: true,
    },

    onHandQty: { type: Number, default: 0 },
    reservedQty: { type: Number, default: 0 },
    expectedReservedQty: { type: Number, default: 0 },
    packedQty: { type: Number, default: 0 },
    expectedPackedQty: { type: Number, default: 0 },
    availableQty: { type: Number, default: 0 },
    expectedAvailableQty: { type: Number, default: 0 },

    expected: { type: Number, default: 0 },
    actual: { type: Number, default: 0 },
    difference: { type: Number, default: 0 },

    repairRecommendation: { type: String, default: "" },
    healthScoreImpact: { type: Number, default: 0 },

    documentReferences: {
      type: [
        {
          type: { type: String, default: "" },
          id: { type: String, default: "" },
          number: { type: String, default: "" },
          qty: { type: Number, default: 0 },
        },
      ],
      default: [],
    },

    fingerprint: { type: String, required: true, index: true },
    lastCheckedAt: { type: Date, default: Date.now, index: true },
    resolvedAt: { type: Date, default: null },
    scanId: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

reservationIntegrityIssueSchema.index(
  { companyId: 1, warehouse: 1, article: 1, issueType: 1 },
  { unique: true }
);
reservationIntegrityIssueSchema.index({ companyId: 1, status: 1, severity: 1, updatedAt: -1 });
reservationIntegrityIssueSchema.index({ companyId: 1, fingerprint: 1 });

const ReservationIntegrityIssue = mongoose.model(
  "ReservationIntegrityIssue",
  reservationIntegrityIssueSchema
);

export default ReservationIntegrityIssue;
