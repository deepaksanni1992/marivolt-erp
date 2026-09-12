/**
 * Dry-run helper to register Deepak Laptop Zebra incoming 100x50 printer against the live Deepak agent.
 *
 * Does NOT mutate production unless --apply is passed.
 * Does NOT change STORE printers, company default, warehouse default, media, or purposes —
 * not even to empty/zero values.
 *
 * Discover the live Deepak agent first — do not guess historical IDs:
 *   1. On DEEPAK LAPTOP: Get-Content C:\ProgramData\MarivoltPrintAgent\config.json
 *      (read agentId). Or ERP Label Settings → agents, computer name.
 *   2. Confirm Rongta mapping for that agent (do not rename Windows queues).
 *
 * Rollback (do NOT clear Zebra supportedPurposes — empty means unrestricted):
 *   1. Deactivate ZEBRA-DEEPAK-GRN explicitly (isActive: false).
 *   2. Restoring an unrestricted Deepak Rongta profile does not change the physical
 *      roll. Incoming 100x50 printing would require reloading matching stock.
 *   3. Do not change STORE defaults.
 *   4. Restore previous agent source and restart the service only if the operator
 *      asked to roll back the agent. Existing jobs keep their frozen destination.
 *
 * Usage:
 *   node scripts/registerDeepakZebraPrinter.mjs
 *   node scripts/registerDeepakZebraPrinter.mjs --agent-id AGTXXXXXXXX
 *   node scripts/registerDeepakZebraPrinter.mjs --agent-id AGTXXXXXXXX --apply
 */
import "../src/loadEnv.js";
import mongoose from "mongoose";
import PrinterConfig from "../src/models/PrinterConfig.js";
import PrintAgent from "../src/models/PrintAgent.js";

const MAR = "69e9f1791bcc5763ef869447";
const CODE = "ZEBRA-DEEPAK-GRN";
const DISPLAY = "Deepak Laptop Zebra GRN 100x50";
const WINDOWS_QUEUE = "ZDesigner ZD220-203dpi ZPL";
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const agentArg = argv.find((a) => a.startsWith("--agent-id="));
const AGENT_ID = String(agentArg ? agentArg.slice("--agent-id=".length) : "")
  .trim()
  .toUpperCase();

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (!process.env.MONGODB_URI && !process.env.MONGO_URI) {
  fail("Mongo URI not set. This script is for an operator with production credentials; default is DRY-RUN.");
}

await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI, { maxPoolSize: 2 });
const companyId = new mongoose.Types.ObjectId(MAR);

const agents = await PrintAgent.find({ companyId, isActive: true })
  .select("agentId name computerName appVersion status lastHeartbeatAt availablePrinters")
  .lean();

console.log("Active agents (discover Deepak; do not guess):");
for (const a of agents) {
  console.log(
    `  ${a.agentId}  computer=${a.computerName || "—"}  name=${a.name || "—"}  ver=${a.appVersion || "—"}  status=${a.status}  printers=${(a.availablePrinters || []).join(" | ")}`
  );
}

const printers = await PrinterConfig.find({ companyId, isActive: true })
  .select("code displayName agentId windowsPrinterName language widthMm heightMm supportedPurposes isDefault isWarehouseDefault")
  .lean();
console.log("\nActive printers:");
for (const p of printers) {
  console.log(
    `  ${p.code}  agent=${p.agentId}  queue="${p.windowsPrinterName}"  lang=${p.language || "TSPL"}  media=${p.widthMm || 0}x${p.heightMm || 0}  default=${p.isDefault}  whDefault=${p.isWarehouseDefault}  purposes=${(p.supportedPurposes || []).join(",") || "(all)"}`
  );
}

if (!AGENT_ID) {
  console.log("\nDRY-RUN only: pass --agent-id=AGT… after confirming the live Deepak agentId from config.json / ERP.");
  console.log("No documents were written.");
  await mongoose.disconnect();
  process.exit(0);
}

const agent = await PrintAgent.findOne({ companyId, agentId: AGENT_ID, isActive: true }).lean();
if (!agent) {
  await mongoose.disconnect();
  fail(`Agent ${AGENT_ID} not found for MAR company. Refusing to guess.`);
}

const listed = (agent.availablePrinters || []).some(
  (n) => String(n).toLowerCase() === WINDOWS_QUEUE.toLowerCase()
);
const existingZebra = await PrinterConfig.findOne({ companyId, code: CODE }).lean();
const existingRongta = printers.filter((p) => p.agentId === AGENT_ID && p.code !== CODE);

const planned = {
  companyId: String(companyId),
  code: CODE,
  displayName: DISPLAY,
  printerModel: "Zebra ZD220T",
  agentId: AGENT_ID,
  windowsPrinterName: WINDOWS_QUEUE,
  language: "ZPL",
  dpi: 203,
  widthMm: 100,
  heightMm: 50,
  supportedPurposes: ["GRN", "GRN_PREPOST", "STOCK", "MANUAL", "TEST", "ASN"],
  isDefault: false,
  isWarehouseDefault: false,
  connectionKind: "USB",
  remarks: listed
    ? "Zebra queue reported by agent heartbeat"
    : "Zebra queue not yet in agent availablePrinters — confirm USB + service account can see the queue",
};

console.log("\nPlanned Zebra profile (STORE defaults unchanged):");
console.log(JSON.stringify(planned, null, 2));
console.log("\nPreserve Deepak Rongta record(s):");
console.log(JSON.stringify(existingRongta, null, 2));
if (existingZebra) {
  console.log("\nExisting ZEBRA-DEEPAK-GRN will be updated in place:");
  console.log(JSON.stringify(existingZebra, null, 2));
}

if (!APPLY) {
  console.log("\nDRY-RUN. Re-run with --apply to upsert. Rongta queues are not renamed or deleted.");
  await mongoose.disconnect();
  process.exit(0);
}

const { upsertPrinter } = await import("../src/services/label/printerManager.js");
const result = await upsertPrinter(companyId, planned, "registerDeepakZebraPrinter");
console.log(`\nApplied. created=${result.created} code=${result.printer.code} agent=${result.printer.agentId}`);
console.log("Did not change isDefault / STORE printers.");
await mongoose.disconnect();
