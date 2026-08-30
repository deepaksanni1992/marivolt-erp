/**
 * Label job list query helpers — filter by packing/allocation before limit.
 */
function t(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return t(v).toUpperCase();
}

function isObjectIdString(raw) {
  return /^[a-fA-F0-9]{24}$/.test(t(raw));
}

export function parseLabelJobIdList(raw) {
  return t(raw)
    .split(",")
    .map((s) => t(s))
    .filter((id) => isObjectIdString(id));
}

export function clampLabelJobListLimit(raw) {
  return Math.min(200, Math.max(1, Number(raw) || 50));
}

/**
 * Mongo filter for GET /labels/jobs. packingId / allocationId are applied here
 * so limit never runs over a company-wide packing job set.
 */
export function buildLabelPrintJobListFilter(companyId, query = {}) {
  const filter = { companyId };
  if (query.status) filter.status = upper(query.status);
  if (query.sourceNo) filter.sourceNo = upper(query.sourceNo);
  if (query.sourceType) filter.sourceType = upper(query.sourceType);
  if (query.packingMode) filter.packingMode = upper(query.packingMode);
  const ir = t(query.isReprint).toLowerCase();
  if (ir === "true" || ir === "1") filter.isReprint = true;
  if (ir === "false" || ir === "0") {
    filter.isReprint = { $ne: true };
    filter.$or = [{ parentJobId: null }, { parentJobId: { $exists: false } }];
  }
  if (isObjectIdString(query.allocationId)) filter.allocationId = query.allocationId;
  if (isObjectIdString(query.packingId)) filter.packingId = query.packingId;
  return filter;
}

export function jobMatchesListFilter(job, filter) {
  if (filter.companyId != null && String(job.companyId) !== String(filter.companyId)) return false;
  if (filter.status && upper(job.status) !== upper(filter.status)) return false;
  if (filter.sourceNo && upper(job.sourceNo) !== upper(filter.sourceNo)) return false;
  if (filter.sourceType && upper(job.sourceType) !== upper(filter.sourceType)) return false;
  if (filter.packingMode && upper(job.packingMode) !== upper(filter.packingMode)) return false;
  if (filter.packingId != null && String(job.packingId || "") !== String(filter.packingId)) return false;
  if (filter.allocationId != null && String(job.allocationId || "") !== String(filter.allocationId)) {
    return false;
  }
  if (filter.isReprint && typeof filter.isReprint === "object" && filter.isReprint.$ne === true) {
    if (job.isReprint === true) return false;
  } else if (filter.isReprint === true) {
    if (job.isReprint !== true) return false;
  }
  if (Array.isArray(filter.$or)) {
    const parentEmpty = job.parentJobId == null || job.parentJobId === "";
    if (!parentEmpty) return false;
  }
  return true;
}

/** Apply list semantics: scoped match, then sort, then limit. */
export function queryLabelJobsScoped(allJobs, query = {}, companyId) {
  const filter = buildLabelPrintJobListFilter(companyId, query);
  const packingIds = parseLabelJobIdList(query.packingIds);
  const limit = clampLabelJobListLimit(query.limit);
  const apply = (scoped) => {
    const matched = (allJobs || []).filter((j) => jobMatchesListFilter(j, scoped));
    matched.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return matched.slice(0, limit);
  };
  if (packingIds.length) {
    return packingIds.flatMap((id) => apply({ ...filter, packingId: id }));
  }
  return apply(filter);
}
