/**
 * CustomsBoe parent helpers — create, search, atomic link qty, status.
 */
import mongoose from "mongoose";
import CustomsBoe from "../models/CustomsBoe.js";
import { nextCustomsBoeRef } from "./customsNumberService.js";
import {
  computeBoeCustomsUnitValue,
  roundCustomsMoney,
  roundCustomsQty,
  CUSTOMS_VALUATION_BOE_AVERAGE,
} from "../utils/customsBoeAverage.js";

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function withCompanyId(companyId, filter = {}) {
  const cid = companyId;
  if (cid == null || cid === "") return { ...filter };
  const s = String(cid).trim();
  if (mongoose.Types.ObjectId.isValid(s)) {
    const oid = new mongoose.Types.ObjectId(s);
    if (!Object.keys(filter).length) {
      return { $or: [{ companyId: oid }, { companyId: s }] };
    }
    return { $and: [{ ...filter }, { $or: [{ companyId: oid }, { companyId: s }] }] };
  }
  return { ...filter, companyId: cid };
}

function parseDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Pure guard used by atomic reserve and unit tests. */
export function canReserveLinkedQty({ boeDeclaredQty, linkedCustomsQty, delta }) {
  const declared = roundCustomsQty(boeDeclaredQty);
  const linked = roundCustomsQty(linkedCustomsQty);
  const add = roundCustomsQty(delta);
  if (!(add > 0)) return { ok: false, message: "This GRN customs qty must be greater than zero" };
  if (!(declared > 0)) return { ok: false, message: "BOE Declared Qty must be greater than zero" };
  if (roundCustomsQty(linked + add) > declared + 1e-9) {
    const remaining = roundCustomsQty(Math.max(0, declared - linked));
    return {
      ok: false,
      message: `Cannot link customs qty ${add}: only ${remaining} remaining of BOE declared qty ${declared}.`,
      remaining,
      declared,
      linked,
      delta: add,
    };
  }
  return {
    ok: true,
    remainingAfter: roundCustomsQty(declared - linked - add),
    declared,
    linked,
    delta: add,
  };
}

/**
 * Mongo filter for atomic linkedCustomsQty increment.
 * Succeeds only when linkedCustomsQty + delta <= boeDeclaredQty.
 */
export function buildLinkedQtyReserveFilter({ boeId, companyId, delta, boeDeclaredQty }) {
  const add = roundCustomsQty(delta);
  const declared = roundCustomsQty(boeDeclaredQty);
  const maxLinkedBefore = roundCustomsQty(declared - add);
  return withCompanyId(companyId, {
    _id: boeId,
    status: { $nin: ["CANCELLED"] },
    linkedCustomsQty: { $lte: maxLinkedBefore + 1e-9 },
  });
}

export function deriveCustomsBoeStatus({
  boeDeclaredQty,
  linkedCustomsQty,
  remainingStockQty = null,
  currentStatus = "OPEN",
} = {}) {
  const st = upper(currentStatus);
  if (st === "CANCELLED") return "CANCELLED";
  const declared = roundCustomsQty(boeDeclaredQty);
  const linked = roundCustomsQty(linkedCustomsQty);
  if (linked <= 1e-9) return "OPEN";
  if (Math.abs(linked - declared) <= 1e-6) {
    // CLOSED is derived when remaining stock known and zero; else RECONCILED.
    if (remainingStockQty != null && roundCustomsQty(remainingStockQty) <= 1e-9) {
      return "CLOSED";
    }
    return "RECONCILED";
  }
  return "OPEN";
}

export function remainingToLinkQty({ boeDeclaredQty, linkedCustomsQty }) {
  return roundCustomsQty(Math.max(0, roundCustomsQty(boeDeclaredQty) - roundCustomsQty(linkedCustomsQty)));
}

/**
 * Detect probable duplicate BOEs (same company, same external BOE # and/or BL).
 * Does not block create — caller may warn and offer Use Existing.
 */
export async function findProbableDuplicateBoes({
  companyId,
  boeNumber = "",
  blNumber = "",
  excludeBoeId = null,
  session = null,
} = {}) {
  const boe = t(boeNumber);
  const bl = t(blNumber);
  if (!boe && !bl) return [];
  const or = [];
  if (boe) or.push({ boeNumber: new RegExp(`^${boe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
  if (bl) or.push({ blNumber: new RegExp(`^${bl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
  const filter = withCompanyId(companyId, {
    status: { $ne: "CANCELLED" },
    $or: or,
  });
  if (excludeBoeId) filter._id = { $ne: excludeBoeId };
  let q = CustomsBoe.find(filter)
    .select(
      "customsBoeRef boeNumber boeDate blNumber awbNumber boeDeclaredQty boeDeclaredValue customsUnitValue customsCurrency linkedCustomsQty status companyCode",
    )
    .sort({ createdAt: -1 })
    .limit(10);
  if (session) q = q.session(session);
  return q.lean();
}

export async function searchCustomsBoes({ companyId, q = "", limit = 20, session = null } = {}) {
  const term = t(q);
  const filter = withCompanyId(companyId, { status: { $ne: "CANCELLED" } });
  if (term) {
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$and = [
      ...(filter.$and || []),
      {
        $or: [{ customsBoeRef: rx }, { boeNumber: rx }, { blNumber: rx }, { awbNumber: rx }],
      },
    ];
  }
  let query = CustomsBoe.find(filter)
    .sort({ boeDate: -1, createdAt: -1 })
    .limit(Math.min(50, Math.max(1, Number(limit) || 20)));
  if (session) query = query.session(session);
  const rows = await query.lean();
  return rows.map((row) => ({
    ...row,
    remainingToLink: remainingToLinkQty(row),
    inboundStatus: deriveCustomsBoeStatus(row),
  }));
}

export async function getCustomsBoeByIdOrRef({ companyId, idOrRef, session = null } = {}) {
  const raw = t(idOrRef);
  if (!raw) return null;
  let filter;
  if (mongoose.Types.ObjectId.isValid(raw) && String(new mongoose.Types.ObjectId(raw)) === raw) {
    filter = withCompanyId(companyId, { _id: raw });
  } else {
    filter = withCompanyId(companyId, { customsBoeRef: upper(raw) });
  }
  let q = CustomsBoe.findOne(filter);
  if (session) q = q.session(session);
  return q;
}

/**
 * Create a new parent CustomsBoe with frozen unit value.
 */
export async function createCustomsBoe({
  session = null,
  req,
  header = {},
  warnDuplicates = true,
} = {}) {
  const companyId = req.companyId;
  const companyCode = upper(req.companyCode || "CMP");
  const boeDeclaredQty = roundCustomsQty(header.boeDeclaredQty);
  const boeDeclaredValue = roundCustomsMoney(header.boeDeclaredValue);
  const unitCalc = computeBoeCustomsUnitValue(boeDeclaredValue, boeDeclaredQty);
  if (!unitCalc.ok) throw new Error(unitCalc.message || "Invalid BOE economics");

  const currency = upper(header.customsCurrency || header.currency || "USD") || "USD";
  let fx = Number(header.exchangeRateToAED);
  if (currency === "AED") fx = 1;
  if (!(fx > 0)) throw new Error("Exchange Rate to AED is required");

  const duplicates = warnDuplicates
    ? await findProbableDuplicateBoes({
        companyId,
        boeNumber: header.boeNumber,
        blNumber: header.blNumber,
        session,
      })
    : [];

  const customsBoeRef = await nextCustomsBoeRef({ companyId, companyCode });
  const lockedAt = new Date();
  const rows = await CustomsBoe.create(
    [
      {
        companyId,
        companyCode,
        customsBoeRef,
        boeNumber: t(header.boeNumber),
        boeDate: parseDate(header.boeDate),
        blNumber: t(header.blNumber),
        awbNumber: t(header.awbNumber),
        boeDeclaredQty,
        customsUom: upper(header.customsUom || "PCS") || "PCS",
        boeDeclaredValue,
        customsCurrency: currency,
        exchangeRateToAED: fx,
        customsUnitValue: unitCalc.customsUnitValue,
        grossWeightKg: Number(header.grossWeightKg) || 0,
        netWeightKg: Number(header.netWeightKg) || 0,
        valuationMethod: CUSTOMS_VALUATION_BOE_AVERAGE,
        valuationLockedAt: lockedAt,
        linkedCustomsQty: 0,
        status: "OPEN",
        createdBy: req.user?.email || "",
        updatedBy: req.user?.email || "",
      },
    ],
    session ? { session } : undefined,
  );
  const boe = rows[0];
  return { boe, duplicates, customsUnitValue: unitCalc.customsUnitValue };
}

/**
 * Atomically reserve (increment) linkedCustomsQty. Throws on over-link or concurrent conflict.
 */
export async function reserveLinkedCustomsQty({
  session = null,
  companyId,
  customsBoeId,
  delta,
  updatedBy = "",
} = {}) {
  const add = roundCustomsQty(delta);
  if (!(add > 0)) throw new Error("This GRN customs qty must be greater than zero");

  let findQ = CustomsBoe.findOne(withCompanyId(companyId, { _id: customsBoeId }));
  if (session) findQ = findQ.session(session);
  const current = await findQ;
  if (!current) throw new Error("Customs BOE not found for this company");
  if (upper(current.status) === "CANCELLED") throw new Error("Cannot link to a cancelled Customs BOE");

  const guard = canReserveLinkedQty({
    boeDeclaredQty: current.boeDeclaredQty,
    linkedCustomsQty: current.linkedCustomsQty,
    delta: add,
  });
  if (!guard.ok) throw new Error(guard.message);

  const filter = buildLinkedQtyReserveFilter({
    boeId: current._id,
    companyId,
    delta: add,
    boeDeclaredQty: current.boeDeclaredQty,
  });

  const nextStatus = deriveCustomsBoeStatus({
    boeDeclaredQty: current.boeDeclaredQty,
    linkedCustomsQty: roundCustomsQty(Number(current.linkedCustomsQty) + add),
    currentStatus: current.status,
  });

  let updQ = CustomsBoe.findOneAndUpdate(
    filter,
    {
      $inc: { linkedCustomsQty: add },
      $set: {
        updatedBy: updatedBy || "",
        status: nextStatus === "CLOSED" ? "RECONCILED" : nextStatus,
      },
    },
    { new: true },
  );
  if (session) updQ = updQ.session(session);
  const updated = await updQ;
  if (!updated) {
    throw new Error(
      "Customs BOE link conflict: remaining qty was claimed by another GRN. Refresh and try again.",
    );
  }
  return updated;
}

/**
 * Release linked qty on GRN cancel (decrement). Never changes frozen economics.
 */
export async function releaseLinkedCustomsQty({
  session = null,
  companyId,
  customsBoeId,
  delta,
  updatedBy = "",
} = {}) {
  const sub = roundCustomsQty(delta);
  if (!(sub > 0) || !customsBoeId) return null;

  let findQ = CustomsBoe.findOne(withCompanyId(companyId, { _id: customsBoeId }));
  if (session) findQ = findQ.session(session);
  const current = await findQ;
  if (!current) return null;

  const nextLinked = roundCustomsQty(Math.max(0, roundCustomsQty(current.linkedCustomsQty) - sub));
  const nextStatus = deriveCustomsBoeStatus({
    boeDeclaredQty: current.boeDeclaredQty,
    linkedCustomsQty: nextLinked,
    currentStatus: current.status === "CANCELLED" ? "CANCELLED" : "OPEN",
  });

  let updQ = CustomsBoe.findOneAndUpdate(
    withCompanyId(companyId, { _id: customsBoeId }),
    {
      $inc: { linkedCustomsQty: -sub },
      $set: {
        updatedBy: updatedBy || "",
        status: nextStatus === "CANCELLED" ? "CANCELLED" : nextStatus,
      },
    },
    { new: true },
  );
  if (session) updQ = updQ.session(session);
  const updated = await updQ;
  // Clamp if floating underflow
  if (updated && Number(updated.linkedCustomsQty) < 0) {
    updated.linkedCustomsQty = 0;
    await updated.save({ session });
  }
  return updated;
}

export function mapBoeEconomicsToLotSnapshot(boe) {
  return {
    customsBoeId: boe._id,
    customsBoeRef: boe.customsBoeRef || "",
    boeNumber: boe.boeNumber || "",
    boeDate: boe.boeDate || null,
    blNumber: boe.blNumber || "",
    awbNumber: boe.awbNumber || "",
    boeDeclaredQty: Number(boe.boeDeclaredQty) || 0,
    customsUom: boe.customsUom || "PCS",
    boeDeclaredValue: Number(boe.boeDeclaredValue) || 0,
    currency: boe.customsCurrency || "USD",
    exchangeRateToAED: Number(boe.exchangeRateToAED) || 0,
    customsUnitValue: Number(boe.customsUnitValue) || 0,
    customsUnitPrice: Number(boe.customsUnitValue) || 0,
    grossWeightKg: Number(boe.grossWeightKg) || 0,
    netWeightKg: Number(boe.netWeightKg) || 0,
    valuationMethod: boe.valuationMethod || CUSTOMS_VALUATION_BOE_AVERAGE,
    valuationLockedAt: boe.valuationLockedAt || null,
  };
}

export { withCompanyId as customsBoeWithCompanyId };
