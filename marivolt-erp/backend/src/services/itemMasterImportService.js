/**
 * Company-scoped Item Master CSV/Excel preview + apply.
 * Preview never writes. Apply never overwrites a populated field with a blank cell.
 */
import mongoose from "mongoose";
import XLSX from "xlsx";
import ItemMaster, { UOM_VALUES } from "../models/itemMasterModel.js";
import ItemTechnical from "../models/itemTechnicalModel.js";
import ItemSupplier from "../models/itemSupplierModel.js";
import Supplier from "../models/Supplier.js";
import { assertValidTaxonomy, mapImportTaxonomyColumns } from "../utils/itemMasterTaxonomy.js";

export const ITEM_MASTER_CLEAR_MARKER = "__CLEAR__";

export const ITEM_MASTER_TEMPLATE_HEADERS = [
  "Article",
  "Status",
  "Vertical",
  "Brand",
  "Model",
  "Configuration",
  "Description",
  "Item Name",
  "UOM",
  "SPN",
  "Material Code",
  "Drawing Number",
  "OEM Reference/Markings",
  "Specifications",
  "Dimensions",
  "External Remarks",
  "Internal Remarks",
  "Supplier 1",
  "Supplier 1 Part Number",
  "Supplier 2",
  "Supplier 2 Part Number",
];

const STOCK_HEADER_RE = /^(qty|quantity|stock|onhand|on hand|available|opening|availability)$/i;

function trim(value) {
  return String(value ?? "").trim();
}

function pick(row, ...keys) {
  for (const key of keys) {
    const out = trim(row[key]);
    if (out) return out;
  }
  return "";
}

function normalizeUom(value, { required = false } = {}) {
  const upper = trim(value).toUpperCase();
  if (!upper) return required ? "" : "";
  return UOM_VALUES.includes(upper) ? upper : null;
}

function isClear(value) {
  return trim(value).toUpperCase() === ITEM_MASTER_CLEAR_MARKER;
}

function mergeScalar(existing, incoming) {
  if (isClear(incoming)) return "";
  if (incoming == null || trim(incoming) === "") return existing ?? "";
  return incoming;
}

function parseWorkbookRows(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer", raw: false });
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: "" });
}

function normalizeHeaderRow(raw) {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [trim(k), v]));
}

function ignoredStockHeaders(row) {
  return Object.keys(row).filter((key) => STOCK_HEADER_RE.test(key));
}

function mapIncomingItem(row) {
  const article = pick(row, "Article", "ARTICLE").toUpperCase();
  const statusRaw = pick(row, "Status", "STATUS");
  let status = "";
  if (statusRaw) {
    const s = statusRaw.toLowerCase();
    if (s === "inactive") status = "Inactive";
    else if (s === "active") status = "Active";
    else status = "__INVALID_STATUS__";
  }
  const uomRaw = pick(row, "UOM", "Uom", "uom");
  const uom = uomRaw ? normalizeUom(uomRaw) : "";
  const taxonomyInput = mapImportTaxonomyColumns({
    ...row,
    Configuration: pick(row, "Configuration", "Config", "CONFIG"),
  });
  return {
    article,
    status,
    uom,
    uomRaw,
    itemName: pick(row, "ITEM NAME", "Item Name", "itemName"),
    description: pick(row, "Description", "DESCRIPTION"),
    taxonomyInput,
    spn: pick(row, "SPN"),
    materialCode: pick(row, "Material Code", "Material code"),
    drawingNumber: pick(row, "Drawing Number", "Drawing number"),
    oeMarkings: pick(row, "OEM Reference/Markings", "OE Markings", "OEM Reference"),
    specifications: pick(row, "Specifications", "Specs"),
    dimension: pick(row, "Dimensions", "Dimension", "DIMENSION"),
    extRemarks: pick(row, "External Remarks", "Ext Remarks", "Ext remarks"),
    internalRemarks: pick(row, "Internal Remarks", "Internal remarks"),
    suppliers: [
      {
        supplierName: pick(row, "Supplier 1"),
        supplierPartNumber: pick(row, "Supplier 1 Part Number", "Supplier 1 P/N", "Supplier 1 P/N "),
      },
      {
        supplierName: pick(row, "Supplier 2"),
        supplierPartNumber: pick(row, "Supplier 2 Part Number", "Supplier 2 P/N", "Supplier 2 P/N "),
      },
    ].filter((s) => s.supplierName),
    ignoredStockHeaders: ignoredStockHeaders(row),
  };
}

function fieldDiffs(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = {};
  for (const key of keys) {
    const from = before?.[key] ?? "";
    const to = after?.[key] ?? "";
    if (String(from) !== String(to)) changes[key] = { from, to };
  }
  return changes;
}

function buildTemplateCsv() {
  const header = ITEM_MASTER_TEMPLATE_HEADERS.map((h) => `"${h}"`).join(",");
  const example = [
    "ART-DEMO-001",
    "Active",
    "Engine",
    "MAN",
    "L27/38",
    "",
    "Demo liner",
    "Cylinder liner",
    "PCS",
    "SPN-1",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
  ]
    .map((c) => `"${String(c).replace(/"/g, '""')}"`)
    .join(",");
  return `${header}\n${example}\n`;
}

export function itemMasterImportTemplateCsv() {
  return buildTemplateCsv();
}

async function knownSupplierNames(companyId) {
  const rows = await Supplier.find({ companyId }).select("name supplierName").lean();
  const names = new Set();
  for (const row of rows || []) {
    const a = trim(row.supplierName).toLowerCase();
    const b = trim(row.name).toLowerCase();
    if (a) names.add(a);
    if (b) names.add(b);
  }
  return names;
}

function mongoSupportsTransactions() {
  const type = String(mongoose.connection?.client?.topology?.description?.type || "");
  return type === "ReplicaSetWithPrimary" || type === "ReplicaSetNoPrimary" || type === "LoadBalanced";
}

function assertItemMasterImportAtomicityAvailable() {
  if (mongoSupportsTransactions()) return;
  const e = new Error(
    "Item Master import requires a replica-set MongoDB so ItemMaster, ItemTechnical and ItemSupplier apply atomically. No records were written."
  );
  e.statusCode = 503;
  e.code = "ITEM_MASTER_IMPORT_ATOMICITY_UNAVAILABLE";
  throw e;
}

function assignImported(target, key, incoming) {
  if (isClear(incoming)) target[key] = "";
  else if (trim(incoming)) target[key] = incoming;
}

export async function previewItemMasterImport({ companyId, buffer }) {
  if (!companyId) {
    const e = new Error("Authenticated company context is required");
    e.statusCode = 403;
    throw e;
  }
  if (!buffer) {
    const e = new Error("Upload CSV/Excel with file field");
    e.statusCode = 400;
    throw e;
  }
  const rows = parseWorkbookRows(buffer);
  const knownSuppliers = await knownSupplierNames(companyId);
  const seen = new Map();
  const articles = [];
  const parsed = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = normalizeHeaderRow(rows[index]);
    const incoming = mapIncomingItem(row);
    const excelRow = index + 2;
    const errors = [];
    if (!incoming.article) errors.push("Article is required");
    if (incoming.article) {
      if (seen.has(incoming.article)) {
        errors.push(`Duplicate article in import file (also row ${seen.get(incoming.article)})`);
      } else {
        seen.set(incoming.article, excelRow);
        articles.push(incoming.article);
      }
    }
    if (incoming.status === "__INVALID_STATUS__") errors.push("Status must be Active or Inactive");
    if (incoming.uomRaw && incoming.uom == null) errors.push(`UOM must be one of ${UOM_VALUES.join(", ")}`);
    try {
      if (incoming.taxonomyInput.vertical || incoming.taxonomyInput.brand || incoming.taxonomyInput.engine) {
        assertValidTaxonomy(incoming.taxonomyInput);
      }
    } catch (err) {
      errors.push(err.message);
    }
    for (const sup of incoming.suppliers) {
      if (!knownSuppliers.has(trim(sup.supplierName).toLowerCase())) {
        errors.push(`Unknown supplier reference: ${sup.supplierName}`);
      }
    }
    parsed.push({ excelRow, incoming, errors });
  }

  const existingRows = articles.length
    ? await ItemMaster.find({ companyId, article: { $in: articles } }).lean()
    : [];
  const existingTech = articles.length
    ? await ItemTechnical.find({ companyId, article: { $in: articles } }).lean()
    : [];
  const existingByArticle = new Map(existingRows.map((r) => [r.article, r]));
  const techByArticle = new Map(existingTech.map((r) => [r.article, r]));

  const result = {
    total: rows.length,
    newArticles: [],
    existingWillChange: [],
    unchanged: [],
    invalid: [],
    duplicateArticles: [],
    ignoredStockColumns: [...new Set(parsed.flatMap((p) => p.incoming.ignoredStockHeaders))],
    rows: [],
  };

  for (const row of parsed) {
    const article = row.incoming.article;
    const existing = existingByArticle.get(article);
    let action = existing ? "UPDATE" : "CREATE";
    const taxonomy = row.incoming.taxonomyInput;
    const proposedItem = existing
      ? {
          itemName: mergeScalar(existing.itemName, row.incoming.itemName),
          description: mergeScalar(existing.description, row.incoming.description),
          vertical: mergeScalar(existing.vertical, taxonomy.vertical),
          brand: mergeScalar(existing.brand || existing.engine, taxonomy.brand || taxonomy.engine),
          model: mergeScalar(existing.model, taxonomy.model),
          config: mergeScalar(existing.config, taxonomy.config),
          uom: row.incoming.uom || existing.uom || "PCS",
          status: row.incoming.status || existing.status || "Active",
        }
      : {
          itemName: row.incoming.itemName || row.incoming.description || article,
          description: row.incoming.description,
          vertical: taxonomy.vertical || "",
          brand: taxonomy.brand || taxonomy.engine || "",
          model: taxonomy.model || "",
          config: taxonomy.config || "",
          uom: row.incoming.uom || "PCS",
          status: row.incoming.status === "Inactive" ? "Inactive" : "Active",
        };
    if (!existing && !row.incoming.itemName && !row.incoming.description && article) {
      row.errors.push("Item Name or Description is required for a new Article");
    }
    const existingSlice = existing
      ? {
          itemName: existing.itemName || "",
          description: existing.description || "",
          vertical: existing.vertical || "",
          brand: existing.brand || existing.engine || "",
          model: existing.model || "",
          config: existing.config || "",
          uom: existing.uom || "",
          status: existing.status || "",
        }
      : {};
    const changes = existing ? fieldDiffs(existingSlice, proposedItem) : proposedItem;
    if (row.errors.length) {
      action = "INVALID";
      result.invalid.push({ row: row.excelRow, article, errors: row.errors });
      if (row.errors.some((e) => e.startsWith("Duplicate article"))) {
        result.duplicateArticles.push(article);
      }
    } else if (!existing) {
      result.newArticles.push(article);
    } else if (Object.keys(changes).length) {
      result.existingWillChange.push(article);
    } else {
      action = "UNCHANGED";
      result.unchanged.push(article);
    }
    result.rows.push({
      row: row.excelRow,
      article,
      action,
      errors: row.errors,
      changes: existing ? changes : proposedItem,
      before: existingSlice,
      after: proposedItem,
      normalizedArticle: article,
      ignoredStockHeaders: row.incoming.ignoredStockHeaders,
      suppliers: row.incoming.suppliers,
      technical: {
        spn: row.incoming.spn,
        materialCode: row.incoming.materialCode,
        drawingNumber: row.incoming.drawingNumber,
        existingSpn: techByArticle.get(article)?.spn || "",
      },
    });
  }

  result.canApply = result.invalid.length === 0 && result.total > 0;
  return result;
}

async function applyInSession({ companyId, userEmail, parsed, existingByArticle, session }) {
  const counts = { created: 0, updated: 0, unchanged: 0, errors: 0 };
  for (const row of parsed) {
    if (row.errors.length) {
      counts.errors += 1;
      continue;
    }
    const incoming = row.incoming;
    const existing = existingByArticle.get(incoming.article);
    const taxonomy = incoming.taxonomyInput.vertical || incoming.taxonomyInput.brand
      ? assertValidTaxonomy(incoming.taxonomyInput)
      : {
          vertical: existing?.vertical || "",
          brand: existing?.brand || existing?.engine || "",
          engine: existing?.engine || existing?.brand || "",
          model: existing?.model || "",
          config: existing?.config || "",
        };
    const payload = existing
      ? {
          itemName: mergeScalar(existing.itemName, incoming.itemName),
          description: mergeScalar(existing.description, incoming.description),
          vertical: mergeScalar(existing.vertical, taxonomy.vertical),
          brand: mergeScalar(existing.brand || existing.engine, taxonomy.brand || taxonomy.engine),
          engine: mergeScalar(existing.engine || existing.brand, taxonomy.engine || taxonomy.brand),
          model: mergeScalar(existing.model, taxonomy.model),
          config: mergeScalar(existing.config, taxonomy.config),
          uom: incoming.uom || existing.uom || "PCS",
          status: incoming.status || existing.status || "Active",
        }
      : {
          companyId,
          article: incoming.article,
          itemName: incoming.itemName || incoming.description || incoming.article,
          description: incoming.description || "",
          ...assertValidTaxonomy({
            vertical: incoming.taxonomyInput.vertical,
            brand: incoming.taxonomyInput.brand || incoming.taxonomyInput.engine,
            engine: incoming.taxonomyInput.engine || incoming.taxonomyInput.brand,
            model: incoming.taxonomyInput.model,
            config: incoming.taxonomyInput.config,
          }),
          uom: incoming.uom || "PCS",
          status: incoming.status === "Inactive" ? "Inactive" : "Active",
        };

    if (existing) {
      const same =
        existing.itemName === payload.itemName &&
        existing.description === payload.description &&
        existing.vertical === payload.vertical &&
        (existing.brand || existing.engine) === (payload.brand || payload.engine) &&
        existing.model === payload.model &&
        existing.config === payload.config &&
        existing.uom === payload.uom &&
        existing.status === payload.status;
      if (same && !incoming.spn && !incoming.materialCode && !incoming.suppliers.length) {
        counts.unchanged += 1;
      } else {
        await ItemMaster.updateOne({ _id: existing._id, companyId }, { $set: payload }, { session, runValidators: true });
        counts.updated += 1;
      }
    } else {
      await ItemMaster.create([{ ...payload, companyId, article: incoming.article }], { session });
      counts.created += 1;
    }

    const techSet = {};
    assignImported(techSet, "spn", incoming.spn);
    assignImported(techSet, "materialCode", incoming.materialCode);
    assignImported(techSet, "drawingNumber", incoming.drawingNumber);
    assignImported(techSet, "oeMarkings", incoming.oeMarkings);
    if (isClear(incoming.specifications)) {
      techSet.technicalSpecifications = [];
    } else if (trim(incoming.specifications)) {
      techSet.technicalSpecifications = [{ specName: "Specs", specValue: incoming.specifications, specUnit: "", notes: "" }];
    }
    assignImported(techSet, "dimension", incoming.dimension);
    assignImported(techSet, "extRemarks", incoming.extRemarks);
    assignImported(techSet, "internalRemarks", incoming.internalRemarks);
    if (Object.keys(techSet).length) {
      await ItemTechnical.findOneAndUpdate(
        { companyId, article: incoming.article },
        { $set: techSet, $setOnInsert: { companyId, article: incoming.article } },
        { upsert: true, new: true, session, runValidators: true }
      );
    }

    for (const supplier of incoming.suppliers) {
      await ItemSupplier.findOneAndUpdate(
        { companyId, article: incoming.article, supplierName: supplier.supplierName, supplierPartNumber: supplier.supplierPartNumber },
        {
          $set: {
            supplierPartNumber: supplier.supplierPartNumber,
            leadTime: "",
            remarks: "",
          },
          $setOnInsert: {
            companyId,
            article: incoming.article,
            supplierName: supplier.supplierName,
            currency: "USD",
            price: 0,
          },
        },
        { upsert: true, new: true, session, runValidators: true }
      );
    }
  }
  return { ...counts, appliedBy: userEmail || "" };
}

export async function applyItemMasterImport({ companyId, buffer, userEmail = "" }) {
  const preview = await previewItemMasterImport({ companyId, buffer });
  if (!preview.canApply) {
    const e = new Error("Import has validation errors; fix them before apply");
    e.statusCode = 409;
    e.code = "ITEM_MASTER_IMPORT_INVALID";
    e.preview = preview;
    throw e;
  }
  const rows = parseWorkbookRows(buffer);
  const parsed = [];
  const seen = new Map();
  for (let index = 0; index < rows.length; index += 1) {
    const incoming = mapIncomingItem(normalizeHeaderRow(rows[index]));
    const errors = [];
    if (seen.has(incoming.article)) errors.push("Duplicate article in import file");
    else seen.set(incoming.article, index + 2);
    parsed.push({ excelRow: index + 2, incoming, errors });
  }
  const articles = parsed.map((p) => p.incoming.article).filter(Boolean);
  const existingRows = await ItemMaster.find({ companyId, article: { $in: articles } }).lean();
  const existingByArticle = new Map(existingRows.map((r) => [r.article, r]));

  assertItemMasterImportAtomicityAvailable();
  const session = await mongoose.startSession();
  try {
    let counts;
    await session.withTransaction(async () => {
      counts = await applyInSession({ companyId, userEmail, parsed, existingByArticle, session });
    });
    return { ...preview, apply: counts };
  } catch (txErr) {
    const msg = String(txErr?.message || "");
    if (/transaction|replica set|not supported/i.test(msg) || txErr?.code === "ITEM_MASTER_IMPORT_ATOMICITY_UNAVAILABLE") {
      const e = new Error(
        "Item Master import requires a replica-set MongoDB so ItemMaster, ItemTechnical and ItemSupplier apply atomically. No records were written."
      );
      e.statusCode = 503;
      e.code = "ITEM_MASTER_IMPORT_ATOMICITY_UNAVAILABLE";
      throw e;
    }
    throw txErr;
  } finally {
    await session.endSession();
  }
}
