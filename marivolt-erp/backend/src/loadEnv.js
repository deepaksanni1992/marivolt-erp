/**
 * Must be imported before any other local module that reads process.env (e.g. S3 config).
 * ESM hoists imports, so this file should be the first side-effect import in server.js.
 *
 * Handles common Windows issues: UTF-8 BOM on .env, quoted values, and merge order so
 * marivolt-erp/backend/.env wins over marivolt-erp/.env for the same key.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripBom(s) {
  if (!s || typeof s !== "string") return s;
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * @param {string} filePath
 * @param {boolean} overwrite - if true, every key in this file sets process.env (even empty).
 *   if false, only set when process.env[key] is undefined or "".
 */
function applyEnvFile(filePath, overwrite) {
  if (!fs.existsSync(filePath)) return;
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  raw = stripBom(raw);
  let parsed;
  try {
    parsed = dotenv.parse(raw);
  } catch {
    return;
  }
  for (const [rawKey, value] of Object.entries(parsed)) {
    const key = String(rawKey).trim();
    if (!key || key.startsWith("#")) continue;
    const v = value === undefined ? "" : String(value);
    const cur = process.env[key];
    if (overwrite || cur === undefined || cur === "") {
      process.env[key] = v;
    }
  }
}

const backendEnv = path.resolve(__dirname, "../.env");
const parentEnv = path.resolve(__dirname, "../../.env");

// Backend .env is authoritative for keys it defines (including empty lines).
applyEnvFile(backendEnv, true);
// Parent (e.g. marivolt-erp/.env) only fills keys still missing / empty.
applyEnvFile(parentEnv, false);
