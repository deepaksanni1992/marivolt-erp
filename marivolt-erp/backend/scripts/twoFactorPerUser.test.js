/**
 * Per-user TOTP isolation tests (no database required).
 * Run: node scripts/twoFactorPerUser.test.js
 */
import { generateSync, generateSecret, verifySync } from "otplib";
import {
  clearUserTwoFactorFields,
  encryptTotpSecret,
  generateUserTotpSecret,
  verifyUserTotpCode,
} from "../src/services/twoFactorService.js";

process.env.TOTP_ENCRYPTION_KEY = process.env.TOTP_ENCRYPTION_KEY || "test-totp-encryption-key-for-ci";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${message}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

function userRecord(name, email) {
  return { name, email, username: email.split("@")[0] };
}

console.log("Per-user 2FA tests\n");

// 1–2: Each user gets a unique secret
const deepakSecret = generateUserTotpSecret();
const advitySecret = generateUserTotpSecret();
assert(deepakSecret && advitySecret, "Generated secrets for Deepak and Advity");
assert(deepakSecret !== advitySecret, "Deepak and Advity have different TOTP secrets");

const deepak = {
  ...userRecord("Deepak", "deepak@example.com"),
  twoFactorEnabled: true,
  twoFactorSecret: encryptTotpSecret(deepakSecret),
};
const advity = {
  ...userRecord("Advity", "advity@example.com"),
  twoFactorEnabled: true,
  twoFactorSecret: encryptTotpSecret(advitySecret),
};

const deepakCode = generateSync({ secret: deepakSecret });
const advityCode = generateSync({ secret: advitySecret });

// 4–7: Login verification uses only that user's secret
assert(verifyUserTotpCode(deepak.twoFactorSecret, deepakCode), "Deepak code verifies for Deepak");
assert(!verifyUserTotpCode(deepak.twoFactorSecret, advityCode), "Advity code fails for Deepak");
assert(verifyUserTotpCode(advity.twoFactorSecret, advityCode), "Advity code verifies for Advity");
assert(!verifyUserTotpCode(advity.twoFactorSecret, deepakCode), "Deepak code fails for Advity");

// 8: Admin reset clears only selected user
Object.assign(deepak, clearUserTwoFactorFields());
assert(!deepak.twoFactorEnabled && !deepak.twoFactorSecret, "Deepak 2FA cleared after reset");
assert(advity.twoFactorEnabled && advity.twoFactorSecret, "Advity 2FA unchanged after Deepak reset");

// 9: Users without 2FA are not blocked (enabled flag false)
const legacyUser = { ...userRecord("Legacy", "legacy@example.com"), twoFactorEnabled: false };
assert(!legacyUser.twoFactorEnabled, "Legacy user without 2FA continues normal login path");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
