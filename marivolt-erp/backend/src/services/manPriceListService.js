/**
 * MAN price-list management: CSV preview/apply, CRUD, export.
 * Purchase fields are never returned on sales-facing helpers.
 */
import crypto from "crypto";
import ItemMaster, { UOM_VALUES } from "../models/itemMasterModel.js";
import ItemTechnical from "../models/itemTechnicalModel.js";
import ItemSupplier from "../models/itemSupplierModel.js";
import Supplier from "../models/Supplier.js";
import AuditLog from "../models/AuditLog.js";
import ManPriceList from "../models/ManPriceList.js";
import ManPriceListRevision from "../models/ManPriceListRevision.js";
import ManPriceListImport from "../models/ManPriceListImport.js";
import { writeAudit } from "./auditService.js";
import { getStockBalance } from "./stockService.js";
import { parseExcelBufferToRows } from "../utils/excelParser.js";
import { runMongoTransaction } from "../utils/mongoTransaction.js";
import {
  MAN_PRICE_LIST_HEADERS,
  cellIsBlank,
  contentFingerprint,
  displayedItemMasterSpn,
  displayedItemMasterSpecs,
  displayedSupplier1,
  formatExportAvailability,
  isManEligibleItem,
  isoTimestamp,
  mapCsvRow,
  parseOptionalMoney,
  preserveArticleCode,
  buildCsv,
  rowHasDuplicateArticle,
  shouldSkipUnchangedImport,
  DEFAULT_FULFILMENT_WAREHOUSE,
} from "../utils/manPriceList.js";

function err(message, statusCode = 400, code = "MAN_PRICE_LIST") {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  return e;
}

function priceListInactiveMessage(article) {
  return `Article ${article} is inactive in Item Master and cannot be used in Price List.`;
}

function isActiveItemMaster(item) {
  return Boolean(item) && String(item.status || "Active") === "Active";
}

function classifyPriceListItemMaster(item, article) {
  if (!item) {
    return {
      code: "ARTICLE_NOT_IN_ITEM_MASTER",
      message: "Unknown Article — create it in Item Master, then re-import",
    };
  }
  if (!isActiveItemMaster(item)) {
    return {
      code: "ARTICLE_INACTIVE",
      message: priceListInactiveMessage(article),
    };
  }
  return null;
}

function throwPriceListArticleIssues(issues) {
  if (!issues.length) return;
  const missing = issues.filter((row) => row.code === "ARTICLE_NOT_IN_ITEM_MASTER");
  const primary = missing[0] || issues[0];
  const e = err(primary.message, 409, primary.code);
  e.articles = [...new Set(issues.map((row) => row.article))];
  e.lines = issues;
  e.errors = issues;
  throw e;
}

function actor(req) {
  return {
    name: req.user?.name || req.user?.email || "",
    email: req.user?.email || "",
  };
}

function priceHash(doc) {
  return contentFingerprint({
    currency: doc.currency || "",
    sellPrice: doc.sellPrice,
    sellIi: doc.sellIi,
    minm: doc.minm,
    rock: doc.rock,
    buy: doc.buy,
    nextBuy: doc.nextBuy,
    leadTime: doc.leadTime || "",
    isActive: doc.isActive !== false,
  });
}

function moneyFromRow(mapped, header) {
  return parseOptionalMoney(mapped[header]);
}

async function resolveSupplier(companyId, name) {
  const raw = String(name || "").trim();
  if (!raw) return { status: "blank", matches: [] };
  const re = new RegExp(`^${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const matches = await Supplier.find({
    companyId,
    $or: [{ supplierName: re }, { name: re }, { shortName: re }],
  })
    .select("_id supplierName name shortName supplierCode")
    .lean();
  if (matches.length === 1) return { status: "matched", matches };
  if (matches.length > 1) return { status: "ambiguous", matches };
  return { status: "unmatched", matches: [] };
}

async function availableQtyForArticle(companyId, article) {
  const bal = await getStockBalance({
    companyId,
    article,
    warehouse: DEFAULT_FULFILMENT_WAREHOUSE,
  });
  return Number(bal.availableQty) || 0;
}

function upsertSpecs(technical, specsText) {
  const value = String(specsText || "").trim();
  if (!value) return technical.technicalSpecifications || [];
  const list = [...(technical.technicalSpecifications || [])];
  const idx = list.findIndex((s) => String(s.specName || "").toUpperCase() === "SPECS");
  if (idx >= 0) list[idx] = { ...list[idx], specName: "SPECS", specValue: value };
  else list.push({ specName: "SPECS", specValue: value });
  return list;
}

export function toManagementDto(row, extras = {}) {
  return {
    id: String(row._id),
    itemMasterId: String(row.itemMasterId),
    article: row.article,
    currency: row.currency,
    sellPrice: row.sellPrice,
    sellIi: row.sellIi,
    minm: row.minm,
    rock: row.rock,
    buy: row.buy,
    nextBuy: row.nextBuy,
    leadTime: row.leadTime || "",
    isActive: row.isActive !== false,
    revision: row.revision,
    updatedAt: row.updatedAt,
    uom: extras.uom || "",
    description: extras.description || "",
    spn: extras.spn || "",
    brand: extras.brand || "",
    model: extras.model || "",
    config: extras.config || "",
    specs: extras.specs || "",
    supplier: extras.supplier || "",
    supplierPartNumber: extras.supplierPartNumber || "",
    availableQty: extras.availableQty,
  };
}

export function toSalesDto(row, extras = {}) {
  return {
    article: row.article,
    currency: row.currency,
    sellPrice: row.sellPrice,
    sellIi: row.sellIi,
    minm: row.minm,
    rock: extras.includeRock ? row.rock : extras.canRock ? row.rock : null,
    leadTime: row.leadTime || "",
    isActive: row.isActive !== false,
    revision: row.revision,
    updatedAt: row.updatedAt,
    uom: extras.uom || "",
    description: extras.description || "",
    spn: extras.spn || "",
    brand: extras.brand || "",
    model: extras.model || "",
    config: extras.config || "",
    specs: extras.specs || "",
    availableQty: extras.availableQty,
  };
}

function itemMasterDisplayExtras(item, technical, extra = {}) {
  return {
    uom: item?.uom || extra.uom || "",
    description: extra.description || item?.description || item?.itemName || "",
    spn: displayedItemMasterSpn(item, technical) || extra.spn || "",
    brand: item?.brand || item?.engine || extra.brand || "",
    model: item?.model || "",
    config: item?.config || "",
    specs: displayedItemMasterSpecs(technical),
    supplier: extra.supplier ?? item?.supplier ?? "",
    supplierPartNumber: extra.supplierPartNumber ?? item?.supplierPartNumber ?? "",
    availableQty: extra.availableQty,
    canRock: extra.canRock,
    includeRock: extra.includeRock,
  };
}

export async function listPriceList(req, { q = "", includeInactive = false } = {}) {
  const filter = { companyId: req.companyId };
  if (!includeInactive) filter.isActive = true;
  if (q) {
    const term = String(q).trim();
    filter.$or = [
      { article: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
    ];
  }
  const rows = await ManPriceList.find(filter).sort({ article: 1 }).lean();
  const articles = rows.map((r) => r.article);
  const items = await ItemMaster.find({ companyId: req.companyId, article: { $in: articles } }).lean();
  const techs = await ItemTechnical.find({ companyId: req.companyId, article: { $in: articles } }).lean();
  const byArticle = new Map(items.map((i) => [i.article, i]));
  const techByArticle = new Map(techs.map((t) => [t.article, t]));
  const out = [];
  for (const row of rows) {
    const item = byArticle.get(row.article);
    const availableQty = await availableQtyForArticle(req.companyId, row.article);
    out.push(
      toManagementDto(
        row,
        itemMasterDisplayExtras(item, techByArticle.get(row.article), {
          supplier: item?.supplier || "",
          supplierPartNumber: item?.supplierPartNumber || "",
          availableQty,
        })
      )
    );
  }
  return out;
}

export async function getPriceListByArticle(req, article, { management = false, canRock = false } = {}) {
  const code = preserveArticleCode(article);
  const row = await ManPriceList.findOne({ companyId: req.companyId, article: code }).lean();
  if (!row) {
    throw err("MAN price list record not found", 404, "MAN_PRICE_LIST_MISSING");
  }
  const item = await ItemMaster.findOne({ companyId: req.companyId, article: code }).lean();
  const technical = await ItemTechnical.findOne({ companyId: req.companyId, article: code }).lean();
  const availableQty = await availableQtyForArticle(req.companyId, code);
  const extras = itemMasterDisplayExtras(item, technical, {
    supplier: item?.supplier || "",
    supplierPartNumber: item?.supplierPartNumber || "",
    availableQty,
    canRock,
  });
  return management ? toManagementDto(row, extras) : toSalesDto(row, extras);
}

async function writeRevision(req, doc, { source, importId, filename, session } = {}) {
  const who = actor(req);
  const payload = {
    companyId: req.companyId,
    priceListId: doc._id,
    article: doc.article,
    revision: doc.revision,
    snapshot: doc.toObject ? doc.toObject() : doc,
    source,
    importId: importId || null,
    sourceFilename: filename || "",
    actorName: who.name,
    actorEmail: who.email,
  };
  if (session) {
    await ManPriceListRevision.create([payload], { session });
  } else {
    await ManPriceListRevision.create(payload);
  }
}

function asObjectIdOrNull(value) {
  const s = String(value || "").trim();
  return /^[a-fA-F0-9]{24}$/.test(s) ? s : null;
}

async function writeImportAudit(req, { doc, preview, row, session }) {
  const userId = asObjectIdOrNull(req.user?._id || req.user?.id);
  const meta = {
    companyId: req.companyId,
    userId,
    userName: req.user?.name || "",
    userEmail: req.user?.email || "",
    action: "UPDATE",
    module: "PRICE_LIST",
    entityType: "ManPriceList",
    entityId: String(doc._id || ""),
    documentNo: row.article,
    description: `MAN price list CSV import ${preview.filename || preview._id} applied to ${row.article}`,
    metadata: {
      importId: String(preview._id),
      filename: preview.filename,
      itemChanges: row.itemChanges,
      priceChanges: row.priceChanges,
    },
  };
  await AuditLog.create([meta], { session });
}

export async function upsertManualPrice(req, article, body = {}) {
  const code = preserveArticleCode(article || body.article);
  const item = await ItemMaster.findOne({ companyId: req.companyId, article: code });
  if (!item) throw err("Item Master record not found", 404, "ITEM_MISSING");
  if (String(item.status || "Active") !== "Active") {
    throw err(
      `Article ${code} is inactive in Item Master and cannot be used on a new transaction.`,
      409,
      "ARTICLE_INACTIVE"
    );
  }
  if (!isManEligibleItem(item)) {
    throw err("Price list is MAN-only; this Article is not MAN-eligible", 400, "NOT_MAN");
  }
  let doc = await ManPriceList.findOne({ companyId: req.companyId, article: code });
  const before = doc ? doc.toObject() : null;
  if (!doc) {
    doc = new ManPriceList({
      companyId: req.companyId,
      itemMasterId: item._id,
      article: code,
      createdBy: actor(req).email,
    });
  }
  const moneyKeys = ["sellPrice", "sellIi", "minm", "rock", "buy", "nextBuy"];
  for (const key of moneyKeys) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    if (body[key] === null || body[key] === "") {
      doc[key] = null;
      continue;
    }
    const parsed = parseOptionalMoney(body[key]);
    if (parsed.error) throw err(parsed.error);
    doc[key] = parsed.present ? parsed.value : null;
  }
  if (body.currency != null && String(body.currency).trim()) {
    doc.currency = String(body.currency).trim().toUpperCase();
  }
  if (body.leadTime != null) doc.leadTime = String(body.leadTime).trim();
  if (body.isActive != null) doc.isActive = Boolean(body.isActive);
  doc.itemMasterId = item._id;
  doc.source = "MANUAL";
  doc.updatedBy = actor(req).email;
  const nextHash = priceHash(doc);
  const unchanged = before && before.contentHash === nextHash && priceHash(before) === nextHash;
  const technical = await ItemTechnical.findOne({ companyId: req.companyId, article: code }).lean();
  const extras = itemMasterDisplayExtras(item, technical);
  if (unchanged && before) {
    return toManagementDto(doc, extras);
  }
  if (before) doc.revision = Number(before.revision || 1) + 1;
  doc.contentHash = nextHash;
  await doc.save();
  await writeRevision(req, doc, { source: "MANUAL" });
  await writeAudit(req, {
    action: before ? "UPDATE" : "CREATE",
    module: "PRICE_LIST",
    entityType: "ManPriceList",
    entityId: doc._id,
    documentNo: code,
    description: `MAN price list ${before ? "updated" : "created"} for ${code}`,
    beforeData: before,
    afterData: doc.toObject(),
  });
  return toManagementDto(doc, extras);
}

export function csvTemplate() {
  return buildCsv(MAN_PRICE_LIST_HEADERS, [{}]);
}

async function loadSupplier1(companyId, article, session = null) {
  const q = ItemSupplier.find({ companyId, article }).sort({ supplierName: 1, _id: 1 });
  if (session) q.session(session);
  const rows = await q;
  return rows[0] || null;
}

function itemFingerprint(item, technical, supplier1 = null) {
  return contentFingerprint({
    updatedAt: item?.updatedAt,
    description: item?.description,
    spn: item?.spn,
    technicalSpn: technical?.spn,
    remarks: item?.remarks,
    supplier: item?.supplier,
    supplierPartNumber: item?.supplierPartNumber,
    supplier1Name: supplier1?.supplierName || "",
    supplier1PartNumber: supplier1?.supplierPartNumber || "",
    specWeight: technical?.specWeight,
    extRemarks: technical?.extRemarks,
    specs: (technical?.technicalSpecifications || []).find((s) => String(s.specName).toUpperCase() === "SPECS")
      ?.specValue,
  });
}

export async function previewImport(req, { buffer, filename }) {
  const rows = parseExcelBufferToRows(buffer, {
    preserveFormattedTextColumns: ["Article", "Part no", "Supplier part No.", "Sell 2"],
  });
  const mappedRows = rows.map((r) => ({ rowNumber: r.rowNumber, data: mapCsvRow(r.data) }));
  const articles = mappedRows.map((r) => preserveArticleCode(r.data.Article));
  const dupes = rowHasDuplicateArticle(articles);
  const errors = [];
  const warnings = [];
  if (dupes.length) {
    errors.push({
      rowNumber: 0,
      article: dupes.join(", "),
      message: `Duplicate Article rows in upload: ${dupes.join(", ")}`,
    });
  }

  const previewRows = [];
  const fingerprints = {};

  for (const { rowNumber, data } of mappedRows) {
    const article = preserveArticleCode(data.Article);
    const rowErrors = [];
    const rowWarnings = [];
    if (!article) {
      rowErrors.push("Article is required");
      errors.push({ rowNumber, article: "", message: "Article is required" });
      previewRows.push({ rowNumber, article: "", errors: rowErrors, warnings: rowWarnings });
      continue;
    }
    const item = await ItemMaster.findOne({ companyId: req.companyId, article }).lean();
    const identityIssue = classifyPriceListItemMaster(item, article);
    if (identityIssue) {
      rowErrors.push(identityIssue.message);
      errors.push({
        rowNumber,
        article,
        message: identityIssue.message,
        code: identityIssue.code,
      });
      previewRows.push({
        rowNumber,
        article,
        itemMasterId: item?._id ? String(item._id) : "",
        unknownArticle: identityIssue.code === "ARTICLE_NOT_IN_ITEM_MASTER",
        inactiveArticle: identityIssue.code === "ARTICLE_INACTIVE",
        errors: rowErrors,
        warnings: rowWarnings,
        code: identityIssue.code,
        proposed: data,
      });
      continue;
    }
    if (!isManEligibleItem(item)) {
      rowErrors.push("Article is not MAN-eligible (brand/engine must be MAN)");
      errors.push({ rowNumber, article, message: "Article is not MAN-eligible" });
      previewRows.push({ rowNumber, article, itemMasterId: String(item._id), errors: rowErrors });
      continue;
    }

    const technical = await ItemTechnical.findOne({ companyId: req.companyId, article }).lean();
    const currentPrice = await ManPriceList.findOne({ companyId: req.companyId, article }).lean();
    const supplier1 = await loadSupplier1(req.companyId, article);
    const displaySpn = displayedItemMasterSpn(item, technical);
    const displaySupplier1 = displayedSupplier1(supplier1, item);

    const moneyFields = [
      ["Sell price", "sellPrice"],
      ["Sell II", "sellIi"],
      ["Minm", "minm"],
      ["Rock", "rock"],
      ["Buy", "buy"],
      ["Next Buy", "nextBuy"],
    ];
    const proposedPrices = {};
    for (const [header, key] of moneyFields) {
      const parsed = moneyFromRow(data, header);
      if (parsed.error) {
        rowErrors.push(`${header}: ${parsed.error}`);
        errors.push({ rowNumber, article, message: `${header}: ${parsed.error}` });
      } else if (parsed.present) {
        proposedPrices[key] = parsed.value;
      }
    }

    const supplierName = String(data.Supplier || "").trim();
    let supplierResolution = { status: "blank", matches: [] };
    if (supplierName) {
      supplierResolution = await resolveSupplier(req.companyId, supplierName);
      if (supplierResolution.status === "ambiguous") {
        rowWarnings.push(`Supplier "${supplierName}" matches multiple supplier records — review required`);
        warnings.push({ rowNumber, article, message: `Ambiguous supplier: ${supplierName}` });
      } else if (supplierResolution.status === "unmatched") {
        rowWarnings.push(`Supplier "${supplierName}" was not found — not created automatically`);
        warnings.push({ rowNumber, article, message: `Unmatched supplier: ${supplierName}` });
      }
    }

    if (!cellIsBlank(data.Availability)) {
      rowWarnings.push(
        "Availability is computed from live stock at export/RFQ time and is not written from this CSV"
      );
    }

    const itemChanges = {};
    if (!cellIsBlank(data.Description) && data.Description !== (item.description || "")) {
      itemChanges.description = { from: item.description || "", to: data.Description };
    }
    if (!cellIsBlank(data["Part no"]) && String(data["Part no"]) !== displaySpn) {
      itemChanges.spn = { from: displaySpn, to: data["Part no"] };
    }
    if (!cellIsBlank(data["UWT (kg)"]) && data["UWT (kg)"] !== (technical?.specWeight || "")) {
      itemChanges.specWeight = { from: technical?.specWeight || "", to: data["UWT (kg)"] };
    }
    if (!cellIsBlank(data["Ext. Remarks"]) && data["Ext. Remarks"] !== (technical?.extRemarks || item.remarks || "")) {
      itemChanges.extRemarks = { from: technical?.extRemarks || item.remarks || "", to: data["Ext. Remarks"] };
    }
    if (!cellIsBlank(data.Specs)) {
      const currentSpecs =
        (technical?.technicalSpecifications || []).find((s) => String(s.specName).toUpperCase() === "SPECS")
          ?.specValue || "";
      if (data.Specs !== currentSpecs) {
        itemChanges.specs = { from: currentSpecs, to: data.Specs };
      }
    }
    if (!cellIsBlank(data["Supplier part No."]) && String(data["Supplier part No."]) !== displaySupplier1.partNumber) {
      itemChanges.supplierPartNumber = {
        from: displaySupplier1.partNumber,
        to: data["Supplier part No."],
        field: "ItemSupplier[0].supplierPartNumber (Supplier 1 P/N)",
      };
    }
    if (
      supplierResolution.status === "matched" &&
      supplierName &&
      supplierName !== displaySupplier1.name
    ) {
      itemChanges.supplier = {
        from: displaySupplier1.name,
        to: supplierName,
        field: "ItemSupplier[0].supplierName (Supplier 1)",
      };
    }

    const priceChanges = {};
    const currentPrices = currentPrice || {};
    for (const [, key] of moneyFields) {
      if (!Object.prototype.hasOwnProperty.call(proposedPrices, key)) continue;
      if (currentPrices[key] !== proposedPrices[key]) {
        priceChanges[key] = { from: currentPrices[key] ?? null, to: proposedPrices[key] };
      }
    }
    if (!cellIsBlank(data.Cur) && String(data.Cur).trim().toUpperCase() !== (currentPrices.currency || "")) {
      priceChanges.currency = { from: currentPrices.currency || "", to: String(data.Cur).trim().toUpperCase() };
    }
    if (!cellIsBlank(data["Lead time"]) && data["Lead time"] !== (currentPrices.leadTime || "")) {
      priceChanges.leadTime = { from: currentPrices.leadTime || "", to: data["Lead time"] };
    }

    if (proposedPrices.minm != null && proposedPrices.sellPrice != null && proposedPrices.minm > proposedPrices.sellPrice) {
      rowWarnings.push("Minm is higher than Sell price — flagged for review (tiers are independent; not auto-corrected)");
    }
    if (proposedPrices.rock != null && proposedPrices.sellPrice != null && proposedPrices.rock > proposedPrices.sellPrice) {
      rowWarnings.push("Rock is higher than Sell price — flagged for review (tiers are independent; not auto-corrected)");
    }
    if (Object.keys(itemChanges).length) {
      rowWarnings.push(
        "Item Master / supplier master columns are not applied from Price List import. Ask an authorized administrator to update Item Master separately."
      );
      warnings.push({
        rowNumber,
        article,
        message: "Price List import does not overwrite Item Master",
      });
    }

    fingerprints[article] = {
      itemUpdatedAt: isoTimestamp(item.updatedAt),
      technicalUpdatedAt: isoTimestamp(technical?.updatedAt),
      supplier1UpdatedAt: isoTimestamp(supplier1?.updatedAt),
      priceUpdatedAt: isoTimestamp(currentPrice?.updatedAt),
      priceRevision: Number(currentPrice?.revision || 0),
      itemHash: itemFingerprint(item, technical, supplier1),
      priceHash: currentPrice ? priceHash(currentPrice) : "",
    };

    if (rowErrors.length) {
      previewRows.push({
        rowNumber,
        article,
        itemMasterId: String(item._id),
        uom: item.uom,
        errors: rowErrors,
        warnings: rowWarnings,
      });
      continue;
    }

    previewRows.push({
      rowNumber,
      article,
      itemMasterId: String(item._id),
      uom: item.uom,
      matchedItem: {
        article: item.article,
        description: item.description,
        spn: item.spn,
        uom: item.uom,
      },
      itemChanges,
      priceChanges,
      proposedPrices,
      proposedItem: {
        description: cellIsBlank(data.Description) ? undefined : data.Description,
        spn: cellIsBlank(data["Part no"]) ? undefined : data["Part no"],
        specWeight: cellIsBlank(data["UWT (kg)"]) ? undefined : data["UWT (kg)"],
        extRemarks: cellIsBlank(data["Ext. Remarks"]) ? undefined : data["Ext. Remarks"],
        specs: cellIsBlank(data.Specs) ? undefined : data.Specs,
        supplierPartNumber: cellIsBlank(data["Supplier part No."]) ? undefined : data["Supplier part No."],
        supplierName: supplierResolution.status === "matched" ? supplierName : undefined,
        supplier1Id: supplier1 ? String(supplier1._id) : "",
        currency: cellIsBlank(data.Cur) ? undefined : String(data.Cur).trim().toUpperCase(),
        leadTime: cellIsBlank(data["Lead time"]) ? undefined : data["Lead time"],
      },
      supplierResolution: supplierResolution.status,
      warnings: rowWarnings,
      errors: [],
      availabilityNote:
        "Availability is live stock (MAIN warehouse). CSV Availability is ignored and never written to stock.",
    });
  }

  const canApply =
    errors.length === 0 &&
    previewRows.some(
      (r) => !r.unknownArticle && !r.inactiveArticle && !(r.errors || []).length
    );
  const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const preview = await ManPriceListImport.create({
    companyId: req.companyId,
    filename: filename || "",
    status: "PREVIEW",
    fileHash,
    rows: previewRows,
    importErrors: errors,
    warnings,
    itemFingerprints: fingerprints,
    canApply,
    createdBy: actor(req).email,
  });

  return {
    previewId: String(preview._id),
    filename: filename || "",
    canApply,
    errors,
    warnings,
    rows: previewRows,
    availabilityNote:
      "The Availability column is accepted for file compatibility only. It is never written to stock. Export/RFQ availability is computed from live MAIN-warehouse stock.",
  };
}

function findOneS(model, filter, session) {
  const q = model.findOne(filter);
  if (session) q.session(session);
  return q;
}

async function applyImportWithSession(req, previewId, session, { injectFailureAfter } = {}) {
  const preview = await findOneS(
    ManPriceListImport,
    { _id: previewId, companyId: req.companyId },
    session
  );
  if (!preview) throw err("Import preview not found", 404, "PREVIEW_MISSING");
  if (preview.status === "APPLIED") {
    return {
      applied: preview.appliedArticles || [],
      skippedUnchanged: preview.skippedUnchanged || [],
      previewId: String(preview._id),
      alreadyApplied: true,
    };
  }
  if (preview.status !== "PREVIEW") throw err("Import preview is not applyable", 409, "PREVIEW_INVALID");
  if (preview.expiresAt && preview.expiresAt.getTime() < Date.now()) {
    throw err("Import preview expired — upload again", 409, "PREVIEW_EXPIRED");
  }
  if (!preview.canApply || (preview.importErrors || preview.errors || []).length) {
    throw err("Import has errors and cannot be applied", 400, "PREVIEW_INVALID");
  }

  const includedRows = (preview.rows || []).filter((row) => preserveArticleCode(row.article));
  const identityIssues = [];
  for (const row of includedRows) {
    const liveItem = await findOneS(ItemMaster, { companyId: req.companyId, article: row.article }, session);
    const identityIssue = classifyPriceListItemMaster(liveItem, row.article);
    if (identityIssue) {
      identityIssues.push({
        article: row.article,
        rowNumber: row.rowNumber,
        code: identityIssue.code,
        message: identityIssue.message,
      });
    }
  }
  throwPriceListArticleIssues(identityIssues);

  const applied = [];
  const skippedUnchanged = [];
  let writes = 0;

  for (const row of preview.rows) {
    if (row.unknownArticle || row.inactiveArticle || (row.errors || []).length) continue;
    const item = await findOneS(ItemMaster, { companyId: req.companyId, article: row.article }, session);
    if (!item) throw err(`Article ${row.article} disappeared since preview — refresh required`, 409, "STALE_PREVIEW");
    const applyIdentity = classifyPriceListItemMaster(item, row.article);
    if (applyIdentity) throwPriceListArticleIssues([{ article: row.article, rowNumber: row.rowNumber, ...applyIdentity }]);
    if (!isManEligibleItem(item)) throw err(`Article ${row.article} is not MAN-eligible`, 400, "NOT_MAN");
    const technical = await findOneS(ItemTechnical, { companyId: req.companyId, article: row.article }, session);
    const price = await findOneS(ManPriceList, { companyId: req.companyId, article: row.article }, session);
    const supplier1 = await loadSupplier1(req.companyId, row.article, session);
    const fp = preview.itemFingerprints?.[row.article] || {};
    const itemChanged =
      isoTimestamp(item.updatedAt) !== String(fp.itemUpdatedAt || "") ||
      isoTimestamp(technical?.updatedAt) !== String(fp.technicalUpdatedAt || "") ||
      isoTimestamp(supplier1?.updatedAt) !== String(fp.supplier1UpdatedAt || "") ||
      itemFingerprint(item, technical, supplier1) !== fp.itemHash;
    const priceChanged =
      isoTimestamp(price?.updatedAt) !== String(fp.priceUpdatedAt || "") ||
      Number(price?.revision || 0) !== Number(fp.priceRevision || 0);
    if (itemChanged || priceChanged) {
      throw err(`Article ${row.article} changed since preview. Upload and preview again.`, 409, "STALE_PREVIEW");
    }

    const proposed = row.proposedItem || {};
    const hasItemChanges = Object.keys(row.itemChanges || {}).length > 0;
    const creating = !price;
    const priceProbe = price
      ? price.toObject()
      : {
          currency: "USD",
          sellPrice: null,
          sellIi: null,
          minm: null,
          rock: null,
          buy: null,
          nextBuy: null,
          leadTime: "",
          isActive: true,
        };
    const nextPrice = { ...priceProbe };
    for (const [k, v] of Object.entries(row.proposedPrices || {})) nextPrice[k] = v;
    if (proposed.currency) nextPrice.currency = proposed.currency;
    if (proposed.leadTime != null) nextPrice.leadTime = proposed.leadTime;
    const beforeHash = priceHash(priceProbe);
    const nextHash = priceHash(nextPrice);
    if (shouldSkipUnchangedImport({ creating, hasItemChanges: false, beforeHash, nextHash })) {
      skippedUnchanged.push(row.article);
      continue;
    }

    // Price List import never writes Item Master / technical / supplier master data.

    let savedPrice = price;
    if (creating || beforeHash !== nextHash) {
      if (creating) {
        const created = await ManPriceList.create(
          [
            {
              companyId: req.companyId,
              itemMasterId: item._id,
              article: row.article,
              currency: nextPrice.currency,
              sellPrice: nextPrice.sellPrice,
              sellIi: nextPrice.sellIi,
              minm: nextPrice.minm,
              rock: nextPrice.rock,
              buy: nextPrice.buy,
              nextBuy: nextPrice.nextBuy,
              leadTime: nextPrice.leadTime || "",
              isActive: true,
              revision: 1,
              contentHash: nextHash,
              source: "CSV",
              lastImportId: preview._id,
              createdBy: actor(req).email,
              updatedBy: actor(req).email,
            },
          ],
          { session }
        );
        savedPrice = created[0];
      } else {
        const nextRevision = Number(price.revision || 1) + 1;
        savedPrice = await ManPriceList.findOneAndUpdate(
          {
            _id: price._id,
            companyId: req.companyId,
            article: row.article,
            revision: Number(fp.priceRevision || price.revision || 1),
            updatedAt: price.updatedAt,
          },
          {
            $set: {
              itemMasterId: item._id,
              currency: nextPrice.currency,
              sellPrice: nextPrice.sellPrice,
              sellIi: nextPrice.sellIi,
              minm: nextPrice.minm,
              rock: nextPrice.rock,
              buy: nextPrice.buy,
              nextBuy: nextPrice.nextBuy,
              leadTime: nextPrice.leadTime || "",
              contentHash: nextHash,
              source: "CSV",
              lastImportId: preview._id,
              updatedBy: actor(req).email,
              revision: nextRevision,
            },
          },
          { session, new: true, runValidators: true }
        );
        if (!savedPrice) {
          throw err(`Article ${row.article} changed since preview. Upload and preview again.`, 409, "STALE_PREVIEW");
        }
      }
      await writeRevision(req, savedPrice, {
        source: "CSV",
        importId: preview._id,
        filename: preview.filename,
        session,
      });
    }
    await writeImportAudit(req, { doc: savedPrice || price, preview, row, session });
    applied.push(row.article);
    writes += 1;
    if (injectFailureAfter != null && writes >= Number(injectFailureAfter)) {
      throw err("Injected import failure", 500, "INJECTED_FAILURE");
    }
  }

  const claimed = await ManPriceListImport.findOneAndUpdate(
    { _id: preview._id, companyId: req.companyId, status: "PREVIEW" },
    {
      $set: {
        status: "APPLIED",
        appliedAt: new Date(),
        appliedArticles: applied,
        skippedUnchanged,
      },
    },
    { session, new: true }
  );
  if (!claimed) throw err("This import was already applied", 409, "PREVIEW_APPLIED");
  return { applied, skippedUnchanged, previewId: String(preview._id), alreadyApplied: false };
}

export async function applyImport(req, previewId, options = {}) {
  try {
    return await runMongoTransaction((session) => applyImportWithSession(req, previewId, session, options));
  } catch (e) {
    const duplicate = Number(e?.code) === 11000;
    const raced = e?.code === "PREVIEW_APPLIED" || e?.code === "STALE_PREVIEW";
    if (duplicate || raced) {
      const preview = await ManPriceListImport.findOne({ _id: previewId, companyId: req.companyId }).lean();
      if (preview?.status === "APPLIED") {
        return {
          applied: preview.appliedArticles || [],
          skippedUnchanged: preview.skippedUnchanged || [],
          previewId: String(preview._id),
          alreadyApplied: true,
        };
      }
    }
    throw e;
  }
}

export async function exportPriceListCsv(req) {
  const rows = await listPriceList(req, { includeInactive: false });
  const out = [];
  for (const row of rows) {
    const item = await ItemMaster.findOne({ companyId: req.companyId, article: row.article }).lean();
    const technical = await ItemTechnical.findOne({ companyId: req.companyId, article: row.article }).lean();
    const supplier1 = await loadSupplier1(req.companyId, row.article);
    const displaySpn = displayedItemMasterSpn(item, technical);
    const displaySup = displayedSupplier1(supplier1, item);
    const specs =
      (technical?.technicalSpecifications || []).find((s) => String(s.specName).toUpperCase() === "SPECS")
        ?.specValue || "";
    out.push({
      Article: row.article,
      Description: item?.description || "",
      "Part no": displaySpn,
      "Sell price": row.sellPrice ?? "",
      "UWT (kg)": technical?.specWeight || "",
      "Ext. Remarks": technical?.extRemarks || item?.remarks || "",
      Availability: formatExportAvailability({
        availableQty: row.availableQty,
        leadTime: row.leadTime,
      }),
      Specs: specs,
      "Sell II": row.sellIi ?? "",
      Minm: row.minm ?? "",
      Rock: row.rock ?? "",
      Buy: row.buy ?? "",
      Cur: row.currency || "",
      "Supplier part No.": displaySup.partNumber,
      Supplier: displaySup.name,
      "Lead time": row.leadTime || "",
      "Next Buy": row.nextBuy ?? "",
    });
  }
  return buildCsv(MAN_PRICE_LIST_HEADERS, out);
}

export { UOM_VALUES };
