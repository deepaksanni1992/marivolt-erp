import crypto from "crypto";
import LabelPrintJob from "../../models/LabelPrintJob.js";

export const LEASE_TTL_MS = 60_000;

export function newLeaseToken() {
  return crypto.randomBytes(16).toString("hex");
}

/** Reclaim expired leases → UNCERTAIN (never auto-reprint). */
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

/**
 * Atomically lease next PENDING job for agent.
 */
export async function leaseNextJob(agent) {
  await reclaimExpiredLeases(agent.companyId);
  const now = new Date();
  const leaseToken = newLeaseToken();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_TTL_MS);
  const job = await LabelPrintJob.findOneAndUpdate(
    {
      companyId: agent.companyId,
      agentId: String(agent.agentId).toUpperCase(),
      status: "PENDING",
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

export async function markJobPrinting(jobId, agent, leaseToken) {
  const job = await LabelPrintJob.findOne({
    _id: jobId,
    companyId: agent.companyId,
    agentId: String(agent.agentId).toUpperCase(),
    status: "LEASED",
    leaseToken: String(leaseToken || ""),
  });
  if (!job) {
    const err = new Error("Job not leased to this agent or invalid lease token");
    err.code = "LABEL_LEASE_INVALID";
    err.statusCode = 409;
    throw err;
  }
  job.status = "PRINTING";
  job.leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS);
  await job.save();
  return job;
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
    leaseToken,
  });
  if (!job) {
    const err = new Error("Job not found or lease token mismatch");
    err.code = "LABEL_LEASE_INVALID";
    err.statusCode = 409;
    throw err;
  }

  const printedQty = Math.max(0, Number(body.printedQty));
  const requested = Number(job.remainingLabels) || Number(job.requestedLabels) || 0;

  if (status === "COMPLETED") {
    const done = Number.isFinite(printedQty) && body.printedQty != null ? printedQty : requested;
    job.printedLabels = (Number(job.printedLabels) || 0) + done;
    job.remainingLabels = Math.max(0, requested - done);
    job.status = job.remainingLabels > 0 ? "PARTIAL" : "COMPLETED";
  } else if (status === "PARTIAL") {
    const done = Number.isFinite(printedQty) ? printedQty : 0;
    job.printedLabels = (Number(job.printedLabels) || 0) + done;
    job.remainingLabels = Math.max(0, requested - done);
    job.status = job.remainingLabels > 0 ? "PARTIAL" : "COMPLETED";
  } else if (status === "FAILED") {
    job.status = "FAILED";
    job.lastError = String(body.error || "Print failed");
    job.retryCount = (Number(job.retryCount) || 0) + 1;
  } else {
    job.status = "UNCERTAIN";
    job.lastError = String(body.error || "Print result uncertain");
    if (Number.isFinite(printedQty) && body.printedQty != null) {
      // Do not treat as success — store hint only via lastError
      job.lastError = `${job.lastError} (agent reported printedQty=${printedQty})`;
    }
  }

  job.leaseToken = "";
  job.leasedToAgentId = "";
  job.leaseExpiresAt = null;
  if (body.error && status !== "COMPLETED") {
    job.lastError = String(body.error);
  }
  await job.save();
  return job;
}

export async function requeueJob(job, { clearError = true } = {}) {
  if (!["FAILED", "PARTIAL", "UNCERTAIN", "CANCELLED"].includes(job.status) && job.status !== "PENDING") {
    // allow PENDING already
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
