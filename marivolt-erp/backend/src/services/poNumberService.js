import DocCounter from "../models/DocCounter.js";
import PurchaseOrder from "../models/PurchaseOrder.js";

const PO_COUNTER_DOC_PREFIX = "PURCHASE_ORDER_SEQ";

/**
 * Company tag for PO numbers: OKE-PO-0001, MAR-PO-0001, etc.
 */
export function resolvePoCompanyTag(companyCode = "", companyName = "") {
  const code = String(companyCode || "").trim().toUpperCase();
  const name = String(companyName || "").toLowerCase();
  if (code === "OKE" || name.includes("okeanos")) return "OKE";
  if (code === "MAR" || name.includes("marivolt")) return "MAR";
  if (code.length >= 2 && code.length <= 8) return code;
  return "PO";
}

export function formatPurchaseOrderNumber(companyTag, seq, padding = 4) {
  return `${companyTag}-PO-${String(seq).padStart(padding, "0")}`;
}

function counterDocKey(companyTag) {
  return `${PO_COUNTER_DOC_PREFIX}:${companyTag}`;
}

/**
 * Raise DocCounter floor to the highest existing {TAG}-PO-NNNN for this company
 * (does not reuse deleted/cancelled numbers — only ensures new seq > legacy max).
 */
export async function ensurePoCounterFloor({ companyId, companyTag }) {
  if (!companyId || !companyTag) return;
  const re = new RegExp(`^${companyTag}-PO-(\\d+)$`, "i");
  const rows = await PurchaseOrder.find({ companyId }).select("poNo poNumber").lean();
  let maxSeq = 0;
  for (const row of rows) {
    for (const field of [row.poNo, row.poNumber]) {
      const m = String(field || "").trim().match(re);
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
  }
  if (maxSeq <= 0) return;
  const docKey = counterDocKey(companyTag);
  await DocCounter.findOneAndUpdate(
    { companyId, docKey },
    { $max: { seq: maxSeq } },
    { upsert: true, setDefaultsOnInsert: { seq: 0 } },
  );
}

async function nextCounterSeq(companyId, companyTag) {
  const docKey = counterDocKey(companyTag);
  const row = await DocCounter.findOneAndUpdate(
    { companyId, docKey },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: { seq: 0 } },
  );
  return row.seq;
}

/**
 * Atomically allocate a company-scoped PO number. Never returns a number already in use.
 */
export async function allocatePurchaseOrderNumber({
  companyId,
  companyCode = "",
  companyName = "",
  padding = 4,
  maxAttempts = 12,
}) {
  if (!companyId) throw new Error("companyId is required to allocate a purchase order number");

  const companyTag = resolvePoCompanyTag(companyCode, companyName);
  await ensurePoCounterFloor({ companyId, companyTag });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const seq = await nextCounterSeq(companyId, companyTag);
    const poNo = formatPurchaseOrderNumber(companyTag, seq, padding);
    const clash = await PurchaseOrder.exists({
      companyId,
      $or: [{ poNo }, { poNumber: poNo }],
    });
    if (!clash) {
      return { poNo, poNumber: poNo, companyTag, seq };
    }
  }

  throw new Error("Unable to allocate a unique purchase order number. Please try again.");
}

/** Remove client-supplied numbers — only the server assigns on create. */
export function stripClientPoNumbers(body) {
  const b = { ...(body || {}) };
  delete b.poNo;
  delete b.poNumber;
  return b;
}

export function isDuplicatePoNumberError(err) {
  if (err?.code !== 11000) return false;
  const msg = String(err.message || "");
  return msg.includes("poNo") || msg.includes("poNumber");
}
