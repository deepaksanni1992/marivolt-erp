import mongoose from "mongoose";
import Company from "../models/Company.js";
import Counter from "../models/Counter.js";
import AdvanceShipmentNotice from "../models/AdvanceShipmentNotice.js";

const ASN_NUMBER_WIDTH = 4;

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function padAsnSeq(seq) {
  return String(Number(seq) || 0).padStart(ASN_NUMBER_WIDTH, "0");
}

export function normalizeCompanyCode(value = "") {
  const clean = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return clean ? clean.slice(0, 3) : "";
}

export function formatAsnNumber(prefix, seq, padding = ASN_NUMBER_WIDTH) {
  return `${normalizeCompanyCode(prefix) || "CMP"}-ASN-${String(Number(seq) || 0).padStart(padding, "0")}`;
}

export function asnCounterKey(prefix) {
  return `asn:${normalizeCompanyCode(prefix) || "CMP"}`;
}

function normalizeCompanyId(companyId) {
  const value = String(companyId || "").trim();
  if (!value) throw new Error("ASN numbering requires companyId");
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

async function maxExistingAsnSequence({ companyId, prefix }) {
  const regex = new RegExp(`^${escapeRegex(prefix)}-ASN-(\\d+)$`, "i");
  const rows = await AdvanceShipmentNotice.find({
    companyId: normalizeCompanyId(companyId),
    asnNo: regex,
  })
    .select("asnNo")
    .lean();
  let max = 0;
  for (const row of rows) {
    const match = String(row.asnNo || "").match(regex);
    const seq = Number(match?.[1] || 0);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
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
 * Next durable company-prefixed ASN number (MAR-ASN-0001).
 * Counter advances even if a later insert is cancelled, so numbers are never reused.
 */
export async function nextAsnNo({ companyId, companyCode = "" } = {}) {
  const prefix = await resolveCompanyPrefix(companyId, companyCode);
  const key = asnCounterKey(prefix);
  const existingMax = await maxExistingAsnSequence({ companyId, prefix });
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

  return formatAsnNumber(prefix, row.seq);
}

export default { nextAsnNo };
