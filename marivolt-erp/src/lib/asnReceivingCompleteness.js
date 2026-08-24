/**
 * Display helpers for ASN receiving-completeness (canonical result from backend).
 */

export function extractAsnCompletenessMissing(payload) {
  if (Array.isArray(payload?.missing)) return payload.missing;
  if (Array.isArray(payload?.details?.missing)) return payload.details.missing;
  if (Array.isArray(payload?.receivingCompleteness?.missing)) {
    return payload.receivingCompleteness.missing;
  }
  return [];
}

export function groupCompletenessMissingByArticle(missing = []) {
  const byArticle = new Map();
  const document = [];
  for (const item of missing || []) {
    const article = String(item?.article || "").trim().toUpperCase();
    if (!article) {
      document.push(item);
      continue;
    }
    if (!byArticle.has(article)) byArticle.set(article, []);
    byArticle.get(article).push(item);
  }
  return {
    document,
    lines: [...byArticle.entries()].map(([article, items]) => ({
      article,
      missing: items,
      labels: items.map((i) => i.label || i.field),
    })),
  };
}

export function asnCompletenessStatusLabel(completeness) {
  if (!completeness) return "Unknown";
  if (completeness.complete) return "Complete for Receiving";
  const missing = completeness.missing || [];
  const articles = new Set(missing.map((m) => String(m.article || "").trim()).filter(Boolean));
  if (articles.size) {
    return `${articles.size} line${articles.size === 1 ? "" : "s"} incomplete`;
  }
  return `${missing.length || "Required"} field${missing.length === 1 ? "" : "s"} incomplete`;
}

export function shipArriveCompletenessWarning(completeness) {
  if (!completeness || completeness.complete) return "";
  const missing = completeness.missing || [];
  const n = missing.length || 0;
  return `ASN can be marked SHIPPED / ARRIVED, but receiving will remain blocked until ${n} required field${
    n === 1 ? " is" : "s are"
  } completed.`;
}

export function formatCompletenessErrorMessage(err) {
  if (!err) return "ASN is incomplete for receiving.";
  if (err.code === "ASN_INCOMPLETE" || err?.details?.complete === false) {
    return err.message || "ASN cannot proceed to receiving until required fields are completed.";
  }
  return err.message || "ASN cannot proceed to receiving.";
}
