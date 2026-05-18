/**
 * Document Lifecycle / State Machine.
 *
 *  Phase-8 introduces strict ERP statuses for every sales document.
 *  The actual schema enums on each Mongoose model are kept
 *  backward-compatible (so historical rows still validate), but every
 *  status mutation in a controller MUST go through `assertTransition`
 *  defined here. Illegal transitions throw a structured
 *  `INVALID_TRANSITION` error so the frontend can surface a clear
 *  message instead of corrupting the lifecycle.
 *
 *  Each document type has:
 *    - `aliases`       legacy → canonical status mapping
 *    - `transitions`   from-status → list of allowed to-statuses
 *    - `terminal`      statuses from which no further transition is
 *                      allowed unless explicitly noted
 *
 *  Reverse-flow rules (Part 2 of the Phase-8 spec):
 *    - Sales Invoice CANCEL is allowed iff `paymentReceivedAmount = 0`
 *      (enforced in the invoice controller, not here).
 *    - RTS CANCEL puts qty back into Allocated (handled in flow code).
 *    - OA CANCEL is rejected if any RTS already exists for that OA
 *      (enforced by `assertNoChildDocs`, used by the controller).
 *
 *  This file is **pure** — it does not touch the DB. It is safe to
 *  call from middlewares, controllers, or tests.
 */

const QUOTATION = {
  canonical: ["DRAFT", "SENT", "APPROVED", "CANCELLED"],
  aliases: {
    DRAFT: "DRAFT",
    SENT: "SENT",
    APPROVED: "APPROVED",
    ACTIVE: "APPROVED",
    CONFIRMED: "APPROVED",
    CLOSED: "APPROVED",
    REJECTED: "CANCELLED",
    EXPIRED: "CANCELLED",
    CONVERTED: "APPROVED",
    CANCELLED: "CANCELLED",
  },
  transitions: {
    DRAFT: ["SENT", "APPROVED", "CANCELLED"],
    SENT: ["APPROVED", "CANCELLED"],
    APPROVED: ["CANCELLED"],
    CANCELLED: [],
  },
};

const PROFORMA = {
  canonical: ["DRAFT", "PENDING_PAYMENT", "PARTIAL_PAYMENT", "PAID", "CANCELLED"],
  aliases: {
    DRAFT: "DRAFT",
    ISSUED: "PENDING_PAYMENT",
    PENDING_PAYMENT: "PENDING_PAYMENT",
    PARTIAL_PAYMENT: "PARTIAL_PAYMENT",
    PAID: "PAID",
    PAID_PENDING_SHIPMENT: "PAID",
    APPROVED: "PAID",
    CONVERTED: "PAID",
    CANCELLED: "CANCELLED",
  },
  transitions: {
    DRAFT: ["PENDING_PAYMENT", "CANCELLED"],
    PENDING_PAYMENT: ["PARTIAL_PAYMENT", "PAID", "CANCELLED"],
    PARTIAL_PAYMENT: ["PARTIAL_PAYMENT", "PAID", "CANCELLED"],
    PAID: ["CANCELLED"],
    CANCELLED: [],
  },
};

const ORDER_ALLOCATION = {
  canonical: ["ALLOCATED", "PARTIALLY_PACKED", "FULLY_PACKED", "INVOICED", "CANCELLED"],
  aliases: {
    OPEN: "ALLOCATED",
    ALLOCATED: "ALLOCATED",
    PARTIALLY_PACKED: "PARTIALLY_PACKED",
    FULLY_PACKED: "FULLY_PACKED",
    PARTIALLY_RTS: "PARTIALLY_PACKED",
    PARTIAL_RTS: "PARTIALLY_PACKED",
    RTS_COMPLETE: "FULLY_PACKED",
    APPROVED: "FULLY_PACKED",
    CLOSED: "INVOICED",
    INVOICED: "INVOICED",
    CONVERTED: "INVOICED",
    CANCELLED: "CANCELLED",
  },
  transitions: {
    ALLOCATED: ["PARTIALLY_PACKED", "FULLY_PACKED", "CANCELLED"],
    PARTIALLY_PACKED: ["PARTIALLY_PACKED", "FULLY_PACKED", "ALLOCATED", "CANCELLED"],
    FULLY_PACKED: ["INVOICED", "PARTIALLY_PACKED", "CANCELLED"],
    INVOICED: ["CANCELLED"],
    CANCELLED: [],
  },
};

const RTS = {
  canonical: ["PENDING", "APPROVED", "DISPATCHED", "CANCELLED"],
  aliases: {
    DRAFT: "PENDING",
    PENDING: "PENDING",
    APPROVED: "APPROVED",
    DISPATCHED: "DISPATCHED",
    CONVERTED_TO_INVOICE: "DISPATCHED",
    CANCELLED: "CANCELLED",
  },
  transitions: {
    PENDING: ["APPROVED", "CANCELLED"],
    APPROVED: ["DISPATCHED", "CANCELLED"],
    DISPATCHED: ["CANCELLED"],
    CANCELLED: [],
  },
};

const SALES_INVOICE = {
  canonical: ["DRAFT", "POSTED", "PARTIAL_PAYMENT", "PAID", "CANCELLED"],
  aliases: {
    DRAFT: "DRAFT",
    POSTED: "POSTED",
    ISSUED: "POSTED",
    DISPATCHED: "POSTED",
    PARTIALLY_PAID: "PARTIAL_PAYMENT",
    PARTIAL_PAYMENT: "PARTIAL_PAYMENT",
    PAID: "PAID",
    CANCELLED: "CANCELLED",
  },
  transitions: {
    DRAFT: ["POSTED", "CANCELLED"],
    POSTED: ["PARTIAL_PAYMENT", "PAID", "CANCELLED"],
    PARTIAL_PAYMENT: ["PARTIAL_PAYMENT", "PAID", "CANCELLED"],
    PAID: ["CANCELLED"],
    CANCELLED: [],
  },
};

export const DOC_TYPES = {
  QUOTATION: "QUOTATION",
  PROFORMA: "PROFORMA",
  ORDER_ALLOCATION: "ORDER_ALLOCATION",
  RTS: "RTS",
  SALES_INVOICE: "SALES_INVOICE",
};

const REGISTRY = {
  [DOC_TYPES.QUOTATION]: QUOTATION,
  [DOC_TYPES.PROFORMA]: PROFORMA,
  [DOC_TYPES.ORDER_ALLOCATION]: ORDER_ALLOCATION,
  [DOC_TYPES.RTS]: RTS,
  [DOC_TYPES.SALES_INVOICE]: SALES_INVOICE,
};

/**
 * Translate any (legacy or canonical) status into the Phase-8
 * canonical form used by the state machine.
 */
export function canonicalStatus(docType, status) {
  const cfg = REGISTRY[docType];
  if (!cfg) return status;
  const norm = String(status || "").trim().toUpperCase();
  if (!norm) return cfg.canonical[0];
  return cfg.aliases[norm] || norm;
}

/**
 * Returns true iff the transition `from → to` is allowed for the
 * given document type. `from` and `to` may be passed as legacy
 * statuses; both are normalised through `canonicalStatus` first.
 */
export function isTransitionAllowed(docType, from, to) {
  const cfg = REGISTRY[docType];
  if (!cfg) return true; // unknown doc type — fail open, controller-level checks remain authoritative
  const f = canonicalStatus(docType, from);
  const t = canonicalStatus(docType, to);
  if (f === t) return true; // re-entrant write of the same status is harmless
  const allowed = cfg.transitions[f] || [];
  return allowed.includes(t);
}

/**
 * Throws a structured error if the transition is illegal. The error
 * carries `code: "INVALID_TRANSITION"` so the API layer can surface
 * a 409 response that the frontend can show as a friendly toast.
 */
export function assertTransition(docType, from, to, opts = {}) {
  if (isTransitionAllowed(docType, from, to)) return;
  const f = canonicalStatus(docType, from);
  const t = canonicalStatus(docType, to);
  const err = new Error(
    `${docType} cannot transition from ${f} to ${t}` +
      (opts.documentNo ? ` for ${opts.documentNo}` : "")
  );
  err.statusCode = 409;
  err.code = "INVALID_TRANSITION";
  err.details = {
    docType,
    from: f,
    to: t,
    allowed: REGISTRY[docType]?.transitions?.[f] || [],
    documentNo: opts.documentNo || "",
  };
  throw err;
}

/**
 * Helper used by controllers that want to short-circuit a flow with
 * a specific business rule (e.g. "cannot cancel invoice with received
 * payment"). Provides the same error shape as `assertTransition`.
 */
export function blockTransition(docType, from, to, message, extra = {}) {
  const err = new Error(message);
  err.statusCode = 409;
  err.code = "INVALID_TRANSITION";
  err.details = {
    docType,
    from: canonicalStatus(docType, from),
    to: canonicalStatus(docType, to),
    ...extra,
  };
  throw err;
}

export function listAllowed(docType, from) {
  return REGISTRY[docType]?.transitions?.[canonicalStatus(docType, from)] || [];
}

export function isTerminal(docType, status) {
  const cfg = REGISTRY[docType];
  if (!cfg) return false;
  const c = canonicalStatus(docType, status);
  return (cfg.transitions[c] || []).length === 0;
}

export default {
  DOC_TYPES,
  canonicalStatus,
  isTransitionAllowed,
  assertTransition,
  blockTransition,
  listAllowed,
  isTerminal,
};
