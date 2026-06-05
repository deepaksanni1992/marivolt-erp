import mongoose from "mongoose";
import Company from "../models/Company.js";
import Counter from "../models/Counter.js";
import CustomsLot from "../models/CustomsLot.js";

const LOT_WIDTH = 4;

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function padSeq(seq) {
  return String(Number(seq) || 0).padStart(LOT_WIDTH, "0");
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
  if (!value) throw new Error("Customs lot numbering requires companyId");
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

async function maxExistingLotSequence({ companyId, prefix }) {
  const regex = new RegExp(`^${escapeRegex(prefix)}-CL-(\\d+)$`, "i");
  const rows = await CustomsLot.find({
    companyId: normalizeCompanyId(companyId),
    customsLotRef: regex,
  })
    .select("customsLotRef")
    .lean();
  let max = 0;
  for (const row of rows) {
    const match = String(row.customsLotRef || "").match(regex);
    const seq = Number(match?.[1] || 0);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

function lotCounterKey(prefix) {
  return `customs-lot:${normalizeCompanyCode(prefix) || "CMP"}`;
}

export async function nextCustomsLotRef({ companyId, companyCode = "" } = {}) {
  const prefix = await resolveCompanyPrefix(companyId, companyCode);
  const key = lotCounterKey(prefix);
  const existingMax = await maxExistingLotSequence({ companyId, prefix });
  const normalizedCompanyId = normalizeCompanyId(companyId);

  await Counter.updateOne(
    { companyId: normalizedCompanyId, key },
    {
      $setOnInsert: { companyId: normalizedCompanyId, key },
      $max: { seq: Math.max(0, Number(existingMax) || 0) },
    },
    { upsert: true },
  );

  const row = await Counter.findOneAndUpdate(
    { companyId: normalizedCompanyId, key },
    {
      $setOnInsert: { companyId: normalizedCompanyId, key },
      $inc: { seq: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: false },
  ).lean();

  return `${prefix}-CL-${padSeq(row.seq)}`;
}
