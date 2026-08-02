import PrintAgent from "../models/PrintAgent.js";
import {
  leaseNextJob,
  markJobPrinting,
  applyAgentResult,
  reclaimExpiredLeases,
} from "../services/label/printQueue.js";
import { recordLabelHistory } from "../services/label/labelAudit.js";
import { syncGrnLabelStatus } from "../services/label/labelService.js";

function sendErr(res, err) {
  res.status(err.statusCode || 400).json({
    message: err.message || "Agent request failed",
    code: err.code || undefined,
  });
}

export async function heartbeat(req, res) {
  try {
    const agent = req.printAgent;
    const computerName = String(req.body?.computerName || "").trim();
    const appVersion = String(req.body?.appVersion || "").trim();
    agent.status = "ONLINE";
    agent.lastHeartbeatAt = new Date();
    agent.lastIp = String(req.ip || req.headers["x-forwarded-for"] || "").slice(0, 120);
    if (computerName) agent.computerName = computerName;
    if (appVersion) agent.appVersion = appVersion;
    await agent.save();
    await reclaimExpiredLeases(agent.companyId);
    res.json({
      ok: true,
      agentId: agent.agentId,
      status: "ONLINE",
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function lease(req, res) {
  try {
    const agent = req.printAgent;
    await reclaimExpiredLeases(agent.companyId);
    const job = await leaseNextJob(agent);
    if (!job) {
      return res.json({ job: null });
    }
    await recordLabelHistory({
      jobId: job._id,
      companyId: job.companyId,
      agentId: agent.agentId,
      computerName: agent.computerName,
      windowsPrinterName: job.windowsPrinterName,
      requestedQty: job.remainingLabels,
      status: "LEASED",
      templateCode: job.templateCode,
      event: "LEASE",
    });
    await syncGrnLabelStatus(job.sourceId, job);
    res.json({
      job: {
        id: job._id,
        jobNo: job.jobNo,
        leaseToken: job.leaseToken,
        leaseExpiresAt: job.leaseExpiresAt,
        windowsPrinterName: job.windowsPrinterName,
        templateCode: job.templateCode,
        requestedLabels: job.remainingLabels,
        tsplPayload: job.tsplPayload,
        sourceNo: job.sourceNo,
      },
    });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function printing(req, res) {
  try {
    const job = await markJobPrinting(req.params.id, req.printAgent, req.body?.leaseToken);
    await syncGrnLabelStatus(job.sourceId, job);
    await recordLabelHistory({
      jobId: job._id,
      companyId: job.companyId,
      agentId: req.printAgent.agentId,
      computerName: req.printAgent.computerName,
      windowsPrinterName: job.windowsPrinterName,
      requestedQty: job.remainingLabels,
      status: "PRINTING",
      templateCode: job.templateCode,
      event: "PRINTING",
    });
    res.json({ ok: true, status: job.status });
  } catch (err) {
    sendErr(res, err);
  }
}

export async function result(req, res) {
  try {
    const job = await applyAgentResult(req.params.id, req.printAgent, req.body || {});
    await syncGrnLabelStatus(job.sourceId, job);
    await recordLabelHistory({
      jobId: job._id,
      companyId: job.companyId,
      agentId: req.printAgent.agentId,
      computerName: req.printAgent.computerName,
      windowsPrinterName: job.windowsPrinterName,
      requestedQty: job.requestedLabels,
      printedQty: req.body?.printedQty || 0,
      status: job.status,
      templateCode: job.templateCode,
      failureReason: job.lastError || "",
      retryCount: job.retryCount,
      event: "RESULT",
    });
    // Mark agent offline-ish only via heartbeat; keep ONLINE after success
    await PrintAgent.updateOne(
      { _id: req.printAgent._id },
      { $set: { lastHeartbeatAt: new Date(), status: "ONLINE" } }
    );
    res.json({
      ok: true,
      status: job.status,
      printedLabels: job.printedLabels,
      remainingLabels: job.remainingLabels,
    });
  } catch (err) {
    sendErr(res, err);
  }
}
