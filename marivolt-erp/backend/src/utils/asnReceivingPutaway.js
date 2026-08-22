/**
 * ASN_RECEIVING physical putaway helpers — StockLocation-backed.
 * Does not redesign warehouse-level stock quantity accounting.
 */
export function tLoc(v) {
  return String(v ?? "").trim();
}

export function upperLoc(v) {
  return tLoc(v).toUpperCase();
}

/** Trim rack/bin parts; preserve display casing except for code generation. */
export function normalizeRackBinPart(v) {
  return tLoc(v);
}

/**
 * Canonical physical putaway locationCode: WAREHOUSE-RACK-BIN (all segments uppercased).
 * Matches existing test/seed convention e.g. MAIN-R01-B03.
 */
export function buildPhysicalPutawayLocationCode(warehouse = "MAIN", rack = "", bin = "") {
  const wh = upperLoc(warehouse) || "MAIN";
  const r = upperLoc(rack);
  const b = upperLoc(bin);
  if (!r || !b) return "";
  return `${wh}-${r}-${b}`;
}

export function defaultPhysicalPutawayLocationName(warehouse = "MAIN", rack = "", bin = "") {
  const code = buildPhysicalPutawayLocationCode(warehouse, rack, bin);
  if (!code) return "";
  return `Putaway ${code}`;
}

/**
 * ASN_RECEIVING physical putaway requires an Active StockLocation in the target warehouse
 * with BOTH rack and bin configured. Warehouse codes (e.g. MAIN) are not putaway.
 */
export function isPhysicalPutawayStockLocation(loc, warehouseCode = "MAIN") {
  if (!loc) return false;
  if (String(loc.status || "Active").toUpperCase() === "INACTIVE") return false;
  const code = upperLoc(loc.locationCode);
  if (!code) return false;
  const wh = upperLoc(warehouseCode) || "MAIN";
  const locWh = upperLoc(loc.warehouse);
  if (locWh && locWh !== wh) return false;
  const rack = tLoc(loc.rack);
  const bin = tLoc(loc.bin);
  if (!rack || !bin) return false;
  return true;
}

export function assertAsnReceivingPutawayLocation(locationCode, {
  warehouse = "MAIN",
  stockLocationsByCode = new Map(),
} = {}) {
  const code = upperLoc(locationCode);
  if (!code) {
    return {
      ok: false,
      code: "GRN_LOCATION_REQUIRED",
      message: "Physical putaway location is required",
    };
  }
  const loc = stockLocationsByCode.get(code) || null;
  if (!loc) {
    return {
      ok: false,
      code: "GRN_LOCATION_REQUIRED",
      message: `Putaway location ${code} is not a known StockLocation`,
    };
  }
  if (String(loc.status || "Active").toUpperCase() === "INACTIVE") {
    return {
      ok: false,
      code: "GRN_LOCATION_REQUIRED",
      message: `Putaway location ${code} is inactive`,
    };
  }
  const wh = upperLoc(warehouse) || "MAIN";
  const locWh = upperLoc(loc.warehouse);
  if (locWh && locWh !== wh) {
    return {
      ok: false,
      code: "GRN_LOCATION_REQUIRED",
      message: `Putaway location ${code} belongs to warehouse ${locWh}, not ${wh}`,
    };
  }
  if (!isPhysicalPutawayStockLocation(loc, wh)) {
    return {
      ok: false,
      code: "GRN_LOCATION_REQUIRED",
      message: `Location ${code} is not a valid physical putaway (Active Rack/Bin StockLocation required)`,
    };
  }
  return { ok: true, location: loc };
}

export function formatStockLocationLabel(loc) {
  if (!loc) return "";
  const code = upperLoc(loc.locationCode);
  const rack = tLoc(loc.rack);
  const bin = tLoc(loc.bin);
  if (rack && bin) return `${code} — Rack ${rack} · Bin ${bin}`;
  return code;
}
