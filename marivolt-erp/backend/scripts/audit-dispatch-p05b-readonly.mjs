/**
 * P0.5B — Read-only Store Dispatch audit (no writes).
 * node scripts/audit-dispatch-p05b-readonly.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

const POSTED = ["POSTED", "PARTIALLY_DISPATCHED", "FULLY_DISPATCHED"];

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const dispatches = db.collection("storedispatches");
  const ledgers = db.collection("stockledgers");
  const invoices = db.collection("salesinvoices");
  const packings = db.collection("storepackings");

  const statusCounts = await dispatches
    .aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { n: -1 } }])
    .toArray();
  const totalDispatch = await dispatches.countDocuments({});
  const indexes = await dispatches.indexes();
  const ledgerIndexes = await ledgers.indexes();

  const posted = await dispatches
    .find({ status: { $in: POSTED } })
    .project({
      _id: 1,
      companyId: 1,
      dispatchNo: 1,
      status: 1,
      packingId: 1,
      salesInvoiceId: 1,
      warehouse: 1,
      lines: 1,
    })
    .toArray();

  const dispatchOut = await ledgers.countDocuments({
    $or: [{ movementType: "DISPATCH_OUT" }, { transactionType: "DISPATCH_OUT" }],
  });
  const dispatchCancel = await ledgers.countDocuments({
    $or: [{ movementType: "DISPATCH_CANCEL" }, { transactionType: "DISPATCH_CANCEL" }],
  });
  const dispatchOutWithSource = await ledgers.countDocuments({
    movementType: "DISPATCH_OUT",
    sourceDocumentType: "STORE_DISPATCH",
    sourceDocumentId: { $type: "objectId" },
  });
  const withEffectKey = await ledgers.countDocuments({ effectKey: { $type: "string", $gt: "" } });

  const postedWithoutLedger = [];
  for (const d of posted) {
    const n = await ledgers.countDocuments({
      companyId: d.companyId,
      $or: [
        {
          referenceNo: d.dispatchNo,
          $or: [{ movementType: "DISPATCH_OUT" }, { transactionType: "DISPATCH_OUT" }],
        },
        {
          sourceDocumentType: "STORE_DISPATCH",
          sourceDocumentId: d._id,
          movementType: "DISPATCH_OUT",
        },
      ],
    });
    if (n === 0) postedWithoutLedger.push({ id: String(d._id), no: d.dispatchNo, status: d.status });
  }

  const outRows = await ledgers
    .find({ $or: [{ movementType: "DISPATCH_OUT" }, { transactionType: "DISPATCH_OUT" }] })
    .project({ _id: 1, referenceNo: 1, sourceDocumentId: 1, companyId: 1, article: 1 })
    .limit(500)
    .toArray();
  const ledgerWithoutDispatch = [];
  for (const r of outRows) {
    let ok = false;
    if (r.sourceDocumentId) {
      ok = !!(await dispatches.findOne({ _id: r.sourceDocumentId, status: { $in: POSTED } }));
    }
    if (!ok && r.referenceNo) {
      ok = !!(await dispatches.findOne({
        companyId: r.companyId,
        dispatchNo: r.referenceNo,
        status: { $in: POSTED },
      }));
    }
    if (!ok) ledgerWithoutDispatch.push({ id: String(r._id), ref: r.referenceNo || "", article: r.article });
  }

  const softDups = await ledgers
    .aggregate([
      { $match: { $or: [{ movementType: "DISPATCH_OUT" }, { transactionType: "DISPATCH_OUT" }] } },
      {
        $group: {
          _id: {
            c: "$companyId",
            r: "$referenceNo",
            a: "$article",
            m: { $ifNull: ["$movementType", "$transactionType"] },
          },
          n: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { n: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();

  const effectKeyDups = await ledgers
    .aggregate([
      { $match: { effectKey: { $type: "string", $gt: "" } } },
      { $group: { _id: "$effectKey", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();

  const cancelled = await dispatches
    .find({ status: "CANCELLED" })
    .project({ _id: 1, dispatchNo: 1, postedAt: 1, companyId: 1 })
    .toArray();
  const cancelledNoReversal = [];
  for (const d of cancelled) {
    if (!d.postedAt) continue;
    const out = await ledgers.countDocuments({
      companyId: d.companyId,
      $or: [
        {
          referenceNo: d.dispatchNo,
          $or: [{ movementType: "DISPATCH_OUT" }, { transactionType: "DISPATCH_OUT" }],
        },
        { sourceDocumentId: d._id, movementType: "DISPATCH_OUT" },
      ],
    });
    const rev = await ledgers.countDocuments({
      companyId: d.companyId,
      $or: [
        {
          referenceNo: d.dispatchNo,
          $or: [{ movementType: "DISPATCH_CANCEL" }, { transactionType: "DISPATCH_CANCEL" }],
        },
        { sourceDocumentId: d._id, movementType: "DISPATCH_CANCEL" },
      ],
    });
    if (out > 0 && rev === 0) cancelledNoReversal.push({ id: String(d._id), no: d.dispatchNo });
  }

  const multiRev = await ledgers
    .aggregate([
      { $match: { movementType: "DISPATCH_CANCEL", reversedFromLedgerId: { $type: "objectId" } } },
      { $group: { _id: "$reversedFromLedgerId", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 20 },
    ])
    .toArray();

  const intermediate = await dispatches.countDocuments({
    status: { $in: ["POSTING", "CANCELLING", "READY"] },
  });

  const siDispatched = await invoices
    .find({ status: "DISPATCHED" })
    .project({ _id: 1, invoiceNo: 1, linkedSalesDispatchId: 1, companyId: 1 })
    .toArray();
  const siWithoutDispatch = [];
  for (const inv of siDispatched) {
    let ok = false;
    if (inv.linkedSalesDispatchId) {
      ok = !!(await dispatches.findOne({
        _id: inv.linkedSalesDispatchId,
        status: { $in: POSTED },
      }));
    }
    if (!ok) {
      ok = !!(await dispatches.findOne({
        companyId: inv.companyId,
        salesInvoiceId: inv._id,
        status: { $in: POSTED },
      }));
    }
    if (!ok) siWithoutDispatch.push({ id: String(inv._id), no: inv.invoiceNo });
  }

  const missingRefs = [];
  const all = await dispatches
    .find({})
    .project({ _id: 1, dispatchNo: 1, packingId: 1, salesInvoiceId: 1, status: 1 })
    .toArray();
  for (const d of all) {
    const pack = d.packingId ? await packings.findOne({ _id: d.packingId }, { projection: { _id: 1 } }) : null;
    const inv = d.salesInvoiceId
      ? await invoices.findOne({ _id: d.salesInvoiceId }, { projection: { _id: 1 } })
      : null;
    if (!pack || !inv) {
      missingRefs.push({
        id: String(d._id),
        no: d.dispatchNo,
        status: d.status,
        missingPack: !pack,
        missingInv: !inv,
      });
    }
  }

  const overDispatch = [];
  for (const d of posted) {
    for (const ln of d.lines || []) {
      const dq = Number(ln.dispatchQty) || 0;
      const pq = Number(ln.packedQty) || Number(ln.invoiceQty) || 0;
      if (pq > 0 && dq > pq + 1e-6) {
        overDispatch.push({ id: String(d._id), line: String(ln._id), article: ln.article });
      }
    }
  }

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidence = {
    capturedAt: new Date().toISOString(),
    phase: "P0.5B-pre-audit",
    statusCounts,
    totalDispatch,
    dispatchIndexes: indexes.map((i) => ({ name: i.name, key: i.key, unique: !!i.unique })),
    ledgerIndexes: ledgerIndexes.map((i) => ({
      name: i.name,
      key: i.key,
      unique: !!i.unique,
      partial: i.partialFilterExpression || null,
    })),
    ledgerCounts: { dispatchOut, dispatchCancel, dispatchOutWithSource, withEffectKey },
    exposure: {
      postedWithoutLedger: postedWithoutLedger.length,
      ledgerWithoutDispatch: ledgerWithoutDispatch.length,
      softDuplicateGroups: softDups.length,
      effectKeyDuplicateGroups: effectKeyDups.length,
      cancelledNoReversal: cancelledNoReversal.length,
      multiReversalPerOriginal: multiRev.length,
      intermediateStatuses: intermediate,
      siDispatchedWithoutDispatch: siWithoutDispatch.length,
      missingPackingOrInvoice: missingRefs.length,
      overDispatchLinesVsLinePacked: overDispatch.length,
    },
    samples: {
      postedWithoutLedger: postedWithoutLedger.slice(0, 10),
      ledgerWithoutDispatch: ledgerWithoutDispatch.slice(0, 10),
      softDups: softDups.slice(0, 5).map((g) => ({
        key: g._id,
        n: g.n,
        ids: (g.ids || []).slice(0, 3).map(String),
      })),
      cancelledNoReversal: cancelledNoReversal.slice(0, 10),
      siWithoutDispatch: siWithoutDispatch.slice(0, 10),
      missingRefs: missingRefs.slice(0, 10),
      overDispatch: overDispatch.slice(0, 10),
    },
  };
  const p = path.join(evidenceDir, `p05b-dispatch-pre-audit-${stamp}.json`);
  fs.writeFileSync(p, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ evidencePath: p, statusCounts, exposure: evidence.exposure, ledgerCounts: evidence.ledgerCounts }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
