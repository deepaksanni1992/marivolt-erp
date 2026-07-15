import ItemMaster, { UOM_VALUES } from "../models/itemMasterModel.js";

const VALID_ITEM_UOMS = new Set(UOM_VALUES);

function text(value) {
  return String(value ?? "").trim();
}

function upper(value) {
  return text(value).toUpperCase();
}

/** Collapse internal whitespace so "433598  AA" matches "433598 AA". */
function normalizeIdentityKey(value) {
  return upper(value).replace(/\s+/g, " ");
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

function whitespaceInsensitiveRegex(value) {
  const escaped = text(value)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`^${escaped}$`, "i");
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
    const out = normalizeIdentityKey(value);
    if (out) return out;
  }
  return "";
}

export function normalizePoItemIdentity(line = {}) {
  const article = firstUpper(line.article, line.articleNo, line.itemCode, line.materialCode, line.partNumber, line.partNo);
  const partNumber = firstUpper(line.partNumber, line.partNo, line.spn, line.SPN);
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
    supplierPartNumber: firstText(line.supplierPartNumber),
    uom: normalizeUom(line.uom),
    drawingNo: firstText(line.drawingNo, line.drawingNumber),
    supplier: firstText(line.supplier, supplierName),
    remarks: firstText(line.remarks, header.remarks),
  };
}

function withSession(query, session) {
  if (session) query.session(session);
  return query;
}

/**
 * Prefer unique keys: partNumber → article → materialCode.
 * Avoid $or so we never attach a part number onto the wrong article row.
 */
async function findExistingItem({ companyId, identity, session = null }) {
  const article = normalizeIdentityKey(identity.article);
  const partNumber = normalizeIdentityKey(identity.partNumber);
  const materialCode = normalizeIdentityKey(identity.materialCode);

  if (partNumber) {
    let hit = await withSession(
      ItemMaster.findOne({ companyId, partNumber }),
      session
    );
    if (hit) return hit;
    hit = await withSession(
      ItemMaster.findOne({ companyId, partNumber: whitespaceInsensitiveRegex(partNumber) }),
      session
    );
    if (hit) return hit;
  }

  if (article) {
    const hit = await withSession(ItemMaster.findOne({ companyId, article }), session);
    if (hit) return hit;
  }

  if (materialCode) {
    const hit = await withSession(
      ItemMaster.findOne({ companyId, materialCode: exactTextRegex(materialCode) }),
      session
    );
    if (hit) return hit;
  }

  return null;
}

async function findByDuplicateKey(companyId, err, session = null) {
  const key = err?.keyValue || {};
  if (key.partNumber != null && String(key.partNumber).trim()) {
    const pn = normalizeIdentityKey(key.partNumber);
    let hit = await withSession(ItemMaster.findOne({ companyId, partNumber: pn }), session);
    if (hit) return hit;
    hit = await withSession(
      ItemMaster.findOne({ companyId, partNumber: whitespaceInsensitiveRegex(pn) }),
      session
    );
    if (hit) return hit;
  }
  if (key.article != null && String(key.article).trim()) {
    const art = normalizeIdentityKey(key.article);
    return withSession(ItemMaster.findOne({ companyId, article: art }), session);
  }
  return null;
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
    "supplierPartNumber",
    "uom",
    "drawingNo",
    "supplier",
    "remarks",
  ];

  for (const field of fillFields) {
    const value = payload[field];
    if (!isBlank(item[field]) || isBlank(value)) continue;
    // Never overwrite identity fields when blank on the target — handled with uniqueness checks below.
    if (field === "partNumber" || field === "article") continue;
    item[field] = value;
    changed = true;
  }

  if (isBlank(item.itemName) && !isBlank(payload.itemName)) {
    item.itemName = payload.itemName;
    changed = true;
  }

  return changed;
}

/**
 * Apply partNumber/article only when safe for unique indexes.
 * Returns true if either field was changed on `item`.
 */
async function applySafeIdentityFields(item, payload, { companyId, session = null } = {}) {
  let changed = false;
  const nextPart = normalizeIdentityKey(payload.partNumber);
  const nextArticle = normalizeIdentityKey(payload.article);

  if (nextPart && isBlank(item.partNumber)) {
    const owner = await withSession(
      ItemMaster.findOne({
        companyId,
        partNumber: nextPart,
        _id: { $ne: item._id },
      }),
      session
    );
    if (!owner) {
      item.partNumber = nextPart;
      changed = true;
    }
  }

  if (nextArticle && isBlank(item.article)) {
    const owner = await withSession(
      ItemMaster.findOne({
        companyId,
        article: nextArticle,
        _id: { $ne: item._id },
      }),
      session
    );
    if (!owner) {
      item.article = nextArticle;
      changed = true;
    }
  }

  return changed;
}

async function persistSyncedItem(existing, { payload, article, poNo, now, session }) {
  let businessChanged = fillMissingFields(existing, { ...payload, article });
  const identityChanged = await applySafeIdentityFields(existing, { ...payload, article }, {
    companyId: existing.companyId,
    session,
  });
  if (identityChanged) businessChanged = true;
  if (isBlank(existing.source)) existing.source = "PO_AUTO_SYNC";
  if (isBlank(existing.sourcePoNo)) existing.sourcePoNo = text(poNo);
  existing.lastSyncedFromPO = text(poNo);
  existing.lastSyncedAt = now;
  try {
    await existing.save(session ? { session } : {});
  } catch (err) {
    if (err?.code !== 11000) throw err;
    // Another unique collision while filling gaps — keep prior row as-is for sync metadata only.
    existing.lastSyncedFromPO = text(poNo);
    existing.lastSyncedAt = now;
    try {
      await existing.save(session ? { session } : {});
    } catch {
      /* best-effort metadata */
    }
  }
  return businessChanged;
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
              partNumber: payload.partNumber || "",
              itemName: payload.itemName || article,
              description: payload.description,
              materialCode: payload.materialCode,
              spn: payload.spn,
              supplierPartNumber: payload.supplierPartNumber,
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
        existing =
          (await findByDuplicateKey(companyId, err, session)) ||
          (await findExistingItem({ companyId, identity, session }));
        if (!existing) {
          throw new Error(
            `Item Master already has part/article for this company (${article || payload.partNumber}). Re-link the PO line to the existing item.`
          );
        }
      }
    }

    const businessChanged = await persistSyncedItem(existing, {
      payload,
      article,
      poNo,
      now,
      session,
    });
    if (businessChanged) summary.updated += 1;
    else summary.unchanged += 1;
  }

  return summary;
}
