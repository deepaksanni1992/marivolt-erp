import LabelPrintJob from "../models/LabelPrintJob.js";
import LabelPrintHistory from "../models/LabelPrintHistory.js";
import * as labelService from "../services/label/labelService.js";
import * as labelSettings from "../services/label/labelSettingsService.js";
import * as printerManager from "../services/label/printerManager.js";
import * as templateService from "../services/label/labelTemplateService.js";
import { getFixedLabelSize } from "../services/label/tsplGenerator.js";
import { recordLabelHistory } from "../services/label/labelAudit.js";
import { syncGrnLabelStatus } from "../services/label/labelService.js";

function sendErr(res, err) {
  const status = err.statusCode || 400;
  res.status(status).json({
    message: err.message || "Label request failed",
    code: err.code || undefined,
  });
}

export async function getSettings(req, res) {
  try {
    const settings = await labelSettings.getLabelSettings(req.companyId);
    res.json({
      ...settings,
      agentBootstrapToken: "",
      labelSize: getFixedLabelSize(),
      template: "MARIVOLT STANDARD LABEL",
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function putSettings(req, res) {
  try {
    const body = { ...(req.body || {}) };
    const bootstrapKeys = [
      "agentBootstrapToken",
      "agentBootstrapEnabled",
      "agentBootstrapExpiresAt",
      "agentBootstrapWarehouse",
      "agentBootstrapMaxUses",
      "clearBootstrapToken",
    ];
    const touchesBootstrap = bootstrapKeys.some((k) => Object.prototype.hasOwnProperty.call(body, k));
    if (touchesBootstrap) {
      const { hasPermission, normaliseRoleCode } = await import("../services/roleService.js");
      const role = normaliseRoleCode(req.user?.role || "");
      const ok = role === "SUPER_ADMIN" || (await hasPermission(req, "LABELS", "admin"));
      if (!ok) {
        const err = new Error("LABELS.admin required to manage agent bootstrap settings");
        err.statusCode = 403;
        err.code = "PERMISSION_DENIED";
        throw err;
      }
    }
    const settings = await labelSettings.upsertLabelSettings(
      req.companyId,
      body,
      req.user?.name || req.user?.email || ""
    );
    res.json({
      ...settings,
      agentBootstrapToken: "",
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listPrinters(req, res) {
  try {
    const includeInactive = String(req.query.includeInactive || "") === "1";
    const rows = await printerManager.listPrinters(req.companyId, { includeInactive });
    // Enrich with queue depth + agent status + physical printer health
    const LabelPrintJob = (await import("../models/LabelPrintJob.js")).default;
    const PrintAgent = (await import("../models/PrintAgent.js")).default;
    const { resolveMappedPrinterHealth } = await import("../services/label/labelRoutingHelpers.js");
    const agentIds = [...new Set(rows.map((r) => r.agentId).filter(Boolean))];
    const agents = await PrintAgent.find({ companyId: req.companyId, agentId: { $in: agentIds } }).lean();
    const agentMap = Object.fromEntries(agents.map((a) => [a.agentId, a]));
    const pending = await LabelPrintJob.aggregate([
      {
        $match: {
          companyId: req.companyId,
          printerConfigId: { $in: rows.map((r) => r._id) },
          status: { $in: ["PENDING", "LEASED", "PRINTING"] },
        },
      },
      { $group: { _id: "$printerConfigId", count: { $sum: 1 } } },
    ]);
    const pendingMap = Object.fromEntries(pending.map((p) => [String(p._id), p.count]));
    const items = rows.map((p) => {
      const ag = agentMap[p.agentId];
      const hb = ag?.lastHeartbeatAt ? new Date(ag.lastHeartbeatAt).getTime() : 0;
      const online = ag?.isActive !== false && ag?.status === "ONLINE" && hb && Date.now() - hb < 90_000;
      const agentStatus = ag?.isActive === false ? "DISABLED" : online ? "ONLINE" : "OFFLINE";
      const health = resolveMappedPrinterHealth(ag, p.windowsPrinterName, {
        agentOnline: agentStatus === "ONLINE",
      });
      return {
        ...p,
        currentQueue: pendingMap[String(p._id)] || 0,
        agentName: ag?.name || "",
        agentComputerName: ag?.computerName || "",
        agentStatus,
        ...health,
        spoolerQueueLength: health.printerQueueLength || 0,
      };
    });
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function upsertPrinter(req, res) {
  try {
    const { auditLabelAdminEvent } = await import("../services/label/labelAudit.js");
    const { printer, created } = await printerManager.upsertPrinter(
      req.companyId,
      req.body || {},
      req.user?.name || ""
    );
    await auditLabelAdminEvent(req, {
      action: created ? "CREATE" : "UPDATE",
      entityType: "PrinterConfig",
      entityId: printer._id,
      documentNo: printer.code,
      description: created ? `Printer Added: ${printer.code}` : `Printer Changed: ${printer.code}`,
      metadata: { agentId: printer.agentId, windowsPrinterName: printer.windowsPrinterName },
    });
    res.status(created ? 201 : 200).json(printer);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function disablePrinter(req, res) {
  try {
    const { auditLabelAdminEvent } = await import("../services/label/labelAudit.js");
    const row = await printerManager.setPrinterActive(req.companyId, req.params.id, false);
    await auditLabelAdminEvent(req, {
      action: "UPDATE",
      entityType: "PrinterConfig",
      entityId: row._id,
      documentNo: row.code,
      description: `Printer Disabled: ${row.code}`,
    });
    res.json(row);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function enablePrinter(req, res) {
  try {
    const row = await printerManager.setPrinterActive(req.companyId, req.params.id, true);
    res.json(row);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function deletePrinter(req, res) {
  try {
    const { auditLabelAdminEvent } = await import("../services/label/labelAudit.js");
    const row = await printerManager.deletePrinter(req.companyId, req.params.id);
    await auditLabelAdminEvent(req, {
      action: "DELETE",
      entityType: "PrinterConfig",
      entityId: row._id,
      documentNo: row.code,
      description: `Printer Deleted (soft): ${row.code}`,
    });
    res.json(row);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listTemplates(req, res) {
  try {
    const items = await templateService.listTemplates();
    res.json({ items, labelSize: getFixedLabelSize() });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function registerAgent(req, res) {
  try {
    const result = await labelService.registerPrintAgent(req, req.body || {});
    res.status(201).json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listAgents(req, res) {
  try {
    const result = await labelService.listAgents(req.companyId, req.query || {});
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function getAgent(req, res) {
  try {
    const item = await labelService.getAgent(req.companyId, req.params.id);
    res.json(item);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function updateAgent(req, res) {
  try {
    const item = await labelService.updatePrintAgent(req, req.params.id, req.body || {});
    res.json(item);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function disableAgent(req, res) {
  try {
    const item = await labelService.setAgentActive(req, req.params.id, false);
    res.json(item);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function enableAgent(req, res) {
  try {
    const item = await labelService.setAgentActive(req, req.params.id, true);
    res.json(item);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function rotateAgentSecret(req, res) {
  try {
    const result = await labelService.rotateAgentSecret(req, req.params.id);
    res.json(result);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function testPrint(req, res) {
  try {
    const job = await labelService.createTestPrintJob(req, {
      agentId: req.body?.agentId || req.params.agentId,
      printerCode: req.body?.printerCode || req.params.printerCode,
    });
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function testConnection(req, res) {
  try {
    const { resolveMappedPrinterHealth } = await import("../services/label/labelRoutingHelpers.js");
    const agent = await labelService.getAgent(req.companyId, req.params.id);
    const printers = (agent.printers || []).filter((p) => p.isActive !== false);
    const available = new Set((agent.availablePrinters || []).map((n) => String(n).toLowerCase()));
    const agentOnline = agent.effectiveStatus === "ONLINE";
    const mappedChecks = printers.map((p) => {
      const win = String(p.windowsPrinterName || "").trim();
      const health = resolveMappedPrinterHealth(agent, win, { agentOnline });
      return {
        code: p.code,
        windowsPrinterName: win,
        foundOnAgent: win ? available.has(win.toLowerCase()) : false,
        agentStatus: agentOnline ? "ONLINE" : agent.effectiveStatus || "OFFLINE",
        printerStatus: health.printerStatus,
        printerConnected: health.printerConnected,
        printerStatusMessage: health.printerStatusMessage,
        lastPrinterSeen: health.lastPrinterSeen,
        queueLength: health.printerQueueLength,
      };
    });
    const anyReady = mappedChecks.some((m) => m.printerStatus === "READY");
    const anyDisconnected = mappedChecks.some((m) => m.printerStatus === "DISCONNECTED");
    const primaryStatus = mappedChecks[0]?.printerStatus || (agentOnline ? "UNKNOWN" : "UNKNOWN");
    let message;
    if (!agentOnline) {
      message = "Agent offline, printer unknown";
    } else if (anyReady) {
      message = "Agent online, printer ready";
    } else if (anyDisconnected) {
      message = "Agent online, printer disconnected";
    } else if (!printers.length) {
      message = "Agent online; no active printer mappings yet.";
    } else {
      message = `Agent online, printer ${String(primaryStatus).toLowerCase().replace(/_/g, " ")}`;
    }
    res.json({
      ok: agentOnline,
      connected: agentOnline,
      agentAuthenticated: true,
      agentId: agent.agentId,
      agentStatus: agentOnline ? "ONLINE" : agent.effectiveStatus || "OFFLINE",
      printerStatus: primaryStatus,
      effectiveStatus: agent.effectiveStatus,
      lastHeartbeatAt: agent.lastHeartbeatAt,
      lastIp: agent.lastIp,
      appVersion: agent.appVersion,
      computerName: agent.computerName,
      availablePrinters: agent.availablePrinters || [],
      mappedPrinters: mappedChecks,
      mappedWindowsPrinterFound: mappedChecks.some((m) => m.foundOnAgent),
      physicalPrintRequired: false,
      message,
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function createFromGrn(req, res) {
  try {
    const job = await labelService.createJobsFromGrn(req, req.body || {});
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function createFromPacking(req, res) {
  try {
    const { createJobsFromPacking } = await import("../services/label/packingLabelService.js");
    const job = await createJobsFromPacking(req, req.body || {});
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function previewFromPacking(req, res) {
  try {
    const { previewPackingLabels } = await import("../services/label/packingLabelService.js");
    const preview = await previewPackingLabels(req, req.body || {});
    res.json({ success: true, ...preview });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function listJobs(req, res) {
  try {
    const filter = { companyId: req.companyId };
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    if (req.query.sourceNo) filter.sourceNo = String(req.query.sourceNo).toUpperCase();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const items = await LabelPrintJob.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("-tsplPayload")
      .lean();
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function getJob(req, res) {
  try {
    const job = await LabelPrintJob.findOne({ _id: req.params.id, companyId: req.companyId }).lean();
    if (!job) return res.status(404).json({ message: "Job not found" });
    res.json(job);
  } catch (err) {
    sendErr(res, err);
  }
}

export async function previewJob(req, res) {
  try {
    const job = await LabelPrintJob.findOne({ _id: req.params.id, companyId: req.companyId }).lean();
    if (!job) return res.status(404).json({ message: "Job not found" });
    res.json({
      jobNo: job.jobNo,
      templateCode: job.templateCode,
      labelSize: getFixedLabelSize(),
      lines: job.lines,
      requestedLabels: job.requestedLabels,
      status: job.status,
      tsplLength: (job.tsplPayload || "").length,
      tsplPreview: String(job.tsplPayload || "").slice(0, 2000),
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function retryJob(req, res) {
  try {
    const job = await labelService.retryJob(req, req.params.id);
    res.json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function confirmPartial(req, res) {
  try {
    const job = await labelService.confirmPartial(req, req.params.id, req.body?.printedQty);
    res.json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function resolveUncertain(req, res) {
  try {
    const job = await labelService.resolveUncertain(req, req.params.id, req.body?.printedQty);
    res.json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function cancelJob(req, res) {
  try {
    const job = await labelService.cancelJob(req, req.params.id);
    res.json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function reprintJob(req, res) {
  try {
    const job = await labelService.reprintJob(req, req.params.id, req.body || {});
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function stockReprint(req, res) {
  try {
    const job = await labelService.createStockReprint(req, req.body || {});
    res.status(201).json({ success: true, job });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function jobHistory(req, res) {
  try {
    const items = await LabelPrintHistory.find({
      companyId: req.companyId,
      jobId: req.params.id,
    })
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();
    res.json({ items });
  } catch (err) {
    sendErr(res, err);
  }
}

export { recordLabelHistory, syncGrnLabelStatus };
