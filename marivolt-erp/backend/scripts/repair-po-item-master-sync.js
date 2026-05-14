import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import Company from "../src/models/Company.js";
import PurchaseOrder from "../src/models/PurchaseOrder.js";
import { syncPoLinesToItemMaster } from "../src/services/poItemMasterSyncService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, "../../.env") });
}

function addSummary(target, source) {
  for (const key of ["scanned", "created", "updated", "unchanged", "skipped"]) {
    target[key] += Number(source?.[key] || 0);
  }
}

function companyLabel(company, companyId) {
  const name = String(company?.name || "").trim();
  const code = String(company?.code || "").trim();
  if (name && code) return `${name} (${code})`;
  return name || code || String(companyId);
}

async function main() {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI missing in .env");
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected. Repairing PO -> Item Master sync company-wise...");

  const [companies, poCompanyIds] = await Promise.all([
    Company.find({}).sort({ name: 1 }).lean(),
    PurchaseOrder.distinct("companyId"),
  ]);
  const companiesById = new Map(companies.map((row) => [String(row._id), row]));
  const companyIds = [...new Set(poCompanyIds.map((id) => String(id)).filter(Boolean))];

  const grand = { companies: 0, purchaseOrders: 0, scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (const companyIdRaw of companyIds) {
    const company = companiesById.get(companyIdRaw) || null;
    const companyId = mongoose.Types.ObjectId.isValid(companyIdRaw)
      ? new mongoose.Types.ObjectId(companyIdRaw)
      : companyIdRaw;
    const pos = await PurchaseOrder.find({ companyId }).sort({ orderDate: 1, createdAt: 1 }).lean();
    const subtotal = { scanned: 0, created: 0, updated: 0, unchanged: 0, skipped: 0 };

    for (const po of pos) {
      const result = await syncPoLinesToItemMaster({
        companyId: po.companyId,
        companyCode: company?.code || "",
        poNo: po.poNo || po.poNumber || "",
        supplierName: po.supplierName || "",
        header: po,
        lines: po.lines || [],
      });
      addSummary(subtotal, result);
    }

    grand.companies += 1;
    grand.purchaseOrders += pos.length;
    addSummary(grand, subtotal);
    console.log(
      `${companyLabel(company, companyIdRaw)}: POs=${pos.length}, lines=${subtotal.scanned}, created=${subtotal.created}, updated=${subtotal.updated}, unchanged=${subtotal.unchanged}, skipped=${subtotal.skipped}`
    );
  }

  console.log("Repair summary:");
  console.log(`Companies: ${grand.companies}`);
  console.log(`Purchase orders scanned: ${grand.purchaseOrders}`);
  console.log(`PO lines scanned: ${grand.scanned}`);
  console.log(`Item Master records created: ${grand.created}`);
  console.log(`Item Master records filled: ${grand.updated}`);
  console.log(`Existing complete/unchanged lines: ${grand.unchanged}`);
  console.log(`Skipped lines without identifiers: ${grand.skipped}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore disconnect errors */
  }
  process.exit(1);
});
