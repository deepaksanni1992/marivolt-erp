/**
 * Canonical Customs GRN field model (revised).
 *
 * Resolution: line override if present, else header default.
 * On post: persist ONLY resolved effective values on GRN line + Customs lot/item.
 * Do not depend on mutable GRN header after posting.
 */

export const CUSTOMS_GRN_HEADER_FIELDS = [
  "receivedDate",
  "boeNumber",
  "boeDate",
  "blNumber",
  "awbNumber",
  "supplierInvoiceNumber",
  "supplierInvoiceDate",
  "countryOfOrigin",
  "hsCode",
  "unitWeightKg",
  "customsUnitPrice",
  "customsCurrency",
  "exchangeRateToAED",
  "customsRemarks",
];

/** Line may override any header field; also carries computed totals. */
export const CUSTOMS_GRN_LINE_FIELDS = [
  ...CUSTOMS_GRN_HEADER_FIELDS,
  "totalWeightKg",
  "customsTotalPrice",
  "customsValueAED",
];

/** Mandatory when customs capture is active for the GRN. BL/AWB/remarks optional. */
export const CUSTOMS_GRN_MANDATORY_EFFECTIVE = [
  "receivedDate",
  "boeNumber",
  "boeDate",
  "supplierInvoiceNumber",
  "supplierInvoiceDate",
  "customsCurrency",
  "exchangeRateToAED",
  "customsUnitPrice",
  "countryOfOrigin",
  "hsCode",
];

function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

export function parseCustomsDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const s = t(value);
  if (!s) return null;
  // Date-only YYYY-MM-DD → local calendar day (no silent TZ shift of calendar date)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isFutureDate(d, now = new Date()) {
  if (!d) return false;
  return startOfLocalDay(d).getTime() > startOfLocalDay(now).getTime();
}

function isBeforeDate(a, b) {
  if (!a || !b) return false;
  return startOfLocalDay(a).getTime() < startOfLocalDay(b).getTime();
}

function isAfterDate(a, b) {
  if (!a || !b) return false;
  return startOfLocalDay(a).getTime() > startOfLocalDay(b).getTime();
}

function hasOwnOverride(override, key) {
  if (!override || typeof override !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(override, key)) return false;
  const v = override[key];
  if (v == null) return false;
  if (typeof v === "string" && !t(v)) return false;
  return true;
}

function pickNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve effective customs values for one GRN line.
 * Never falls back to commercial unitCost — customs price must come from capture.
 * Totals are always recalculated server-side (client-imported totals are ignored).
 * TotalWeightKg uses qty × unitWeight unless an authorised weight override is granted.
 */
export function resolveCustomsLineEffective({
  header = {},
  override = {},
  quantity = 0,
  allowances = {},
} = {}) {
  const qty = Math.max(0, Number(quantity) || 0);

  const pick = (key, { upperCase = false, numeric = false } = {}) => {
    if (hasOwnOverride(override, key)) {
      const raw = override[key];
      if (numeric) return pickNum(raw);
      return upperCase ? upper(raw) : t(raw);
    }
    if (hasOwnOverride(header, key)) {
      const raw = header[key];
      if (numeric) return pickNum(raw);
      return upperCase ? upper(raw) : t(raw);
    }
    if (numeric) return null;
    return "";
  };

  const pickDate = (key) => {
    if (hasOwnOverride(override, key)) return parseCustomsDate(override[key]);
    if (hasOwnOverride(header, key)) return parseCustomsDate(header[key]);
    return null;
  };

  const unitWeightKg = pick("unitWeightKg", { numeric: true }) ?? 0;
  const customsUnitPrice = pick("customsUnitPrice", { numeric: true }) ?? 0;
  let customsCurrency = pick("customsCurrency", { upperCase: true });
  let exchangeRateToAED = pick("exchangeRateToAED", { numeric: true });

  // AED forces FX = 1 (server-side; client cannot send a different rate for AED)
  if (customsCurrency === "AED") {
    exchangeRateToAED = 1;
  }

  const rate =
    exchangeRateToAED == null || !(Number(exchangeRateToAED) > 0) ? null : Number(exchangeRateToAED);

  // Computed totals — always server-side from qty × unit fields
  const computedTotalWeight = qty > 0 && unitWeightKg > 0 ? qty * unitWeightKg : 0;
  let totalWeightKg = computedTotalWeight;
  if (
    allowances.allowTotalWeightOverride &&
    hasOwnOverride(override, "totalWeightKg") &&
    pickNum(override.totalWeightKg) != null
  ) {
    totalWeightKg = pickNum(override.totalWeightKg);
  }

  const customsTotalPrice = qty * customsUnitPrice;
  const customsValueAED = rate != null ? customsTotalPrice * rate : 0;

  return {
    receivedDate: pickDate("receivedDate"),
    boeNumber: pick("boeNumber"),
    boeDate: pickDate("boeDate"),
    blNumber: pick("blNumber"),
    awbNumber: pick("awbNumber"),
    supplierInvoiceNumber: pick("supplierInvoiceNumber"),
    supplierInvoiceDate: pickDate("supplierInvoiceDate"),
    countryOfOrigin: pick("countryOfOrigin", { upperCase: true }),
    hsCode: pick("hsCode", { upperCase: true }),
    unitWeightKg,
    totalWeightKg: Number(totalWeightKg) || 0,
    customsUnitPrice,
    customsTotalPrice: Number(customsTotalPrice) || 0,
    customsCurrency,
    exchangeRateToAED: rate,
    customsValueAED: Number(customsValueAED) || 0,
    customsRemarks: pick("customsRemarks"),
    quantity: qty,
  };
}

export function validateCustomsMandatoryEffective(effective, { location = "" } = {}) {
  const errors = [];
  const label = {
    receivedDate: "Received Date",
    boeNumber: "BOE Number",
    boeDate: "BOE Date",
    supplierInvoiceNumber: "Supplier Invoice Number",
    supplierInvoiceDate: "Supplier Invoice Date",
    customsCurrency: "Customs Currency",
    exchangeRateToAED: "Exchange Rate to AED",
    customsUnitPrice: "Customs Unit Price",
    countryOfOrigin: "Country of Origin",
    hsCode: "HS Code",
  };

  for (const key of CUSTOMS_GRN_MANDATORY_EFFECTIVE) {
    const v = effective[key];
    if (key.endsWith("Date")) {
      if (!v) errors.push(`${label[key]} is required`);
      continue;
    }
    if (key === "customsUnitPrice" || key === "exchangeRateToAED") {
      if (v == null || !(Number(v) > 0)) errors.push(`${label[key]} is required and must be greater than zero`);
      continue;
    }
    if (!t(v)) errors.push(`${label[key]} is required`);
  }

  if (upper(effective.customsCurrency) === "AED" && Number(effective.exchangeRateToAED) !== 1) {
    errors.push("When Customs Currency is AED, Exchange Rate to AED must be 1");
  }

  if (!t(location)) errors.push("Location is required");
  if (!(Number(effective.quantity) > 0)) errors.push("Quantity is required and must be greater than zero");

  return errors;
}

/**
 * Merge client-requested date/weight overrides with server-granted permission.
 * Client checkboxes alone NEVER grant allowance — permissionRequired must be true.
 */
export function resolveCustomsAllowances({ requested = {}, permissionGranted = false } = {}) {
  const grant = Boolean(permissionGranted);
  return {
    allowBoeBeforePoDate: grant && Boolean(requested.allowBoeBeforePoDate),
    allowInvoiceAfterReceivedDate: grant && Boolean(requested.allowInvoiceAfterReceivedDate),
    allowFutureReceivedDate: grant && Boolean(requested.allowFutureReceivedDate),
    allowTotalWeightOverride: grant && Boolean(requested.allowTotalWeightOverride),
  };
}

/**
 * Date validation. Does not mutate dates.
 * allowances must already be permission-gated via resolveCustomsAllowances.
 */
export function validateCustomsDates(effective, { poDate = null, allowances = {} } = {}) {
  const errors = [];
  const po = parseCustomsDate(poDate);
  const received = effective.receivedDate;
  const boe = effective.boeDate;
  const invoice = effective.supplierInvoiceDate;

  if (boe) {
    if (isFutureDate(boe)) errors.push("BOE Date cannot be in the future");
    if (po && isBeforeDate(boe, po) && !allowances.allowBoeBeforePoDate) {
      errors.push("BOE Date cannot be earlier than PO date unless explicitly authorised");
    }
  }

  if (invoice) {
    if (isFutureDate(invoice)) errors.push("Supplier Invoice Date cannot be in the future");
    if (received && isAfterDate(invoice, received) && !allowances.allowInvoiceAfterReceivedDate) {
      errors.push(
        "Supplier Invoice Date cannot be later than Received Date unless override permission exists"
      );
    }
  }

  if (received) {
    if (po && isBeforeDate(received, po)) {
      errors.push("Received Date cannot be earlier than PO date");
    }
    if (isFutureDate(received) && !allowances.allowFutureReceivedDate) {
      errors.push("Received Date cannot be in the future unless future GRN is explicitly supported");
    }
  }

  return errors;
}

/**
 * Normalize raw customs body into header defaults + line override map.
 * Accepts both revised names and legacy aliases (currency, unitPrice, weightKg, remarks).
 */
export function normalizeCustomsHeaderDefaults(raw = {}) {
  const c = raw?.customs && typeof raw.customs === "object" ? raw.customs : raw;
  return {
    receivedDate: c.receivedDate ?? c.ReceivedDate ?? "",
    boeNumber: t(c.boeNumber ?? c.BOENumber),
    boeDate: c.boeDate ?? c.BOEDate ?? "",
    blNumber: t(c.blNumber ?? c.BLNumber),
    awbNumber: t(c.awbNumber ?? c.AWBNumber),
    supplierInvoiceNumber: t(c.supplierInvoiceNumber ?? c.SupplierInvoiceNumber ?? c.supplierInvoiceNo),
    supplierInvoiceDate: c.supplierInvoiceDate ?? c.SupplierInvoiceDate ?? "",
    countryOfOrigin: t(c.countryOfOrigin ?? c.CountryOfOrigin),
    hsCode: t(c.hsCode ?? c.HSCode),
    unitWeightKg: c.unitWeightKg ?? c.UnitWeightKg ?? c.weightKg ?? "",
    customsUnitPrice: c.customsUnitPrice ?? c.CustomsUnitPrice ?? c.unitPrice ?? "",
    customsCurrency: t(c.customsCurrency ?? c.CustomsCurrency ?? c.currency),
    exchangeRateToAED: c.exchangeRateToAED ?? c.ExchangeRateToAED ?? "",
    customsRemarks: t(c.customsRemarks ?? c.CustomsRemarks ?? c.remarks),
  };
}

export function normalizeCustomsLineOverride(row = {}) {
  const o = {};
  const map = {
    receivedDate: ["receivedDate", "ReceivedDate"],
    boeNumber: ["boeNumber", "BOENumber"],
    boeDate: ["boeDate", "BOEDate"],
    blNumber: ["blNumber", "BLNumber"],
    awbNumber: ["awbNumber", "AWBNumber"],
    supplierInvoiceNumber: ["supplierInvoiceNumber", "SupplierInvoiceNumber"],
    supplierInvoiceDate: ["supplierInvoiceDate", "SupplierInvoiceDate"],
    countryOfOrigin: ["countryOfOrigin", "CountryOfOrigin"],
    hsCode: ["hsCode", "HSCode"],
    unitWeightKg: ["unitWeightKg", "UnitWeightKg", "weightKg"],
    totalWeightKg: ["totalWeightKg", "TotalWeightKg"],
    customsUnitPrice: ["customsUnitPrice", "CustomsUnitPrice", "unitPrice"],
    customsTotalPrice: ["customsTotalPrice", "CustomsTotalPrice"],
    customsCurrency: ["customsCurrency", "CustomsCurrency", "currency"],
    exchangeRateToAED: ["exchangeRateToAED", "ExchangeRateToAED"],
    customsValueAED: ["customsValueAED", "CustomsValueAED"],
    customsRemarks: ["customsRemarks", "CustomsRemarks", "remarks"],
  };
  for (const [canon, aliases] of Object.entries(map)) {
    for (const a of aliases) {
      if (Object.prototype.hasOwnProperty.call(row, a) && row[a] != null && row[a] !== "") {
        o[canon] = row[a];
        break;
      }
    }
  }
  return o;
}

export function buildLineOverrideMap(customs = {}) {
  const map = new Map();
  for (const row of customs.lineOverrides || []) {
    const key = String(row?.poLineId ?? row?.grnLineId ?? "");
    if (!key) continue;
    map.set(key, normalizeCustomsLineOverride(row));
  }
  return map;
}

/**
 * Validate all selected lines when customs capture is active.
 * Returns { ok, errors: [{ line, article, messages }] }.
 */
export function validateCustomsCaptureForGrn({
  header = {},
  lineOverrides = new Map(),
  lines = [],
  poDate = null,
  allowances = {},
} = {}) {
  const headerNorm = normalizeCustomsHeaderDefaults(header);
  const errors = [];

  for (const line of lines) {
    const qty = Number(line.acceptedQty ?? line.receivedQty ?? line.quantity ?? line.grnQty) || 0;
    if (qty <= 0) continue;
    const key = String(line.poLineId ?? line._id ?? "");
    const override = lineOverrides.get(key) || normalizeCustomsLineOverride(line.customsOverride || {});
    const effective = resolveCustomsLineEffective({
      header: headerNorm,
      override,
      quantity: qty,
      allowances,
    });
    const msgs = [
      ...validateCustomsMandatoryEffective(effective, { location: line.location }),
      ...validateCustomsDates(effective, { poDate, allowances }),
    ];
    if (msgs.length) {
      errors.push({
        line: key || line.article || "?",
        article: line.article || "",
        messages: msgs,
        effective,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Snapshot for GRN line persistence (effective only). */
export function toPersistedGrnLineCustoms(effective) {
  return {
    receivedDate: effective.receivedDate || null,
    boeNumber: effective.boeNumber || "",
    boeDate: effective.boeDate || null,
    blNumber: effective.blNumber || "",
    awbNumber: effective.awbNumber || "",
    supplierInvoiceNumber: effective.supplierInvoiceNumber || "",
    supplierInvoiceDate: effective.supplierInvoiceDate || null,
    countryOfOrigin: effective.countryOfOrigin || "",
    hsCode: effective.hsCode || "",
    unitWeightKg: Number(effective.unitWeightKg) || 0,
    totalWeightKg: Number(effective.totalWeightKg) || 0,
    customsUnitPrice: Number(effective.customsUnitPrice) || 0,
    customsTotalPrice: Number(effective.customsTotalPrice) || 0,
    customsCurrency: effective.customsCurrency || "",
    exchangeRateToAED: Number(effective.exchangeRateToAED) || 0,
    customsValueAED: Number(effective.customsValueAED) || 0,
    customsRemarks: effective.customsRemarks || "",
  };
}

export class CustomsGrnValidationError extends Error {
  constructor(errors = []) {
    const flat = errors
      .flatMap((e) => (e.messages || []).map((m) => `${e.article || e.line}: ${m}`))
      .join("; ");
    super(flat || "Customs validation failed");
    this.name = "CustomsGrnValidationError";
    this.code = "CUSTOMS_GRN_VALIDATION";
    this.errors = errors;
    this.statusCode = 400;
  }
}
