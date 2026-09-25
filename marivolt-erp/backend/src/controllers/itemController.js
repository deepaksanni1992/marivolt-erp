import mongoose from "mongoose";
import ItemMaster, { UOM_VALUES } from "../models/itemMasterModel.js";
import ItemTechnical from "../models/itemTechnicalModel.js";
import ItemSupplier from "../models/itemSupplierModel.js";
import StockBalance from "../models/StockBalance.js";
import Quotation from "../models/Quotation.js";
import PurchaseOrder from "../models/PurchaseOrder.js";
import GRN from "../models/GRN.js";
import OrderAcknowledgement from "../models/OrderAcknowledgement.js";
import ManPriceList from "../models/ManPriceList.js";
import { writeAudit } from "../services/auditService.js";
import { hasPermission } from "../services/roleService.js";
import { resolveLookup, resolveLookupBatch } from "../services/itemResolutionService.js";
import {
  applyItemMasterImport,
  itemMasterImportTemplateCsv,
  previewItemMasterImport,
} from "../services/itemMasterImportService.js";
import {
  assertValidTaxonomy,
  buildCascadingFacets,
  resolveBrandValue,
} from "../utils/itemMasterTaxonomy.js";
import {
  canonicalItemMasterPartNumber,
  isActiveAliasStatus,
  publicManufacturerPartNumberDto,
  resolveImportedPartNumber,
} from "../utils/partNumberTerminology.js";
import {
  addAlternatePartNumber,
  promoteAlternatePartNumber,
  removeAlternatePartNumber,
  setAlternatePartNumberStatus,
} from "../services/itemTechnicalAliasService.js";

function isLiveItemMasterAdmin(req) {
  const role = String(req.user?.role || "").trim().toLowerCase();
  return role === "super_admin" || role === "admin";
}

function dtoOpts(req) {
  const admin = isLiveItemMasterAdmin(req);
  return { includeInactive: admin, includeAudit: false };
}

function scrubTechnicalAliases(technical, req) {
  if (!technical) return null;
  const admin = isLiveItemMasterAdmin(req);
  const pn = publicManufacturerPartNumberDto({}, technical, "", {
    includeInactive: admin,
    includeAudit: admin,
  });
  const copy = { ...technical };
  copy.alternatePartNumbers = pn.alternatePartNumbers;
  return copy;
}

async function canSeeSupplierPurchasePrices(req) {
  return (await hasPermission(req, "ITEM_MASTER", "edit")) || (await hasPermission(req, "PURCHASE", "edit"));
}

function redactSuppliers(suppliers = [], allowPrice) {
  if (allowPrice) return suppliers;
  return (suppliers || []).map((row) => {
    const { price, ...rest } = row;
    return rest;
  });
}

function withCompany(req, filter = {}) {
  return { companyId: req.companyId, ...filter };
}

function escRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsePaging(req) {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
  return { page, limit, skip: (page - 1) * limit };
}

function trim(value) {
  return String(value ?? "").trim();
}

function normalizeUom(value) {
  const upper = trim(value).toUpperCase();
  return UOM_VALUES.includes(upper) ? upper : "PCS";
}

function pick(row, ...keys) {
  for (const key of keys) {
    const out = trim(row[key]);
    if (out) return out;
  }
  return "";
}

function normalizeDimension(value) {
  const raw = trim(value).replace(/\s+/g, " ");
  if (!raw) return "";
  const isValid = /^(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)\s*x\s*(\d+(\.\d+)?)(\s*mm)?$/i.test(raw);
  if (!isValid) {
    throw new Error("Invalid dimension format");
  }
  return raw.replace(/\s*mm$/i, "").replace(/\s*x\s*/gi, "x");
}

function normalizeTechnicalArrayRows(rows, mapFn) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => mapFn(row || {}))
    .filter((row) => Object.values(row).some((v) => (typeof v === "boolean" ? v : trim(v))));
}

function parseImportList(raw, mapFn, fieldName) {
  const value = trim(raw);
  if (!value) return [];
  return value
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((entry) => {
      const tokens = entry.split("|").map((x) => x.trim());
      if (tokens.length < 1) throw new Error(`Invalid ${fieldName} mapping format`);
      return mapFn(tokens);
    });
}

async function validateNoCircularInterchange({ req, article, interchangeableParts, excludeId = null }) {
  const rows = await ItemTechnical.find(withCompany(req, excludeId ? { _id: { $ne: excludeId } } : {}))
    .select("article interchangeableParts")
    .lean();
  const graph = new Map();
  for (const row of rows) {
    const key = trim(row.article).toUpperCase();
    if (!key) continue;
    const refs = (row.interchangeableParts || [])
      .map((r) => trim(r.article).toUpperCase())
      .filter(Boolean);
    graph.set(key, refs);
  }
  const src = trim(article).toUpperCase();
  graph.set(
    src,
    (interchangeableParts || [])
      .map((r) => trim(r.article).toUpperCase())
      .filter(Boolean)
  );
  const seen = new Set();
  const stack = new Set();
  function dfs(node) {
    if (stack.has(node)) return true;
    if (seen.has(node)) return false;
    seen.add(node);
    stack.add(node);
    const next = graph.get(node) || [];
    for (const n of next) {
      if (dfs(n)) return true;
    }
    stack.delete(node);
    return false;
  }
  if (dfs(src)) {
    throw new Error(`Circular interchangeable mapping detected for article ${src}`);
  }
}

function normalizeTechnicalPayload(body = {}, audit = {}) {
  const cylinderCount = body.cylinderCount == null || body.cylinderCount === "" ? null : Number(body.cylinderCount);
  const modelMappings = normalizeTechnicalArrayRows(body.modelMappings, (row) => ({
    modelCode: trim(row.modelCode),
    modelName: trim(row.modelName),
    variant: trim(row.variant),
    notes: trim(row.notes),
  }));
  const esn = trim(body.esn);
  if (esn && !modelMappings.length && !trim(body.model)) {
    throw new Error("Invalid ESN/model combination: model mapping is required when ESN is provided");
  }
  const partNumberResolved = resolveImportedPartNumber({
    "Part Number": body.partNumber,
    SPN: body.spn,
  });
  if (partNumberResolved.error) {
    const err = new Error(partNumberResolved.error);
    err.code = partNumberResolved.code;
    throw err;
  }
  return {
    spn: partNumberResolved.value || trim(body.spn),
    esn,
    materialCode: trim(body.materialCode),
    drawingNumber: trim(body.drawingNumber),
    dimension: normalizeDimension(body.dimension),
    cylinderCount: Number.isFinite(cylinderCount) ? cylinderCount : null,
    specDimensions: trim(body.specDimensions || body.dimension),
    specWeight: trim(body.specWeight),
    specMaterial: trim(body.specMaterial),
    specTolerances: trim(body.specTolerances),
    specMarkings: trim(body.specMarkings || body.oeMarkings),
    revisionNo: trim(body.revisionNo),
    oeMarkings: trim(body.oeMarkings),
    extRemarks: trim(body.extRemarks),
    internalRemarks: trim(body.internalRemarks),
    technicalDocuments: normalizeTechnicalArrayRows(body.technicalDocuments, (row) => ({
      documentId: row.documentId || null,
      fileName: trim(row.fileName),
      documentType: trim(row.documentType),
      notes: trim(row.notes),
    })),
    modelMappings,
    configurationMappings: normalizeTechnicalArrayRows(body.configurationMappings, (row) => ({
      configurationCode: trim(row.configurationCode),
      configurationName: trim(row.configurationName),
      applicability: trim(row.applicability),
      notes: trim(row.notes),
    })),
    oemCrossReferences: normalizeTechnicalArrayRows(body.oemCrossReferences, (row) => ({
      oemName: trim(row.oemName),
      oemPartNumber: trim(row.oemPartNumber),
      oemDescription: trim(row.oemDescription),
      notes: trim(row.notes),
    })),
    supplierReferences: normalizeTechnicalArrayRows(body.supplierReferences, (row) => ({
      supplierName: trim(row.supplierName),
      supplierPartNumber: trim(row.supplierPartNumber),
      preferred: Boolean(row.preferred),
      notes: trim(row.notes),
    })),
    technicalSpecifications: normalizeTechnicalArrayRows(body.technicalSpecifications, (row) => ({
      specName: trim(row.specName),
      specValue: trim(row.specValue),
      specUnit: trim(row.specUnit),
      notes: trim(row.notes),
    })),
    interchangeableParts: normalizeTechnicalArrayRows(body.interchangeableParts, (row) => ({
      article: trim(row.article).toUpperCase(),
      partNumber: trim(row.partNumber),
      description: trim(row.description),
      interchangeType: ["INTERCHANGEABLE", "SUPERSEDED", "REPLACEMENT"].includes(trim(row.interchangeType).toUpperCase())
        ? trim(row.interchangeType).toUpperCase()
        : "INTERCHANGEABLE",
      replacementPriority: Number(row.replacementPriority) || 0,
      replacementNotes: trim(row.replacementNotes),
      notes: trim(row.notes),
    })),
    // Client alternatePartNumbers / normalized / _id are ignored. Use dedicated alias routes.
  };
}

async function ensureItemExists(req, article) {
  const item = await ItemMaster.findOne(withCompany(req, { article })).select("_id article").lean();
  if (!item) throw new Error("Article not found in ItemMaster");
}

function mapMerged(item, technical, suppliers, searchQuery = "", req = null) {
  const pn = publicManufacturerPartNumberDto(item, technical, searchQuery, dtoOpts(req || {}));
  return {
    ...item,
    technical: scrubTechnicalAliases(technical, req || {}),
    suppliers: suppliers || [],
    dimension: technical?.dimension || "",
    spn: canonicalItemMasterPartNumber(item, technical),
    primaryPartNumber: pn.primaryPartNumber,
    alternatePartNumbers: pn.alternatePartNumbers,
    alternateCount: pn.alternateCount,
    matchedPartNumber: pn.matchedPartNumber,
  };
}

async function resolveItemByLookupInput(req, input = {}) {
  return resolveLookup({ companyId: req.companyId, input });
}

export async function listItemFacets(req, res) {
  try {
    const vertical = trim(req.query.vertical);
    const brand = trim(req.query.engineBrand || req.query.brand || req.query.engine);
    const model = trim(req.query.engineModel || req.query.model);
    const rows = await ItemMaster.find(withCompany(req))
      .select("vertical brand engine model config")
      .lean();
    const facets = buildCascadingFacets(rows, { vertical, brand, model });
    res.json(facets);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function listItems(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req);
    const filter = withCompany(req);
    let scopedArticles = null;
    const applyArticleScope = (articles) => {
      const next = new Set((articles || []).map((x) => trim(x).toUpperCase()).filter(Boolean));
      if (scopedArticles == null) scopedArticles = next;
      else scopedArticles = new Set([...scopedArticles].filter((x) => next.has(x)));
    };

    const status = trim(req.query.status);
    if (status && ["Active", "Inactive"].includes(status)) filter.status = status;
    const vertical = trim(req.query.vertical);
    if (vertical) filter.vertical = new RegExp(`^${escRe(vertical)}$`, "i");
    const engine = trim(req.query.engineBrand || req.query.brand || req.query.engine);
    if (engine) {
      const engineRe = new RegExp(`^${escRe(engine)}$`, "i");
      filter.$and = [...(filter.$and || []), { $or: [{ engine: engineRe }, { brand: engineRe }] }];
    }
    const model = trim(req.query.engineModel || req.query.model);
    if (model) filter.model = new RegExp(`^${escRe(model)}$`, "i");
    const config = trim(req.query.configuration || req.query.config);
    if (config) filter.config = new RegExp(`^${escRe(config)}$`, "i");
    const spn = trim(req.query.spn || req.query.partNumber);
    const esn = trim(req.query.esn);
    const cylinderCount = trim(req.query.cylinderCount);
    const oemReference = trim(req.query.oemReference);
    const supplierReference = trim(req.query.supplierReference);
    const materialCode = trim(req.query.materialCode);
    const drawingNumber = trim(req.query.drawingNumber);

    const search = trim(req.query.search);
    if (search) {
      const re = new RegExp(escRe(search), "i");
      const [technicalArticles, supplierArticles] = await Promise.all([
        ItemTechnical.find(
          withCompany(req, {
            $or: [
              { spn: re },
              { esn: re },
              { materialCode: re },
              { drawingNumber: re },
              { dimension: re },
              { "modelMappings.modelCode": re },
              { "modelMappings.modelName": re },
              { "configurationMappings.configurationCode": re },
              { "configurationMappings.configurationName": re },
              { "oemCrossReferences.oemPartNumber": re },
              { "supplierReferences.supplierPartNumber": re },
              { "interchangeableParts.article": re },
              { "interchangeableParts.partNumber": re },
              { "interchangeableParts.replacementNotes": re },
              isLiveItemMasterAdmin(req)
                ? { "alternatePartNumbers.partNumber": re }
                : {
                    alternatePartNumbers: {
                      $elemMatch: {
                        $or: [{ partNumber: re }, { normalized: re }],
                        status: { $nin: ["INACTIVE"] },
                      },
                    },
                  },
            ],
          })
        )
          .distinct("article"),
        ItemSupplier.find(
          withCompany(req, {
            $or: [{ supplierName: re }, { supplierPartNumber: re }],
          })
        )
          .distinct("article"),
      ]);
      const articleHits = [...new Set([...technicalArticles, ...supplierArticles])];
      filter.$or = [
        { article: re },
        { itemName: re },
        { description: re },
        { engine: re },
        { brand: re },
        { vertical: re },
        { model: re },
        { config: re },
        ...(articleHits.length ? [{ article: { $in: articleHits } }] : []),
      ];
    }
    const technicalFilter = withCompany(req, {});
    let hasTechnicalFilter = false;
    if (spn) {
      const spnRe = new RegExp(escRe(spn), "i");
      technicalFilter.$or = isLiveItemMasterAdmin(req)
        ? [{ spn: spnRe }, { "alternatePartNumbers.partNumber": spnRe }, { "alternatePartNumbers.normalized": spn.toUpperCase() }]
        : [
            { spn: spnRe },
            {
              alternatePartNumbers: {
                $elemMatch: {
                  $or: [{ partNumber: spnRe }, { normalized: spn.toUpperCase() }],
                  status: { $nin: ["INACTIVE"] },
                },
              },
            },
          ];
      hasTechnicalFilter = true;
    }
    if (esn) {
      technicalFilter.esn = new RegExp(escRe(esn), "i");
      hasTechnicalFilter = true;
    }
    if (cylinderCount) {
      technicalFilter.cylinderCount = Number(cylinderCount);
      hasTechnicalFilter = true;
    }
    if (oemReference) {
      technicalFilter["oemCrossReferences.oemPartNumber"] = new RegExp(escRe(oemReference), "i");
      hasTechnicalFilter = true;
    }
    if (materialCode) {
      technicalFilter.materialCode = new RegExp(escRe(materialCode), "i");
      hasTechnicalFilter = true;
    }
    if (drawingNumber) {
      technicalFilter.drawingNumber = new RegExp(escRe(drawingNumber), "i");
      hasTechnicalFilter = true;
    }
    if (hasTechnicalFilter) {
      const technicalArticles = await ItemTechnical.find(technicalFilter).distinct("article");
      applyArticleScope(technicalArticles);
    }
    if (supplierReference) {
      const supplierRe = new RegExp(escRe(supplierReference), "i");
      const [supplierArticlesFromMaster, supplierArticlesFromTech] = await Promise.all([
        ItemSupplier.find(withCompany(req, { supplierPartNumber: supplierRe })).distinct("article"),
        ItemTechnical.find(withCompany(req, { "supplierReferences.supplierPartNumber": supplierRe })).distinct("article"),
      ]);
      applyArticleScope([...supplierArticlesFromMaster, ...supplierArticlesFromTech]);
    }
    if (scopedArticles != null) {
      const scoped = [...scopedArticles];
      if (!scoped.length) return res.json({ items: [], total: 0, page, limit });
      if (filter.article?.$in) {
        const current = new Set(filter.article.$in.map((x) => trim(x).toUpperCase()));
        filter.article = { $in: scoped.filter((x) => current.has(x)) };
      } else {
        filter.article = { $in: scoped };
      }
    }

    const [items, total] = await Promise.all([
      ItemMaster.find(filter).sort({ article: 1 }).skip(skip).limit(limit).lean(),
      ItemMaster.countDocuments(filter),
    ]);

    const articles = items.map((row) => row.article);
    const [technicalRows, supplierRows, stockRows] = await Promise.all([
      ItemTechnical.find(withCompany(req, { article: { $in: articles } })).lean(),
      ItemSupplier.find(withCompany(req, { article: { $in: articles } })).sort({ supplierName: 1 }).lean(),
      StockBalance.find(withCompany(req, { article: { $in: articles } }))
        .select("article onHandQty")
        .lean(),
    ]);
    const technicalByArticle = new Map(technicalRows.map((row) => [row.article, row]));
    const suppliersByArticle = new Map();
    const qtyByArticle = new Map();
    for (const sup of supplierRows) {
      const list = suppliersByArticle.get(sup.article) || [];
      list.push(sup);
      suppliersByArticle.set(sup.article, list);
    }
    for (const stk of stockRows) {
      qtyByArticle.set(stk.article, Number(qtyByArticle.get(stk.article) || 0) + Number(stk.onHandQty || 0));
    }
    const merged = items.map((row) => {
      const technical = technicalByArticle.get(row.article) || null;
      const supplierList = suppliersByArticle.get(row.article) || [];
      const pn = publicManufacturerPartNumberDto(row, technical, search, dtoOpts(req));
      return {
        ...row,
        technical: scrubTechnicalAliases(technical, req),
        dimension: technical?.dimension || "",
        spn: canonicalItemMasterPartNumber(row, technical),
        primaryPartNumber: pn.primaryPartNumber,
        alternatePartNumbers: pn.alternatePartNumbers,
        alternateCount: pn.alternateCount,
        matchedPartNumber: pn.matchedPartNumber,
        esn: technical?.esn || "",
        materialCode: technical?.materialCode || "",
        drawingNumber: technical?.drawingNumber || "",
        cylinderCount: technical?.cylinderCount ?? "",
        extRemarks: technical?.extRemarks || "",
        internalRemarks: technical?.internalRemarks || "",
        oeMarkings: technical?.oeMarkings || "",
        modelMapCount: (technical?.modelMappings || []).length,
        configMapCount: (technical?.configurationMappings || []).length,
        oemRefCount: (technical?.oemCrossReferences || []).length,
        interchangeCount: (technical?.interchangeableParts || []).length,
        supplier1: supplierList[0]?.supplierName || "",
        supplier1PartNumber: supplierList[0]?.supplierPartNumber || "",
        supplier2: supplierList[1]?.supplierName || "",
        supplier2PartNumber: supplierList[1]?.supplierPartNumber || "",
        qty: Number(qtyByArticle.get(row.article) || 0),
      };
    });

    res.json({ items: merged, total, page, limit });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getItem(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const item = await ItemMaster.findOne(withCompany(req, { article })).lean();
    if (!item) return res.status(404).json({ message: "Not found" });
    const [technical, suppliers] = await Promise.all([
      ItemTechnical.findOne(withCompany(req, { article })).lean(),
      ItemSupplier.find(withCompany(req, { article })).sort({ supplierName: 1 }).lean(),
    ]);
    const allowPrice = await canSeeSupplierPurchasePrices(req);
    res.json(mapMerged(item, technical, redactSuppliers(suppliers, allowPrice), "", req));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function createItem(req, res) {
  try {
    const article = trim(req.body.article).toUpperCase();
    const taxonomy = assertValidTaxonomy({
      vertical: req.body.vertical,
      brand: req.body.brand,
      engine: req.body.engine,
      model: req.body.model,
      config: req.body.config,
    });
    const payload = {
      companyId: req.companyId,
      article,
      itemName: trim(req.body.itemName),
      description: trim(req.body.description),
      ...taxonomy,
      uom: normalizeUom(req.body.uom),
      status: trim(req.body.status) === "Inactive" ? "Inactive" : "Active",
    };
    const created = await ItemMaster.create(payload);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateItem(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const taxonomy = assertValidTaxonomy({
      vertical: req.body.vertical,
      brand: req.body.brand,
      engine: req.body.engine,
      model: req.body.model,
      config: req.body.config,
    });
    const payload = {
      itemName: trim(req.body.itemName),
      description: trim(req.body.description),
      ...taxonomy,
      uom: normalizeUom(req.body.uom),
      status: trim(req.body.status) === "Inactive" ? "Inactive" : "Active",
    };
    const existing = await ItemMaster.findOne(withCompany(req, { article })).lean();
    if (!existing) return res.status(404).json({ message: "Not found" });
    if (payload.status === "Inactive" && existing.status !== "Inactive") {
      if (!(await hasPermission(req, "ITEM_MASTER", "cancel"))) {
        return res.status(403).json({ message: "Permission denied: ITEM_MASTER.cancel", code: "PERMISSION_DENIED" });
      }
    }
    if (payload.status === "Active" && existing.status === "Inactive") {
      if (!(await hasPermission(req, "ITEM_MASTER", "approve"))) {
        return res.status(403).json({ message: "Permission denied: ITEM_MASTER.approve", code: "PERMISSION_DENIED" });
      }
    }
    const row = await ItemMaster.findOneAndUpdate(withCompany(req, { article }), payload, {
      new: true,
      runValidators: true,
    });
    if (!row) return res.status(404).json({ message: "Not found" });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteItem(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const refs = [];
    const [qt, po, grn, oa, stock, price] = await Promise.all([
      Quotation.countDocuments(withCompany(req, { "lines.article": article })),
      PurchaseOrder.countDocuments(withCompany(req, { "lines.article": article })),
      GRN.countDocuments(withCompany(req, { "items.article": article })),
      OrderAcknowledgement.countDocuments(withCompany(req, { "lines.article": article })),
      StockBalance.countDocuments(withCompany(req, { $or: [{ article }, { itemCode: article }] })),
      ManPriceList.countDocuments(withCompany(req, { article })),
    ]);
    if (qt) refs.push(`${qt} quotation(s)`);
    if (po) refs.push(`${po} purchase order(s)`);
    if (grn) refs.push(`${grn} GRN(s)`);
    if (oa) refs.push(`${oa} order acknowledgement(s)`);
    if (stock) refs.push(`${stock} stock balance row(s)`);
    if (price) refs.push(`${price} price list row(s)`);
    if (refs.length) {
      return res.status(409).json({
        message: `Cannot delete Article ${article} because it is referenced by ${refs.join(", ")}. Deactivate it instead.`,
        code: "ARTICLE_IN_USE",
        article,
      });
    }
    const deleted = await ItemMaster.findOneAndDelete(withCompany(req, { article }));
    if (!deleted) return res.status(404).json({ message: "Not found" });
    await Promise.all([
      ItemTechnical.deleteMany(withCompany(req, { article })),
      ItemSupplier.deleteMany(withCompany(req, { article })),
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createItemTechnical(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const payload = {
      companyId: req.companyId,
      article,
      ...normalizeTechnicalPayload(req.body, { createdBy: req.user?.email, updatedBy: req.user?.email }),
    };
    await validateNoCircularInterchange({ req, article, interchangeableParts: payload.interchangeableParts });
    const row = await ItemTechnical.findOneAndUpdate(withCompany(req, { article }), payload, {
      new: true,
      upsert: true,
      runValidators: true,
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function getItemTechnical(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const row = await ItemTechnical.findOne(withCompany(req, { article })).lean();
    res.json(row ? scrubTechnicalAliases(row, req) : null);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateItemTechnical(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const payload = normalizeTechnicalPayload(req.body, {
      createdBy: req.user?.email,
      updatedBy: req.user?.email,
    });
    const existing = await ItemTechnical.findOne(withCompany(req, { article })).select("_id").lean();
    await validateNoCircularInterchange({
      req,
      article,
      interchangeableParts: payload.interchangeableParts,
      excludeId: existing?._id || null,
    });
    const row = await ItemTechnical.findOneAndUpdate(withCompany(req, { article }), payload, {
      new: true,
      upsert: true,
      runValidators: true,
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function createItemSupplier(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const row = await ItemSupplier.create({
      companyId: req.companyId,
      article,
      supplierName: trim(req.body.supplierName),
      supplierPartNumber: trim(req.body.supplierPartNumber),
      currency: trim(req.body.currency || "USD").toUpperCase() || "USD",
      price: Number(req.body.price) || 0,
      leadTime: trim(req.body.leadTime),
      remarks: trim(req.body.remarks),
    });
    res.status(201).json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function listItemSuppliers(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const rows = await ItemSupplier.find(withCompany(req, { article })).sort({ supplierName: 1 }).lean();
    const allowPrice = await canSeeSupplierPurchasePrices(req);
    res.json(redactSuppliers(rows, allowPrice));
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function updateItemSupplier(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const supplierId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(supplierId)) {
      return res.status(400).json({ message: "Invalid supplier id" });
    }
    await ensureItemExists(req, article);
    const row = await ItemSupplier.findOneAndUpdate(
      withCompany(req, { _id: supplierId, article }),
      {
        supplierName: trim(req.body.supplierName),
        supplierPartNumber: trim(req.body.supplierPartNumber),
        currency: trim(req.body.currency || "USD").toUpperCase() || "USD",
        price: Number(req.body.price) || 0,
        leadTime: trim(req.body.leadTime),
        remarks: trim(req.body.remarks),
      },
      { new: true, runValidators: true }
    );
    if (!row) return res.status(404).json({ message: "Supplier row not found" });
    res.json(row);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function deleteItemSupplier(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const supplierId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(supplierId)) {
      return res.status(400).json({ message: "Invalid supplier id" });
    }
    const row = await ItemSupplier.findOneAndDelete(withCompany(req, { _id: supplierId, article }));
    if (!row) return res.status(404).json({ message: "Supplier row not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function downloadItemImportTemplate(req, res) {
  const csv = itemMasterImportTemplateCsv();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="item-master-import-template.csv"');
  res.send(csv);
}

export async function previewItemImport(req, res) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: "Upload CSV/Excel with file field" });
    const preview = await previewItemMasterImport({ companyId: req.companyId, buffer: req.file.buffer });
    res.json(preview);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message, code: err.code, preview: err.preview });
  }
}

export async function applyItemImport(req, res) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: "Upload CSV/Excel with file field" });
    const result = await applyItemMasterImport({
      companyId: req.companyId,
      buffer: req.file.buffer,
      userEmail: req.user?.email || "",
    });
    await writeAudit(req, {
      action: "IMPORT",
      module: "ITEM_MASTER",
      entityType: "ITEM_MASTER",
      documentNo: "",
      description: `Item Master import applied created=${result.apply?.created || 0} updated=${result.apply?.updated || 0}`,
      metadata: result.apply || {},
    });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ message: err.message, code: err.code, preview: err.preview });
  }
}

export async function importItems(req, res) {
  return applyItemImport(req, res);
}


export async function exportItems(req, res) {
  try {
    const rows = await ItemMaster.find(withCompany(req)).sort({ article: 1 }).lean();
    const articles = rows.map((row) => row.article);
    const [technicals, suppliers] = await Promise.all([
      ItemTechnical.find(withCompany(req, { article: { $in: articles } })).lean(),
      ItemSupplier.find(withCompany(req, { article: { $in: articles } })).lean(),
    ]);
    const technicalByArticle = new Map(technicals.map((row) => [row.article, row]));
    const suppliersByArticle = new Map();
    for (const row of suppliers) {
      const list = suppliersByArticle.get(row.article) || [];
      list.push(`${row.supplierName}${row.supplierPartNumber ? ` (${row.supplierPartNumber})` : ""}`);
      suppliersByArticle.set(row.article, list);
    }

    const merged = rows.map((item) => {
      const tech = technicalByArticle.get(item.article);
      return {
        Article: item.article,
        "ITEM NAME": item.itemName,
        Description: item.description,
        Vertical: item.vertical,
        Brand: resolveBrandValue(item),
        Model: item.model,
        Config: item.config,
        "Part Number": tech?.spn || "",
        "Alternate Part Numbers": (tech?.alternatePartNumbers || [])
          .filter((x) => isLiveItemMasterAdmin(req) || isActiveAliasStatus(x.status))
          .map((x) => x.partNumber)
          .filter(Boolean)
          .join("; "),
        ESN: tech?.esn || "",
        "Material Code": tech?.materialCode || "",
        "Drawing Number": tech?.drawingNumber || "",
        "Cylinder Count": tech?.cylinderCount ?? "",
        Dimension: tech?.dimension || "",
        "OE Markings": tech?.oeMarkings || "",
        "Model Mappings": (tech?.modelMappings || [])
          .map((x) => `${x.modelCode}${x.modelName ? `:${x.modelName}` : ""}`)
          .join("; "),
        "Configuration Mappings": (tech?.configurationMappings || [])
          .map((x) => `${x.configurationCode}${x.configurationName ? `:${x.configurationName}` : ""}`)
          .join("; "),
        "OEM Cross References": (tech?.oemCrossReferences || [])
          .map((x) => `${x.oemName ? `${x.oemName}:` : ""}${x.oemPartNumber}`)
          .join("; "),
        "Interchangeable Parts": (tech?.interchangeableParts || [])
          .map((x) => `${x.article || x.partNumber}${x.interchangeType ? ` (${x.interchangeType})` : ""}`)
          .join("; "),
        "Supplier References": (tech?.supplierReferences || [])
          .map((x) => `${x.supplierName}${x.supplierPartNumber ? `:${x.supplierPartNumber}` : ""}`)
          .join("; "),
        "Technical Specifications": (tech?.technicalSpecifications || [])
          .map((x) => `${x.specName}:${x.specValue}${x.specUnit ? ` ${x.specUnit}` : ""}`)
          .join("; "),
        "Revision No": tech?.revisionNo || "",
        Suppliers: (suppliersByArticle.get(item.article) || []).join("; "),
        Status: item.status,
      };
    });

    res.json({ items: merged });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

export async function getItemCompatibility(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    await ensureItemExists(req, article);
    const technical = await ItemTechnical.findOne(withCompany(req, { article })).lean();
    if (!technical) {
      return res.json({
        article,
        compatibleEngineModels: [],
        compatibleConfigs: [],
        esns: [],
        oemRefs: [],
        supplierRefs: [],
        interchangeableParts: [],
        manufacturerPartNumbers: { primaryPartNumber: "", alternatePartNumbers: [] },
      });
    }
    const pn = publicManufacturerPartNumberDto({ article }, technical, "", dtoOpts(req));
    res.json({
      article,
      compatibleEngineModels: (technical.modelMappings || []).map((x) => ({
        modelCode: x.modelCode,
        modelName: x.modelName,
        variant: x.variant,
      })),
      compatibleConfigs: (technical.configurationMappings || []).map((x) => ({
        configurationCode: x.configurationCode,
        configurationName: x.configurationName,
        applicability: x.applicability,
      })),
      esns: technical.esn ? [technical.esn] : [],
      oemRefs: (technical.oemCrossReferences || []).map((x) => ({
        oemName: x.oemName,
        oemPartNumber: x.oemPartNumber,
      })),
      supplierRefs: (technical.supplierReferences || []).map((x) => ({
        supplierName: x.supplierName,
        supplierPartNumber: x.supplierPartNumber,
      })),
      interchangeableParts: (technical.interchangeableParts || []).map((x) => ({
        article: x.article,
        partNumber: x.partNumber,
        description: x.description,
        interchangeType: x.interchangeType,
        replacementPriority: x.replacementPriority,
        replacementNotes: x.replacementNotes,
      })),
      manufacturerPartNumbers: {
        primaryPartNumber: pn.primaryPartNumber,
        alternatePartNumbers: pn.alternatePartNumbers,
      },
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function resolveItemByTechnicalLookup(req, res) {
  try {
    const payload = req.method === "GET" ? req.query : req.body;
    const resolved = await resolveItemByLookupInput(req, payload || {});
    await writeAudit(req, {
      action: "LOOKUP",
      module: "ITEM_MASTER",
      entityType: "ITEM_RESOLUTION",
      entityId: resolved.matchedArticle || "",
      documentNo: resolved.matchedArticle || "",
      description: `Item lookup requested (${resolved.confidence})`,
      metadata: {
        input: payload || {},
        matchedArticle: resolved.matchedArticle || "",
        confidence: resolved.confidence || "",
        duplicateWarning: Boolean(resolved.duplicateWarning),
      },
    });
    res.json(resolved);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function bulkResolveItemLookup(req, res) {
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: "Upload CSV/Excel with file field" });
    const workbook = XLSX.read(req.file.buffer, { type: "buffer", raw: false });
    const ws = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    const normalizedRows = rows.map((raw) => {
      const row = Object.fromEntries(Object.entries(raw).map(([k, v]) => [trim(k), trim(v)]));
      return {
        _raw: row,
        article: pick(row, "Article", "ARTICLE"),
        esn: pick(row, "ESN"),
        spn: pick(row, "Part Number", "Part No.", "Part No", "SPN"),
        materialCode: pick(row, "Material Code", "MaterialCode", "MATERIAL CODE"),
        drawingNumber: pick(row, "Drawing Number", "DRAWING NUMBER"),
        oemReference: pick(row, "OEM Ref", "OEM Reference", "OEM"),
        supplierReference: pick(row, "Supplier Ref", "Supplier Reference"),
        engineModel: pick(row, "Engine Model"),
        configuration: pick(row, "Configuration", "Config"),
      };
    });
    const resolutions = await resolveLookupBatch({ companyId: req.companyId, rows: normalizedRows });
    const out = normalizedRows.map((row, index) => {
      const resolved = resolutions[index] || {};
      return {
        row: index + 2,
        input: row._raw,
        matchedArticle: resolved.matchedArticle || "",
        confidence: resolved.confidence || "NO_MATCH",
        candidateCount: (resolved.alternativeCandidates || []).length + (resolved.matchedArticle ? 1 : 0),
        reason: resolved.matchedReason || "",
        duplicateWarning: Boolean(resolved.duplicateWarning),
        alternatives: resolved.alternativeCandidates || [],
      };
    });
    await writeAudit(req, {
      action: "IMPORT",
      module: "ITEM_MASTER",
      entityType: "ITEM_RESOLUTION_BULK",
      entityId: "",
      documentNo: "",
      description: `Bulk technical resolution import processed (${out.length} rows)`,
      metadata: {
        total: out.length,
        matched: out.filter((x) => Boolean(x.matchedArticle)).length,
        lowConfidence: out.filter((x) => x.confidence === "LOW").length,
        duplicateWarnings: out.filter((x) => x.duplicateWarning).length,
      },
    });
    res.json({
      total: out.length,
      matched: out.filter((x) => Boolean(x.matchedArticle)).length,
      noMatch: out.filter((x) => !x.matchedArticle).length,
      errors: 0,
      items: out,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

export async function recordResolutionOverride(req, res) {
  try {
    const source = req.body?.source || "MANUAL";
    const selectedArticle = trim(req.body?.selectedArticle).toUpperCase();
    const input = req.body?.input || {};
    const alternatives = Array.isArray(req.body?.alternatives) ? req.body.alternatives : [];
    if (!selectedArticle) return res.status(400).json({ message: "selectedArticle is required" });
    await ensureItemExists(req, selectedArticle);
    await writeAudit(req, {
      action: "OVERRIDE",
      module: "ITEM_MASTER",
      entityType: "ITEM_RESOLUTION_OVERRIDE",
      entityId: selectedArticle,
      documentNo: selectedArticle,
      description: `Item resolution override accepted for ${selectedArticle}`,
      metadata: {
        source,
        input,
        selectedArticle,
        alternatives,
      },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
}

function aliasHttp(res, err) {
  return res.status(err.statusCode || 400).json({ message: err.message, code: err.code });
}

function aliasAudit(req, action, article, partNumber, extra = {}) {
  return writeAudit(req, {
    action,
    module: "ITEM_MASTER",
    entityType: "ITEM_TECHNICAL_ALIAS",
    entityId: article,
    documentNo: article,
    description: `${action} manufacturer Part Number "${partNumber}" on ${article}`,
    metadata: { article, partNumber, ...extra },
  });
}

export async function addItemAlternate(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const row = await addAlternatePartNumber({
      companyId: req.companyId,
      article,
      partNumber: req.body?.partNumber,
      userEmail: req.user?.email,
      expectedUpdatedAt: req.body?.expectedUpdatedAt || null,
    });
    await aliasAudit(req, "CREATE", article, req.body?.partNumber);
    res.json(scrubTechnicalAliases(row, req));
  } catch (err) {
    aliasHttp(res, err);
  }
}

export async function removeItemAlternate(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const partNumber = req.body?.partNumber;
    const row = await removeAlternatePartNumber({
      companyId: req.companyId,
      article,
      partNumber,
      expectedUpdatedAt: req.body?.expectedUpdatedAt || null,
    });
    await aliasAudit(req, "DELETE", article, partNumber);
    res.json(scrubTechnicalAliases(row, req));
  } catch (err) {
    aliasHttp(res, err);
  }
}

export async function promoteItemAlternate(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const partNumber = req.body?.partNumber;
    const row = await promoteAlternatePartNumber({
      companyId: req.companyId,
      article,
      partNumber,
      userEmail: req.user?.email,
      expectedUpdatedAt: req.body?.expectedUpdatedAt || null,
    });
    await aliasAudit(req, "UPDATE", article, partNumber, { operation: "PROMOTE" });
    res.json(scrubTechnicalAliases(row, req));
  } catch (err) {
    aliasHttp(res, err);
  }
}

export async function setItemAlternateStatus(req, res) {
  try {
    const article = trim(req.params.article).toUpperCase();
    const partNumber = req.body?.partNumber;
    const row = await setAlternatePartNumberStatus({
      companyId: req.companyId,
      article,
      partNumber,
      status: req.body?.status,
      userEmail: req.user?.email,
      expectedUpdatedAt: req.body?.expectedUpdatedAt || null,
    });
    await aliasAudit(req, "UPDATE", article, partNumber, { operation: "STATUS", status: req.body?.status });
    res.json(scrubTechnicalAliases(row, req));
  } catch (err) {
    aliasHttp(res, err);
  }
}
