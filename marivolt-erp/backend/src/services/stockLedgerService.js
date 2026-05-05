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

  const ledger = await StockLedger.create(
    [
      {
        companyId,
        transactionDate,
        transactionType,
        referenceType,
        referenceNo,
        article: filter.article,
        location: filter.location,
        batchNo: filter.batchNo,
        serialNo: filter.serialNo,
        qtyIn: qIn,
        qtyOut: qOut,
        balanceQty: current.onHandQty,
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

