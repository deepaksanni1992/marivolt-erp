import crypto from "crypto";
import LabelPrintJob from "../../models/LabelPrintJob.js";
import { agentSupportsZpl } from "./labelLanguages.js";

export const LEASE_TTL_MS = 60_000;

export function newLeaseToken() {
  return crypto.randomBytes(16).toString("hex");
}

export function timingSafeEqualString(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length) {
    // Compare against self to keep work roughly constant, then fail
    crypto.timingSafeEqual(aa, aa);
    return false;
  }
  return crypto.timingSafeEqual(aa, bb);
}

/** Reclaim expired leases → UNCERTAIN (never auto-reprint / never auto PENDING). */
export async function reclaimExpiredLeases(companyId = null) {
  const now = new Date();
  const filter = {
    status: { $in: ["LEASED", "PRINTING"] },
    leaseExpiresAt: { $ne: null, $lt: now },
  };
  if (companyId) filter.companyId = companyId;
  const result = await LabelPrintJob.updateMany(filter, {
    $set: {
      status: "UNCERTAIN",
      lastError: "Lease expired — print result unknown. Confirm printed quantity before retry.",
      leaseToken: "",
      leasedToAgentId: "",
      leaseExpiresAt: null,
    },
  });
  return result.modifiedCount || 0;
}

function blockedWindowsPrinterNames(agent, extra = []) {
  const out = [];
  const seen = new Set();
  const add = (name) => {
    const n = String(name || "").trim();
    if (!n) return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };
  for (const row of agent?.printerStatus || []) {
    const st = String(row?.status || "")
      .trim()
      .toUpperCase();
    if (st && st !== "READY" && st !== "UNKNOWN") add(row.name);
  }
  for (const name of extra) add(name);
  return out;
}

/**
 * Atomically lease next PENDING job for agent (DB-level race safe).
 * Skips jobs whose frozen Windows queue is known-unhealthy so a down Rongta
 * does not starve Zebra jobs on the same agent (never silent-swaps destination).
 */
export async function leaseNextJob(agent, opts = {}) {
  await reclaimExpiredLeases(agent.companyId);
  const now = new Date();
  const leaseToken = newLeaseToken();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_MS);
  const supportsZpl = agentSupportsZpl(agent);
  const languageFilter = supportsZpl
    ? {}
    : {
        $or: [
          { language: { $exists: false } },
          { language: null },
          { language: "" },
          { language: "TSPL" },
        ],
      };
  const blocked = blockedWindowsPrinterNames(agent, opts.unhealthyPrinters || opts.skipWindowsPrinterNames || []);
  const printerFilter = blocked.length ? { windowsPrinterName: { $nin: blocked } } : {};
  const job = await LabelPrintJob.findOneAndUpdate(
    {
      companyId: agent.companyId,
      agentId: String(agent.agentId).toUpperCase(),
      status: "PENDING",
      ...languageFilter,
      ...printerFilter,
    },
    {
      $set: {
        status: "LEASED",
        leasedToAgentId: String(agent.agentId).toUpperCase(),
        leaseExpiresAt,
        leaseToken,
      },
    },
    { sort: { createdAt: 1 }, new: true }
  );
  return job;
}

export async function releaseLeaseToPending(jobId, agent, leaseToken) {
  const token = String(leaseToken || "");
  const job = await LabelPrintJob.findOne({
    _id: jobId,
    companyId: agent.companyId,
    agentId: String(agent.agentId).toUpperCase(),
    status: "LEASED",
  });
  if (!job || !timingSafeEqualString(job.leaseToken, token)) {
    const err = new Error("Job not leased to this agent or invalid lease token");
    err.code = "LABEL_LEASE_INVALID";
    err.statusCode = 409;
    throw err;
  }
  const updated = await LabelPrintJob.findOneAndUpdate(
    {
      _id: jobId,
      companyId: agent.companyId,
      agentId: String(agent.agentId).toUpperCase(),
      status: "LEASED",
      leaseToken: job.leaseToken,
    },
    {
      $set: {
        status: "PENDING",
        leaseToken: "",
        leasedToAgentId: "",
        leaseExpiresAt: null,
      },
    },
    { new: true }
  );
  if (!updated) {
    const err = new Error("Lease already advanced; cannot return to PENDING");
    err.code = "LABEL_TRANSITION_REJECTED";
    err.statusCode = 409;
    throw err;
  }
  return updated;
}

export async function markJobPrinting(jobId, agent, leaseToken) {
  const token = String(leaseToken || "");
  const job = await LabelPrintJob.findOne({
    _id: jobId,
    companyId: agent.companyId,
    agentId: String(agent.agentId).toUpperCase(),
    status: "LEASED",
  });
  if (!job || !timingSafeEqualString(job.leaseToken, token)) {
    const err = new Error("Job not leased to this agent or invalid lease token");
    err.code = "LABEL_LEASE_INVALID";
    err.statusCode = 409;
    throw err;
  }
  const updated = await LabelPrintJob.findOneAndUpdate(
    {
      _id: jobId,
      companyId: agent.companyId,
      agentId: String(agent.agentId).toUpperCase(),
      status: "LEASED",
      leaseToken: job.leaseToken,
    },
    {
      $set: {
        status: "PRINTING",
        leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS),
      },
    },
    { new: true }
  );
  if (!updated) {
    const err = new Error("Invalid transition or lease lost");
    err.code = "LABEL_TRANSITION_REJECTED";
    err.statusCode = 409;
    throw err;
  }
  return updated;
}

export async function applyAgentResult(jobId, agent, body = {}) {
  const leaseToken = String(body.leaseToken || "");
  const status = String(body.status || "").toUpperCase();
  const allowed = new Set(["COMPLETED", "FAILED", "UNCERTAIN", "PARTIAL"]);
  if (!allowed.has(status)) {
    const err = new Error("Invalid result status");
    err.code = "LABEL_RESULT_INVALID";
    err.statusCode = 400;
    throw err;
  }

  const job = await LabelPrintJob.findOne({
    _id: jobId,
    companyId: agent.companyId,
    agentId: String(agent.agentId).toUpperCase(),
    status: { $in: ["LEASED", "PRINTING"] },
  });
  if (!job || !timingSafeEqualString(job.leaseToken, leaseToken)) {
    const err = new Error("Job not found or lease token mismatch");
    err.code = "LABEL_LEASE_INVALID";
    err.statusCode = 409;
    throw err;
  }

  const printedQtyRaw = body.printedQty;
  const printedQty = Math.max(0, Number(printedQtyRaw));
  const requested = Number(job.remainingLabels) || Number(job.requestedLabels) || 0;

  const $set = {
    leaseToken: "",
    leasedToAgentId: "",
    leaseExpiresAt: null,
  };

  if (status === "COMPLETED" || status === "PARTIAL") {
    const done =
      status === "COMPLETED" && (printedQtyRaw == null || printedQtyRaw === "")
        ? requested
        : Math.min(requested, Number.isFinite(printedQty) ? printedQty : 0);
    $set.printedLabels = (Number(job.printedLabels) || 0) + done;
    $set.remainingLabels = Math.max(0, requested - done);
    $set.status = $set.remainingLabels > 0 ? "PARTIAL" : "COMPLETED";
    if ($set.status === "COMPLETED") $set.lastError = "";
  } else if (status === "FAILED") {
    $set.status = "FAILED";
    $set.lastError = String(body.error || "Print failed");
    $set.retryCount = (Number(job.retryCount) || 0) + 1;
  } else {
    $set.status = "UNCERTAIN";
    $set.lastError = String(body.error || "Print result uncertain");
    if (printedQtyRaw != null && Number.isFinite(printedQty)) {
      $set.lastError = `${$set.lastError} (agent reported printedQty=${printedQty})`;
    }
  }
  if (body.error && status !== "COMPLETED") {
    $set.lastError = String(body.error);
  }

  const update = { $set };
  if (status === "FAILED" && String(job.sourceType || "").toUpperCase() === "PACKING") {
    update.$unset = { idempotencyKey: "" };
  }

  const updated = await LabelPrintJob.findOneAndUpdate(
    {
      _id: jobId,
      companyId: agent.companyId,
      agentId: String(agent.agentId).toUpperCase(),
      status: { $in: ["LEASED", "PRINTING"] },
      leaseToken: job.leaseToken,
    },
    update,
    { new: true }
  );
  if (!updated) {
    const err = new Error("Result already applied or lease invalid");
    err.code = "LABEL_RESULT_ALREADY_APPLIED";
    err.statusCode = 409;
    throw err;
  }
  return updated;
}

export async function requeueJob(job, { clearError = true } = {}) {
  if (job.status === "UNCERTAIN") {
    const err = new Error("UNCERTAIN jobs require manual printed-qty confirmation before retry");
    err.code = "LABEL_UNCERTAIN_CONFIRM_REQUIRED";
    err.statusCode = 400;
    throw err;
  }
  if (!["FAILED", "PARTIAL", "CANCELLED"].includes(job.status) && job.status !== "PENDING") {
    const err = new Error(`Cannot requeue job in status ${job.status}`);
    err.code = "LABEL_TRANSITION_REJECTED";
    err.statusCode = 400;
    throw err;
  }
  const remaining = Math.max(0, Number(job.remainingLabels) || 0);
  if (remaining <= 0 && job.status !== "FAILED") {
    const err = new Error("No remaining labels to print");
    err.code = "LABEL_NOTHING_TO_PRINT";
    err.statusCode = 400;
    throw err;
  }
  if (job.status === "FAILED" && remaining <= 0) {
    job.remainingLabels = Number(job.requestedLabels) || 0;
  }
  job.status = "PENDING";
  job.leaseToken = "";
  job.leasedToAgentId = "";
  job.leaseExpiresAt = null;
  if (clearError) job.lastError = "";
  await job.save();
  return job;
}
