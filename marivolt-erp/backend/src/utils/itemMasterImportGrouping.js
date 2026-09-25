/**
 * Group Item Master import rows by Article so one Article can carry many
 * manufacturer Part Numbers. Does not unique-collapse Part Numbers across Articles.
 */
import {
  ITEM_MASTER_CLEAR_MARKER,
  PART_NUMBER_ROLE_ALTERNATE,
  PART_NUMBER_ROLE_PRIMARY,
  canonicalItemMasterPartNumber,
  normalizePartNumberValue,
  sanitizeAlternatePartNumberList,
} from "./partNumberTerminology.js";

const SHARED_FIELDS = [
  ["uom", "UOM"],
  ["vertical", "Vertical"],
  ["brand", "Brand"],
  ["model", "Model"],
  ["config", "Configuration"],
  ["description", "Description"],
  ["itemName", "Item Name"],
  ["status", "Status"],
  ["specifications", "Specifications"],
  ["dimension", "Dimensions"],
  ["materialCode", "Material Code"],
  ["drawingNumber", "Drawing Number"],
  ["oeMarkings", "OEM Reference/Markings"],
];

function trim(value) {
  return String(value ?? "").trim();
}

function isClear(value) {
  return trim(value).toUpperCase() === ITEM_MASTER_CLEAR_MARKER;
}

function comparable(key, value) {
  const t = trim(value);
  if (!t) return "";
  if (isClear(t)) return ITEM_MASTER_CLEAR_MARKER;
  if (["uom", "vertical", "brand", "model", "config", "status"].includes(key)) return t.toUpperCase();
  return t;
}

export function formatSourceRowList(rows = []) {
  const unique = [...new Set((rows || []).map((n) => Number(n)).filter((n) => Number.isFinite(n)))];
  if (!unique.length) return "";
  if (unique.length === 1) return String(unique[0]);
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

export function parsePartNumberRole(raw) {
  const role = trim(raw).toUpperCase();
  if (!role) return "";
  if (role === PART_NUMBER_ROLE_PRIMARY || role === "PRIMARY PART NUMBER") return PART_NUMBER_ROLE_PRIMARY;
  if (role === PART_NUMBER_ROLE_ALTERNATE || role === "ALTERNATE PART NUMBER") return PART_NUMBER_ROLE_ALTERNATE;
  return "__INVALID_ROLE__";
}

export function splitAlternatePartNumberCell(raw) {
  return String(raw ?? "")
    .split(/[,;]+/)
    .map((part) => trim(part))
    .filter(Boolean);
}

function collectRowPartNumbers(incoming, excelRow) {
  const out = [];
  const role = incoming.partNumberRole || "";
  const push = (display, declaredRole = "") => {
    if (!display) return;
    if (isClear(display)) {
      out.push({ display, normalized: ITEM_MASTER_CLEAR_MARKER, role: declaredRole || role, excelRow, clear: true });
      return;
    }
    const normalized = normalizePartNumberValue(display);
    if (!normalized) return;
    out.push({
      display,
      normalized,
      role: declaredRole || role,
      excelRow,
      clear: false,
    });
  };
  push(incoming.spn, role);
  for (const extra of incoming.extraAlternatePartNumbers || []) {
    push(extra, PART_NUMBER_ROLE_ALTERNATE);
  }
  return out;
}

function firstNonblank(rows, getter) {
  let clearValue = "";
  for (const row of rows) {
    const value = getter(row);
    if (isClear(value)) {
      clearValue = ITEM_MASTER_CLEAR_MARKER;
      continue;
    }
    if (trim(value)) return value;
  }
  return clearValue;
}

function detectSharedFieldConflicts(parsedRows) {
  const conflicts = [];
  for (const [key, label] of SHARED_FIELDS) {
    const seen = [];
    for (const row of parsedRows) {
      const raw =
        key === "vertical"
          ? row.incoming.taxonomyInput?.vertical
          : key === "brand"
            ? row.incoming.taxonomyInput?.brand || row.incoming.taxonomyInput?.engine
            : key === "model"
              ? row.incoming.taxonomyInput?.model
              : key === "config"
                ? row.incoming.taxonomyInput?.config
                : row.incoming[key];
      const cmp = comparable(key, raw);
      if (!cmp) continue;
      const prev = seen.find((s) => s.cmp === cmp);
      if (prev) {
        prev.rows.push(row.excelRow);
        continue;
      }
      seen.push({ cmp, display: trim(raw), rows: [row.excelRow] });
    }
    if (seen.length > 1) {
      conflicts.push({
        field: label,
        values: seen.map((s) => ({ value: s.display, rows: s.rows })),
      });
    }
  }
  return conflicts;
}

function mergeIncomingMaster(parsedRows) {
  const first = parsedRows[0]?.incoming || {};
  const tax = {
    vertical: firstNonblank(parsedRows, (r) => r.incoming.taxonomyInput?.vertical),
    brand: firstNonblank(parsedRows, (r) => r.incoming.taxonomyInput?.brand || r.incoming.taxonomyInput?.engine),
    engine: firstNonblank(parsedRows, (r) => r.incoming.taxonomyInput?.engine || r.incoming.taxonomyInput?.brand),
    model: firstNonblank(parsedRows, (r) => r.incoming.taxonomyInput?.model),
    config: firstNonblank(parsedRows, (r) => r.incoming.taxonomyInput?.config),
  };
  return {
    article: first.article,
    status: firstNonblank(parsedRows, (r) => (r.incoming.status === "__INVALID_STATUS__" ? "" : r.incoming.status)),
    uom: firstNonblank(parsedRows, (r) => r.incoming.uom),
    uomRaw: firstNonblank(parsedRows, (r) => r.incoming.uomRaw),
    itemName: firstNonblank(parsedRows, (r) => r.incoming.itemName),
    description: firstNonblank(parsedRows, (r) => r.incoming.description),
    taxonomyInput: tax,
    specifications: firstNonblank(parsedRows, (r) => r.incoming.specifications),
    dimension: firstNonblank(parsedRows, (r) => r.incoming.dimension),
    materialCode: firstNonblank(parsedRows, (r) => r.incoming.materialCode),
    drawingNumber: firstNonblank(parsedRows, (r) => r.incoming.drawingNumber),
    oeMarkings: firstNonblank(parsedRows, (r) => r.incoming.oeMarkings),
    extRemarks: firstNonblank(parsedRows, (r) => r.incoming.extRemarks),
    internalRemarks: firstNonblank(parsedRows, (r) => r.incoming.internalRemarks),
    suppliers: parsedRows.flatMap((r) => r.incoming.suppliers || []),
    ignoredStockHeaders: [...new Set(parsedRows.flatMap((r) => r.incoming.ignoredStockHeaders || []))],
    partNumberError: parsedRows.map((r) => r.incoming.partNumberError).find(Boolean) || "",
  };
}

export function analyzeItemMasterArticleGroup(parsedRows = [], existingItem = null, existingTech = null) {
  const article = parsedRows[0]?.incoming?.article || "";
  const sourceRows = parsedRows.map((r) => r.excelRow);
  const errors = [];
  const rowErrors = parsedRows.flatMap((r) => r.errors || []);
  errors.push(...rowErrors);

  const invalidRole = parsedRows.find((r) => r.incoming.partNumberRole === "__INVALID_ROLE__");
  if (invalidRole) {
    errors.push(`Row ${invalidRole.excelRow}: Part Number Role must be Primary or Alternate`);
  }

  const pnEntries = parsedRows.flatMap((r) => collectRowPartNumbers(r.incoming, r.excelRow));
  const clearEntries = pnEntries.filter((e) => e.clear);
  const realEntries = pnEntries.filter((e) => !e.clear);
  if (clearEntries.length && realEntries.length) {
    errors.push("Cannot mix __CLEAR__ with other Part Numbers on the same Article group");
  }

  const byNormalized = new Map();
  const redundantRows = [];
  for (const entry of realEntries) {
    const prev = byNormalized.get(entry.normalized);
    if (prev) {
      redundantRows.push({ row: entry.excelRow, partNumber: entry.display, alsoRow: prev.excelRow });
      prev.sourceRows.push(entry.excelRow);
      continue;
    }
    byNormalized.set(entry.normalized, { ...entry, sourceRows: [entry.excelRow] });
  }
  const distinct = [...byNormalized.values()];

  const declaredPrimary = distinct.filter((e) => e.role === PART_NUMBER_ROLE_PRIMARY);
  if (declaredPrimary.length > 1) {
    const nums = declaredPrimary.map((e) => e.display).join(", ");
    errors.push(`Conflicting Primary Part Number declarations (${nums})`);
  }

  const existingPrimary = trim(canonicalItemMasterPartNumber(existingItem || {}, existingTech || {}));
  const existingPrimaryNorm = normalizePartNumberValue(existingPrimary);
  let primary = { display: existingPrimary, normalized: existingPrimaryNorm, proposed: false, sourceRows: [] };
  const remaining = [];

  if (clearEntries.length && !realEntries.length) {
    primary = { display: ITEM_MASTER_CLEAR_MARKER, normalized: "", proposed: false, sourceRows: clearEntries.map((e) => e.excelRow) };
  } else if (existingPrimaryNorm) {
    for (const entry of distinct) {
      if (entry.normalized === existingPrimaryNorm) {
        primary.sourceRows = entry.sourceRows;
        continue;
      }
      if (entry.role === PART_NUMBER_ROLE_PRIMARY) {
        errors.push(
          `Cannot replace existing Primary Part Number "${existingPrimary}" with "${entry.display}". Add it as an Alternate instead.`
        );
        continue;
      }
      remaining.push(entry);
    }
  } else if (declaredPrimary.length === 1) {
    primary = {
      display: declaredPrimary[0].display,
      normalized: declaredPrimary[0].normalized,
      proposed: true,
      sourceRows: declaredPrimary[0].sourceRows,
    };
    remaining.push(...distinct.filter((e) => e.normalized !== primary.normalized));
  } else if (distinct.length) {
    const first = distinct[0];
    primary = {
      display: first.display,
      normalized: first.normalized,
      proposed: true,
      sourceRows: first.sourceRows,
    };
    remaining.push(...distinct.slice(1));
  }

  const conflicts = detectSharedFieldConflicts(parsedRows);
  if (conflicts.length) {
    for (const c of conflicts) {
      const detail = c.values.map((v) => `"${v.value}" (rows ${formatSourceRowList(v.rows)})`).join(" vs ");
      errors.push(`Conflicting ${c.field}: ${detail}`);
    }
  }

  const merged = mergeIncomingMaster(parsedRows);
  if (!existingItem && !merged.itemName && !merged.description && article) {
    errors.push("Item Name or Description is required for a new Article");
  }

  const existingAlts = sanitizeAlternatePartNumberList(existingTech?.alternatePartNumbers || [], primary.display);
  const existingAltNorm = new Set(existingAlts.map((a) => a.normalized));
  const aliasesAdded = remaining.filter((e) => !existingAltNorm.has(e.normalized)).length;
  const groupMessage =
    sourceRows.length > 1
      ? `Article ${article} appears on rows ${formatSourceRowList(sourceRows)} with ${distinct.length || realEntries.length} Part Number${
          (distinct.length || realEntries.length) === 1 ? "" : "s"
        }. One Item Master Article will be created/updated and all Part Numbers will be linked.`
      : "";

  const blocked = errors.length > 0 || conflicts.length > 0;
  return {
    article,
    sourceRows,
    groupMessage,
    primaryPartNumber: primary.display === ITEM_MASTER_CLEAR_MARKER ? "" : primary.display,
    primaryClear: primary.display === ITEM_MASTER_CLEAR_MARKER,
    primaryProposed: Boolean(primary.proposed),
    primarySourceRows: primary.sourceRows,
    alternates: remaining.map((e) => ({
      partNumber: e.display,
      normalized: e.normalized,
      sourceRows: e.sourceRows,
    })),
    aliasesAdded,
    redundantRows,
    conflicts,
    errors: [...new Set(errors)],
    blocked,
    mergedIncoming: merged,
    distinctPartNumberCount: distinct.length,
  };
}

export function groupParsedItemMasterRows(parsed = []) {
  const groups = [];
  const order = [];
  const byArticle = new Map();
  for (const row of parsed) {
    const article = row.incoming?.article || "";
    if (!article) {
      groups.push({
        article: "",
        sourceRows: [row.excelRow],
        parsedRows: [row],
        orphan: true,
      });
      continue;
    }
    if (!byArticle.has(article)) {
      byArticle.set(article, { article, parsedRows: [] });
      order.push(article);
    }
    byArticle.get(article).parsedRows.push(row);
  }
  const analyzed = [];
  for (const article of order) {
    analyzed.push(byArticle.get(article));
  }
  for (const orphan of groups) analyzed.push(orphan);
  return analyzed;
}
