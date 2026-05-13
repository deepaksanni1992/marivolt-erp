import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "../src/models/Company.js";
import Counter from "../src/models/Counter.js";
import GRN from "../src/models/GRN.js";
import PurchaseOrder from "../src/models/PurchaseOrder.js";
import StockLocation from "../src/models/StockLocation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

const RECEIPT_GRN_STATUSES = ["POSTED", "RECEIVED", "PARTIAL_RECEIVED", "CLOSED"];

function companyCode(row) {
  return String(row?.code || "").trim().toUpperCase();
}

function counterKey(code) {
  return `grn:${companyCode({ code }) || "CMP"}`;
}

function maxGrnSeq(rows, code) {
  const re = new RegExp(`^${code}-GRN-(\\d+)$`, "i");
  let max = 0;
  for (const row of rows) {
    const match = String(row.grnNo || "").match(re);
    const seq = Number(match?.[1] || 0);
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max;
}

function poLineQty(line) {
  const ordered = Number(line?.orderedQty ?? line?.qty ?? line?.quantity ?? line?.orderedQuantity) || 0;
  const cancelled = Number(line?.cancelledQty ?? line?.cancelled) || 0;
  return { ordered, cancelled };
}

function receiptStatusForLines(lines = []) {
  const anyReceived = lines.some((line) => (Number(line.receivedQty) || 0) > 0.001);
  const anyPending = lines.some((line) => (Number(line.pendingQty) || 0) > 0.001);
  if (anyReceived && !anyPending) return "FULLY_RECEIVED";
  if (anyReceived) return "PARTIALLY_RECEIVED";
  return "NOT_RECEIVED";
}

async function ensureMainWarehouse(companyId) {
  const existing = await StockLocation.findOne({ companyId, locationCode: "MAIN" });
  if (!existing) {
    await StockLocation.create({
      companyId,
      locationCode: "MAIN",
      locationName: "Main Warehouse",
      status: "Active",
    });
    return "created";
  }

  let changed = false;
  if (existing.status !== "Active") {
    existing.status = "Active";
    changed = true;
  }
  if (!String(existing.locationName || "").trim()) {
    existing.locationName = "Main Warehouse";
    changed = true;
  }
  if (changed) {
    await existing.save();
    return "updated";
  }
  return "ok";
}

async function buildReceivedByPoLine(companyId) {
  const rows = await GRN.find({
    companyId,
    status: { $in: RECEIPT_GRN_STATUSES },
  })
    .select("poId items grnNo")
    .lean();

  const received = new Map();
  for (const grn of rows) {
    if (!grn.poId) continue;
    for (const line of grn.items || []) {
      if (!line.poLineId) continue;
      const key = `${String(grn.poId)}:${String(line.poLineId)}`;
      received.set(key, (received.get(key) || 0) + (Number(line.acceptedQty ?? line.receivedQty) || 0));
    }
  }
  return { received, grnCount: rows.length };
}

async function repairPurchaseOrders(companyId) {
  const { received, grnCount } = await buildReceivedByPoLine(companyId);
  const pos = await PurchaseOrder.find({ companyId });
  let updated = 0;

  for (const po of pos) {
    let changed = false;
    for (const line of po.lines || []) {
      const key = `${String(po._id)}:${String(line._id)}`;
      const { ordered, cancelled } = poLineQty(line);
      const receivedQty = Math.min(ordered, received.get(key) || 0);
      const pendingQty = Math.max(0, ordered - receivedQty - cancelled);
      if (Number(line.receivedQty || 0) !== receivedQty) {
        line.receivedQty = receivedQty;
        changed = true;
      }
      if (Number(line.pendingQty || 0) !== pendingQty) {
        line.pendingQty = pendingQty;
        changed = true;
      }
      if (Number(line.orderedQty || 0) !== ordered) {
        line.orderedQty = ordered;
        changed = true;
      }
      if (Number(line.qty || 0) !== ordered) {
        line.qty = ordered;
        changed = true;
      }
    }

    const receiptStatus = receiptStatusForLines(po.lines || []);
    const progressStatus =
      receiptStatus === "FULLY_RECEIVED" ? "COMPLETE" : receiptStatus === "PARTIALLY_RECEIVED" ? "PARTIAL" : "NONE";
    const nonTerminal = !["CANCELLED", "CLOSED", "REJECTED"].includes(String(po.status || "").toUpperCase());
    const nextPoStatus =
      receiptStatus === "FULLY_RECEIVED"
        ? "RECEIVED"
        : receiptStatus === "PARTIALLY_RECEIVED"
          ? "PARTIAL_RECEIVED"
          : String(po.status || "").toUpperCase().includes("RECEIVED")
            ? "SENT"
            : po.status;
    const summary = (po.lines || [])
      .map((line) => `${line.itemCode || line.article || ""}:${Number(line.receivedQty) || 0}/${Number(line.orderedQty ?? line.qty) || 0}`)
      .join("; ")
      .slice(0, 500);

    if (po.grnReceiptStatus !== receiptStatus) {
      po.grnReceiptStatus = receiptStatus;
      changed = true;
    }
    if (po.grnProgressStatus !== progressStatus) {
      po.grnProgressStatus = progressStatus;
      changed = true;
    }
    if (po.receivedQtySummary !== summary) {
      po.receivedQtySummary = summary;
      changed = true;
    }
    if (nonTerminal && po.status !== nextPoStatus) {
      po.status = nextPoStatus;
      changed = true;
    }

    if (changed) {
      po.markModified("lines");
      await po.save();
      updated += 1;
    }
  }

  return { grnCount, poScanned: pos.length, poUpdated: updated };
}

async function repairCompany(company) {
  const code = companyCode(company);
  const grns = await GRN.find({ companyId: company._id }).select("grnNo").lean();
  const maxSeq = maxGrnSeq(grns, code);
  await Counter.findOneAndUpdate(
    { companyId: company._id, key: counterKey(code) },
    {
      $set: { companyId: company._id, key: counterKey(code), seq: maxSeq },
    },
    { upsert: true, new: true, setDefaultsOnInsert: false }
  );
  const mainWarehouse = await ensureMainWarehouse(company._id);
  const poRepair = await repairPurchaseOrders(company._id);
  return {
    company: code,
    grnsScanned: grns.length,
    maxSeq,
    counterKey: counterKey(code),
    mainWarehouse,
    ...poRepair,
  };
}

async function run() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing in .env");
  await mongoose.connect(process.env.MONGO_URI);

  const companies = await Company.find({ code: { $in: ["MAR", "OKE"] } }).sort({ code: 1 }).lean();
  if (!companies.length) throw new Error("No MAR/OKE companies found.");

  const summaries = [];
  for (const company of companies) {
    summaries.push(await repairCompany(company));
  }

  console.log("GRN repair summary");
  for (const s of summaries) {
    console.log(
      [
        `company=${s.company}`,
        `grnsScanned=${s.grnsScanned}`,
        `maxSeq=${s.maxSeq}`,
        `counter=${s.counterKey}`,
        `mainWarehouse=${s.mainWarehouse}`,
        `receiptGrns=${s.grnCount}`,
        `poScanned=${s.poScanned}`,
        `poUpdated=${s.poUpdated}`,
      ].join(" | ")
    );
  }
  console.log("Done. No GRN, PO, sales, stock, or ledger records were deleted.");
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect errors during failure handling
  }
  process.exit(1);
});
