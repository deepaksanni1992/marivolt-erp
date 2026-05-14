import ItemMaster, { UOM_VALUES } from "../models/itemMasterModel.js";

const VALID_ITEM_UOMS = new Set(UOM_VALUES);

function text(value) {
  return String(value ?? "").trim();
}

function upper(value) {
  return text(value).toUpperCase();
}

function isBlank(value) {
  return value == null || (typeof value === "string" && value.trim() === "");
}

function normalizeUom(value) {
  const uom = upper(value || "PCS");
  return VALID_ITEM_UOMS.has(uom) ? uom : "PCS";
}

function exactTextRegex(value) {
  return new RegExp(`^${text(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
}

function firstText(...values) {
  for (const value of values) {
    const out = text(value);
    if (out) return out;
  }
  return "";
}

function firstUpper(...values) {
  for (const value of values) {
    const out = upper(value);
    if (out) return out;
  }
  return "";
}

export function normalizePoItemIdentity(line = {}) {
  const article = firstUpper(line.article, line.articleNo, line.itemCode, line.materialCode, line.partNumber, line.partNo);
  const partNumber = firstUpper(line.partNumber, line.partNo, line.supplierPartNumber);
  const materialCode = firstUpper(line.materialCode, line.itemCode);
  return { article, partNumber, materialCode };
}

function buildSyncPayload({ line = {}, header = {}, supplierName = "" }) {
  const identity = normalizePoItemIdentity(line);
  const brand = firstText(line.brand, line.engine, header.brand, header.engine);
  const description = firstText(line.description, line.itemName);
  return {
    ...identity,
    itemName: description || identity.partNumber || identity.article,
    description,
    vertical: firstText(line.vertical, header.vertical),
    brand,
    engine: brand,
    model: firstText(line.model, header.model),
    config: firstText(line.config, header.config),
    esn: firstText(line.esn, header.esn),
    spn: firstUpper(line.spn, line.SPN, line.partNo),
    uom: normalizeUom(line.uom),
    drawingNo: firstText(line.drawingNo, line.drawingNumber),
    supplier: firstText(line.supplier, supplierName),
    remarks: firstText(line.remarks, header.remarks),
  };
}

async function findExistingItem({ companyId, identity, session = null }) {
  const clauses = [];
  if (identity.article) clauses.push({ article: identity.article });
  if (identity.partNumber) clauses.push({ partNumber: exactTextRegex(identity.partNumber) });
  if (identity.materialCode) clauses.push({ materialCode: exactTextRegex(identity.materialCode) });
  if (!clauses.length) return null;

  const query = ItemMaster.findOne({ companyId, $or: clauses });
  if (session) query.session(session);
  return query;
}

function fillMissingFields(item, payload) {
  let changed = false;
  const fillFields = [
    "vertical",
    "brand",
    "engine",
    "model",
    "config",
    "esn",
    "article",
    "partNumber",
    "description",
    "materialCode",
    "spn",
    "uom",
    "drawingNo",
    "supplier",
    "remarks",
  ];

  for (const field of fillFields) {
    const value = payload[field];
    if (!isBlank(item[field]) || isBlank(value)) continue;
    item[field] = value;
    changed = true;
  }

  if (isBlank(item.itemName) && !isBlank(payload.itemName)) {
    item.itemName = payload.itemName;
    changed = true;
  }

  return changed;
}

export async function syncPoLinesToItemMaster({
  companyId,
  companyCode = "",
  poNo = "",
  supplierName = "",
  header = {},
  lines = [],
  session = null,
} = {}) {
  if (!companyId) throw new Error("companyId is required for PO Item Master sync");
  const now = new Date();
  const summary = { scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 };

  for (const line of lines || []) {
    summary.scanned += 1;
    const payload = buildSyncPayload({ line, header, supplierName });
    if (!payload.article && !payload.partNumber && !payload.materialCode) {
      summary.skipped += 1;
      continue;
    }
    const article = payload.article || payload.partNumber || payload.materialCode;
    const identity = { ...payload, article };
    let existing = await findExistingItem({ companyId, identity, session });

    if (!existing) {
      try {
        const created = await ItemMaster.create(
          [
            {
              companyId,
              companyCode: upper(companyCode),
              article,
              partNumber: payload.partNumber,
              itemName: payload.itemName || article,
              description: payload.description,
              materialCode: payload.materialCode,
              spn: payload.spn,
              vertical: payload.vertical,
              brand: payload.brand,
              engine: payload.engine,
              model: payload.model,
              config: payload.config,
              esn: payload.esn,
              drawingNo: payload.drawingNo,
              supplier: payload.supplier,
              remarks: payload.remarks,
              uom: payload.uom,
              status: "Active",
              source: "PO_AUTO_SYNC",
              sourcePoNo: text(poNo),
              lastSyncedFromPO: text(poNo),
              lastSyncedAt: now,
            },
          ],
          session ? { session } : {}
        );
        existing = Array.isArray(created) ? created[0] : created;
        summary.created += 1;
        continue;
      } catch (err) {
        if (err?.code !== 11000) throw err;
        existing = await findExistingItem({ companyId, identity, session });
        if (!existing) {
          throw new Error(`Item ${article} could not be auto-created for this company.`);
        }
      }
    }

    const businessChanged = fillMissingFields(existing, { ...payload, article });
    if (isBlank(existing.source)) existing.source = "PO_AUTO_SYNC";
    if (isBlank(existing.sourcePoNo)) existing.sourcePoNo = text(poNo);
    existing.lastSyncedFromPO = text(poNo);
    existing.lastSyncedAt = now;
    await existing.save(session ? { session } : {});
    if (businessChanged) summary.updated += 1;
    else summary.unchanged += 1;
  }

  return summary;
}
