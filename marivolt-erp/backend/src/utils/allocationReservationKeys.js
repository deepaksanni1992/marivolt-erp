/**
 * P3 — Order Allocation reservation effectKey identity.
 *
 * ============================================================================
 * Semantics (explicit invariants)
 * ============================================================================
 *
 * reservationEffectVersion
 *   - 1 = legacy / missing field: v1 human-number identity family
 *   - 2 = this allocation uses v2 immutable reservation identity semantics
 *   - Version 2 does NOT assert that a reserve ledger row already exists
 *     (create stamps v2 before reserve; txn rollback removes the doc if
 *     reserve fails). Future reserve/release/retry for version≥2 MUST use v2.
 *
 * reservationIdentityNo
 *   - Frozen ORIGINAL allocationNo used to construct v1 effectKeys
 *   - Immutable after first establishment; never updated on display rename
 *   - Used only for legacy v1 release reconstruction
 *
 * Active reservation identity family is exactly ONE of:
 *   LEGACY V1  or  IMMUTABLE V2
 * Never both for the same release operation.
 *
 * Formats:
 *   v1: alloc:reserve:{companyId}:{allocationNo}:{article}
 *   v2: alloc:reserve:v2:{companyId}:{allocationId}:{article}
 *
 * Reservation granularity matches reserveAllocationLines dedupe-by-article
 * (duplicate Article lines share one reserve effect per allocation).
 *
 * Historical StockLedger rows are never rewritten.
 */

export const ALLOC_RESERVE_EFFECT_V1_PREFIX = "alloc:reserve:";
export const ALLOC_RELEASE_EFFECT_V1_PREFIX = "alloc:release:";
export const ALLOC_RESERVE_EFFECT_V2_PREFIX = "alloc:reserve:v2:";
export const ALLOC_RELEASE_EFFECT_V2_PREFIX = "alloc:release:v2:";

export const RESERVATION_EFFECT_VERSION_V1 = 1;
export const RESERVATION_EFFECT_VERSION_V2 = 2;

function s(v) {
  return String(v ?? "").trim();
}

function articleKey(article) {
  return s(article).toUpperCase();
}

/** v1 human-number key (legacy / frozen identity number). */
export function buildAllocReserveEffectKeyV1({ companyId, allocationNo, article }) {
  return `${ALLOC_RESERVE_EFFECT_V1_PREFIX}${s(companyId)}:${s(allocationNo)}:${articleKey(article)}`;
}

export function buildAllocReleaseEffectKeyV1({ companyId, allocationNo, article }) {
  return `${ALLOC_RELEASE_EFFECT_V1_PREFIX}${s(companyId)}:${s(allocationNo)}:${articleKey(article)}`;
}

/** v2 immutable allocationId key. */
export function buildAllocReserveEffectKeyV2({ companyId, allocationId, article }) {
  return `${ALLOC_RESERVE_EFFECT_V2_PREFIX}${s(companyId)}:${s(allocationId)}:${articleKey(article)}`;
}

export function buildAllocReleaseEffectKeyV2({ companyId, allocationId, article }) {
  return `${ALLOC_RELEASE_EFFECT_V2_PREFIX}${s(companyId)}:${s(allocationId)}:${articleKey(article)}`;
}

/**
 * Build reserve key for an allocation based on stamped metadata.
 * Production create paths call buildAllocReserveEffectKeyV2 directly so new
 * reserves never depend on a missing/stale version field.
 */
export function buildAllocReserveEffectKeyForAllocation({ companyId, allocation, article }) {
  const version = Number(allocation?.reservationEffectVersion) || RESERVATION_EFFECT_VERSION_V1;
  if (version >= RESERVATION_EFFECT_VERSION_V2 && allocation?._id) {
    return buildAllocReserveEffectKeyV2({
      companyId,
      allocationId: allocation._id,
      article,
    });
  }
  const identityNo = s(allocation?.reservationIdentityNo) || s(allocation?.allocationNo);
  return buildAllocReserveEffectKeyV1({
    companyId,
    allocationNo: identityNo,
    article,
  });
}

/**
 * Resolve exactly ONE release effectKey family.
 *
 * Strategy:
 * 1. If reservationEffectVersion >= 2 → v2 release (deterministic; no DB lookup)
 * 2. Else if a v2 reserve effectKey already exists in StockLedger → v2 release
 *    (bounded exact-match lookup; cancel/release path only)
 * 3. Else v1 release using frozen reservationIdentityNo
 *    (fallback: current allocationNo — safe only because legacy active
 *    reservations cannot be renamed under P3)
 *
 * Never emit both v1 and v2 for the same article release.
 *
 * @param {{
 *   companyId: any,
 *   allocation: object,
 *   article: string,
 *   reserveExists?: (effectKey: string) => Promise<boolean>,
 * }} args
 */
export async function resolveAllocReleaseEffectKey({
  companyId,
  allocation,
  article,
  reserveExists,
}) {
  const version = Number(allocation?.reservationEffectVersion) || RESERVATION_EFFECT_VERSION_V1;
  const v2Reserve = allocation?._id
    ? buildAllocReserveEffectKeyV2({
        companyId,
        allocationId: allocation._id,
        article,
      })
    : "";

  let useV2 = version >= RESERVATION_EFFECT_VERSION_V2;
  if (!useV2 && v2Reserve && typeof reserveExists === "function") {
    // Exact effectKey match on StockLedger — used only when version stamp is
    // absent/legacy but a v2 reserve somehow exists. Cancel path only.
    useV2 = Boolean(await reserveExists(v2Reserve));
  }

  if (useV2 && allocation?._id) {
    return {
      version: RESERVATION_EFFECT_VERSION_V2,
      effectKey: buildAllocReleaseEffectKeyV2({
        companyId,
        allocationId: allocation._id,
        article,
      }),
      reserveEffectKey: v2Reserve,
    };
  }

  const identityNo = s(allocation?.reservationIdentityNo) || s(allocation?.allocationNo);
  return {
    version: RESERVATION_EFFECT_VERSION_V1,
    effectKey: buildAllocReleaseEffectKeyV1({
      companyId,
      allocationNo: identityNo,
      article,
    }),
    reserveEffectKey: buildAllocReserveEffectKeyV1({
      companyId,
      allocationNo: identityNo,
      article,
    }),
  };
}

/** True if allocation uses immutable v2 reservation identity semantics. */
export function allocationUsesV2ReservationIdentity(allocation) {
  return Number(allocation?.reservationEffectVersion) >= RESERVATION_EFFECT_VERSION_V2;
}

/**
 * Remaining qty that still occupies the reserved bucket for this allocation
 * (ordered − packed). Used by rename guards to detect active reservations.
 */
export function allocationRemainingReservedQty(allocation) {
  return (allocation?.lines || []).reduce((sum, line) => {
    const qty = Math.max(0, Number(line?.qty) || 0);
    const packed = Math.max(0, Number(line?.packedQty) || 0);
    return sum + Math.max(0, qty - packed);
  }, 0);
}

/**
 * Detect alloc:* effectKey shape for diagnostics (does not mutate ledger).
 * @returns {{ kind: 'reserve'|'release'|null, version: 1|2|null, companyId?: string, identity?: string, article?: string }}
 */
export function parseAllocReservationEffectKey(effectKey) {
  const raw = s(effectKey);
  if (!raw) return { kind: null, version: null };

  let m = raw.match(/^alloc:reserve:v2:([^:]+):([^:]+):(.+)$/i);
  if (m) {
    return { kind: "reserve", version: 2, companyId: m[1], identity: m[2], article: m[3].toUpperCase() };
  }
  m = raw.match(/^alloc:release:v2:([^:]+):([^:]+):(.+)$/i);
  if (m) {
    return { kind: "release", version: 2, companyId: m[1], identity: m[2], article: m[3].toUpperCase() };
  }
  m = raw.match(/^alloc:reserve:([^:]+):([^:]+):(.+)$/i);
  if (m && !String(m[1]).toLowerCase().startsWith("v2")) {
    return { kind: "reserve", version: 1, companyId: m[1], identity: m[2], article: m[3].toUpperCase() };
  }
  m = raw.match(/^alloc:release:([^:]+):([^:]+):(.+)$/i);
  if (m && !String(m[1]).toLowerCase().startsWith("v2")) {
    return { kind: "release", version: 1, companyId: m[1], identity: m[2], article: m[3].toUpperCase() };
  }
  return { kind: null, version: null };
}

/**
 * In-memory effectKey store mirroring stockService allocate/cancel idempotency:
 * existing effectKey → return existing row, do not mutate buckets again.
 */
export function createAllocEffectIdempotencySimulator(initialReservedQty = 0) {
  const ledgerByKey = new Map();
  let reservedQty = Number(initialReservedQty) || 0;
  return {
    get reservedQty() {
      return reservedQty;
    },
    get ledgerCount() {
      return ledgerByKey.size;
    },
    has(effectKey) {
      return ledgerByKey.has(String(effectKey || ""));
    },
    reserve(effectKey, qty) {
      const ek = String(effectKey || "");
      if (ledgerByKey.has(ek)) {
        return { applied: false, row: ledgerByKey.get(ek), reservedQty };
      }
      const q = Number(qty) || 0;
      reservedQty += q;
      const row = { effectKey: ek, kind: "reserve", qty: q };
      ledgerByKey.set(ek, row);
      return { applied: true, row, reservedQty };
    },
    release(effectKey, qty) {
      const ek = String(effectKey || "");
      if (ledgerByKey.has(ek)) {
        return { applied: false, row: ledgerByKey.get(ek), reservedQty };
      }
      const q = Number(qty) || 0;
      reservedQty -= q;
      const row = { effectKey: ek, kind: "release", qty: q };
      ledgerByKey.set(ek, row);
      return { applied: true, row, reservedQty };
    },
  };
}
