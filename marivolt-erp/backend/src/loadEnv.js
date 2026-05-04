/**
 * Must be imported before any other local module that reads process.env (e.g. S3 config).
 * ESM hoists imports, so this file should be the first side-effect import in server.js.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// backend/src -> ../.env = backend/.env (primary)
dotenv.config({ path: path.resolve(__dirname, "../.env") });
// marivolt-erp/.env — only fills vars not already set (dotenv default override = false)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
