/**
 * System-wide quotation / RFQ duplicate-Article preservation.
 *
 * Every valid source row is an independent customer line. Article is never a
 * unique line identity. Normalization is used only to detect duplicate groups.
 *
 * Brand / engine / model / customer / company do not change this rule.
 */

/** Same trim + uppercase as Item Master / articleTransactionValidator.normalizeArticle. */
export function normalizeArticleForDuplicateGroup(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function newQuotationClientLineId() {
  return `ql-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function salesDocumentLineKey(line, idx = 0) {
  const id = line?._id != null ? String(line._id) : "";
  if (id) return id;
  const client = String(line?.clientLineId || line?.sourceLineId || "").trim();
  if (client) return client;
  return `line-${idx}`;
}

export function preserveQuotationLinesInOrder(lines = []) {
  if (!Array.isArray(lines)) return [];
  return lines.slice();
}

function compactHeader(s) {
  return String(s ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/_/g, " ")
    .replace(/\s/g, "");
}

function pickCsv(row, aliases) {
  if (!row || typeof row !== "object") return "";
  const keyMap = Object.keys(row).map((k) => ({ raw: k, c: compactHeader(k) }));
  for (const a of aliases) {
    const want = compactHeader(a);
    const hit = keyMap.find((x) => x.c === want);
    if (!hit) continue;
    const v = row[hit.raw];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    return String(v).trim();
  }
  return "";
}

function parseMoneyOrQty(raw) {
  const s = String(raw ?? "")
    .trim()
    .replace(/,/g, "");
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function csvRowIsBlank(row) {
  if (!row || typeof row !== "object") return true;
  return !Object.keys(row).some((k) => String(row[k] ?? "").trim() !== "");
}

function requestedPartNumberOf(line, opts = {}) {
  if (typeof opts.requestedPartNumberOf === "function") {
    return String(opts.requestedPartNumberOf(line) || "").trim();
  }
  return String(
    line?.customerPartNo ||
      line?.requestedPartNo ||
      line?.requestedPartNumber ||
      line?.partNo ||
      ""
  ).trim();
}

function selectedPartNumberOf(line) {
  return String(line?.partNumber || line?.spn || line?.selectedPartNumber || "").trim();
}

function lineArticle(line, opts = {}) {
  if (typeof opts.articleOf === "function") {
    return normalizeArticleForDuplicateGroup(opts.articleOf(line));
  }
  return normalizeArticleForDuplicateGroup(
    line?.article || line?.selectedArticle || line?.itemCode || ""
  );
}

function lineIsExcluded(line, opts = {}) {
  if (typeof opts.excludeOf === "function") return Boolean(opts.excludeOf(line));
  if (line?.exclude === true) return true;
  if (line?.includeInOA === false) return true;
  return false;
}

function lineQty(line) {
  const n = Number(line?.qty ?? line?.orderedQty ?? line?.quantity);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse quotation/sales-document CSV objects (Papa header:true rows).
 * Preserves original file order and 1-based source row numbers (header = 1).
 * Invalid rows are skipped independently and are not treated as valid duplicates.
 */
export function parseQuotationCsvDataRows(rows = [], { headerRowNumber = 1 } = {}) {
  const out = [];
  (rows || []).forEach((row, i) => {
    const sourceRowNumber = headerRowNumber + 1 + i;
    if (csvRowIsBlank(row)) return;
    const articleRaw = pickCsv(row, ["article", "item", "item code", "itemcode", "sku"]);
    const description = pickCsv(row, ["description", "desc", "item description"]);
    const qtyRaw = pickCsv(row, ["qty", "quantity", "q"]);
    const qty = qtyRaw === "" ? NaN : parseMoneyOrQty(qtyRaw);
    if (!articleRaw || !description || !(qty > 0)) return;
    const partNumber = pickCsv(row, ["part number", "part no", "partno", "partnumber", "maker part", "spn"]);
    const uom = pickCsv(row, ["uom", "unit", "unit of measure"]) || "PCS";
    const priceRaw = pickCsv(row, ["price", "unit price", "sale price", "unitprice", "rate"]);
    const price = Number.isFinite(parseMoneyOrQty(priceRaw)) ? Math.max(0, parseMoneyOrQty(priceRaw)) : 0;
    const remarks = pickCsv(row, ["remarks", "notes", "note"]);
    const materialCode = pickCsv(row, ["material code", "material", "materialcode"]);
    const availability = pickCsv(row, ["availability", "stock", "avail"]);
    out.push({
      serialNo: out.length + 1,
      article: articleRaw.toUpperCase(),
      partNumber,
      customerPartNo: partNumber,
      description,
      uom,
      qty,
      price,
      totalPrice: qty * price,
      remarks,
      materialCode,
      availability,
      sourceRowNumber,
      clientLineId: newQuotationClientLineId(),
    });
  });
  return out;
}

export function appendImportedQuotationLines(baseLines = [], importedLines = []) {
  const prev = Array.isArray(baseLines) ? baseLines : [];
  const hasRealLine = prev.some(
    (l) => String(l?.article || "").trim() !== "" || String(l?.description || "").trim() !== ""
  );
  const base = hasRealLine ? prev.map((l) => ({ ...l })) : [];
  const imported = (importedLines || []).map((row) => ({
    ...row,
    clientLineId: row.clientLineId || newQuotationClientLineId(),
  }));
  const out = [...base, ...imported];
  return out.map((line, idx) => {
    const qty = Number(line.qty) || 0;
    const price = Number(line.price) || 0;
    return {
      ...line,
      serialNo: idx + 1,
      totalPrice: Number(line.totalPrice) || qty * price,
    };
  });
}

/**
 * Group repeated normalized Articles. Does not mutate or merge lines.
 * Blank articles are ignored. Excluded lines omitted unless includeExcluded.
 */
export function detectDuplicateArticleGroups(lines = [], opts = {}) {
  const includeExcluded = Boolean(opts.includeExcluded);
  const buckets = new Map();

  (lines || []).forEach((line, idx) => {
    if (!includeExcluded && lineIsExcluded(line, opts)) return;
    const article = lineArticle(line, opts);
    if (!article) return;
    const requestedPartNumber = requestedPartNumberOf(line, opts);
    const selectedPartNumber = selectedPartNumberOf(line);
    const occurrence = {
      index: idx,
      serialNo: Number(line?.serialNo) || idx + 1,
      sourceRowNumber: line?.sourceRowNumber != null && line.sourceRowNumber !== "" ? Number(line.sourceRowNumber) : null,
      clientLineId: String(line?.clientLineId || line?._id || "").trim(),
      lineId: line?._id != null ? String(line._id) : "",
      requestedPartNumber,
      selectedPartNumber,
      description: String(line?.description || "").trim(),
      uom: String(line?.uom || "PCS").trim() || "PCS",
      qty: lineQty(line),
      remarks: String(line?.remarks || line?.specifications || "").trim(),
      exclude: lineIsExcluded(line, opts),
    };
    const list = buckets.get(article) || [];
    list.push(occurrence);
    buckets.set(article, list);
  });

  const groups = [];
  for (const [article, occurrences] of buckets) {
    if (occurrences.length < 2) continue;
    const quantities = occurrences.map((o) => o.qty);
    const groupedQty = quantities.reduce((acc, n) => acc + (Number(n) || 0), 0);
    groups.push({
      article,
      occurrences,
      occurrenceCount: occurrences.length,
      quantities,
      groupedQty,
      sourceRowNumbers: occurrences.map((o) => o.sourceRowNumber).filter((n) => n != null && Number.isFinite(n)),
      requestedPartNumbers: occurrences.map((o) => o.requestedPartNumber),
      selectedPartNumbers: occurrences.map((o) => o.selectedPartNumber),
      descriptions: occurrences.map((o) => o.description),
      uoms: occurrences.map((o) => o.uom),
      remarks: occurrences.map((o) => o.remarks),
    });
  }
  return groups;
}

export function duplicateGroupsFingerprint(groups = []) {
  return JSON.stringify(
    (groups || []).map((g) => ({
      article: g.article,
      occurrences: (g.occurrences || []).map((o) => ({
        id: o.clientLineId || o.lineId || "",
        sourceRowNumber: o.sourceRowNumber,
        serialNo: o.serialNo,
        qty: o.qty,
        requestedPartNumber: o.requestedPartNumber || "",
        selectedPartNumber: o.selectedPartNumber || "",
        exclude: Boolean(o.exclude),
      })),
    }))
  );
}

export function needsDuplicateArticleAcknowledgement(lines = [], acknowledgedFingerprint = "", opts = {}) {
  const groups = detectDuplicateArticleGroups(lines, opts);
  if (!groups.length) {
    return { required: false, groups: [], fingerprint: "" };
  }
  const fingerprint = duplicateGroupsFingerprint(groups);
  return {
    required: fingerprint !== String(acknowledgedFingerprint || ""),
    groups,
    fingerprint,
  };
}

export function duplicateArticleLineHint(line, groups = [], opts = {}) {
  const article = lineArticle(line, opts);
  if (!article) return null;
  const group = (groups || []).find((g) => g.article === article);
  if (!group || group.occurrenceCount < 2) return null;
  const labels = group.occurrences.map((o) => {
    if (o.sourceRowNumber != null && Number.isFinite(Number(o.sourceRowNumber))) return String(o.sourceRowNumber);
    return String(o.serialNo);
  });
  const uniqueLabels = [...new Set(labels)];
  const detail =
    uniqueLabels.length > 1
      ? `Also appears on rows ${uniqueLabels.join(" and ")}. Both lines will be kept.`
      : `This Article appears ${group.occurrenceCount} times. All lines will be kept.`;
  return {
    article,
    badge: "Duplicate Article",
    detail,
    groupedQty: group.groupedQty,
    occurrenceCount: group.occurrenceCount,
  };
}

/** Ordered idempotency payload — never unique-by-Article. */
export function quotationIdempotencyLineList(lines = []) {
  return (lines || []).map((l, idx) => ({
    sourceIndex: idx,
    sourceRowNumber:
      l?.sourceRowNumber == null || l.sourceRowNumber === "" ? "" : Number(l.sourceRowNumber),
    article: normalizeArticleForDuplicateGroup(l?.article || l?.selectedArticle),
    requestedPartNumber: requestedPartNumberOf(l),
    customerPartNo: String(l?.customerPartNo || l?.requestedPartNo || "").trim(),
    qty: Number(l?.qty) || 0,
    uom: String(l?.uom || "").trim().toUpperCase(),
    priceTier: String(l?.priceTier || "").trim().toUpperCase(),
    currency: String(l?.currency || l?.convertedCurrency || "").trim().toUpperCase(),
    sourceCurrency: String(l?.sourceCurrency || "").trim().toUpperCase(),
    conversionRate: l?.conversionRate == null || l.conversionRate === "" ? "" : Number(l.conversionRate),
    exclude: Boolean(l?.exclude === true || l?.includeInOA === false),
  }));
}

export const DUPLICATE_ARTICLES_MODAL_TITLE = "Duplicate Articles found";
export const DUPLICATE_ARTICLES_MODAL_MESSAGE =
  "The uploaded file contains repeated Articles. All lines will be kept separately. Review the rows below before continuing.";
export const DUPLICATE_ARTICLES_KEEP_LABEL = "Keep all lines and continue";
export const DUPLICATE_ARTICLES_CANCEL_LABEL = "Cancel and review file";
export const DUPLICATE_ARTICLE_BADGE = "Duplicate Article";
