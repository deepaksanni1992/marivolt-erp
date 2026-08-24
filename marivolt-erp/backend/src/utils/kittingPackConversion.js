/**
 * PACK_CONVERSION BOM validation, snapshots, previews, and workflow rules.
 * UOM values always come from Item Master — never hard-coded SET/PCS in execution.
 */
import ItemMaster from "../models/itemMasterModel.js";
import { deriveStockBuckets } from "../services/stockExpectedBuckets.js";
import {
  BOM_ITEM_INACTIVE,
  BOM_ITEM_NOT_FOUND,
  BOM_PACK_CONVERSION_INVALID,
  BOM_RATIO_MUST_BE_INTEGER,
  KIT_FRACTIONAL_SET_NOT_ALLOWED,
  DEKIT_FRACTIONAL_SET_NOT_ALLOWED,
  DEKIT_WORKFLOW_BLOCKED,
  KIT_WORKFLOW_BLOCKED,
} from "./kittingIdempotency.js";

export const BOM_KIND = Object.freeze({
  PACK_CONVERSION: "PACK_CONVERSION",
  GENERIC: "GENERIC",
});

export function resolveBomKind(kitType) {
  return String(kitType || "").trim().toUpperCase() === "PACK_CONVERSION"
    ? BOM_KIND.PACK_CONVERSION
    : BOM_KIND.GENERIC;
}

export function isPositiveInteger(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 && Number.isInteger(v);
}

export function isPositiveWholeQuantity(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 && Math.abs(v - Math.round(v)) < 1e-9;
}

/**
 * Phase-1 extensible UOM-pair rules for PACK_CONVERSION BOM save.
 * Requires parent and component UOM to differ (pack contains another unit).
 */
export function validatePackConversionUomPair(parentUom, componentUom) {
  const p = String(parentUom || "").trim().toUpperCase();
  const c = String(componentUom || "").trim().toUpperCase();
  if (!p || !c) return { ok: false, message: "Parent and component UOM required from Item Master" };
  if (p === c) {
    return {
      ok: false,
      message: "PACK_CONVERSION requires parent and component to use different Item Master UOM values",
    };
  }
  return { ok: true };
}

export async function resolveItemMasterArticles(companyId, articles) {
  const codes = [...new Set(articles.map((a) => String(a || "").trim().toUpperCase()).filter(Boolean))];
  const rows = await ItemMaster.find({ companyId, article: { $in: codes } }).lean();
  const map = new Map(rows.map((r) => [String(r.article).toUpperCase(), r]));
  return map;
}

export function assertItemOperational(item, articleCode) {
  if (!item) {
    const err = new Error(`Item Master article not found: ${articleCode}`);
    err.code = BOM_ITEM_NOT_FOUND;
    err.article = articleCode;
    throw err;
  }
  if (String(item.status || "Active") !== "Active") {
    const err = new Error(`Item Master article is not active: ${articleCode}`);
    err.code = BOM_ITEM_INACTIVE;
    err.article = articleCode;
    throw err;
  }
  return item;
}

export function validatePackConversionLineRules(line = {}) {
  if (Boolean(line.optionalFlag)) {
    return { ok: false, message: "PACK_CONVERSION cannot use optional components" };
  }
  const alts = Array.isArray(line.alternativeArticles) ? line.alternativeArticles : [];
  if (alts.length > 0) {
    return { ok: false, message: "PACK_CONVERSION cannot use alternative articles" };
  }
  if (String(line.interchangeableGroup || "").trim()) {
    return { ok: false, message: "PACK_CONVERSION cannot use interchange groups" };
  }
  const qty = Number(line.qty);
  if (!isPositiveInteger(qty)) {
    return { ok: false, code: BOM_RATIO_MUST_BE_INTEGER, message: "Conversion ratio must be a positive integer" };
  }
  return { ok: true };
}

/**
 * Validate PACK_CONVERSION BOM payload. Mutates/enriches lines with Item Master cache fields.
 */
export async function validateAndEnrichPackConversionBom({ companyId, parentItemCode, lines, workflowMode }) {
  const parentCode = String(parentItemCode || "").trim().toUpperCase();
  if (!parentCode) {
    const err = new Error("parentItemCode required");
    err.code = BOM_PACK_CONVERSION_INVALID;
    throw err;
  }
  const normalizedLines = (lines || []).filter((l) => String(l.article || l.componentItemCode || "").trim());
  if (normalizedLines.length !== 1) {
    const err = new Error("PACK_CONVERSION requires exactly one component line");
    err.code = BOM_PACK_CONVERSION_INVALID;
    throw err;
  }
  const line = normalizedLines[0];
  const lineRules = validatePackConversionLineRules(line);
  if (!lineRules.ok) {
    const err = new Error(lineRules.message);
    err.code = lineRules.code || BOM_PACK_CONVERSION_INVALID;
    throw err;
  }
  const componentCode = String(line.article || line.componentItemCode || "").trim().toUpperCase();
  if (componentCode === parentCode) {
    const err = new Error("Parent and component article must differ");
    err.code = BOM_PACK_CONVERSION_INVALID;
    throw err;
  }

  const itemMap = await resolveItemMasterArticles(companyId, [parentCode, componentCode]);
  const parentItem = assertItemOperational(itemMap.get(parentCode), parentCode);
  const componentItem = assertItemOperational(itemMap.get(componentCode), componentCode);

  const uomCheck = validatePackConversionUomPair(parentItem.uom, componentItem.uom);
  if (!uomCheck.ok) {
    const err = new Error(uomCheck.message);
    err.code = BOM_PACK_CONVERSION_INVALID;
    throw err;
  }

  const wf = String(workflowMode || "BOTH").trim().toUpperCase();
  if (!["ASSEMBLY", "DISASSEMBLY", "BOTH"].includes(wf)) {
    const err = new Error("Invalid workflowMode");
    err.code = BOM_PACK_CONVERSION_INVALID;
    throw err;
  }

  return {
    parentItem,
    componentItem,
    enrichedLine: {
      ...line,
      article: componentCode,
      componentItemCode: componentCode,
      qty: Number(line.qty),
      componentUom: String(componentItem.uom || "PCS").toUpperCase(),
      componentItemName: componentItem.itemName || "",
      description: line.description || componentItem.description || componentItem.itemName || "",
      optionalFlag: false,
      alternativeArticles: [],
      interchangeableGroup: "",
    },
    parentUom: String(parentItem.uom || "PCS").toUpperCase(),
    parentItemName: parentItem.itemName || "",
    workflowMode: wf,
  };
}

export function bomConversionDefChanged(existing, payload) {
  if (!existing) return false;
  const oldRev = String(existing.revisionNo || "").trim();
  const newRev = String(payload.revisionNo ?? existing.revisionNo ?? "").trim();
  if (oldRev !== newRev) return true;
  const oldLines = (existing.lines || []).map((l) => ({
    a: String(l.article || l.componentItemCode || "").toUpperCase(),
    q: Number(l.qty) || 0,
  }));
  const newLines = (payload.lines || existing.lines || []).map((l) => ({
    a: String(l.article || l.componentItemCode || "").toUpperCase(),
    q: Number(l.qty) || 0,
  }));
  if (oldLines.length !== newLines.length) return true;
  for (let i = 0; i < oldLines.length; i += 1) {
    if (oldLines[i].a !== newLines[i].a || oldLines[i].q !== newLines[i].q) return true;
  }
  return false;
}

export function appendBomRevisionHistory(existing, createdBy = "") {
  if (!existing?.lines?.length) return [];
  const history = Array.isArray(existing.revisions) ? [...existing.revisions] : [];
  history.push({
    revisionNo: String(existing.revisionNo || "R1").trim(),
    lines: JSON.parse(JSON.stringify(existing.lines || [])),
    parentUom: existing.parentUom || "",
    parentItemName: existing.parentItemName || "",
    effectiveFrom: existing.updatedAt || existing.createdAt || new Date(),
    createdAt: new Date(),
    createdBy: String(createdBy || existing.createdBy || ""),
    changeReason: "Conversion definition superseded",
  });
  return history;
}

export function buildLinesSnapshotFromBom(bom, itemMap = new Map()) {
  return (bom.lines || []).map((l) => {
    const code = String(l.componentItemCode || l.article || "").trim().toUpperCase();
    const item = itemMap.get(code);
    return {
      lineId: String(l._id || code),
      componentItemCode: code,
      componentUom: String(l.componentUom || item?.uom || "PCS").toUpperCase(),
      componentItemName: String(l.componentItemName || item?.itemName || ""),
      qtyPerKit: Number(l.qty) || 0,
      description: String(l.description || item?.description || item?.itemName || ""),
      optionalFlag: Boolean(l.optionalFlag),
      alternativeArticles: Array.isArray(l.alternativeArticles) ? l.alternativeArticles : [],
    };
  });
}

export function childQtyForParent(parentQty, snapshotLines) {
  let total = 0;
  for (const ln of snapshotLines || []) {
    total += (Number(parentQty) || 0) * (Number(ln.qtyPerKit) || 0);
  }
  return total;
}

export function buildConversionPreview({
  direction,
  parentItemCode,
  parentUom,
  parentQty,
  linesSnapshot,
}) {
  const parentCode = String(parentItemCode || "").trim().toUpperCase();
  const qty = Number(parentQty) || 0;
  const consume = [];
  const produce = [];
  if (direction === "KIT") {
    for (const ln of linesSnapshot || []) {
      consume.push({
        article: ln.componentItemCode,
        qty: qty * (Number(ln.qtyPerKit) || 0),
        uom: ln.componentUom || "PCS",
        description: ln.description || ln.componentItemName || "",
      });
    }
    produce.push({
      article: parentCode,
      qty,
      uom: parentUom || "SET",
      description: "",
    });
  } else {
    consume.push({
      article: parentCode,
      qty,
      uom: parentUom || "SET",
      description: "",
    });
    for (const ln of linesSnapshot || []) {
      produce.push({
        article: ln.componentItemCode,
        qty: qty * (Number(ln.qtyPerKit) || 0),
        uom: ln.componentUom || "PCS",
        description: ln.description || ln.componentItemName || "",
      });
    }
  }
  return { consume, produce };
}

export function maxKittableSets(availableChildQty, qtyPerParent) {
  const avail = Number(availableChildQty) || 0;
  const ratio = Number(qtyPerParent) || 0;
  if (!(ratio > 0)) return 0;
  return Math.floor(avail / ratio);
}

export function assertWorkflowAllowsKitting(workflowMode) {
  const wf = String(workflowMode || "BOTH").trim().toUpperCase();
  if (wf === "DISASSEMBLY") {
    const err = new Error("BOM workflowMode DISASSEMBLY does not allow kitting");
    err.code = KIT_WORKFLOW_BLOCKED;
    throw err;
  }
}

export function assertWorkflowAllowsDeKitting(workflowMode) {
  const wf = String(workflowMode || "BOTH").trim().toUpperCase();
  if (wf === "ASSEMBLY") {
    const err = new Error("BOM workflowMode ASSEMBLY does not allow de-kitting");
    err.code = DEKIT_WORKFLOW_BLOCKED;
    throw err;
  }
}

export function assertPackConversionParentQtyInteger(parentQty, parentUom) {
  if (!isPositiveWholeQuantity(parentQty)) {
    const err = new Error(`Parent quantity must be a positive whole number (${parentUom || "units"})`);
    err.code = KIT_FRACTIONAL_SET_NOT_ALLOWED;
    throw err;
  }
}

export function assertDeKitParentQtyInteger(parentQty, parentUom) {
  if (!isPositiveWholeQuantity(parentQty)) {
    const err = new Error(`De-kit parent quantity must be a positive whole number (${parentUom || "units"})`);
    err.code = DEKIT_FRACTIONAL_SET_NOT_ALLOWED;
    throw err;
  }
}

export function deriveAvailabilityFromBalance(bal) {
  return deriveStockBuckets(bal || {}).availableQty;
}
