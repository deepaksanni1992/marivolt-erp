/**
 * Canonical OEM Part Number is stored as ItemTechnical.spn (fallback ItemMaster.spn).
 * User-facing name is "Part Number" / "Part No.". Do not persist a second master field.
 */

export const PART_NUMBER_CONFLICT = "PART_NUMBER_CONFLICT";
export const PART_NUMBER_MISMATCH = "PART_NUMBER_MISMATCH";
export const ITEM_MASTER_CLEAR_MARKER = "__CLEAR__";

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

export function snapshotPartNumberFields(canonical) {
  const value = trim(canonical);
  return {
    partNo: value,
    partNumber: value,
    spn: value,
  };
}

export function partNumberMismatchMessage(article, incoming, master) {
  return `PART_NUMBER_MISMATCH: Article ${article || "(blank)"} Part Number "${incoming}" does not match Item Master "${master || ""}". Update Item Master instead of overwriting it from the document.`;
}
