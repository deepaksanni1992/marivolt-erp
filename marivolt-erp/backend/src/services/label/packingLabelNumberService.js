import mongoose from "mongoose";
import Counter from "../../models/Counter.js";
import { PACKING_LABEL_NO_PATTERN } from "../../models/PackingLabelUnit.js";

export const PACKING_LABEL_COUNTER_KEY = "packingLabelUnit";
export const PACKING_LABEL_SEQ_MAX = 99_999_999;
export const PACKING_LABEL_PAD_WIDTH = 6;

function normalizeCompanyId(companyId) {
  const value = String(companyId || "").trim();
  if (!value) {
    const err = new Error("Packing label numbering requires companyId");
    err.statusCode = 400;
    err.code = "LABEL_COMPANY_REQUIRED";
    throw err;
  }
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : companyId;
}

export function packingLabelCounterKey() {
  return PACKING_LABEL_COUNTER_KEY;
}

export function formatPackingLabelNo(seq) {
  const n = Math.floor(Number(seq) || 0);
  if (!Number.isFinite(n) || n < 1) {
    const err = new Error("Packing label sequence must be a positive integer");
    err.statusCode = 400;
    err.code = "LABEL_COUNTER_INVALID";
    throw err;
  }
  if (n > PACKING_LABEL_SEQ_MAX) {
    const err = new Error("Packing label counter overflow: maximum eight digits (MAR-PL-99999999)");
    err.statusCode = 409;
    err.code = "LABEL_COUNTER_OVERFLOW";
    throw err;
  }
  const width = n >= 10 ** PACKING_LABEL_PAD_WIDTH ? String(n).length : PACKING_LABEL_PAD_WIDTH;
  const labelNo = `MAR-PL-${String(n).padStart(width, "0")}`;
  if (!PACKING_LABEL_NO_PATTERN.test(labelNo)) {
    const err = new Error("Packing label number failed regex ^MAR-PL-[0-9]{1,8}$");
    err.statusCode = 409;
    err.code = "LABEL_COUNTER_OVERFLOW";
    throw err;
  }
  return labelNo;
}

/**
 * Atomic company-scoped next MAR-PL number.
 * Counter advances even if the unit is later cancelled, so numbers are never reused.
 */
export async function nextPackingLabelNo(companyId) {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  const key = packingLabelCounterKey();
  const row = await Counter.findOneAndUpdate(
    { companyId: normalizedCompanyId, key },
    {
      $setOnInsert: { companyId: normalizedCompanyId, key },
      $inc: { seq: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: false }
  ).lean();

  const seq = Number(row?.seq) || 0;
  if (seq > PACKING_LABEL_SEQ_MAX) {
    await Counter.updateOne(
      { companyId: normalizedCompanyId, key, seq: { $gt: PACKING_LABEL_SEQ_MAX } },
      { $set: { seq: PACKING_LABEL_SEQ_MAX } }
    );
    const err = new Error("Packing label counter overflow: maximum eight digits (MAR-PL-99999999)");
    err.statusCode = 409;
    err.code = "LABEL_COUNTER_OVERFLOW";
    throw err;
  }
  return formatPackingLabelNo(seq);
}

export default { nextPackingLabelNo, formatPackingLabelNo, packingLabelCounterKey };
