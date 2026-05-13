import mongoose from "mongoose";
import Company from "../models/Company.js";
import Counter from "../models/Counter.js";
import GRN from "../models/GRN.js";

const GRN_NUMBER_WIDTH = 4;

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function padSeq(seq) {
  return String(Number(seq) || 0).padStart(GRN_NUMBER_WIDTH, "0");
}

function normalizeCompanyCode(value = "") {
  const clean = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return clean ? clean.slice(0, 3) : "";
}

function normalizeCompanyId(companyId) {
  const value = String(companyId || "").trim();
  if (!value) throw new Error("GRN numbering requires companyId");
  return mongoose.Types.ObjectId.isValid(value) ? new mongoose.Types.ObjectId(value) : companyId;
}

async function resolveCompanyPrefix(companyId, companyCode = "") {
  const fromRequest = normalizeCompanyCode(companyCode);
  if (fromRequest) return fromRequest;

  const company = mongoose.Types.ObjectId.isValid(String(companyId || ""))
    ? await Company.findById(companyId).select("code").lean()
    : null;
  return normalizeCompanyCode(company?.code) || "CMP";
}

async function maxExistingGrnSequence({ companyId, prefix }) {
  const regex = new RegExp(`^${escapeRegex(prefix)}-GRN-(\\d+)$`, "i");
  const rows = await GRN.find({ companyId: normalizeCompanyId(companyId), grnNo: regex }).select("grnNo").lean();
  let max = 0;
  for (const row of rows) {
    const match = String(row.grnNo || "").match(regex);
    const seq = Number(match?.[1] || 0);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

function grnCounterKey(prefix) {
  return `grn:${normalizeCompanyCode(prefix) || "CMP"}`;
}

async function ensureCounterAtLeast({ companyId, key, floorSeq }) {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  const filter = { companyId: normalizedCompanyId, key };
  const update = {
    $setOnInsert: { companyId: normalizedCompanyId, key },
    $max: { seq: Math.max(0, Number(floorSeq) || 0) },
  };

  try {
    await Counter.updateOne(filter, update, { upsert: true });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    await Counter.updateOne(filter, { $max: update.$max });
  }
}

/**
 * Returns the next durable, company-prefixed GRN number.
 *
 * The counter is intentionally advanced outside the GRN posting
 * transaction so a duplicate-key retry can consume the next number
 * even when the failed GRN insert rolls back stock and PO updates.
 */
export async function nextGrnNo({ companyId, companyCode = "" } = {}) {
  const prefix = await resolveCompanyPrefix(companyId, companyCode);
  const key = grnCounterKey(prefix);
  const existingMax = await maxExistingGrnSequence({ companyId, prefix });
  await ensureCounterAtLeast({ companyId, key, floorSeq: existingMax });

  const normalizedCompanyId = normalizeCompanyId(companyId);
  const row = await Counter.findOneAndUpdate(
    { companyId: normalizedCompanyId, key },
    {
      $setOnInsert: { companyId: normalizedCompanyId, key },
      $inc: { seq: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: false }
  ).lean();

  return `${prefix}-GRN-${padSeq(row.seq)}`;
}

export default { nextGrnNo };
