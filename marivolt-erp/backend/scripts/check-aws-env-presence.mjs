/**
 * One-off: prints set | EMPTY_OR_MISSING for each AWS_* key (never prints values).
 * Run: node scripts/check-aws-env-presence.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");
if (!fs.existsSync(envPath)) {
  console.log("NO_ENV_FILE");
  process.exit(1);
}
let raw = fs.readFileSync(envPath, "utf8");
if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
const parsed = dotenv.parse(raw);
function val(k) {
  let v = String(parsed[k] ?? "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  return v;
}
const keys = ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_S3_BUCKET"];
for (const k of keys) {
  const v = val(k);
  console.log(`${k}:${v ? "set" : "EMPTY_OR_MISSING"}`);
}
