/**
 * Canonical StockLocation create/reuse — shared by Location Master and ASN receiving putaway.
 */
import StockLocation from "../models/StockLocation.js";
import {
  buildPhysicalPutawayLocationCode,
  defaultPhysicalPutawayLocationName,
  isPhysicalPutawayStockLocation,
  normalizeRackBinPart,
  upperLoc,
} from "../utils/asnReceivingPutaway.js";

function t(v) {
  return String(v ?? "").trim();
}

export class StockLocationError extends Error {
  constructor(message, status = 400, code = "STOCK_LOCATION_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Create Active StockLocation or reuse existing row by companyId + locationCode.
 * When requirePhysical=true, reused rows must satisfy ASN physical putaway rules.
 */
export async function createOrReuseStockLocation({
  companyId,
  locationCode,
  locationName,
  warehouse,
  rack,
  bin,
  status = "Active",
  requirePhysical = false,
  physicalWarehouse = "MAIN",
} = {}) {
  const code = upperLoc(locationCode);
  if (!code) {
    throw new StockLocationError("Location code is required", 400, "STOCK_LOCATION_CODE_REQUIRED");
  }

  const wh = upperLoc(warehouse) || "MAIN";
  const rackNorm = normalizeRackBinPart(rack);
  const binNorm = normalizeRackBinPart(bin);
  const payload = {
    companyId,
    locationCode: code,
    locationName: t(locationName) || defaultPhysicalPutawayLocationName(wh, rackNorm, binNorm) || code,
    warehouse: wh,
    rack: rackNorm,
    bin: binNorm,
    status: String(status).toUpperCase() === "INACTIVE" ? "Inactive" : "Active",
  };

  try {
    const row = await StockLocation.create(payload);
    return { row: row.toObject ? row.toObject() : row, created: true, reused: false };
  } catch (err) {
    if (err?.code === 11000) {
      const existing = await StockLocation.findOne({ companyId, locationCode: code }).lean();
      if (!existing) throw err;
      if (requirePhysical && !isPhysicalPutawayStockLocation(existing, physicalWarehouse)) {
        throw new StockLocationError(
          `Location ${code} exists but is not a compatible Active physical putaway location`,
          409,
          "STOCK_LOCATION_INCOMPATIBLE",
        );
      }
      return { row: existing, created: false, reused: true };
    }
    throw err;
  }
}

/** Purpose-limited physical Rack/Bin create for ASN receiving putaway. */
export async function createPhysicalPutawayStockLocation({
  companyId,
  warehouse = "MAIN",
  rack,
  bin,
} = {}) {
  const rackNorm = normalizeRackBinPart(rack);
  const binNorm = normalizeRackBinPart(bin);
  if (!rackNorm) {
    throw new StockLocationError("Rack is required", 400, "RECEIVING_PUTAWAY_RACK_REQUIRED");
  }
  if (!binNorm) {
    throw new StockLocationError("Bin is required", 400, "RECEIVING_PUTAWAY_BIN_REQUIRED");
  }
  const wh = upperLoc(warehouse) || "MAIN";
  const locationCode = buildPhysicalPutawayLocationCode(wh, rackNorm, binNorm);
  if (!locationCode) {
    throw new StockLocationError("Could not build putaway location code", 400, "RECEIVING_PUTAWAY_NOT_ELIGIBLE");
  }

  return createOrReuseStockLocation({
    companyId,
    locationCode,
    locationName: defaultPhysicalPutawayLocationName(wh, rackNorm, binNorm),
    warehouse: wh,
    rack: rackNorm,
    bin: binNorm,
    status: "Active",
    requirePhysical: true,
    physicalWarehouse: wh,
  });
}
