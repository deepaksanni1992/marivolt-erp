import mongoose from "mongoose";
import Company from "../models/Company.js";
import Counter from "../models/Counter.js";
import CustomsLot from "../models/CustomsLot.js";
import CustomsInvoice from "../models/CustomsInvoice.js";
import CustomsBoe from "../models/CustomsBoe.js";

const LOT_WIDTH = 4;
const INVOICE_WIDTH = 5;
const BOE_WIDTH = 4;

function escapeRegex(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function padSeq(seq) {
  return String(Number(seq) || 0).padStart(LOT_WIDTH, "0");
}

function padInvoiceSeq(seq) {
  return String(Number(seq) || 0).padStart(INVOICE_WIDTH, "0");
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

async function maxExistingInvoiceSequence({ companyId, prefix }) {
  const regex = new RegExp(`^${escapeRegex(prefix)}-CUS-(\\d+)$`, "i");
  const rows = await CustomsInvoice.find({
    companyId: normalizeCompanyId(companyId),
    customsInvoiceNumber: regex,
  })
    .select("customsInvoiceNumber")
    .lean();
  let max = 0;
  for (const row of rows) {
    const match = String(row.customsInvoiceNumber || "").match(regex);
    const seq = Number(match?.[1] || 0);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

function invoiceCounterKey(prefix) {
  return `customs-invoice:${normalizeCompanyCode(prefix) || "CMP"}`;
}

export async function nextCustomsInvoiceNumber({ companyId, companyCode = "" } = {}) {
  const prefix = await resolveCompanyPrefix(companyId, companyCode);
  const key = invoiceCounterKey(prefix);
  const existingMax = await maxExistingInvoiceSequence({ companyId, prefix });
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

  return `${prefix}-CUS-${padInvoiceSeq(row.seq)}`;
}

function padBoeSeq(seq) {
  return String(Number(seq) || 0).padStart(BOE_WIDTH, "0");
}

async function maxExistingBoeSequence({ companyId, prefix }) {
  const regex = new RegExp(`^${escapeRegex(prefix)}-BOE-(\\d+)$`, "i");
  const rows = await CustomsBoe.find({
    companyId: normalizeCompanyId(companyId),
    customsBoeRef: regex,
  })
    .select("customsBoeRef")
    .lean();
  let max = 0;
  for (const row of rows) {
    const match = String(row.customsBoeRef || "").match(regex);
    const seq = Number(match?.[1] || 0);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

function boeCounterKey(prefix) {
  return `customs-boe:${normalizeCompanyCode(prefix) || "CMP"}`;
}

export async function nextCustomsBoeRef({ companyId, companyCode = "" } = {}) {
  const prefix = await resolveCompanyPrefix(companyId, companyCode);
  const key = boeCounterKey(prefix);
  const existingMax = await maxExistingBoeSequence({ companyId, prefix });
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

  return `${prefix}-BOE-${padBoeSeq(row.seq)}`;
}
