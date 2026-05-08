import StockBalance from "../models/StockBalance.js";
import StockLedger from "../models/StockLedger.js";

function f(value) {
  return String(value ?? "").trim();
}

function keyFilter(companyId, article, location, batchNo = "", serialNo = "") {
  return {
    companyId,
    article: f(article).toUpperCase(),
    location: f(location).toUpperCase(),
    batchNo: f(batchNo),
    serialNo: f(serialNo),
  };
}

/**
 * Maps the legacy `transactionType` enum to the Phase-3 unified
 * `movementType` vocabulary used by the unified Stock Ledger view.
 * Returning `null` is fine — the schema accepts null.
 */
function legacyToUnifiedMovementType(tx) {
  switch (tx) {
    case "GRN":
      return "GRN_IN";
    case "SALES_ALLOCATION":
      return "ALLOCATION";
    case "ORDER_ALLOCATION_CANCEL":
      return "ALLOCATION_CANCEL";
    case "RTS":
      return "RTS_TRANSFER";
    case "RTS_CANCEL":
      return "RTS_CANCEL";
    case "SALES_INVOICE":
      return "SALES_INVOICE_OUT";
    case "SALES_INVOICE_CANCEL":
      return "SALES_INVOICE_CANCEL";
    case "STOCK_ADJUSTMENT":
      return "STOCK_ADJUSTMENT";
    case "TRANSFER_IN":
      return "STOCK_TRANSFER_IN";
    case "TRANSFER_OUT":
      return "STOCK_TRANSFER_OUT";
    case "OPENING":
      return "OPENING_BALANCE";
    default:
      return null;
  }
}

/**
 * Posts a stock movement to the StockLedger and updates the
 * matching StockBalance row.
 *
 * Backward-compatible enrichment (Phase 3):
 *   • All callers continue to pass the same legacy fields.
 *   • Optional Phase-3 fields (customerName, supplierName,
 *     locationFrom, locationTo, sourceModule) can now be
 *     supplied; they are persisted on the ledger row.
 *   • The post-mutation balance snapshot (onHandAfter,
 *     allocatedAfter, rtsAfter, availableAfter) is captured
 *     after the StockBalance update and stored on the
 *     ledger row so the Stock Ledger UI never has to
 *     aggregate to render it.
 */
export async function postLedgerMovement({
  session,
  companyId,
  transactionDate,
  transactionType,
  referenceType = "",
  referenceNo = "",
  article,
  location,
  batchNo = "",
  serialNo = "",
  qtyIn = 0,
  qtyOut = 0,
  unitCost = 0,
  currency = "USD",
  remarks = "",
  createdBy = "",
  // Phase-3 optional enrichment fields ↓
  customerName = "",
  supplierName = "",
  locationFrom = "",
  locationTo = "",
  warehouse = "",
  sourceModule = "",
  movementType: explicitMovementType = null,
  isNegativeAllocation = false,
}) {
  const qIn = Number(qtyIn) || 0;
  const qOut = Number(qtyOut) || 0;
  if (qIn < 0 || qOut < 0 || (qIn === 0 && qOut === 0)) {
    throw new Error("Invalid stock movement quantity");
  }

  const filter = keyFilter(companyId, article, location, batchNo, serialNo);
  const balance = await StockBalance.findOne(filter).session(session);
  const current = balance || new StockBalance({ ...filter });

  const nextOnHand = Number(current.onHandQty || 0) + qIn - qOut;
  if (nextOnHand < 0) throw new Error("Negative stock not allowed");

  current.onHandQty = nextOnHand;
  current.quantity = nextOnHand;
  current.itemCode = filter.article;
  current.warehouse = filter.location;
  current.reservedQty = Number(current.allocatedQty || 0);
  current.availableQty = nextOnHand - Number(current.allocatedQty || 0) - Number(current.rtsQty || 0);
  if (current.availableQty < 0) throw new Error("Movement causes negative available stock");
  current.avgCost = Number(unitCost || current.avgCost || 0);
  current.unitCost = current.avgCost;
  current.currency = f(currency || current.currency || "USD").toUpperCase();
  current.lastTransactionDate = transactionDate;
  await current.save({ session });

  // Phase-3 after-balance snapshot. We use the freshly-persisted
  // `current` document so the snapshot reflects exactly what other
  // operations in this transaction will see.
  const onHandAfter = Number(current.onHandQty || 0);
  const allocatedAfter = Math.max(
    Number(current.allocatedQty || 0),
    Number(current.reservedQty || 0)
  );
  const rtsAfter = Number(current.rtsQty || 0);
  const availableAfter = onHandAfter - allocatedAfter - rtsAfter;

  const movementType = explicitMovementType || legacyToUnifiedMovementType(transactionType);
  // For TRANSFER_IN / TRANSFER_OUT we infer locationFrom/To when the
  // caller didn't supply them, using the location they did pass.
  let derivedFrom = f(locationFrom).toUpperCase();
  let derivedTo = f(locationTo).toUpperCase();
  if (!derivedFrom && transactionType === "TRANSFER_OUT") derivedFrom = filter.location;
  if (!derivedTo && transactionType === "TRANSFER_IN") derivedTo = filter.location;

  const ledger = await StockLedger.create(
    [
      {
        companyId,
        transactionDate,
        transactionType,
        movementType,
        sourceModule: f(sourceModule),
        referenceType,
        referenceNo,
        article: filter.article,
        location: filter.location,
        warehouse: f(warehouse).toUpperCase() || filter.location,
        locationFrom: derivedFrom,
        locationTo: derivedTo,
        customerName: f(customerName),
        supplierName: f(supplierName),
        batchNo: filter.batchNo,
        serialNo: filter.serialNo,
        qtyIn: qIn,
        qtyOut: qOut,
        balanceQty: current.onHandQty,
        onHandAfter,
        allocatedAfter,
        rtsAfter,
        availableAfter,
        isNegativeAllocation: Boolean(isNegativeAllocation),
        unitCost: Number(unitCost) || 0,
        currency: current.currency,
        remarks: f(remarks),
        createdBy: f(createdBy),
      },
    ],
    { session }
  );

  return { ledger: ledger[0], balance: current };
}
