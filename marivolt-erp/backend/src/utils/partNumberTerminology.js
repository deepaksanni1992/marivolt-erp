/**
 * Canonical OEM Part Number is stored as ItemTechnical.spn (fallback ItemMaster.spn).
 * User-facing name is "Part Number" / "Part No.". Do not persist a second master field.
 */

export const PART_NUMBER_CONFLICT = "PART_NUMBER_CONFLICT";
export const PART_NUMBER_MISMATCH = "PART_NUMBER_MISMATCH";
export const PART_NUMBER_NOT_LINKED_TO_ARTICLE = "PART_NUMBER_NOT_LINKED_TO_ARTICLE";
export const PART_NUMBER_INACTIVE = "PART_NUMBER_INACTIVE";
export const ITEM_MASTER_CLEAR_MARKER = "__CLEAR__";
export const ALIAS_STATUS_ACTIVE = "ACTIVE";
export const ALIAS_STATUS_INACTIVE = "INACTIVE";
export const DUPLICATE_ALIAS = "DUPLICATE_ALIAS";
export const ALIAS_EQUALS_PRIMARY = "ALIAS_EQUALS_PRIMARY";
export const ALIAS_NOT_FOUND = "ALIAS_NOT_FOUND";
export const STALE_ITEM_TECHNICAL = "STALE_ITEM_TECHNICAL";

const PART_NUMBER_HEADERS = [
  "Part Number",
  "Part No.",
  "Part No",
  "Part Nr.",
  "Part Nr",
  "Part number",
  "partNumber",
  "partNo",
];
const SPN_HEADERS = ["SPN", "spn"];

function trim(value) {
  return String(value ?? "").trim();
}

export function normalizePartNumberValue(value) {
  return trim(value).replace(/\s+/g, " ").toUpperCase();
}

/** Displayed / snapshot Part Number. Does not read ItemMaster.partNumber (legacy identity). */
export function canonicalItemMasterPartNumber(item = {}, technical = {}) {
  return String(technical?.spn || item?.spn || "");
}

export function displayedItemMasterPartNumber(item = {}, technical = {}) {
  return canonicalItemMasterPartNumber(item, technical);
}

function cellFromHeaders(row, headers) {
  for (const key of headers) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const raw = row[key];
      if (raw != null && trim(raw) !== "") return trim(String(raw));
    }
  }
  return "";
}

function headerPresent(row, headers) {
  return headers.some((key) => Object.prototype.hasOwnProperty.call(row, key));
}

function isClear(value) {
  return trim(value).toUpperCase() === ITEM_MASTER_CLEAR_MARKER;
}

/**
 * Resolve Item Master import/API Part Number from preferred and legacy SPN headers.
 * Same normalized values are accepted once. Conflicting nonblank values are rejected.
 */
export function resolveImportedPartNumber(row = {}) {
  const partNumber = cellFromHeaders(row, PART_NUMBER_HEADERS);
  const spn = cellFromHeaders(row, SPN_HEADERS);
  const hasPart = headerPresent(row, PART_NUMBER_HEADERS) && partNumber !== "";
  const hasSpn = headerPresent(row, SPN_HEADERS) && spn !== "";

  if (hasPart && hasSpn) {
    if (isClear(partNumber) && isClear(spn)) {
      return { value: ITEM_MASTER_CLEAR_MARKER, error: "" };
    }
    if (isClear(partNumber) !== isClear(spn) || normalizePartNumberValue(partNumber) !== normalizePartNumberValue(spn)) {
      return {
        value: "",
        error: `${PART_NUMBER_CONFLICT}: Part Number and SPN differ`,
        code: PART_NUMBER_CONFLICT,
      };
    }
  }

  const chosen = partNumber || spn;
  return { value: chosen, error: "" };
}

export function incomingDocumentPartNumber(line = {}) {
  return trim(line.partNumber || line.partNo || line.spn || line.SPN || "");
}

/** PO selected manufacturer Part Number. Never reads supplierPartNumber. */
export function incomingPoManufacturerPartNumber(line = {}) {
  return trim(line.partNo || line.partNumber || line.spn || line.SPN || "");
}

export function snapshotPartNumberFields(canonical) {
  const value = trim(canonical);
  return {
    partNo: value,
    partNumber: value,
    spn: value,
  };
}

/**
 * Quotation/OA snapshot mapping:
 * - customerPartNo = original customer request (unchanged)
 * - matchedPartNumber = Item Master Primary or Alternate that matched/was selected
 * - legacy partNumber = customerPartNo when supplied, otherwise matchedPartNumber
 */
export function snapshotSalesLinePartNumberFields({ customerPartNo = "", matchedPartNumber = "" } = {}) {
  const requested = trim(customerPartNo);
  const matched = trim(matchedPartNumber);
  return {
    customerPartNo: requested,
    matchedPartNumber: matched,
    partNumber: requested || matched,
  };
}

export function partNumberMismatchMessage(article, incoming, master) {
  return `PART_NUMBER_MISMATCH: Article ${article || "(blank)"} Part Number "${incoming}" does not match Item Master "${master || ""}". Update Item Master instead of overwriting it from the document.`;
}

export function partNumberNotLinkedMessage(article, incoming) {
  return `PART_NUMBER_NOT_LINKED_TO_ARTICLE: Part Number "${incoming}" is not an active manufacturer Part Number for Article ${article || "(blank)"}.`;
}

export function partNumberInactiveMessage(article, incoming) {
  return `PART_NUMBER_INACTIVE: Part Number "${incoming}" is inactive for Article ${article || "(blank)"} and cannot be used on a new or changed line.`;
}

export const PART_NUMBER_ROLE_PRIMARY = "PRIMARY";
export const PART_NUMBER_ROLE_ALTERNATE = "ALTERNATE";

export function isActiveAliasStatus(status) {
  const s = String(status || ALIAS_STATUS_ACTIVE).trim().toUpperCase();
  return s !== ALIAS_STATUS_INACTIVE;
}

export function manufacturerPartNumberPack(item = {}, technical = {}) {
  const primaryDisplay = trim(canonicalItemMasterPartNumber(item, technical));
  const primaryNormalized = normalizePartNumberValue(primaryDisplay);
  const seen = new Set();
  if (primaryNormalized) seen.add(primaryNormalized);
  const alternatePartNumbers = [];
  for (const row of technical?.alternatePartNumbers || item?.alternatePartNumbers || []) {
    const display = trim(row?.partNumber || "");
    const normalized = normalizePartNumberValue(display);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    alternatePartNumbers.push({
      partNumber: display || normalized,
      normalized,
      status: isActiveAliasStatus(row?.status) ? ALIAS_STATUS_ACTIVE : ALIAS_STATUS_INACTIVE,
      createdBy: trim(row?.createdBy),
      updatedBy: trim(row?.updatedBy),
    });
  }
  return {
    primaryPartNumber: primaryDisplay,
    primaryNormalized,
    alternatePartNumbers,
    allNormalized: [...seen],
  };
}

export function articleOwnsManufacturerPartNumber(item = {}, technical = {}, incoming = "", { requireActive = false } = {}) {
  const needle = normalizePartNumberValue(incoming);
  if (!needle) {
    return { owned: false, role: "", matchedPartNumber: "", inactive: false };
  }
  const pack = manufacturerPartNumberPack(item, technical);
  if (pack.primaryNormalized && pack.primaryNormalized === needle) {
    return { owned: true, role: PART_NUMBER_ROLE_PRIMARY, matchedPartNumber: pack.primaryPartNumber, inactive: false };
  }
  const alt = pack.alternatePartNumbers.find((row) => row.normalized === needle);
  if (alt) {
    const inactive = alt.status === ALIAS_STATUS_INACTIVE;
    if (requireActive && inactive) {
      return { owned: false, role: PART_NUMBER_ROLE_ALTERNATE, matchedPartNumber: alt.partNumber, inactive: true };
    }
    return { owned: true, role: PART_NUMBER_ROLE_ALTERNATE, matchedPartNumber: alt.partNumber, inactive };
  }
  return { owned: false, role: "", matchedPartNumber: "", inactive: false };
}

export function matchedManufacturerPartNumber(item = {}, technical = {}, query = "", { requireActive = false } = {}) {
  const owned = articleOwnsManufacturerPartNumber(item, technical, query, { requireActive });
  if (owned.owned) return owned.matchedPartNumber;
  if (requireActive) return "";
  const needle = trim(query);
  if (!needle) return "";
  const pack = manufacturerPartNumberPack(item, technical);
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (pack.primaryPartNumber && re.test(pack.primaryPartNumber)) return pack.primaryPartNumber;
  const alt = pack.alternatePartNumbers.find((row) => re.test(row.partNumber) || re.test(row.normalized));
  return alt?.partNumber || "";
}

export function publicManufacturerPartNumberDto(item = {}, technical = {}, searchQuery = "", opts = {}) {
  const includeInactive = Boolean(opts.includeInactive);
  const includeAudit = Boolean(opts.includeAudit);
  const pack = manufacturerPartNumberPack(item, technical);
  const alts = pack.alternatePartNumbers.filter((row) => includeInactive || row.status !== ALIAS_STATUS_INACTIVE);
  return {
    primaryPartNumber: pack.primaryPartNumber,
    alternatePartNumbers: alts.map((row) => {
      const out = { partNumber: row.partNumber };
      if (includeInactive || includeAudit) out.status = row.status;
      if (includeAudit) {
        out.createdBy = row.createdBy;
        out.updatedBy = row.updatedBy;
      }
      return out;
    }),
    alternateCount: alts.length,
    matchedPartNumber: matchedManufacturerPartNumber(item, technical, searchQuery, {
      requireActive: !includeInactive,
    }),
  };
}

export function sanitizeAlternatePartNumberList(list = [], primaryValue = "", audit = {}) {
  const primaryNorm = normalizePartNumberValue(primaryValue);
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const display = trim(raw?.partNumber ?? raw ?? "");
    if (!display) continue;
    const normalized = normalizePartNumberValue(display);
    if (!normalized || normalized === primaryNorm || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({
      partNumber: display,
      normalized,
      status: isActiveAliasStatus(raw?.status) ? ALIAS_STATUS_ACTIVE : ALIAS_STATUS_INACTIVE,
      createdBy: trim(raw?.createdBy || audit.createdBy || ""),
      updatedBy: trim(audit.updatedBy || raw?.updatedBy || ""),
    });
  }
  return out;
}

export function manufacturerPartNumberFindFilter(companyId, needle, { activeOnly = true } = {}) {
  const n = normalizePartNumberValue(needle);
  if (!n) return null;
  const exact = new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const altMatch = activeOnly
    ? {
        alternatePartNumbers: {
          $elemMatch: {
            $or: [{ normalized: n }, { partNumber: exact }],
            status: { $nin: [ALIAS_STATUS_INACTIVE] },
          },
        },
      }
    : { $or: [{ "alternatePartNumbers.normalized": n }, { "alternatePartNumbers.partNumber": exact }] };
  return {
    companyId,
    $or: [{ spn: exact }, altMatch],
  };
}
