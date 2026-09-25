/**
 * Atomic add / remove / promote / deactivate of manufacturer Part Number aliases.
 * Aliases are keyed by normalized display value, never by array index or client _id.
 */
import ItemMaster from "../models/itemMasterModel.js";
import ItemTechnical from "../models/itemTechnicalModel.js";
import { runMongoTransaction } from "../utils/mongoTransaction.js";
import {
  ALIAS_EQUALS_PRIMARY,
  ALIAS_NOT_FOUND,
  ALIAS_STATUS_ACTIVE,
  ALIAS_STATUS_INACTIVE,
  DUPLICATE_ALIAS,
  PART_NUMBER_NOT_LINKED_TO_ARTICLE,
  STALE_ITEM_TECHNICAL,
  articleOwnsManufacturerPartNumber,
  canonicalItemMasterPartNumber,
  normalizePartNumberValue,
  partNumberNotLinkedMessage,
  sanitizeAlternatePartNumberList,
} from "../utils/partNumberTerminology.js";

function trim(value) {
  return String(value ?? "").trim();
}

function aliasError(message, statusCode, code, extra = {}) {
  const e = new Error(message);
  e.statusCode = statusCode;
  e.code = code;
  Object.assign(e, extra);
  return e;
}

async function loadArticle({ companyId, article }) {
  if (companyId == null || companyId === "") {
    throw aliasError("Authenticated company context is required", 403, "ARTICLE_COMPANY_REQUIRED");
  }
  const code = String(article || "").trim().toUpperCase();
  if (!code) throw aliasError("Article is required", 400, "ARTICLE_REQUIRED");
  const item = await ItemMaster.findOne({ companyId, article: code }).lean();
  if (!item) throw aliasError(`Article ${code} is not available in Item Master`, 404, "NOT_FOUND");
  return { item, article: code };
}

function assertFresh(row, expectedUpdatedAt) {
  if (!expectedUpdatedAt) return;
  const current = row?.updatedAt ? new Date(row.updatedAt).getTime() : 0;
  const expected = new Date(expectedUpdatedAt).getTime();
  if (!Number.isFinite(expected) || current !== expected) {
    throw aliasError(
      "Item Technical was changed by another user. Reload and retry.",
      409,
      STALE_ITEM_TECHNICAL
    );
  }
}

export async function addAlternatePartNumber({
  companyId,
  article,
  partNumber,
  userEmail = "",
  expectedUpdatedAt = null,
} = {}) {
  const { item, article: code } = await loadArticle({ companyId, article });
  const display = trim(partNumber);
  const normalized = normalizePartNumberValue(display);
  if (!normalized) throw aliasError("Part Number is required", 400, "PART_NUMBER_REQUIRED");

  const existing = await ItemTechnical.findOne({ companyId, article: code }).lean();
  if (existing) assertFresh(existing, expectedUpdatedAt);
  const owned = articleOwnsManufacturerPartNumber(item, existing || {}, display);
  if (owned.role === "PRIMARY") {
    throw aliasError(
      `Part Number "${display}" is already the Primary Part Number for Article ${code}.`,
      409,
      ALIAS_EQUALS_PRIMARY
    );
  }
  if (owned.owned) {
    throw aliasError(
      `Part Number "${display}" is already linked to Article ${code}.`,
      409,
      DUPLICATE_ALIAS
    );
  }

  const entry = {
    partNumber: display,
    normalized,
    status: ALIAS_STATUS_ACTIVE,
    createdBy: trim(userEmail),
    updatedBy: trim(userEmail),
  };

  if (!existing) {
    await ItemTechnical.create({
      companyId,
      article: code,
      spn: canonicalItemMasterPartNumber(item),
      alternatePartNumbers: [entry],
    });
    return ItemTechnical.findOne({ companyId, article: code }).lean();
  }

  const result = await ItemTechnical.updateOne(
    {
      companyId,
      article: code,
      $and: [
        {
          $or: [{ spn: { $exists: false } }, { spn: "" }, { spn: { $not: new RegExp(`^${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } }],
        },
        { "alternatePartNumbers.normalized": { $ne: normalized } },
      ],
    },
    { $push: { alternatePartNumbers: entry } }
  );
  if (!result.matchedCount) {
    const latest = await ItemTechnical.findOne({ companyId, article: code }).lean();
    const again = articleOwnsManufacturerPartNumber(item, latest || {}, display);
    if (again.role === "PRIMARY") {
      throw aliasError(
        `Part Number "${display}" is already the Primary Part Number for Article ${code}.`,
        409,
        ALIAS_EQUALS_PRIMARY
      );
    }
    throw aliasError(`Part Number "${display}" is already linked to Article ${code}.`, 409, DUPLICATE_ALIAS);
  }
  return ItemTechnical.findOne({ companyId, article: code }).lean();
}

export async function removeAlternatePartNumber({
  companyId,
  article,
  partNumber,
  expectedUpdatedAt = null,
} = {}) {
  const { item, article: code } = await loadArticle({ companyId, article });
  const normalized = normalizePartNumberValue(partNumber);
  if (!normalized) throw aliasError("Part Number is required", 400, "PART_NUMBER_REQUIRED");
  const existing = await ItemTechnical.findOne({ companyId, article: code }).lean();
  if (!existing) throw aliasError(`Part Number "${partNumber}" is not linked to Article ${code}.`, 409, ALIAS_NOT_FOUND);
  assertFresh(existing, expectedUpdatedAt);
  const owned = articleOwnsManufacturerPartNumber(item, existing, partNumber);
  if (owned.role === "PRIMARY") {
    throw aliasError("Cannot remove the Primary Part Number. Promote another number or clear it explicitly.", 409, ALIAS_EQUALS_PRIMARY);
  }
  const result = await ItemTechnical.updateOne(
    { companyId, article: code, "alternatePartNumbers.normalized": normalized },
    { $pull: { alternatePartNumbers: { normalized } } }
  );
  if (!result.matchedCount) {
    throw aliasError(`Part Number "${partNumber}" is not linked to Article ${code}.`, 409, ALIAS_NOT_FOUND);
  }
  return ItemTechnical.findOne({ companyId, article: code }).lean();
}

export async function setAlternatePartNumberStatus({
  companyId,
  article,
  partNumber,
  status,
  userEmail = "",
  expectedUpdatedAt = null,
} = {}) {
  const { item, article: code } = await loadArticle({ companyId, article });
  const normalized = normalizePartNumberValue(partNumber);
  const next = String(status || "").trim().toUpperCase();
  if (next !== ALIAS_STATUS_ACTIVE && next !== ALIAS_STATUS_INACTIVE) {
    throw aliasError("Status must be ACTIVE or INACTIVE", 400, "INVALID_ALIAS_STATUS");
  }
  const existing = await ItemTechnical.findOne({ companyId, article: code }).lean();
  if (!existing) throw aliasError(`Part Number "${partNumber}" is not linked to Article ${code}.`, 409, ALIAS_NOT_FOUND);
  assertFresh(existing, expectedUpdatedAt);
  const owned = articleOwnsManufacturerPartNumber(item, existing, partNumber);
  if (!owned.owned || owned.role !== "ALTERNATE") {
    throw aliasError(partNumberNotLinkedMessage(code, partNumber), 409, PART_NUMBER_NOT_LINKED_TO_ARTICLE);
  }
  const result = await ItemTechnical.updateOne(
    { companyId, article: code, "alternatePartNumbers.normalized": normalized },
    {
      $set: {
        "alternatePartNumbers.$.status": next,
        "alternatePartNumbers.$.updatedBy": trim(userEmail),
      },
    }
  );
  if (!result.matchedCount) {
    throw aliasError(`Part Number "${partNumber}" is not linked to Article ${code}.`, 409, ALIAS_NOT_FOUND);
  }
  return ItemTechnical.findOne({ companyId, article: code }).lean();
}

export async function promoteAlternatePartNumber({
  companyId,
  article,
  partNumber,
  userEmail = "",
  expectedUpdatedAt = null,
} = {}) {
  const { item, article: code } = await loadArticle({ companyId, article });
  const display = trim(partNumber);
  const normalized = normalizePartNumberValue(display);
  if (!normalized) throw aliasError("Part Number is required", 400, "PART_NUMBER_REQUIRED");

  return runMongoTransaction(async (session) => {
    const existing = await ItemTechnical.findOne({ companyId, article: code }).session(session);
    if (!existing) {
      throw aliasError(partNumberNotLinkedMessage(code, display), 409, PART_NUMBER_NOT_LINKED_TO_ARTICLE);
    }
    assertFresh(existing, expectedUpdatedAt);
    const owned = articleOwnsManufacturerPartNumber(item, existing, display);
    if (owned.role === "PRIMARY") {
      return existing.toObject();
    }
    if (!owned.owned || owned.inactive) {
      throw aliasError(partNumberNotLinkedMessage(code, display), 409, PART_NUMBER_NOT_LINKED_TO_ARTICLE);
    }
    const oldPrimary = trim(existing.spn || canonicalItemMasterPartNumber(item));
    const nextAlts = [];
    if (oldPrimary && normalizePartNumberValue(oldPrimary) !== normalized) {
      nextAlts.push({
        partNumber: oldPrimary,
        normalized: normalizePartNumberValue(oldPrimary),
        status: ALIAS_STATUS_ACTIVE,
        createdBy: trim(userEmail),
        updatedBy: trim(userEmail),
      });
    }
    for (const row of existing.alternatePartNumbers || []) {
      if (normalizePartNumberValue(row.partNumber) === normalized) continue;
      nextAlts.push(row);
    }
    const sanitized = sanitizeAlternatePartNumberList(nextAlts, display, {
      createdBy: userEmail,
      updatedBy: userEmail,
    });
    const result = await ItemTechnical.updateOne(
      { _id: existing._id, companyId, updatedAt: existing.updatedAt },
      { $set: { spn: owned.matchedPartNumber || display, alternatePartNumbers: sanitized } },
      { session }
    );
    if (!result.matchedCount) {
      throw aliasError(
        "Item Technical was changed by another user. Reload and retry.",
        409,
        STALE_ITEM_TECHNICAL
      );
    }
    return ItemTechnical.findOne({ companyId, article: code }).session(session).lean();
  });
}
