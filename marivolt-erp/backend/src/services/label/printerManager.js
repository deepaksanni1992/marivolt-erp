import mongoose from "mongoose";
import PrinterConfig from "../../models/PrinterConfig.js";
import PrintAgent from "../../models/PrintAgent.js";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import { getLabelSettings } from "./labelSettingsService.js";
import { pickBestPrinter, isAgentOnline } from "./labelRoutingHelpers.js";
import {
  LABEL_PURPOSES,
  assertPrinterCompatible,
  printerLanguage,
} from "./labelPrinterProfile.js";
import { LABEL_LANGUAGES, normalizeLabelLanguage } from "./labelLanguages.js";

function upper(v) {
  return String(v || "").trim().toUpperCase();
}

function normalizePurposeList(raw) {
  if (raw == null) return undefined;
  if (!Array.isArray(raw)) {
    const one = String(raw || "")
      .trim()
      .toUpperCase();
    return one && LABEL_PURPOSES.includes(one) ? [one] : [];
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const p = String(item || "")
      .trim()
      .toUpperCase();
    if (!LABEL_PURPOSES.includes(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function normalizeTemplateCodeList(raw) {
  if (raw == null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const c = String(item || "")
      .trim()
      .toUpperCase();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
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
  const language =
    body.language != null
      ? normalizeLabelLanguage(body.language)
      : existing?.language
        ? printerLanguage(existing)
        : "TSPL";
  if (!LABEL_LANGUAGES.includes(language)) {
    const err = new Error("Printer language must be TSPL or ZPL");
    err.statusCode = 400;
    throw err;
  }
  const dpiRaw = body.dpi != null ? Number(body.dpi) : Number(existing?.dpi) || 203;
  const dpi = Number.isFinite(dpiRaw) && dpiRaw > 0 ? Math.round(dpiRaw) : 203;
  const widthMm =
    body.widthMm != null
      ? Math.max(0, Number(body.widthMm) || 0)
      : existing?.widthMm != null
        ? Number(existing.widthMm) || 0
        : 0;
  const heightMm =
    body.heightMm != null
      ? Math.max(0, Number(body.heightMm) || 0)
      : existing?.heightMm != null
        ? Number(existing.heightMm) || 0
        : 0;
  const purposes =
    body.supportedPurposes !== undefined
      ? normalizePurposeList(body.supportedPurposes)
      : existing?.supportedPurposes;
  const templates =
    body.supportedTemplateCodes !== undefined
      ? normalizeTemplateCodeList(body.supportedTemplateCodes)
      : existing?.supportedTemplateCodes;

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
          language,
          dpi,
          widthMm,
          heightMm,
          supportedPurposes: purposes,
          supportedTemplateCodes: templates,
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

function compatibilityOpts(companyId, printer, agent, opts) {
  return {
    companyId,
    purpose: opts.purpose,
    templateCode: opts.templateCode,
    language: opts.language,
    widthMm: opts.widthMm,
    heightMm: opts.heightMm,
    agent,
    requireAgentId: opts.agentId,
  };
}

async function pickCompatible(companyId, rows, opts) {
  if (!rows.length) return null;
  const { agentMap, pendingMap } = await loadAgentAndPendingMaps(companyId, rows);
  const compatible = [];
  for (const printer of rows) {
    const agent = agentMap[upper(printer.agentId)] || null;
    try {
      assertPrinterCompatible(printer, compatibilityOpts(companyId, printer, agent, opts));
      compatible.push(printer);
    } catch {
      /* skip incompatible — never silent-swap at explicit resolve */
    }
  }
  return selectRoutable(compatible, agentMap, pendingMap);
}

async function hopSameAgent(companyId, seed, opts) {
  if (!seed?.agentId) return null;
  const rows = await PrinterConfig.find({
    companyId,
    isActive: true,
    agentId: upper(seed.agentId),
  }).lean();
  return pickCompatible(companyId, rows, opts);
}

/**
 * Enterprise print routing (company-scoped only).
 *
 * Order:
 * 1. Explicit printerCode (validated; never swapped)
 * 2. Explicit agentId — purpose-compatible printer on that agent only
 * 3. Warehouse default — if incompatible, same-agent hop only
 * 4. Any active printer assigned to that warehouse (deterministic pick among compatible)
 * 5. Company default — if incompatible, same-agent hop only
 * 6. Settings LABEL_DEFAULT_PRINTER_CODE
 * 7. Legacy fallback among compatible printers (deterministic pick)
 *
 * Never crosses company boundaries. Never falls back to another laptop when an
 * explicit printer/agent was requested. Skips disabled printers/agents.
 */
export async function resolvePrinterForJob(companyId, printerCode, opts = {}) {
  const settings = await getLabelSettings(companyId);
  const code = upper(printerCode || "");
  const warehouseCode = upper(opts.warehouseCode || "");
  const requestedAgentId = upper(opts.agentId || "");

  const trySelect = async (filter) => {
    const rows = await PrinterConfig.find({ companyId, isActive: true, ...filter }).lean();
    return pickCompatible(companyId, rows, opts);
  };

  if (code) {
    const explicit = await PrinterConfig.findOne({ companyId, code, isActive: true }).lean();
    if (!explicit) {
      throw missingPrinterError(`Printer code ${code} not found or inactive`);
    }
    const agent = await PrintAgent.findOne({ companyId, agentId: upper(explicit.agentId) }).lean();
    assertPrinterCompatible(explicit, compatibilityOpts(companyId, explicit, agent, opts));
    return explicit;
  }

  if (requestedAgentId) {
    const onAgent = await trySelect({ agentId: requestedAgentId });
    if (onAgent) return onAgent;
    throw missingPrinterError(
      `No compatible printer on agent ${requestedAgentId} for ${opts.purpose || "this label"}`
    );
  }

  if (warehouseCode) {
    const rows = await PrinterConfig.find({
      companyId,
      isActive: true,
      warehouseCode,
      isWarehouseDefault: true,
    }).lean();
    if (rows.length) {
      const compatible = await pickCompatible(companyId, rows, opts);
      if (compatible) return compatible;
      const hopped = await hopSameAgent(companyId, rows[0], opts);
      if (hopped) return hopped;
    }
  }

  if (warehouseCode) {
    const anyWh = await trySelect({ warehouseCode });
    if (anyWh) return anyWh;
  }

  {
    const defaults = await PrinterConfig.find({ companyId, isActive: true, isDefault: true }).lean();
    if (defaults.length) {
      const compatible = await pickCompatible(companyId, defaults, opts);
      if (compatible) return compatible;
      const hopped = await hopSameAgent(companyId, defaults[0], opts);
      if (hopped) return hopped;
    }
  }

  if (settings.defaultPrinterCode) {
    const fromSettings = await trySelect({ code: upper(settings.defaultPrinterCode) });
    if (fromSettings) return fromSettings;
    const seed = await PrinterConfig.findOne({
      companyId,
      isActive: true,
      code: upper(settings.defaultPrinterCode),
    }).lean();
    const hopped = await hopSameAgent(companyId, seed, opts);
    if (hopped) return hopped;
  }

  const legacy = await trySelect({});
  if (legacy) return legacy;

  throw missingPrinterError(
    warehouseCode
      ? `No compatible printer for warehouse ${warehouseCode} / ${opts.purpose || "this label"} (check mappings, language, and media)`
      : `No compatible printer configured for ${opts.purpose || "this label"} (check agent, language, and media)`
  );
}

export async function resolvePrinterDestination(companyId, body = {}) {
  const printer = await resolvePrinterForJob(companyId, body.printerCode, {
    warehouseCode: body.warehouseCode,
    agentId: body.agentId,
    purpose: body.purpose,
    templateCode: body.templateCode,
    language: body.language,
    widthMm: body.widthMm,
    heightMm: body.heightMm,
  });
  const agent = await PrintAgent.findOne({ companyId, agentId: upper(printer.agentId) }).lean();
  return { printer, agent };
}

export async function touchPrinterLastPrint(printerConfigId) {
  if (!printerConfigId) return;
  await PrinterConfig.updateOne({ _id: printerConfigId }, { $set: { lastPrintAt: new Date() } });
}

export { isAgentOnline };
