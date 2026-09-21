/**
 * MAN engine product-line access.
 * Users without MAN_ENGINE.create may still use ordinary sales / purchase / ASN,
 * but cannot open MAN RFQ or write documents that contain MAN-eligible items.
 */
import Item from "../models/Item.js";
import { hasPermission } from "../services/roleService.js";
import { isManEligibleItem } from "./manPriceList.js";

export const MAN_ENGINE_MODULE = "MAN_ENGINE";
export const MAN_ENGINE_DENIED = "MAN_ENGINE_DENIED";

export class ManEngineAccessError extends Error {
  constructor(message, articles = []) {
    super(message);
    this.name = "ManEngineAccessError";
    this.statusCode = 403;
    this.status = 403;
    this.code = MAN_ENGINE_DENIED;
    this.articles = [...new Set((articles || []).map((a) => String(a || "").trim().toUpperCase()).filter(Boolean))];
  }
}

function articleOf(row = {}) {
  return String(row.article || row.itemCode || row.articleNo || "").trim().toUpperCase();
}

function isManRfqSource(value) {
  return String(value || "").trim().toUpperCase() === "MAN_RFQ";
}

export async function canWriteManEngine(req) {
  return hasPermission(req, MAN_ENGINE_MODULE, "create");
}

async function loadItemsByArticle(companyId, articles, findItems) {
  const codes = [...new Set((articles || []).map((a) => String(a || "").trim().toUpperCase()).filter(Boolean))];
  if (!codes.length || !companyId) return [];
  if (typeof findItems === "function") return findItems(companyId, codes);
  return Item.find({ companyId, article: { $in: codes } })
    .select("article brand engine")
    .lean();
}

/**
 * Fail closed: any MAN RFQ source, MAN header brand/engine, MAN line brand/engine,
 * or MAN-eligible Item Master row requires MAN_ENGINE.create.
 */
export async function assertManEngineWriteAccess(
  req,
  { lines = [], header = null, sourceType = "", extraHeaders = [] } = {},
  deps = {}
) {
  if (await canWriteManEngine(req)) return;

  const headers = [header, ...(extraHeaders || [])].filter(Boolean);
  const articleHits = [];

  if (isManRfqSource(sourceType) || headers.some((h) => isManRfqSource(h.sourceType))) {
    throw new ManEngineAccessError("You do not have access to MAN engine model activity");
  }

  for (const h of headers) {
    if (isManEligibleItem(h)) {
      throw new ManEngineAccessError("You do not have access to MAN engine model activity");
    }
  }

  for (const line of lines || []) {
    if (isManEligibleItem(line)) {
      articleHits.push(articleOf(line) || "MAN");
    }
  }

  const items = await loadItemsByArticle(
    req.companyId,
    (lines || []).map(articleOf),
    deps.findItems
  );
  for (const item of items || []) {
    if (isManEligibleItem(item)) articleHits.push(articleOf(item));
  }

  if (articleHits.length) {
    throw new ManEngineAccessError(
      `You do not have access to MAN engine model article(s): ${[...new Set(articleHits)].join(", ")}`,
      articleHits
    );
  }
}
