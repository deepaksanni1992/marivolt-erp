import mongoose from "mongoose";
import PrinterConfig from "../../models/PrinterConfig.js";
import PrintAgent from "../../models/PrintAgent.js";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import { getLabelSettings } from "./labelSettingsService.js";
import { pickBestPrinter, isAgentOnline } from "./labelRoutingHelpers.js";

function upper(v) {
  return String(v || "").trim().toUpperCase();
}

function mapConnectionKind(body) {
  const kind = String(body.connectionKind || body.connection || "").trim().toUpperCase();
  if (kind === "NETWORK") return "NETWORK";
  if (kind === "WINDOWS_QUEUE" || kind === "WINDOWS") return "WINDOWS_QUEUE";
  if (kind === "USB") return "USB";
  if (body.connectionType === "TCP_9100") return "NETWORK";
  return "USB";
}

function missingPrinterError(reason) {
  const err = new Error(reason || "No active printer configured. Register a print agent and printer first.");
  err.code = "LABEL_PRINTER_MISSING";
  err.statusCode = 400;
  return err;
}

export async function listPrinters(companyId, { includeInactive = false } = {}) {
  const filter = { companyId };
  if (!includeInactive) filter.isActive = true;
  return PrinterConfig.find(filter).sort({ warehouseCode: 1, code: 1 }).lean();
}

export async function getPrinter(companyId, idOrCode) {
  const code = upper(idOrCode);
  let doc = null;
  if (String(idOrCode).match(/^[a-f0-9]{24}$/i)) {
    doc = await PrinterConfig.findOne({ _id: idOrCode, companyId }).lean();
  }
  if (!doc) {
    doc = await PrinterConfig.findOne({ companyId, code }).lean();
  }
  return doc;
}

async function loadAgentAndPendingMaps(companyId, printers) {
  const agentIds = [...new Set(printers.map((p) => upper(p.agentId)).filter(Boolean))];
  const agents = agentIds.length
    ? await PrintAgent.find({ companyId, agentId: { $in: agentIds } }).lean()
    : [];
  const agentMap = Object.fromEntries(agents.map((a) => [upper(a.agentId), a]));
  const ids = printers.map((p) => p._id).filter(Boolean);
  let pendingMap = {};
  if (ids.length) {
    const pending = await LabelPrintJob.aggregate([
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(String(companyId)),
          printerConfigId: { $in: ids },
          status: { $in: ["PENDING", "LEASED", "PRINTING"] },
        },
      },
      { $group: { _id: "$printerConfigId", count: { $sum: 1 } } },
    ]);
    pendingMap = Object.fromEntries(pending.map((r) => [String(r._id), r.count]));
  }
  return { agentMap, pendingMap };
}

function selectRoutable(printers, agentMap, pendingMap) {
  return pickBestPrinter(printers, agentMap, pendingMap);
}

/**
 * Clear prior defaults then set — race-safe via partial unique indexes + clear-first.
 */
export async function upsertPrinter(companyId, body = {}, createdBy = "") {
  const code = upper(body.code);
  if (!code) {
    const err = new Error("Printer code is required");
    err.statusCode = 400;
    throw err;
  }
  const agentId = upper(body.agentId);
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
  const warehouseCode = upper(body.warehouseCode || agent.warehouseCode);
  const wantCompanyDefault = Boolean(body.isDefault);
  const wantWarehouseDefault = Boolean(body.isWarehouseDefault);

  if (wantCompanyDefault) {
    await PrinterConfig.updateMany(
      { companyId, isDefault: true, code: { $ne: code } },
      { $set: { isDefault: false } }
    );
  }
  if (wantWarehouseDefault && warehouseCode) {
    await PrinterConfig.updateMany(
      { companyId, warehouseCode, isWarehouseDefault: true, code: { $ne: code } },
      { $set: { isWarehouseDefault: false } }
    );
  }

  const connectionKind = mapConnectionKind(body);
  const connectionType =
    body.connectionType === "TCP_9100"
      ? "TCP_9100"
      : "WINDOWS_SPOOLER";

  const existing = await PrinterConfig.findOne({ companyId, code }).lean();
  try {
    const doc = await PrinterConfig.findOneAndUpdate(
      { companyId, code },
      {
        $set: {
          displayName: String(body.displayName || body.printerName || code).trim().slice(0, 120),
          printerModel: String(body.printerModel || body.model || "").trim().slice(0, 80),
          branchId: body.branchId || agent.branchId || null,
          branchName: String(body.branchName || agent.branchName || "").trim().slice(0, 120),
          warehouseId: body.warehouseId || agent.warehouseId || null,
          warehouseCode,
          agentId,
          windowsPrinterName: windowsPrinterName.slice(0, 200),
          connectionKind,
          connectionType,
          isDefault: wantCompanyDefault,
          isWarehouseDefault: wantWarehouseDefault,
          isActive: body.isActive !== false,
          remarks: String(body.remarks || "").trim().slice(0, 500),
          createdBy: String(createdBy || existing?.createdBy || ""),
        },
        $setOnInsert: { companyId, code },
      },
      { upsert: true, new: true }
    );
    return { printer: doc, created: !existing };
  } catch (e) {
    if (e?.code === 11000) {
      const err = new Error(
        "Default printer conflict: another active company or warehouse default already exists"
      );
      err.code = "LABEL_PRINTER_DEFAULT_CONFLICT";
      err.statusCode = 409;
      throw err;
    }
    throw e;
  }
}

export async function setPrinterActive(companyId, idOrCode, isActive) {
  const printer = await getPrinter(companyId, idOrCode);
  if (!printer) {
    const err = new Error("Printer not found");
    err.statusCode = 404;
    throw err;
  }
  return PrinterConfig.findOneAndUpdate(
    { _id: printer._id },
    { $set: { isActive: Boolean(isActive) } },
    { new: true }
  );
}

/**
 * Soft-delete only. Refuses if active in-flight jobs exist (pending/leased/printing/uncertain/failed).
 * Historical COMPLETED jobs are preserved; soft-delete keeps the document.
 */
export async function deletePrinter(companyId, idOrCode) {
  const printer = await getPrinter(companyId, idOrCode);
  if (!printer) {
    const err = new Error("Printer not found");
    err.statusCode = 404;
    throw err;
  }
  const blocking = await LabelPrintJob.countDocuments({
    companyId,
    printerConfigId: printer._id,
    status: { $in: ["PENDING", "LEASED", "PRINTING", "FAILED", "UNCERTAIN", "PARTIAL"] },
  });
  if (blocking > 0) {
    const err = new Error(
      `Cannot delete printer ${printer.code}: ${blocking} open job(s). Disable the printer or resolve jobs first.`
    );
    err.code = "LABEL_PRINTER_HAS_OPEN_JOBS";
    err.statusCode = 409;
    throw err;
  }
  return PrinterConfig.findOneAndUpdate(
    { _id: printer._id },
    { $set: { isActive: false } },
    { new: true }
  );
}

/**
 * Enterprise print routing (company-scoped only).
 *
 * Order:
 * 1. Explicit printerCode
 * 2. Warehouse default
 * 3. Any active printer assigned to that warehouse (deterministic pick)
 * 4. Company default
 * 5. Settings LABEL_DEFAULT_PRINTER_CODE
 * 6. Legacy fallback among active printers (deterministic pick)
 *
 * Never crosses company boundaries. Skips disabled printers/agents and empty Windows names.
 */
export async function resolvePrinterForJob(companyId, printerCode, opts = {}) {
  const settings = await getLabelSettings(companyId);
  const code = upper(printerCode || "");
  const warehouseCode = upper(opts.warehouseCode || "");
  const now = Date.now();

  const trySelect = async (filter) => {
    const rows = await PrinterConfig.find({ companyId, isActive: true, ...filter }).lean();
    if (!rows.length) return null;
    const { agentMap, pendingMap } = await loadAgentAndPendingMaps(companyId, rows);
    return selectRoutable(rows, agentMap, pendingMap);
  };

  // 1. Explicit
  if (code) {
    const explicit = await PrinterConfig.findOne({ companyId, code, isActive: true }).lean();
    if (!explicit) {
      throw missingPrinterError(`Printer code ${code} not found or inactive`);
    }
    if (!String(explicit.windowsPrinterName || "").trim()) {
      throw missingPrinterError(`Printer ${code} has no Windows printer name configured`);
    }
    const agent = await PrintAgent.findOne({ companyId, agentId: upper(explicit.agentId) }).lean();
    if (!agent || agent.isActive === false) {
      throw missingPrinterError(
        `Printer ${code} is mapped to a disabled or missing agent (${explicit.agentId})`
      );
    }
    return explicit;
  }

  // 2. Warehouse default
  if (warehouseCode) {
    const whDefault = await trySelect({ warehouseCode, isWarehouseDefault: true });
    if (whDefault) return whDefault;
  }

  // 3. Any warehouse-assigned
  if (warehouseCode) {
    const anyWh = await trySelect({ warehouseCode });
    if (anyWh) return anyWh;
  }

  // 4. Company default
  {
    const companyDefault = await trySelect({ isDefault: true });
    if (companyDefault) return companyDefault;
  }

  // 5. Settings default code
  if (settings.defaultPrinterCode) {
    const fromSettings = await trySelect({ code: upper(settings.defaultPrinterCode) });
    if (fromSettings) return fromSettings;
  }

  // 6. Legacy fallback
  const legacy = await trySelect({});
  if (legacy) return legacy;

  throw missingPrinterError(
    warehouseCode
      ? `No routable printer for warehouse ${warehouseCode} (agent online preferred; check mappings/defaults)`
      : "No routable printer configured (check agent status, Windows queue names, and defaults)"
  );
}

export async function touchPrinterLastPrint(printerConfigId) {
  if (!printerConfigId) return;
  await PrinterConfig.updateOne({ _id: printerConfigId }, { $set: { lastPrintAt: new Date() } });
}

export { isAgentOnline };
