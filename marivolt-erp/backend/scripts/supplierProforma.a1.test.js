/**
 * A0/A1 — Supplier Proforma workflow tests.
 * Run: node scripts/supplierProforma.a1.test.js
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTO_DRAFT_PI_PURCHASE_DOC_TYPES,
  NEVER_DRAFT_PI_PURCHASE_DOC_TYPES,
  createDraftPurchaseInvoiceFromPurchaseDocument,
} from "../src/services/purchaseInvoiceDraftFromDocumentService.js";
import {
  SUPPLIER_PROFORMA_ADVANCE_EXCEEDS_TOTAL,
  SUPPLIER_PROFORMA_DUPLICATE,
  SUPPLIER_PROFORMA_NOT_EDITABLE,
  SUPPLIER_PROFORMA_PROTECTED_FIELD,
  assertAdvanceWithinTotal,
  assertEditableStatus,
  normalizeSupplierProformaNo,
  rejectProtectedFields,
  resolveAdvanceAmounts,
  SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX,
} from "../src/utils/supplierProforma.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "..", "src");
const frontRoot = path.join(__dirname, "..", "..", "src");

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

console.log("\nSupplier Proforma (A0/A1)\n");

await run("1. SUPPLIER_PROFORMA not in AUTO_DRAFT set", () => {
  assert.equal(AUTO_DRAFT_PI_PURCHASE_DOC_TYPES.has("SUPPLIER_PROFORMA"), false);
  assert.equal(NEVER_DRAFT_PI_PURCHASE_DOC_TYPES.has("SUPPLIER_PROFORMA"), true);
});

await run("2. SUPPLIER_TAX_INVOICE remains auto-draft eligible", () => {
  assert.equal(AUTO_DRAFT_PI_PURCHASE_DOC_TYPES.has("SUPPLIER_TAX_INVOICE"), true);
});

await run("3. COMMERCIAL_INVOICE behaviour unchanged (still auto-draft; flagged for review)", () => {
  assert.equal(AUTO_DRAFT_PI_PURCHASE_DOC_TYPES.has("COMMERCIAL_INVOICE"), true);
  const svc = fs.readFileSync(
    path.join(srcRoot, "services/purchaseInvoiceDraftFromDocumentService.js"),
    "utf8"
  );
  assert.match(svc, /Flagged for business review/);
  assert.match(svc, /COMMERCIAL_INVOICE/);
});

await run("createDraft rejects SUPPLIER_PROFORMA even without restrictAutoTypes", async () => {
  const r = await createDraftPurchaseInvoiceFromPurchaseDocument({
    companyId: "000000000000000000000001",
    companyCode: "TST",
    userEmail: "t@test",
    purchaseDocument: {
      linkedPoId: "000000000000000000000002",
      documentType: "SUPPLIER_PROFORMA",
      documentNo: "SPF-1",
    },
    restrictAutoTypes: false,
  });
  assert.equal(r.created, false);
  assert.equal(r.skippedReason, "SUPPLIER_PROFORMA_NOT_INVOICE");
});

await run("4-6. Normalize / advance resolve / caps", () => {
  assert.equal(normalizeSupplierProformaNo("  ab  12 "), "AB 12");
  const a = resolveAdvanceAmounts({ totalValue: 1000, requestedAdvancePercent: 30, requestedAdvanceAmount: 0 });
  assert.equal(a.requestedAdvanceAmount, 300);
  assert.throws(
    () => assertAdvanceWithinTotal({ totalValue: 100, requestedAdvanceAmount: 150 }),
    (e) => e.code === SUPPLIER_PROFORMA_ADVANCE_EXCEEDS_TOTAL
  );
  const p = resolveAdvanceAmounts({ totalValue: 200, requestedAdvanceAmount: 50, requestedAdvancePercent: 0 });
  assert.ok(p.requestedAdvancePercent > 0 && p.requestedAdvancePercent <= 100);
});

await run("9-10. Editable statuses + protected fields", () => {
  assertEditableStatus("DRAFT");
  assertEditableStatus("RECEIVED");
  assert.throws(() => assertEditableStatus("APPROVED"), (e) => e.code === SUPPLIER_PROFORMA_NOT_EDITABLE);
  assert.throws(() => rejectProtectedFields({ companyId: "x" }), (e) => e.code === SUPPLIER_PROFORMA_PROTECTED_FIELD);
  assert.throws(() => rejectProtectedFields({ paymentStatus: "PAID" }), (e) => e.code === SUPPLIER_PROFORMA_PROTECTED_FIELD);
  assert.throws(() => rejectProtectedFields({ documentStatus: "APPROVED" }), (e) => e.code === SUPPLIER_PROFORMA_PROTECTED_FIELD);
});

await run("11-14. Controller transitions and routes exist", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers/supplierProformaController.js"), "utf8");
  assert.match(ctrl, /receiveSupplierProforma/);
  assert.match(ctrl, /approveSupplierProforma/);
  assert.match(ctrl, /cancelSupplierProforma/);
  assert.match(ctrl, /SUPPLIER_PROFORMA_INVALID_TRANSITION|documentStatus !== "DRAFT"/);
  assert.match(ctrl, /assertOneApprovedPerPo/);
  assert.match(ctrl, /supplierProformaHasAdvanceDependency/);
  const routes = fs.readFileSync(path.join(srcRoot, "routes/supplierProformaRoutes.js"), "utf8");
  assert.match(routes, /\/:id\/receive/);
  assert.match(routes, /\/:id\/approve/);
  assert.match(routes, /\/:id\/cancel/);
  const poRoutes = fs.readFileSync(path.join(srcRoot, "routes/purchaseRoutes.js"), "utf8");
  assert.match(poRoutes, /supplier-proformas/);
});

await run("17-20. No stock/AP/ledger/GRN mutation from SupplierProforma module", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers/supplierProformaController.js"), "utf8");
  assert.ok(!ctrl.includes("stockService"));
  assert.ok(!ctrl.includes("StockLedger"));
  assert.ok(!/\bSupplierLedger\b/.test(ctrl));
  assert.ok(!ctrl.includes("packFromAllocation"));
  const model = fs.readFileSync(path.join(srcRoot, "models/SupplierProforma.js"), "utf8");
  assert.ok(!/qtyIn|qtyOut|stockQty/.test(model));
  const poDoc = fs.readFileSync(path.join(srcRoot, "controllers/purchasePoDocumentController.js"), "utf8");
  assert.match(poDoc, /No Purchase Invoice or AP liability has been created/);
  assert.match(poDoc, /ensureSupplierProformaFromPurchaseDocument/);
});

await run("21-22. PurchaseDocument link + idempotent ensure helper", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers/supplierProformaController.js"), "utf8");
  assert.match(ctrl, /purchaseDocumentId/);
  assert.match(ctrl, /ensureSupplierProformaFromPurchaseDocument/);
  assert.match(ctrl, /if \(existing\) return \{ created: false/);
});

await run("23. Legacy audit script is read-only (no update/delete)", () => {
  const audit = fs.readFileSync(path.join(__dirname, "audit-supplier-proforma-legacy-a1.mjs"), "utf8");
  assert.ok(!/\.updateOne\(|\.deleteOne\(|\.findOneAndUpdate\(/.test(audit));
  assert.match(audit, /postedFromProformaHighRiskManualReview|POSTED/);
});

await run("Duplicate index migration is controlled dry-run", () => {
  const mig = fs.readFileSync(path.join(__dirname, "migrate-supplier-proforma-unique-index-a1.mjs"), "utf8");
  assert.match(mig, /--execute/);
  assert.match(mig, /DRY RUN|DRY_RUN/);
  assert.equal(SUPPLIER_PROFORMA_ACTIVE_UNIQUE_INDEX.unique, true);
  assert.ok(!fs.readFileSync(path.join(srcRoot, "models/SupplierProforma.js"), "utf8").includes("uniq_active_supplier_proforma"));
});

await run("Frontend: no Apply Advance / no PI label as proforma", () => {
  const ui = fs.readFileSync(path.join(frontRoot, "components/purchase/SupplierProformaPanel.jsx"), "utf8");
  assert.match(ui, /does not create AP liability/i);
  assert.ok(!/Apply Advance/i.test(ui));
  assert.ok(!/Post Purchase Invoice/i.test(ui));
});

await run("Upload modal does not auto-create PI for SUPPLIER_PROFORMA", () => {
  const modal = fs.readFileSync(path.join(frontRoot, "components/purchase/PoSupplierDocUploadModal.jsx"), "utf8");
  assert.match(modal, /SUPPLIER_PROFORMA/);
  assert.match(modal, /isProforma/);
  assert.match(modal, /does not create/i);
});

await run("30. RTS remains absent", () => {
  const ctrl = fs.readFileSync(path.join(srcRoot, "controllers/supplierProformaController.js"), "utf8");
  assert.ok(!/RTS|readyToShip/i.test(ctrl));
});

await run("PO document create skips auto-draft for proforma", () => {
  const poDoc = fs.readFileSync(path.join(srcRoot, "controllers/purchasePoDocumentController.js"), "utf8");
  assert.match(poDoc, /purchaseInvoiceId:\s*null/);
  assert.match(poDoc, /ensureSupplierProformaFromPurchaseDocument/);
  const createFn = poDoc.indexOf("export async function createPoDocument");
  const slice = poDoc.slice(createFn, createFn + 4500);
  assert.match(slice, /SUPPLIER_PROFORMA/);
  assert.match(slice, /No Purchase Invoice or AP liability has been created/);
  assert.ok(!/AUTO_DRAFT_PI_PURCHASE_DOC_TYPES\.has\(documentType\)[\s\S]{0,80}SUPPLIER_PROFORMA/.test(slice));
});

await run("Duplicate constant exported", () => {
  assert.equal(SUPPLIER_PROFORMA_DUPLICATE, "SUPPLIER_PROFORMA_DUPLICATE");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
