/**
 * Readonly MAR vs OKE label-printing configuration audit.
 * Does not modify any data.
 *
 * Usage: node scripts/auditLabelPrintingMarVsOke.readonly.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import mongoose from "mongoose";
import Company from "../src/models/Company.js";
import PrintAgent from "../src/models/PrintAgent.js";
import PrinterConfig from "../src/models/PrinterConfig.js";
import LabelTemplate from "../src/models/LabelTemplate.js";
import LabelPrintJob from "../src/models/LabelPrintJob.js";
import Warehouse from "../src/models/Warehouse.js";
import { getLabelSettings } from "../src/services/label/labelSettingsService.js";
import { isAgentOnline } from "../src/services/label/labelRoutingHelpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

function summarizeAgent(a) {
  const online = isAgentOnline(a);
  return {
    agentId: a.agentId,
    name: a.name,
    computerName: a.computerName,
    warehouseCode: a.warehouseCode,
    isActive: a.isActive,
    status: a.status,
    effectiveOnline: online,
    lastHeartbeatAt: a.lastHeartbeatAt,
    availablePrinters: a.availablePrinters || [],
    installationId: a.installationId ? `${String(a.installationId).slice(0, 8)}…` : "",
    hasSecretHash: Boolean(a.secretHash),
  };
}

function summarizePrinter(p) {
  return {
    code: p.code,
    displayName: p.displayName,
    agentId: p.agentId,
    windowsPrinterName: p.windowsPrinterName,
    warehouseCode: p.warehouseCode,
    isActive: p.isActive,
    isDefault: p.isDefault,
    isWarehouseDefault: p.isWarehouseDefault,
    connectionKind: p.connectionKind,
    printerModel: p.printerModel || "",
  };
}

async function auditCompany(code, company) {
  const settings = await getLabelSettings(company._id);
  const agents = await PrintAgent.find({ companyId: company._id }).sort({ updatedAt: -1 }).lean();
  const printers = await PrinterConfig.find({ companyId: company._id }).sort({ code: 1 }).lean();
  const warehouses = await Warehouse.find({ companyId: company._id }).select("code name isActive").lean();
  const recentJobs = await LabelPrintJob.find({ companyId: company._id })
    .sort({ createdAt: -1 })
    .limit(5)
    .select("jobNo status agentId templateCode sourceNo createdAt warehouseCode")
    .lean();
  const onlineAgents = agents.filter((a) => a.isActive && isAgentOnline(a));
  const activePrinters = printers.filter((p) => p.isActive);
  const companyDefault = activePrinters.find((p) => p.isDefault) || null;
  const mainWhDefault = activePrinters.find((p) => p.isWarehouseDefault && p.warehouseCode === "MAIN") || null;

  return {
    code,
    companyId: String(company._id),
    companyName: company.name,
    settings: {
      enabled: settings.enabled,
      defaultPrinterCode: settings.defaultPrinterCode,
      autoPrintAfterGrn: settings.autoPrintAfterGrn,
      allowManualReprint: settings.allowManualReprint,
      maxPerJob: settings.maxPerJob,
      defaultCopies: settings.defaultCopies,
      hasAgentBootstrapToken: settings.hasAgentBootstrapToken,
      agentBootstrapEnabled: settings.agentBootstrapEnabled,
      agentBootstrapWarehouse: settings.agentBootstrapWarehouse,
      agentBootstrapExpiresAt: settings.agentBootstrapExpiresAt,
      agentBootstrapMaxUses: settings.agentBootstrapMaxUses,
      agentBootstrapUseCount: settings.agentBootstrapUseCount,
    },
    warehouses: warehouses.map((w) => ({ code: w.code, name: w.name, isActive: w.isActive })),
    agentCount: agents.length,
    agents: agents.map(summarizeAgent),
    onlineAgentIds: onlineAgents.map((a) => a.agentId),
    printerCount: printers.length,
    printers: printers.map(summarizePrinter),
    companyDefaultPrinter: companyDefault ? summarizePrinter(companyDefault) : null,
    mainWarehouseDefaultPrinter: mainWhDefault ? summarizePrinter(mainWhDefault) : null,
    recentJobs,
  };
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGO_URI missing");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const mar = await Company.findOne({ code: /^MAR$/i }).lean();
  const oke = await Company.findOne({ code: /^OKE$/i }).lean();
  if (!mar) throw new Error("Company MAR not found");
  if (!oke) throw new Error("Company OKE not found");

  const templates = await LabelTemplate.find({}).select("code name companyId isSystem isActive widthMm heightMm").lean();

  const marAudit = await auditCompany("MAR", mar);
  const okeAudit = await auditCompany("OKE", oke);

  const settingKeys = [
    "enabled",
    "defaultPrinterCode",
    "autoPrintAfterGrn",
    "allowManualReprint",
    "maxPerJob",
    "defaultCopies",
    "hasAgentBootstrapToken",
    "agentBootstrapEnabled",
    "agentBootstrapWarehouse",
  ];

  const comparison = settingKeys.map((k) => ({
    setting: k,
    MAR: marAudit.settings[k],
    OKE: okeAudit.settings[k],
    action:
      marAudit.settings[k] === okeAudit.settings[k]
        ? "OK (same)"
        : k === "hasAgentBootstrapToken" || k === "agentBootstrapEnabled"
          ? "OKE needs its own bootstrap token (do not copy MAR secret)"
          : k === "defaultPrinterCode"
            ? "OKE needs its own printer code after OKE PrinterConfig exists"
            : "Mirror operational value to OKE if safe",
  }));

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "READONLY",
    templates,
    comparison,
    MAR: marAudit,
    OKE: okeAudit,
    architectureNotes: {
      printAgentCompanyScoped: true,
      agentIdGloballyUnique: true,
      sharingOneAgentIdentityUnsafe: true,
      preferredPath: "Option B: separate OKE PrintAgent identity; same physical PC/printer via second agent config dir (MARIVOLT_AGENT_DIR)",
      labelEnabledCausesUiDisable: "LABEL_ENABLED / settings.enabled",
      brandingHardcodedToday: "MARIVOLT FZE in labelService + tsplGenerator default",
    },
  };

  console.log(JSON.stringify(report, null, 2));
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
