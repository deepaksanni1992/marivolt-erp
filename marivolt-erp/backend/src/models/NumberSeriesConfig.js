import mongoose from "mongoose";

/**
 * NumberSeriesConfig — Phase-10.
 *
 * Configurable document numbering. The legacy generators
 * (`nextSalesDocNumber`, `nextSequentialNumber`) keep working
 * unchanged for documents that don't have a config row; when a row
 * exists for the (companyId, branchId, docKey) triple the new
 * generator (`numberSeriesService.nextNumber`) reads the format
 * from this collection.
 *
 * Format tokens supported:
 *   {COMPANY}  — 2-letter company initial (MV / OK / ...)
 *   {BRANCH}   — branch code (uppercase)
 *   {YYYY}     — 4-digit year, {YY} — 2-digit year
 *   {MM}       — 2-digit month, {DD} — 2-digit day
 *   {SEQ}      — running sequence (left-padded to `padding`)
 *
 * Default formats:
 *   PI / SI — "{COMPANY}/{YYMMDD}.{SEQ}"  (legacy compatible)
 *   GRN     — "GRN-{YYYY}-{SEQ}"
 *   etc.
 */
const SERIES_RESET_CYCLES = ["NEVER", "DAILY", "MONTHLY", "YEARLY"];

const numberSeriesConfigSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },
    /** Document key — uppercase. e.g. SALES_INVOICE, PROFORMA, GRN. */
    docKey: { type: String, required: true, trim: true, uppercase: true },
    description: { type: String, default: "", trim: true },
    prefix: { type: String, default: "", trim: true },
    suffix: { type: String, default: "", trim: true },
    /** Format string with tokens. Falls back to a sensible default if blank. */
    format: { type: String, default: "" },
    padding: { type: Number, default: 4, min: 0, max: 10 },
    startSeq: { type: Number, default: 1, min: 0 },
    /** Period at which the sequence resets. */
    resetCycle: {
      type: String,
      enum: SERIES_RESET_CYCLES,
      default: "DAILY",
    },
    isActive: { type: Boolean, default: true, index: true },
    notes: { type: String, default: "" },
  },
  { timestamps: true }
);

numberSeriesConfigSchema.index(
  { companyId: 1, branchId: 1, docKey: 1 },
  { unique: true }
);

export const NUMBER_SERIES_RESET_CYCLES = SERIES_RESET_CYCLES;
export default mongoose.model("NumberSeriesConfig", numberSeriesConfigSchema);
