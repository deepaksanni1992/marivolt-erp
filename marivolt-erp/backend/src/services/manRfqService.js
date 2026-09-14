/**
 * MAN RFQ → standard quotation. Selling tiers only; purchase data never leaves this path.
 */
import ItemMaster from "../models/itemMasterModel.js";
import ItemTechnical from "../models/itemTechnicalModel.js";
import ManPriceList from "../models/ManPriceList.js";
import Quotation from "../models/Quotation.js";
import { persistNewQuotation } from "../controllers/quotationController.js";
import { getStockBalance } from "./stockService.js";
import { hasPermission } from "./roleService.js";
import { runMongoTransaction } from "../utils/mongoTransaction.js";
import {
  classifyManRfqCandidates,
  DEFAULT_FULFILMENT_WAREHOUSE,
  DEFAULT_MAN_TIER,
  formatManAvailability,
  isManEligibleItem,
  normalizePartNoForMatch,
  normalizeRfqUom,
  parseRfqCsvRow,
  manRfqRequestHash,
  redactManRfqMatchResponse,
  redactQuotationForSalesApi,
  roundQuotationMoney,
  selectTierUnitPrice,
  TIER_PERMISSION_ACTION,
  tierIsSelectable,
  toSalesMatchPrices,
  uomsCompatible,
} from "../utils/manPriceList.js";
import { parseExcelBufferToRows } from "../utils/excelParser.js";

function err(message, statusCode = 400, code = "MAN_RFQ", extra = {}) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  if (extra.article) e.article = extra.article;
  return e;
}

async function liveAvailable(companyId, article) {
  const bal = await getStockBalance({
    companyId,
    article,
    warehouse: DEFAULT_FULFILMENT_WAREHOUSE,
  });
  return Number(bal.availableQty) || 0;
}

async function userCanTier(req, tier) {
  const action = TIER_PERMISSION_ACTION[String(tier || "").toUpperCase()];
  if (!action) return false;
  return hasPermission(req, "SALES", action);
}

function sellingCandidate(price, { canRock }) {
  return toSalesMatchPrices(price, { canRock });
}

export async function matchRfqLines(req, { lines = [], defaultTier = DEFAULT_MAN_TIER } = {}) {
  const canRock = await userCanTier(req, "ROCK");
  const results = [];
  for (const raw of lines) {
    const partNoOriginal = String(raw.partNo ?? raw.partNumber ?? "").trim();
    const uom = normalizeRfqUom(raw.uom);
    const qty = Number(raw.qty);
    const customerLine = String(raw.customerLine || raw.reference || "").trim();
    const requestedDescription = String(raw.description || "").trim();
    const engineModel = String(raw.engineModel || raw.model || "").trim();
    const configuration = String(raw.configuration || raw.specs || "").trim();
    const needle = normalizePartNoForMatch(partNoOriginal);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const spnExact = needle ? new RegExp(`^${escaped}$`, "i") : null;

    const base = {
      customerLine,
      requestedPartNo: partNoOriginal,
      requestedDescription,
      engineModel,
      configuration,
      uom,
      qty,
      status: "",
      selectedArticle: "",
      candidates: [],
      exclusionReason: "",
    };

    if (!partNoOriginal || !uom || !(qty > 0)) {
      results.push({ ...base, status: "INVALID", exclusionReason: "Part no, UOM and Qty are required" });
      continue;
    }

    const byMaster = needle
      ? await ItemMaster.find({
          companyId: req.companyId,
          status: "Active",
          spn: spnExact,
        }).lean()
      : [];
    const techHits = needle
      ? await ItemTechnical.find({ companyId: req.companyId, spn: spnExact }).select("article").lean()
      : [];
    const known = new Set(byMaster.map((i) => i.article));
    const extraCodes = techHits.map((t) => t.article).filter((a) => a && !known.has(a));
    const extraItems = extraCodes.length
      ? await ItemMaster.find({
          companyId: req.companyId,
          status: "Active",
          article: { $in: extraCodes },
        }).lean()
      : [];
    const items = [...byMaster, ...extraItems];

    const manItems = items.filter(isManEligibleItem);
    const nonMan = items.filter((i) => !isManEligibleItem(i));
    if (!manItems.length && nonMan.length) {
      results.push({
        ...base,
        status: "NON_MAN",
        exclusionReason: "Matched non-MAN Article — use the existing manual quotation process",
      });
      continue;
    }
    if (!manItems.length) {
      results.push({ ...base, status: "NOT_FOUND", exclusionReason: "Not found" });
      continue;
    }

    const candidates = [];
    for (const item of manItems) {
      const price = await ManPriceList.findOne({
        companyId: req.companyId,
        article: item.article,
        isActive: true,
      }).lean();
      const availableQty = await liveAvailable(req.companyId, item.article);
      const uomOk = uomsCompatible(item.uom, uom);
      const modelConflict =
        engineModel && item.model && String(item.model).trim().toUpperCase() !== engineModel.toUpperCase();
      candidates.push({
        article: item.article,
        spn: item.spn || "",
        description: item.description || item.itemName || "",
        model: item.model || "",
        config: item.config || "",
        uom: item.uom,
        availableQty,
        leadTime: price?.leadTime || "",
        prices: price ? sellingCandidate(price, { canRock }) : null,
        uomOk,
        modelConflict: Boolean(modelConflict),
        pricingOk: Boolean(price && tierIsSelectable(price, defaultTier)),
      });
    }

    const classified = classifyManRfqCandidates(candidates);
    if (classified.status === "REVIEW") {
      results.push({
        ...base,
        status: "REVIEW",
        candidates,
        exclusionReason: classified.reason,
      });
      continue;
    }
    if (classified.status === "PRICING_REQUIRED") {
      results.push({
        ...base,
        status: "PRICING_REQUIRED",
        candidates,
        exclusionReason: classified.reason,
      });
      continue;
    }
    if (classified.status === "MULTIPLE") {
      results.push({
        ...base,
        status: "MULTIPLE",
        candidates,
        exclusionReason: classified.reason,
      });
      continue;
    }
    if (classified.status === "MATCHED") {
      const pick = classified.pick;
      const availability = formatManAvailability({
        availableQty: pick.availableQty,
        requestedQty: qty,
        uom: pick.uom,
        leadTime: pick.leadTime,
      });
      results.push({
        ...base,
        status: "MATCHED",
        selectedArticle: pick.article,
        description: pick.description,
        uom: pick.uom,
        priceTier: defaultTier,
        unitPrice: selectTierUnitPrice(pick.prices, defaultTier),
        availability,
        availabilityCheckedAt: new Date().toISOString(),
        priceListRevision: pick.prices.revision,
        currency: pick.prices.currency,
        candidates,
      });
      continue;
    }
    results.push({ ...base, status: "REVIEW", candidates, exclusionReason: classified.reason || "Requires review" });
  }
  return redactManRfqMatchResponse({ lines: results });
}

export async function parseRfqFile(buffer) {
  const rows = parseExcelBufferToRows(buffer, {
    preserveFormattedTextColumns: ["Part no", "Part No", "UOM", "Qty"],
  });
  return rows.map((r) => parseRfqCsvRow(r.data));
}

export async function refreshAvailability(req, lines = []) {
  const canRock = await userCanTier(req, "ROCK");
  const out = [];
  for (const line of lines) {
    const article = String(line.article || line.selectedArticle || "").trim().toUpperCase();
    const qty = Number(line.qty) || 0;
    const uom = line.uom;
    if (!article) {
      out.push({
        article: "",
        selectedArticle: "",
        qty,
        uom,
        availability: "",
      });
      continue;
    }
    const price = await ManPriceList.findOne({ companyId: req.companyId, article, isActive: true }).lean();
    const availableQty = await liveAvailable(req.companyId, article);
    out.push({
      article,
      selectedArticle: article,
      qty,
      uom,
      availableQty,
      availability: formatManAvailability({
        availableQty,
        requestedQty: qty,
        uom,
        leadTime: price?.leadTime || "",
      }),
      availabilityCheckedAt: new Date().toISOString(),
      priceListRevision: price ? Number(price.revision) || 0 : undefined,
      prices: price ? toSalesMatchPrices(price, { canRock }) : null,
    });
  }
  return redactManRfqMatchResponse({ lines: out });
}

function asQuotation(doc) {
  const raw = doc?.toObject ? doc.toObject() : doc;
  return redactQuotationForSalesApi(raw);
}

function isManRfqDupKey(err) {
  return Number(err?.code) === 11000 && String(err?.message || "").includes("manRfqIdempotencyKey");
}

export async function createQuotationFromManRfq(req, body = {}) {
  const idempotencyKey = String(body.idempotencyKey || "").trim();
  if (!idempotencyKey) throw err("idempotencyKey is required", 400, "MAN_RFQ_KEY_REQUIRED");

  const defaultTier = String(body.defaultTier || DEFAULT_MAN_TIER).toUpperCase();
  const inputLines = Array.isArray(body.lines) ? body.lines : [];
  const included = inputLines.filter((l) => l.exclude !== true);
  if (!included.length) throw err("Resolve or exclude every RFQ line before creating a quotation");

  const quoteLines = [];
  for (const line of included) {
    const article = String(line.selectedArticle || line.article || "").trim().toUpperCase();
    const item = await ItemMaster.findOne({ companyId: req.companyId, article, status: "Active" });
    if (!item) throw err(`Article ${article || "(blank)"} was not found`, 400, "MAN_RFQ", { article });
    if (!isManEligibleItem(item)) {
      throw err(`Article ${article} is not MAN-eligible`, 400, "MAN_RFQ", { article });
    }
    const uom = String(line.uom || item.uom || "").trim().toUpperCase();
    if (!uomsCompatible(item.uom, uom)) {
      throw err(`UOM ${uom} is incompatible with Item Master UOM ${item.uom} for ${article}`);
    }
    if (!item.uom) throw err(`Item Master UOM is missing for ${article}`);
    const qty = Number(line.qty);
    if (!(qty > 0)) throw err(`Invalid quantity for ${article}`);

    const price = await ManPriceList.findOne({ companyId: req.companyId, article, isActive: true });
    if (!price) throw err(`No active MAN price list for ${article}`, 400, "MAN_RFQ", { article });
    const clientRev = Number(line.priceListRevision);
    if (!Number.isFinite(clientRev) || clientRev !== Number(price.revision)) {
      throw err("Prices changed since review. Refresh or recheck the affected row.", 409, "STALE_PRICE", {
        article,
      });
    }

    const tier = String(line.priceTier || defaultTier).toUpperCase();
    if (!(await userCanTier(req, tier))) {
      throw err(`Not permitted to use price tier ${tier}`, 403, "TIER_DENIED", { article });
    }
    if (!tierIsSelectable(price, tier)) {
      throw err(`Tier ${tier} has no price for ${article}`, 400, "MAN_RFQ", { article });
    }
    const unitPrice = roundQuotationMoney(selectTierUnitPrice(price, tier));
    if (line.unitPrice != null && roundQuotationMoney(line.unitPrice) !== unitPrice) {
      throw err("Submitted unit price does not match the current authorised tier price", 409, "STALE_PRICE", {
        article,
      });
    }

    const availableQty = await liveAvailable(req.companyId, article);
    const checkedAt = new Date();
    const availability = formatManAvailability({
      availableQty,
      requestedQty: qty,
      uom: item.uom,
      leadTime: price.leadTime || "",
    });

    quoteLines.push({
      article,
      partNumber: item.spn || "",
      customerPartNo: String(line.requestedPartNo || line.customerPartNo || "").trim(),
      description: item.description || item.itemName || article,
      uom: item.uom,
      qty,
      price: unitPrice,
      totalPrice: roundQuotationMoney(qty * unitPrice),
      availability,
      remarks: String(line.customerLine || "").trim(),
      priceTier: tier,
      priceListId: String(price._id),
      priceListRevision: price.revision,
      availabilityCheckedAt: checkedAt,
      sourceType: "MAN_RFQ",
      currency: price.currency || body.currency || "USD",
    });
  }

  const customerId = body.customerId || body.header?.customerId;
  const currency = body.currency || body.header?.currency || "USD";
  const requestHash = manRfqRequestHash({ customerId, currency, lines: quoteLines });

  const payload = {
    ...body.header,
    customerId,
    customerName: body.customerName || body.header?.customerName,
    currency,
    engine: "MAN",
    sourceType: "MAN_RFQ",
    manRfqIdempotencyKey: idempotencyKey,
    manRfqRequestHash: requestHash,
    lines: quoteLines,
    internalNotes: [
      body.header?.internalNotes || "",
      ...(inputLines
        .filter((l) => l.exclude)
        .map((l) => `Excluded ${l.requestedPartNo || l.article}: ${l.exclusionReason || l.excludeReason || "excluded"}`)),
    ]
      .filter(Boolean)
      .join("\n"),
  };

  const resolveExisting = (existing) => {
    const hash = existing.manRfqRequestHash || "";
    if (hash && hash !== requestHash) {
      throw err("Idempotency key already used for a different RFQ", 409, "IDEMPOTENCY_CONFLICT");
    }
    return { quotation: asQuotation(existing), reused: true };
  };

  try {
    return await runMongoTransaction(async (session) => {
      const existing = await Quotation.findOne({
        companyId: req.companyId,
        sourceType: "MAN_RFQ",
        manRfqIdempotencyKey: idempotencyKey,
      }).session(session);
      if (existing) return resolveExisting(existing);
      const quotation = await persistNewQuotation(req, payload, { skipAutoCreateItems: true, session });
      return { quotation: asQuotation(quotation), reused: false };
    });
  } catch (e) {
    if (isManRfqDupKey(e)) {
      const existing = await Quotation.findOne({
        companyId: req.companyId,
        sourceType: "MAN_RFQ",
        manRfqIdempotencyKey: idempotencyKey,
      });
      if (existing) return resolveExisting(existing);
    }
    throw e;
  }
}
