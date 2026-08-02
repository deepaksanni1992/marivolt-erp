/**
 * Shared helpers for searchable document selectors (GRN / Packing).
 * No stock / posting side effects.
 */

export function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function clampPage(v, fallback = 1) {
  return Math.max(1, Number(v) || fallback);
}

export function clampLimit(v, { fallback = 25, max = 50 } = {}) {
  return Math.min(max, Math.max(1, Number(v) || fallback));
}

export function safeSearchTerm(raw, { maxLen = 80 } = {}) {
  return String(raw || "")
    .trim()
    .slice(0, maxLen);
}

/**
 * Rank preference for document search results.
 * Lower score = better. Exact id/number matches win.
 */
export function rankDocumentMatch(q, candidates = []) {
  const term = String(q || "")
    .trim()
    .toUpperCase();
  if (!term) return 100;
  for (let i = 0; i < candidates.length; i += 1) {
    const c = String(candidates[i] || "")
      .trim()
      .toUpperCase();
    if (!c) continue;
    if (c === term) return i * 10;
    if (c.startsWith(term)) return 20 + i * 10;
    if (c.includes(term)) return 40 + i * 10;
  }
  return 90;
}

export function paginateArray(items, page, limit) {
  const total = items.length;
  const start = (page - 1) * limit;
  const slice = items.slice(start, start + limit);
  return {
    items: slice,
    page,
    limit,
    total,
    hasMore: start + slice.length < total,
  };
}
