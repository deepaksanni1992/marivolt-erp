/**
 * A0/A1 — Read-only legacy audit for Supplier Proforma → PurchaseInvoice misuse.
 * Masks supplier names, amounts, and document numbers.
 *
 * Usage: node scripts/audit-supplier-proforma-legacy-a1.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) dotenv.config({ path: path.join(__dirname, "../../.env") });

function mask(s, keep = 2) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  if (t.length <= keep * 2) return "*".repeat(Math.min(4, t.length));
  return `${t.slice(0, keep)}…${t.slice(-keep)}`;
}

function maskAmount(n) {
  const v = Number(n) || 0;
  if (!(v > 0)) return 0;
  if (v < 100) return "<100";
  if (v < 1000) return "~100s";
  if (v < 10000) return "~1k";
  if (v < 100000) return "~10k";
  return "~100k+";
}

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeNo(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

async function main() {
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI missing");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;

  const purchaseDocs = db.collection("purchasedocuments");
  const invoices = db.collection("purchaseinvoices");
  const payments = db.collection("supplierpayments");
  const grns = db.collection("grns");
  const pos = db.collection("purchaseorders");
  const supplierProformas = db.collection("supplierproformas");

  const proformaDocs = await purchaseDocs
    .find({ documentType: "SUPPLIER_PROFORMA", status: { $ne: "VOID" } })
    .project({
      _id: 1,
      companyId: 1,
      linkedPoId: 1,
      supplierId: 1,
      documentNo: 1,
      amount: 1,
      currency: 1,
      documentId: 1,
      status: 1,
    })
    .toArray();

  const linkedToPo = proformaDocs.filter((d) => d.linkedPoId).length;

  const draftFromProforma = [];
  const postedFromProforma = [];
  const cancelledFromProforma = [];

  for (const d of proformaDocs) {
    const dno = String(d.documentNo || "").trim();
    if (!dno || !d.linkedPoId) continue;
    const matches = await invoices
      .find({
        companyId: d.companyId,
        linkedPoId: d.linkedPoId,
        supplierInvoiceNo: new RegExp(`^${escapeRegex(dno)}$`, "i"),
      })
      .project({ _id: 1, status: 1, invoiceNumber: 1, supplierInvoiceNo: 1, linkedPoNumber: 1, totalAmount: 1 })
      .toArray();
    for (const inv of matches) {
      const row = {
        purchaseDocumentId: String(d._id),
        invoiceId: String(inv._id),
        status: inv.status,
        invoiceNumberMasked: mask(inv.invoiceNumber),
        supplierInvoiceNoMasked: mask(inv.supplierInvoiceNo),
        poMasked: mask(inv.linkedPoNumber),
        amountBand: maskAmount(inv.totalAmount),
      };
      const st = String(inv.status || "").toUpperCase();
      if (st === "DRAFT") draftFromProforma.push(row);
      else if (st === "POSTED") postedFromProforma.push(row);
      else if (st === "CANCELLED") cancelledFromProforma.push(row);
    }
  }

  const advancePaidPos = await pos.countDocuments({ apPaymentStatus: "ADVANCE_PAID" });

  const poIdsWithProforma = [...new Set(proformaDocs.map((d) => String(d.linkedPoId || "")).filter(Boolean))];
  const poObjectIds = poIdsWithProforma
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const posWithProforma = await pos
    .find({ _id: { $in: poObjectIds } })
    .project({ _id: 1, poNo: 1, poNumber: 1, apPaymentStatus: 1, companyId: 1 })
    .toArray();

  let paymentsBeforeFinalPi = 0;
  let poWithAdvanceAndFinalPi = 0;
  for (const po of posWithProforma) {
    const poNos = [...new Set([po.poNo, po.poNumber].map((s) => String(s || "").trim()).filter(Boolean))];
    const postedPi = await invoices.countDocuments({
      companyId: po.companyId,
      linkedPoId: po._id,
      status: "POSTED",
    });
    const payCount =
      poNos.length === 0
        ? 0
        : await payments.countDocuments({
            companyId: po.companyId,
            linkedPoNo: { $in: poNos },
            status: { $ne: "CANCELLED" },
          });
    if (payCount > 0 && postedPi === 0) paymentsBeforeFinalPi += 1;
    if (payCount > 0 && postedPi > 0) poWithAdvanceAndFinalPi += 1;
  }

  const grnOnProformaPos = await grns.countDocuments({
    poId: { $in: poObjectIds },
    status: { $in: ["POSTED", "RECEIVED", "PARTIAL_RECEIVED", "CLOSED"] },
  });

  const dupGroups = await purchaseDocs
    .aggregate([
      {
        $match: {
          documentType: "SUPPLIER_PROFORMA",
          status: { $ne: "VOID" },
          documentNo: { $type: "string", $ne: "" },
        },
      },
      {
        $group: {
          _id: {
            companyId: "$companyId",
            supplierId: "$supplierId",
            norm: { $toUpper: { $trim: { input: "$documentNo" } } },
          },
          n: { $sum: 1 },
        },
      },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();

  let supplierProformaCount = 0;
  try {
    supplierProformaCount = await supplierProformas.estimatedDocumentCount();
  } catch {
    supplierProformaCount = 0;
  }

  const docsWithoutSupplierProforma =
    supplierProformaCount === 0
      ? proformaDocs.length
      : (
          await Promise.all(
            proformaDocs.map(async (d) => {
              const linked = await supplierProformas.countDocuments({ purchaseDocumentId: d._id });
              return linked === 0 ? 1 : 0;
            })
          )
        ).reduce((a, b) => a + b, 0);

  const report = {
    capturedAt: new Date().toISOString(),
    note: "Masked evidence — names/values/document numbers redacted",
    totals: {
      purchaseDocumentsSupplierProforma: proformaDocs.length,
      supplierProformaLinkedToPo: linkedToPo,
      draftPurchaseInvoicesFromProformaDocNo: draftFromProforma.length,
      postedPurchaseInvoicesFromProformaDocNo: postedFromProforma.length,
      cancelledPurchaseInvoicesFromProformaDocNo: cancelledFromProforma.length,
      poMarkedAdvancePaid: advancePaidPos,
      posWithPaymentBeforeFinalPi: paymentsBeforeFinalPi,
      posWithAdvancePaymentAndFinalPi: poWithAdvanceAndFinalPi,
      grnsOnProformaLinkedPos: grnOnProformaPos,
      duplicateProformaDocNoGroups: dupGroups.length,
      existingSupplierProformaCollectionCount: supplierProformaCount,
      proformaDocsWithoutSupplierProformaRecord: docsWithoutSupplierProforma,
    },
    samples: {
      draftFromProforma: draftFromProforma.slice(0, 20),
      postedFromProformaHighRiskManualReview: postedFromProforma.slice(0, 20),
      cancelledFromProforma: cancelledFromProforma.slice(0, 10),
      duplicateGroupsMasked: dupGroups.slice(0, 20).map((g) => ({
        companyId: mask(String(g._id.companyId)),
        supplierId: mask(String(g._id.supplierId || "")),
        normMasked: mask(g._id.norm, 1),
        n: g.n,
      })),
    },
    recommendations: {
      draft: "Review DRAFT PIs matched to SUPPLIER_PROFORMA documentNos — prefer cancel/delete draft or relink; do not auto-delete.",
      posted:
        "POSTED PIs matched to SUPPLIER_PROFORMA are high-risk manual review. Do not auto-cancel. Confirm whether they represent real final invoices.",
      commercialInvoice: "COMMERCIAL_INVOICE remains in AUTO_DRAFT_PI set pending business confirmation.",
    },
  };

  const evidenceDir = path.join(__dirname, "repair-evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(evidenceDir, `supplier-proforma-legacy-a1-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.totals, null, 2));
  console.log("Evidence:", outPath);
  if (postedFromProforma.length) {
    console.log("WARNING: POSTED PurchaseInvoices matched to SUPPLIER_PROFORMA — manual review required; not modified.");
  }
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
