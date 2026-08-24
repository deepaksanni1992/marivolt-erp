/**
 * PACK_CONVERSION inventory cost helpers.
 * Total value is conserved: sourceQty × sourceUnitCost = targetQty × targetUnitCost.
 */

export function resolveBalanceUnitCost(balanceRow) {
  const raw = balanceRow?.raw ?? balanceRow ?? {};
  return Math.max(0, Number(raw.avgCost ?? raw.unitCost ?? 0) || 0);
}

export function computeConservedTargetUnitCost(sourceQty, sourceUnitCost, targetQty) {
  const srcQ = Number(sourceQty) || 0;
  const srcC = Math.max(0, Number(sourceUnitCost) || 0);
  const tgtQ = Number(targetQty) || 0;
  if (!(srcQ > 0) || !(tgtQ > 0)) return 0;
  return (srcQ * srcC) / tgtQ;
}

export function computeWeightedAverageUnitCost(existingQty, existingUnitCost, incomingQty, incomingUnitCost) {
  const oldQ = Math.max(0, Number(existingQty) || 0);
  const oldC = Math.max(0, Number(existingUnitCost) || 0);
  const inQ = Math.max(0, Number(incomingQty) || 0);
  const inC = Math.max(0, Number(incomingUnitCost) || 0);
  const newQ = oldQ + inQ;
  if (!(newQ > 0)) return inC;
  return (oldQ * oldC + inQ * inC) / newQ;
}

export function roundMoney(value, decimals = 6) {
  const n = Number(value) || 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
