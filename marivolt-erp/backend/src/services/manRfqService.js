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
  applyManRfqCurrencyGate,
  classifyManRfqCandidates,
  configOrSpecConflict,
  manCurrenciesMatch,
  manRfqCurrencyMismatchMessage,
  MAN_RFQ_CURRENCY_MISMATCH,
  normalizeManCurrency,
  DEFAULT_FULFILMENT_WAREHOUSE,
  DEFAULT_MAN_TIER,
  displayedItemMasterSpecs,
  displayedItemMasterSpn,
  formatManAvailability,
  isManEligibleItem,
  MAN_RFQ_MODEL_ERROR_CODES,
  MAN_RFQ_MODEL_MODES,
  modelIsKnownManEngine,
  modelsEquivalent,
  normalizePartNoForMatch,
  normalizeRfqUom,
  parseRfqCsvRow,
  manRfqRequestHash,
  preserveArticleCode,
  redactManRfqMatchResponse,
  redactQuotationForSalesApi,
  resolveManRfqRequestMode,
  resolveRfqLineModel,
  quotationLineTotal,
  roundQuotationMoney,
  selectTierUnitPrice,
  TIER_PERMISSION_ACTION,
  tierIsSelectable,
  toSalesMatchPrices,
  uniqueManEngineModels,
  uomsCompatible,
} from "../utils/manPriceList.js";
import { parseExcelBufferToRows } from "../utils/excelParser.js";

function err(message, statusCode = 400, code = "MAN_RFQ", extra = {}) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  if (extra.article) e.article = extra.article;
  if (extra.priceCurrency) e.priceCurrency = extra.priceCurrency;
  if (extra.quotationCurrency) e.quotationCurrency = extra.quotationCurrency;
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

async function knownManModelsForCompany(req) {
  const items = await ItemMaster.find({
    companyId: req.companyId,
    status: "Active",
  })
    .select("brand engine model")
    .lean();
  return uniqueManEngineModels(items);
}

async function resolveValidatedManRfqMode(req, { modelMode, headerModel } = {}) {
  const parsed = resolveManRfqRequestMode({ modelMode, headerModel });
  if (!parsed.ok) throw err(parsed.message, 400, parsed.code);
  const knownModels = await knownManModelsForCompany(req);
  if (parsed.mode === MAN_RFQ_MODEL_MODES.SELECTED) {
    if (!parsed.headerModel) {
      throw err(
        "Select a MAN engine model before matching, or choose mixed models / model not specified",
        400,
        MAN_RFQ_MODEL_ERROR_CODES.REQUIRED
      );
    }
    if (!modelIsKnownManEngine(knownModels, parsed.headerModel)) {
      throw err(
        "Engine Model must be an active MAN Item Master model for this company",
        400,
        MAN_RFQ_MODEL_ERROR_CODES.MISMATCH
      );
    }
  }
  return { ...parsed, knownModels };
}

function lineCustomerModel(line = {}) {
  return String(line.customerEngineModel || line.requestedModel || line.engineModel || line.model || "").trim();
}

function lineRequestedConfiguration(line = {}) {
  return String(line.requestedConfiguration || line.configuration || "").trim();
}

function lineRequestedSpecifications(line = {}) {
  return String(line.requestedSpecifications || line.specifications || line.specs || "").trim();
}

export async function listManEngineModels(req) {
  const items = await ItemMaster.find({
    companyId: req.companyId,
    status: "Active",
  })
    .select("brand engine model")
    .lean();
  return { models: uniqueManEngineModels(items) };
}

export async function getManItemSalesSnapshot(req, article) {
  const code = preserveArticleCode(article);
  const item = await ItemMaster.findOne({ companyId: req.companyId, article: code, status: "Active" }).lean();
  if (!item || !isManEligibleItem(item)) {
    throw err("MAN Item Master record not found", 404, "NOT_FOUND");
  }
  const tech = await ItemTechnical.findOne({ companyId: req.companyId, article: code }).lean();
  const price = await ManPriceList.findOne({ companyId: req.companyId, article: code, isActive: true }).lean();
  const canRock = await userCanTier(req, "ROCK");
  const availableQty = await liveAvailable(req.companyId, code);
  return redactManRfqMatchResponse({
    article: item.article,
    spn: displayedItemMasterSpn(item, tech),
    engineModel: item.model || "",
    configuration: item.config || "",
    specifications: displayedItemMasterSpecs(tech),
    uom: item.uom || "",
    availableQty,
    leadTime: price?.leadTime || "",
    currency: price?.currency || "",
    priceCurrency: normalizeManCurrency(price?.currency),
    prices: price ? sellingCandidate(price, { canRock }) : null,
  });
}

export async function matchRfqLines(
  req,
  { lines = [], defaultTier = DEFAULT_MAN_TIER, headerMode, headerModel, modelMode, currency } = {}
) {
  const quotationCurrency = normalizeManCurrency(currency);
  if (!quotationCurrency) {
    throw err("Quotation currency is required", 400, "CURRENCY_REQUIRED");
  }
  const { mode, headerModel: header } = await resolveValidatedManRfqMode(req, {
    modelMode: modelMode || headerMode,
    headerModel,
  });

  const canRock = await userCanTier(req, "ROCK");
  const results = [];
  for (const raw of lines) {
    const partNoOriginal = String(raw.partNo ?? raw.partNumber ?? "").trim();
    const uom = normalizeRfqUom(raw.uom);
    const qty = Number(raw.qty);
    const customerLine = String(raw.customerLine || raw.reference || "").trim();
    const customerReference = String(raw.customerReference || "").trim();
    const requestedDescription = String(raw.description || "").trim();
    const lineEngineModel = String(raw.engineModel || raw.model || "").trim();
    const configuration = String(raw.configuration || "").trim();
    const specifications = String(raw.specifications || raw.specs || "").trim();
    const resolved = resolveRfqLineModel({
      headerMode: mode,
      headerModel: header,
      lineModel: lineEngineModel,
    });
    const needle = normalizePartNoForMatch(partNoOriginal);
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const spnExact = needle ? new RegExp(`^${escaped}$`, "i") : null;

    const base = {
      customerLine,
      customerReference,
      requestedPartNo: partNoOriginal,
      requestedDescription,
      requestedModel: resolved.originalCustomerModel,
      engineModel: resolved.resolvedModel,
      configuration,
      specifications,
      uom,
      qty,
      status: "",
      selectedArticle: "",
      candidates: [],
      availableModels: [],
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

    const techs = await ItemTechnical.find({
      companyId: req.companyId,
      article: { $in: manItems.map((i) => i.article) },
    }).lean();
    const techByArticle = new Map(techs.map((t) => [t.article, t]));

    const candidates = [];
    for (const item of manItems) {
      const price = await ManPriceList.findOne({
        companyId: req.companyId,
        article: item.article,
        isActive: true,
      }).lean();
      const availableQty = await liveAvailable(req.companyId, item.article);
      const tech = techByArticle.get(item.article) || {};
      const itemSpecs = displayedItemMasterSpecs(tech);
      const uomOk = uomsCompatible(item.uom, uom);
      const modelConflict = Boolean(
        resolved.resolvedModel && item.model && !modelsEquivalent(item.model, resolved.resolvedModel)
      );
      const cfgConflict = configOrSpecConflict(configuration, item.config);
      const specConflict = configOrSpecConflict(specifications, itemSpecs);
      candidates.push({
        article: item.article,
        spn: displayedItemMasterSpn(item, tech),
        description: item.description || item.itemName || "",
        model: item.model || "",
        config: item.config || "",
        specifications: itemSpecs,
        uom: item.uom,
        availableQty,
        leadTime: price?.leadTime || "",
        prices: price ? sellingCandidate(price, { canRock }) : null,
        priceCurrency: normalizeManCurrency(price?.currency),
        uomOk,
        modelConflict,
        configConflict: Boolean(cfgConflict || specConflict),
        exactModelMatch: Boolean(resolved.resolvedModel && modelsEquivalent(item.model, resolved.resolvedModel)),
        exactConfigMatch: Boolean(configuration && item.config && modelsEquivalent(configuration, item.config)),
        pricingOk: Boolean(price && tierIsSelectable(price, defaultTier)),
      });
    }

    const classified = classifyManRfqCandidates(candidates, {
      headerMode: mode,
      resolvedModel: resolved.resolvedModel,
      lineModelMissing: resolved.lineModelMissing,
      headerLineConflict: resolved.headerLineConflict,
      modelAware: true,
    });
    const withModels = {
      ...base,
      availableModels: classified.availableModels || [],
      matchedEngineModel: classified.pick?.model || "",
    };
    if (classified.status === "MATCHED") {
      const pick = classified.pick;
      const availability = formatManAvailability({
        availableQty: pick.availableQty,
        requestedQty: qty,
        uom: pick.uom,
        leadTime: pick.leadTime,
      });
      const priceCurrency = normalizeManCurrency(pick.prices?.currency || pick.priceCurrency);
      const gated = applyManRfqCurrencyGate({
        quotationCurrency,
        priceCurrency,
        unitPrice: roundQuotationMoney(selectTierUnitPrice(pick.prices, defaultTier)),
        status: "MATCHED",
      });
      results.push({
        ...withModels,
        status: gated.status,
        selectedArticle: pick.article,
        description: pick.description,
        matchedEngineModel: pick.model || "",
        configuration,
        specifications,
        uom: pick.uom,
        availableQty: pick.availableQty,
        leadTime: pick.leadTime,
        priceTier: gated.ok ? defaultTier : "",
        unitPrice: gated.ok ? gated.unitPrice : undefined,
        availability,
        availabilityCheckedAt: new Date().toISOString(),
        priceListRevision: pick.prices.revision,
        currency: priceCurrency,
        priceCurrency,
        currencyMismatch: gated.currencyMismatch,
        exclusionReason: gated.ok ? "" : gated.reason,
        candidates,
      });
      continue;
    }
    results.push({
      ...withModels,
      status: classified.status || "REVIEW",
      priceCurrency: normalizeManCurrency(classified.pick?.prices?.currency || classified.pick?.priceCurrency),
      candidates,
      exclusionReason: classified.reason || "Requires review",
    });
  }
  return redactManRfqMatchResponse({ lines: results });
}

export async function parseRfqFile(buffer) {
  const rows = parseExcelBufferToRows(buffer, {
    preserveFormattedTextColumns: ["Part no", "Part No", "UOM", "Qty", "Engine Model", "Engine model"],
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
      priceCurrency: normalizeManCurrency(price?.currency),
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
  const headerFromBody = body.header || {};
  const { mode: headerMode, headerModel, knownModels } = await resolveValidatedManRfqMode(req, {
    modelMode: headerFromBody.modelMode || body.modelMode,
    headerModel: headerFromBody.model || body.model,
  });
  const inputLines = Array.isArray(body.lines) ? body.lines : [];
  const included = inputLines.filter((l) => l.exclude !== true);
  if (!included.length) throw err("Resolve or exclude every RFQ line before creating a quotation");

  const quotationCurrency = normalizeManCurrency(body.currency || headerFromBody.currency);
  if (!quotationCurrency) throw err("Quotation currency is required", 400, "CURRENCY_REQUIRED");

  for (const line of included) {
    const article = String(line.selectedArticle || "").trim().toUpperCase();
    if (!article) continue;
    const priceRow = await ManPriceList.findOne({ companyId: req.companyId, article, isActive: true }).lean();
    if (!priceRow) continue;
    if (!manCurrenciesMatch(quotationCurrency, priceRow.currency)) {
      throw err(manRfqCurrencyMismatchMessage(quotationCurrency, priceRow.currency), 409, MAN_RFQ_CURRENCY_MISMATCH, {
        article,
        priceCurrency: normalizeManCurrency(priceRow.currency),
        quotationCurrency,
      });
    }
  }

  const quoteLines = [];
  for (const line of included) {
    const article = String(line.selectedArticle || "").trim().toUpperCase();
    if (!article) {
      throw err("Select an Article on every included RFQ line", 400, MAN_RFQ_MODEL_ERROR_CODES.REQUIRED);
    }
    const item = await ItemMaster.findOne({ companyId: req.companyId, article, status: "Active" });
    if (!item) throw err(`Article ${article || "(blank)"} was not found`, 400, "MAN_RFQ", { article });
    if (!isManEligibleItem(item)) {
      throw err(`Article ${article} is not MAN-eligible`, 400, "MAN_RFQ", { article });
    }
    const customerModel = lineCustomerModel(line);
    const requestedConfiguration = lineRequestedConfiguration(line);
    const requestedSpecifications = lineRequestedSpecifications(line);
    const resolved = resolveRfqLineModel({
      headerMode,
      headerModel,
      lineModel: customerModel,
    });
    if (resolved.headerLineConflict) {
      throw err(
        "Line Engine Model differs from the header Engine Model",
        400,
        MAN_RFQ_MODEL_ERROR_CODES.CONFLICT,
        { article }
      );
    }
    if (headerMode === MAN_RFQ_MODEL_MODES.MIXED && resolved.lineModelMissing) {
      throw err(
        "Engine Model is required on each line for mixed-model RFQs",
        400,
        MAN_RFQ_MODEL_ERROR_CODES.REQUIRED,
        { article }
      );
    }
    if (
      (headerMode === MAN_RFQ_MODEL_MODES.SELECTED || headerMode === MAN_RFQ_MODEL_MODES.MIXED) &&
      resolved.resolvedModel &&
      !modelIsKnownManEngine(knownModels, resolved.resolvedModel)
    ) {
      throw err(
        `Engine Model ${resolved.resolvedModel} is not an active MAN Item Master model`,
        400,
        MAN_RFQ_MODEL_ERROR_CODES.MISMATCH,
        { article }
      );
    }
    if (headerMode === MAN_RFQ_MODEL_MODES.SELECTED) {
      if (!modelsEquivalent(item.model, headerModel)) {
        throw err(`Article ${article} is not for Engine Model ${headerModel}`, 400, MAN_RFQ_MODEL_ERROR_CODES.MISMATCH, {
          article,
        });
      }
    } else if (resolved.resolvedModel && !modelsEquivalent(item.model, resolved.resolvedModel)) {
      throw err(`Article ${article} is not for Engine Model ${resolved.resolvedModel}`, 400, MAN_RFQ_MODEL_ERROR_CODES.MISMATCH, {
        article,
      });
    }
    const tech = await ItemTechnical.findOne({ companyId: req.companyId, article }).lean();
    const itemSpecs = displayedItemMasterSpecs(tech || {});
    if (configOrSpecConflict(requestedConfiguration, item.config)) {
      throw err(`Configuration is incompatible for ${article}`, 400, MAN_RFQ_MODEL_ERROR_CODES.CONFIG_CONFLICT, {
        article,
      });
    }
    if (configOrSpecConflict(requestedSpecifications, itemSpecs)) {
      throw err(`Specifications are incompatible for ${article}`, 400, MAN_RFQ_MODEL_ERROR_CODES.SPEC_CONFLICT, {
        article,
      });
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
    if (!manCurrenciesMatch(quotationCurrency, price.currency)) {
      throw err(manRfqCurrencyMismatchMessage(quotationCurrency, price.currency), 409, MAN_RFQ_CURRENCY_MISMATCH, {
        article,
        priceCurrency: normalizeManCurrency(price.currency),
        quotationCurrency,
      });
    }
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
      partNumber: displayedItemMasterSpn(item, tech || {}),
      customerPartNo: String(line.requestedPartNo || line.customerPartNo || "").trim(),
      description: item.description || item.itemName || article,
      uom: item.uom,
      qty,
      price: unitPrice,
      totalPrice: quotationLineTotal(unitPrice, qty),
      availability,
      remarks: String(line.customerLine || "").trim(),
      priceTier: tier,
      priceListId: String(price._id),
      priceListRevision: price.revision,
      availabilityCheckedAt: checkedAt,
      sourceType: "MAN_RFQ",
      currency: quotationCurrency,
      customerEngineModel: resolved.originalCustomerModel,
      engineModel: item.model || "",
      config: item.config || "",
      specifications: itemSpecs,
      modelMatchStatus: resolved.resolvedModel && modelsEquivalent(item.model, resolved.resolvedModel)
        ? "MATCHED"
        : resolved.resolvedModel
          ? "MODEL_MISMATCH"
          : headerMode === MAN_RFQ_MODEL_MODES.UNSPECIFIED
            ? "UNSPECIFIED"
            : "MATCHED",
    });
  }

  const customerId = body.customerId || headerFromBody.customerId;
  const currency = quotationCurrency;
  const requestHash = manRfqRequestHash({ customerId, currency, lines: quoteLines });

  const payload = {
    ...headerFromBody,
    customerId,
    customerName: body.customerName || headerFromBody.customerName,
    customerReference: headerFromBody.customerReference || body.customerReference || "",
    quotationDate: headerFromBody.quotationDate || body.quotationDate,
    validityDate: headerFromBody.validityDate || body.validityDate,
    currency,
    engine: "MAN",
    model: headerMode === MAN_RFQ_MODEL_MODES.SELECTED ? headerModel : "",
    esn: String(headerFromBody.esn || "").trim(),
    vesselPlant: String(headerFromBody.vesselPlant || "").trim(),
    remarks: headerFromBody.remarks || "",
    manRfqModelMode: headerMode,
    sourceType: "MAN_RFQ",
    manRfqIdempotencyKey: idempotencyKey,
    manRfqRequestHash: requestHash,
    lines: quoteLines,
    internalNotes: [
      headerFromBody.internalNotes || "",
      `MAN RFQ model mode: ${headerMode}`,
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
