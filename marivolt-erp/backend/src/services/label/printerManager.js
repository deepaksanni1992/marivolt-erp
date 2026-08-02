import PrinterConfig from "../../models/PrinterConfig.js";
import PrintAgent from "../../models/PrintAgent.js";
import { getLabelSettings } from "./labelSettingsService.js";

export async function listPrinters(companyId) {
  return PrinterConfig.find({ companyId, isActive: true }).sort({ code: 1 }).lean();
}

export async function upsertPrinter(companyId, body = {}, createdBy = "") {
  const code = String(body.code || "").trim().toUpperCase();
  if (!code) {
    const err = new Error("Printer code is required");
    err.statusCode = 400;
    throw err;
  }
  const agentId = String(body.agentId || "").trim().toUpperCase();
  const windowsPrinterName = String(body.windowsPrinterName || "").trim();
  if (!agentId || !windowsPrinterName) {
    const err = new Error("agentId and windowsPrinterName are required");
    err.statusCode = 400;
    throw err;
  }
  const agent = await PrintAgent.findOne({ companyId, agentId, isActive: true });
  if (!agent) {
    const err = new Error("Print agent not found for this company");
    err.statusCode = 404;
    throw err;
  }
  if (body.isDefault) {
    await PrinterConfig.updateMany({ companyId }, { $set: { isDefault: false } });
  }
  const doc = await PrinterConfig.findOneAndUpdate(
    { companyId, code },
    {
      $set: {
        displayName: String(body.displayName || code).trim(),
        warehouseId: body.warehouseId || agent.warehouseId || null,
        warehouseCode: String(body.warehouseCode || agent.warehouseCode || "").trim().toUpperCase(),
        agentId,
        windowsPrinterName,
        connectionType: body.connectionType === "TCP_9100" ? "TCP_9100" : "WINDOWS_SPOOLER",
        isDefault: Boolean(body.isDefault),
        isActive: body.isActive !== false,
        createdBy: String(createdBy || ""),
      },
      $setOnInsert: { companyId, code },
    },
    { upsert: true, new: true }
  );
  return doc;
}

export async function resolvePrinterForJob(companyId, printerCode) {
  const settings = await getLabelSettings(companyId);
  const code = String(printerCode || settings.defaultPrinterCode || "")
    .trim()
    .toUpperCase();
  let printer = null;
  if (code) {
    printer = await PrinterConfig.findOne({ companyId, code, isActive: true });
  }
  if (!printer) {
    printer = await PrinterConfig.findOne({ companyId, isDefault: true, isActive: true });
  }
  if (!printer) {
    printer = await PrinterConfig.findOne({ companyId, isActive: true }).sort({ createdAt: 1 });
  }
  if (!printer) {
    const err = new Error("No active printer configured. Register a print agent and printer first.");
    err.code = "LABEL_PRINTER_MISSING";
    err.statusCode = 400;
    throw err;
  }
  return printer;
}
