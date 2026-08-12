/**
 * Mirror safe MAR → OKE label-printing operational settings.
 * Does NOT clone PrintAgent, secrets, installationId, or PrinterConfig.
 *
 * Dry-run (default):
 *   node scripts/setupOkeLabelPrintingFromMar.mjs
 *
 * Apply:
 *   node scripts/setupOkeLabelPrintingFromMar.mjs --apply
 *
 * Optional: also set a fresh OKE bootstrap token (printed once to stdout):
 *   node scripts/setupOkeLabelPrintingFromMar.mjs --apply --with-bootstrap
 */
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import PrintAgent from "../src/models/PrintAgent.js";
import PrinterConfig from "../src/models/PrinterConfig.js";
import { getLabelSettings, upsertLabelSettings } from "../src/services/label/labelSettingsService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const APPLY = process.argv.includes("--apply");
const WITH_BOOTSTRAP = process.argv.includes("--with-bootstrap");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI missing");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const mar = await Company.findOne({ code: /^MAR$/i }).lean();
  const oke = await Company.findOne({ code: /^OKE$/i }).lean();
  if (!mar || !oke) throw new Error("MAR and/or OKE company not found");

  const marSettings = await getLabelSettings(mar._id);
  const okeBefore = await getLabelSettings(oke._id);
  const okeAgents = await PrintAgent.countDocuments({ companyId: oke._id });
  const okePrinters = await PrinterConfig.countDocuments({ companyId: oke._id });

  const patch = {
    enabled: true,
    autoPrintAfterGrn: Boolean(marSettings.autoPrintAfterGrn),
    allowManualReprint: marSettings.allowManualReprint !== false,
    maxPerJob: Math.max(1, Number(marSettings.maxPerJob) || 200),
    defaultCopies: Math.max(1, Number(marSettings.defaultCopies) || 1),
    // Keep empty until an OKE PrinterConfig exists — never copy MAR printer code blindly.
    defaultPrinterCode: "",
    agentBootstrapWarehouse: "MAIN",
  };

  let bootstrapPlain = "";
  if (WITH_BOOTSTRAP) {
    bootstrapPlain = crypto.randomBytes(18).toString("base64url");
    patch.agentBootstrapToken = bootstrapPlain;
    patch.agentBootstrapEnabled = true;
    patch.agentBootstrapMaxUses = 5;
    patch.agentBootstrapExpiresAt = "";
  }

  const report = {
    mode: APPLY ? "APPLY" : "DRY_RUN",
    withBootstrap: WITH_BOOTSTRAP,
    marCompanyId: String(mar._id),
    okeCompanyId: String(oke._id),
    okeAgentCount: okeAgents,
    okePrinterCount: okePrinters,
    before: okeBefore,
    plannedPatch: {
      ...patch,
      agentBootstrapToken: WITH_BOOTSTRAP ? "(new token generated — shown once below)" : undefined,
    },
    notes: [
      "PrintAgent rows are NOT copied (agentId is globally unique; secrets must not be shared).",
      "PrinterConfig rows are NOT auto-created — register an OKE agent first, then map MAIN → Rongta.",
      "Same physical PC/printer is supported via Option B: second agent identity + MARIVOLT_AGENT_DIR.",
      "Layout template MARIVOLT_STANDARD remains shared; printed branding is company-aware in code.",
    ],
    deferredUntilAgentRegistered: okeAgents === 0,
  };

  if (!APPLY) {
    console.log(JSON.stringify(report, null, 2));
    console.log("\nDry-run only. Re-run with --apply to write OKE settings.");
    await mongoose.disconnect();
    return;
  }

  const after = await upsertLabelSettings(oke._id, patch, "setupOkeLabelPrintingFromMar");
  report.after = after;
  console.log(JSON.stringify(report, null, 2));
  if (bootstrapPlain) {
    console.log("\n=== OKE bootstrap token (store securely; shown once) ===");
    console.log(bootstrapPlain);
    console.log("=== end token ===\n");
  }
  console.log(
    okeAgents === 0
      ? "OKE settings applied. Still need: register OKE PrintAgent + PrinterConfig before jobs will print."
      : "OKE settings applied. Verify PrinterConfig routing for MAIN."
  );
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
