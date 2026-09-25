/**
 * Company-scoped Active Article validation for transactional documents.
 * Item Master is the only identity source. Lookups are exact { companyId, article }.
 */
import ItemMaster from "../models/itemMasterModel.js";
import ItemTechnical from "../models/itemTechnicalModel.js";
import {
  PART_NUMBER_INACTIVE,
  PART_NUMBER_MISMATCH,
  PART_NUMBER_NOT_LINKED_TO_ARTICLE,
  articleOwnsManufacturerPartNumber,
  canonicalItemMasterPartNumber,
  incomingDocumentPartNumber,
  incomingPoManufacturerPartNumber,
  partNumberInactiveMessage,
  partNumberNotLinkedMessage,
  snapshotPartNumberFields,
  snapshotSalesLinePartNumberFields,
  matchedManufacturerPartNumber,
} from "../utils/partNumberTerminology.js";

export const ARTICLE_NOT_IN_ITEM_MASTER = "ARTICLE_NOT_IN_ITEM_MASTER";
export const ARTICLE_INACTIVE = "ARTICLE_INACTIVE";
export const ARTICLE_COMPANY_REQUIRED = "ARTICLE_COMPANY_REQUIRED";
export { PART_NUMBER_MISMATCH, PART_NUMBER_NOT_LINKED_TO_ARTICLE, PART_NUMBER_INACTIVE };

const NOT_FOUND_MESSAGE =
  "Article {article} is not available in the active Item Master. Ask an authorized administrator to create or activate it first.";
const INACTIVE_MESSAGE =
  "Article {article} is inactive in Item Master and cannot be used on a new transaction.";

export class ArticleValidationError extends Error {
  constructor({ code, message, statusCode = 409, articles = [], lines = [] } = {}) {
    super(message || "Article validation failed");
    this.name = "ArticleValidationError";
    this.code = code || ARTICLE_NOT_IN_ITEM_MASTER;
    this.statusCode = statusCode;
    this.articles = articles;
    this.lines = lines;
    this.errors = lines;
  }

  toJSON() {
    return {
      message: this.message,
      code: this.code,
      articles: this.articles,
      lines: this.lines,
      errors: this.errors,
    };
  }
}

export function isArticleValidationError(err) {
  return err instanceof ArticleValidationError || err?.name === "ArticleValidationError";
}

export function sendArticleValidationError(res, err) {
  return res.status(err.statusCode || 409).json(err.toJSON ? err.toJSON() : {
    message: err.message,
    code: err.code,
  });
}

/** Match Item Master schema: trim + uppercase. Do not collapse internal whitespace. */
export function normalizeArticle(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function articleFromLine(line = {}) {
  return normalizeArticle(
    line.article || line.articleNo || line.articleNumber || line.itemCode || line.item_code || ""
  );
}

function formatMessage(template, article) {
  return template.replace("{article}", article || "(blank)");
}

/**
 * Lines whose Article is new or changed compared with the persisted document.
 * Unchanged historical lines are skipped so old documents remain editable for
 * commercial fields without re-validating a now-missing/inactive Article.
 */
export function linesRequiringArticleValidation(previousLines = [], nextLines = []) {
  const prevById = new Map();
  (previousLines || []).forEach((line) => {
    const id = line?._id || line?.id;
    if (id) prevById.set(String(id), normalizeArticle(articleFromLine(line)));
  });
  const out = [];
  (nextLines || []).forEach((line, index) => {
    const article = articleFromLine(line);
    const id = line?._id || line?.id;
    let previousArticle = "";
    if (id && prevById.has(String(id))) {
      previousArticle = prevById.get(String(id));
    } else if (!id && previousLines[index]) {
      previousArticle = normalizeArticle(articleFromLine(previousLines[index]));
    }
    if (article && previousArticle === article) return;
    out.push({
      line,
      index,
      article,
      reason: !article ? "BLANK" : previousArticle ? "CHANGED" : "NEW",
    });
  });
  return out;
}

export function linesRequiringManufacturerPartNumberValidation(previousLines = [], nextLines = []) {
  const prevById = new Map();
  (previousLines || []).forEach((line, index) => {
    const id = line?._id || line?.id;
    const snapshot = {
      article: normalizeArticle(articleFromLine(line)),
      partNo: incomingPoManufacturerPartNumber(line),
    };
    if (id) prevById.set(String(id), snapshot);
    prevById.set(`idx:${index}`, snapshot);
  });
  const out = [];
  (nextLines || []).forEach((line, index) => {
    const article = articleFromLine(line);
    const partNo = incomingPoManufacturerPartNumber(line);
    const id = line?._id || line?.id;
    const prev = (id && prevById.get(String(id))) || prevById.get(`idx:${index}`) || {};
    const articleChanged = !prev.article || prev.article !== article;
    const pnChanged = incomingPoManufacturerPartNumber({ partNo: prev.partNo }) !== partNo;
    if (!articleChanged && !pnChanged && prev.article) return;
    out.push({
      line,
      index,
      article,
      reason: !prev.article ? "NEW" : articleChanged ? "CHANGED" : "PART_NUMBER_CHANGED",
    });
  });
  return out;
}

export async function loadActiveArticlesByCode({ companyId, articles = [], session = null } = {}) {
  if (companyId == null || companyId === "") {
    throw new ArticleValidationError({
      code: ARTICLE_COMPANY_REQUIRED,
      message: "Authenticated company context is required",
      statusCode: 403,
    });
  }
  const unique = [...new Set((articles || []).map(normalizeArticle).filter(Boolean))];
  if (!unique.length) return new Map();
  const query = ItemMaster.find({ companyId, article: { $in: unique } });
  if (session) query.session(session);
  const rows = await query.lean();
  const techQuery = ItemTechnical.find({ companyId, article: { $in: unique } }).select(
    "article spn alternatePartNumbers"
  );
  if (session) techQuery.session(session);
  const techRows = await techQuery.lean();
  const techByArticle = new Map((techRows || []).map((row) => [normalizeArticle(row.article), row]));
  return new Map(
    (rows || []).map((row) => {
      const article = normalizeArticle(row.article);
      const tech = techByArticle.get(article);
      return [
        article,
        {
          ...row,
          spn: canonicalItemMasterPartNumber(row, tech),
          alternatePartNumbers: tech?.alternatePartNumbers || [],
        },
      ];
    })
  );
}

export function classifyArticleIssues({ articles = [], itemsByArticle, lineNumbersByArticle } = {}) {
  const missing = [];
  const inactive = [];
  for (const raw of articles) {
    const article = normalizeArticle(raw);
    if (!article) continue;
    const item = itemsByArticle.get(article);
    const lines = lineNumbersByArticle?.get(article) || [];
    if (!item) {
      missing.push({ article, lineNumbers: lines, code: ARTICLE_NOT_IN_ITEM_MASTER });
    } else if (String(item.status || "Active") !== "Active") {
      inactive.push({ article, lineNumbers: lines, code: ARTICLE_INACTIVE, item });
    }
  }
  return { missing, inactive };
}

function throwClassified({ missing, inactive }) {
  if (!missing.length && !inactive.length) return;
  const lines = [
    ...missing.map((row) => ({
      article: row.article,
      lineNumbers: row.lineNumbers,
      code: ARTICLE_NOT_IN_ITEM_MASTER,
      message: formatMessage(NOT_FOUND_MESSAGE, row.article),
    })),
    ...inactive.map((row) => ({
      article: row.article,
      lineNumbers: row.lineNumbers,
      code: ARTICLE_INACTIVE,
      message: formatMessage(INACTIVE_MESSAGE, row.article),
    })),
  ];
  const primary = missing.length ? missing[0] : inactive[0];
  const code = missing.length ? ARTICLE_NOT_IN_ITEM_MASTER : ARTICLE_INACTIVE;
  const template = missing.length ? NOT_FOUND_MESSAGE : INACTIVE_MESSAGE;
  throw new ArticleValidationError({
    code,
    message: formatMessage(template, primary.article),
    statusCode: 409,
    articles: lines.map((row) => row.article),
    lines,
  });
}

/**
 * Validate every Article on a new document (create, duplicate, import, downstream).
 * Returns a Map of normalized article → Item Master lean document.
 */
export async function assertActiveArticles({
  companyId,
  lines = [],
  session = null,
  allowBlank = false,
} = {}) {
  const lineNumbersByArticle = new Map();
  const articles = [];
  (lines || []).forEach((line, index) => {
    const article = articleFromLine(line);
    if (!article) {
      if (allowBlank) return;
      throw new ArticleValidationError({
        code: ARTICLE_NOT_IN_ITEM_MASTER,
        message: formatMessage(NOT_FOUND_MESSAGE, ""),
        articles: [""],
        lines: [
          {
            article: "",
            lineNumbers: [index + 1],
            code: ARTICLE_NOT_IN_ITEM_MASTER,
            message: formatMessage(NOT_FOUND_MESSAGE, ""),
          },
        ],
      });
    }
    articles.push(article);
    const nums = lineNumbersByArticle.get(article) || [];
    nums.push(index + 1);
    lineNumbersByArticle.set(article, nums);
  });
  const itemsByArticle = await loadActiveArticlesByCode({ companyId, articles, session });
  const classified = classifyArticleIssues({ articles, itemsByArticle, lineNumbersByArticle });
  throwClassified(classified);
  return itemsByArticle;
}

/** Validate only added/changed Articles on an existing document. */
export async function assertActiveArticlesForChangedLines({
  companyId,
  previousLines = [],
  nextLines = [],
  session = null,
} = {}) {
  const changed = linesRequiringArticleValidation(previousLines, nextLines).filter(
    (row) => row.reason !== "BLANK" || articleFromLine(row.line)
  );
  const toCheck = changed
    .filter((row) => articleFromLine(row.line))
    .map((row) => row.line);
  if (!toCheck.length) return new Map();
  return assertActiveArticles({ companyId, lines: toCheck, session });
}

export function snapshotQuotationLineFromItem(line = {}, item) {
  if (!item) return line;
  const requestedPartNo =
    String(line.customerPartNo || "").trim() || incomingDocumentPartNumber(line);
  const matched =
    matchedManufacturerPartNumber(item, item, requestedPartNo, { requireActive: true }) ||
    canonicalItemMasterPartNumber(item);
  const salesFields = snapshotSalesLinePartNumberFields({
    customerPartNo: requestedPartNo,
    matchedPartNumber: matched,
  });
  return {
    ...line,
    article: item.article,
    description: item.description || item.itemName || line.description || "",
    ...salesFields,
    uom: item.uom || line.uom || "PCS",
    materialCode: item.materialCode || line.materialCode || "",
    engineModel: line.engineModel || item.model || "",
    config: line.config || item.config || "",
  };
}

export function snapshotPoLineFromItem(line = {}, item) {
  if (!item) return line;
  const incoming = incomingPoManufacturerPartNumber(line);
    const owned = articleOwnsManufacturerPartNumber(item, item, incoming, { requireActive: true });
  const snapshotValue = !incoming
    ? canonicalItemMasterPartNumber(item)
    : owned.owned
      ? owned.matchedPartNumber || incoming
      : canonicalItemMasterPartNumber(item);
  const partFields = snapshotPartNumberFields(snapshotValue);
  return {
    ...line,
    article: item.article,
    articleNo: item.article,
    itemCode: item.article,
    description: item.description || item.itemName || line.description || "",
    ...partFields,
    materialCode: item.materialCode || line.materialCode || "",
    drawingNo: item.drawingNo || line.drawingNo || "",
    vertical: item.vertical || line.vertical || "",
    brand: item.brand || item.engine || line.brand || "",
    engine: item.engine || item.brand || line.engine || "",
    model: item.model || line.model || "",
    config: item.config || line.config || "",
    esn: item.esn || line.esn || "",
    uom: item.uom || line.uom || "PCS",
    supplierPartNumber: line.supplierPartNumber || "",
  };
}

export function applyItemMasterSnapshotsToLines(lines = [], itemsByArticle, kind = "quotation") {
  const apply = kind === "po" ? snapshotPoLineFromItem : snapshotQuotationLineFromItem;
  return (lines || []).map((line) => {
    const article = articleFromLine(line);
    const item = itemsByArticle.get(article);
    return item ? apply(line, item) : line;
  });
}

/** Reject PO Part Number values that are not the current Primary or an Active Alternate. */
export function assertPoLinesPartNumberMatchesMaster(lines = [], itemsByArticle) {
  const mismatches = [];
  (lines || []).forEach((line, index) => {
    const incoming = incomingPoManufacturerPartNumber(line);
    if (!incoming) return;
    const article = articleFromLine(line);
    const item = itemsByArticle.get(article);
    if (!item) return;
    const owned = articleOwnsManufacturerPartNumber(item, item, incoming, { requireActive: true });
    if (owned.inactive) {
      mismatches.push({
        article,
        lineNumbers: [index + 1],
        code: PART_NUMBER_INACTIVE,
        message: partNumberInactiveMessage(article, incoming),
      });
      return;
    }
    if (!owned.owned) {
      mismatches.push({
        article,
        lineNumbers: [index + 1],
        code: PART_NUMBER_NOT_LINKED_TO_ARTICLE,
        message: partNumberNotLinkedMessage(article, incoming),
      });
    }
  });
  if (!mismatches.length) return;
  throw new ArticleValidationError({
    code: mismatches[0].code,
    message: mismatches[0].message,
    statusCode: 409,
    articles: mismatches.map((row) => row.article),
    lines: mismatches,
  });
}
