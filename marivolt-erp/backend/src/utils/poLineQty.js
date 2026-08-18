/**
 * Purchase order line quantity helpers.
 *
 * PO lines carry both `qty` and `orderedQty`. The edit form only writes `qty`,
 * so the stored `orderedQty` must never win over an explicitly edited quantity.
 */

/** Ordered quantity of a line: a positive `qty` wins, else fall back to `orderedQty`. */
export function resolveOrderedQty(line = {}) {
  const qty = Number(line?.qty);
  if (Number.isFinite(qty) && qty > 0) return qty;
  const ordered = Number(line?.orderedQty);
  if (Number.isFinite(ordered) && ordered > 0) return ordered;
  return 0;
}

export function poLineToPlain(line) {
  if (!line) return {};
  if (typeof line.toObject === "function") return line.toObject();
  return { ...line };
}

export function poLineItemCode(line = {}) {
  return String(
    line?.itemCode || line?.article || line?.articleNo || line?.materialCode || line?.partNumber || line?.partNo || ""
  ).trim();
}

/** Received / rejected / cancelled quantities are owned by GRN, never by the PO edit form. */
function keepReceiptQtysFromStored(merged, storedLine) {
  const stored = poLineToPlain(storedLine);
  return {
    ...merged,
    receivedQty: Number(stored.receivedQty) || 0,
    rejectedQty: Number(stored.rejectedQty) || 0,
    cancelledQty: Number(stored.cancelledQty) || 0,
    asnActiveQty: Number(stored.asnActiveQty) || 0,
  };
}

export function mergeLinePatch(storedLine, patchLine) {
  const stored = poLineToPlain(storedLine);
  const patch = poLineToPlain(patchLine);
  const provided = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const merged = { ...stored, ...provided, _id: patch._id || stored._id };

  const patchedQty = provided.qty !== undefined ? Number(provided.qty) : Number(provided.orderedQty);
  if (Number.isFinite(patchedQty)) {
    merged.qty = patchedQty;
    merged.orderedQty = patchedQty;
  }

  return keepReceiptQtysFromStored(merged, stored);
}

/**
 * Merge incoming PO lines onto the stored lines, matched by line `_id`.
 * Positional matching is only used for legacy payloads that carry no line ids.
 */
export function mergePoLineBases(storedLines = [], incomingLines = []) {
  const stored = Array.from(storedLines || []);
  if (!Array.isArray(incomingLines) || !incomingLines.length) return stored.map(poLineToPlain);

  const byId = new Map(
    stored.map((line) => [String(line?._id || ""), line]).filter(([id]) => id)
  );
  const payloadHasLineIds = incomingLines.some((line) => String(line?._id || line?.id || "").trim());

  return incomingLines.map((incoming, index) => {
    const raw = incoming || {};
    const id = String(raw._id || raw.id || "").trim();
    const base = (id && byId.get(id)) || (payloadHasLineIds ? null : stored[index]) || null;
    return mergeLinePatch(base, raw);
  });
}

/** Reject non-numeric / zero / negative quantities instead of silently keeping the old value. */
export function validateIncomingPoLineQtys(incomingLines = []) {
  const errors = [];
  (incomingLines || []).forEach((raw, index) => {
    const code = poLineItemCode(raw);
    if (!code) return;
    if (raw?.qty === undefined && raw?.orderedQty === undefined) return;
    const qty = Number(raw.qty ?? raw.orderedQty);
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`Line ${index + 1} (${code}): quantity must be a number greater than zero.`);
    }
  });
  return errors;
}

/** A PO line may not drop below what GRN already received against it. */
export function validateReceivedQtyFloor(storedLines = [], mergedLines = []) {
  const receivedById = new Map();
  for (const line of storedLines || []) {
    const id = String(line?._id || "");
    const received = Number(line?.receivedQty) || 0;
    if (id && received > 0) receivedById.set(id, received);
  }
  if (!receivedById.size) return [];

  const errors = [];
  const keptIds = new Set();
  for (const line of mergedLines || []) {
    const id = String(line?._id || "");
    if (!id) continue;
    keptIds.add(id);
    const received = receivedById.get(id);
    if (!received) continue;
    if (resolveOrderedQty(line) < received - 1e-6) {
      const label = poLineItemCode(line) || id;
      errors.push(`${label}: PO quantity cannot be less than the already received quantity of ${received}.`);
    }
  }
  for (const [id, received] of receivedById) {
    if (keptIds.has(id)) continue;
    errors.push(`A purchase order line with received quantity ${received} cannot be removed.`);
  }
  return errors;
}
