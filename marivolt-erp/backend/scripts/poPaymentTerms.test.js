/**
 * PO payment terms resolution (no DB).
 * Run: node scripts/poPaymentTerms.test.js
 */
import assert from "assert";
import {
  DEFAULT_COMMERCIAL,
  resolvePoPaymentFields,
} from "../src/constants/purchaseOrderDefaults.js";

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  passed += 1;
  console.log("✓", name);
}

ok(
  "empty body + supplier → supplier terms",
  resolvePoPaymentFields({}, "Net 30").payment === "Net 30" &&
    resolvePoPaymentFields({}, "Net 30").paymentTerms === "Net 30"
);

ok(
  "explicit paymentTerms wins over supplier",
  resolvePoPaymentFields({ paymentTerms: "50% advance" }, "Net 30").payment === "50% advance"
);

ok(
  "non-default payment wins over supplier",
  resolvePoPaymentFields({ payment: "LC at sight" }, "Net 30").payment === "LC at sight"
);

ok(
  "commercial default alone + supplier → supplier (auto-fill)",
  resolvePoPaymentFields({ payment: DEFAULT_COMMERCIAL.payment }, "Net 45").payment === "Net 45"
);

ok(
  "commercial default sent as paymentTerms (user chose default) wins",
  resolvePoPaymentFields(
    { payment: DEFAULT_COMMERCIAL.payment, paymentTerms: DEFAULT_COMMERCIAL.payment },
    "Net 45"
  ).payment === DEFAULT_COMMERCIAL.payment
);

ok(
  "empty everything → commercial default",
  resolvePoPaymentFields({}, "").payment === DEFAULT_COMMERCIAL.payment
);

ok(
  "payment and paymentTerms always synced",
  (() => {
    const r = resolvePoPaymentFields({ paymentTerms: "COD" }, "Net 30");
    return r.payment === r.paymentTerms && r.payment === "COD";
  })()
);

console.log(`\n${passed} checks passed`);
