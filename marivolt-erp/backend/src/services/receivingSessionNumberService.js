import mongoose from "mongoose";
import Company from "../models/Company.js";
import Counter from "../models/Counter.js";
import ReceivingSession from "../models/ReceivingSession.js";

const RCV_NUMBER_WIDTH = 6;

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function padRcvSeq(seq, padding = RCV_NUMBER_WIDTH) {
  return String(Number(seq) || 0).padStart(padding, "0");
}

export function normalizeCompanyCode(value = "") {
  const clean = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return clean ? clean.slice(0, 3) : "";
}

export function formatReceivingSessionNumber(prefix, seq, padding = RCV_NUMBER_WIDTH) {
  return `${normalizeCompanyCode(prefix) || "CMP"}-RCV-${padRcvSeq(seq, padding)}`;
}

export function receivingSessionCounterKey(prefix) {
  return `rcv:${normalizeCompanyCode(prefix) || "CMP"}`;
}

function normalizeCompanyId(companyId) {
  const value = String(companyId || "").trim();
  if (!value) throw new Error("Receiving session numbering requires companyId");
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

async function maxExistingRcvSequence({ companyId, prefix }) {
  const regex = new RegExp(`^${escapeRegex(prefix)}-RCV-(\\d+)$`, "i");
  const rows = await ReceivingSession.find({
    companyId: normalizeCompanyId(companyId),
    sessionNo: regex,
  })
    .select("sessionNo")
    .lean();
  let max = 0;
  for (const row of rows) {
    const match = String(row.sessionNo || "").match(regex);
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
 * Next durable company-prefixed receiving session number (MAR-RCV-000001).
 * Counter advances even if a session is later cancelled, so numbers are never reused.
 */
export async function nextReceivingSessionNo({ companyId, companyCode = "" } = {}) {
  const prefix = await resolveCompanyPrefix(companyId, companyCode);
  const key = receivingSessionCounterKey(prefix);
  const existingMax = await maxExistingRcvSequence({ companyId, prefix });
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

  return formatReceivingSessionNumber(prefix, row.seq);
}

export default { nextReceivingSessionNo };
