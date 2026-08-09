/**
 * Non-secret deployment metadata for ops verification.
 * Prefer platform-injected commit SHA when present.
 */
export function getDeploymentVersion(env = process.env) {
  const commitRaw =
    env.RENDER_GIT_COMMIT ||
    env.COMMIT_SHA ||
    env.GIT_COMMIT_SHA ||
    env.SOURCE_VERSION ||
    env.VERCEL_GIT_COMMIT_SHA ||
    env.HEROKU_SLUG_COMMIT ||
    "";
  const commit = String(commitRaw || "")
    .trim()
    .replace(/^"|"$/g, "")
    .slice(0, 40);

  const environment = String(env.NODE_ENV || "development").trim() || "development";
  const buildTime = String(env.BUILD_TIME || env.RENDER_GIT_COMMIT_TIMESTAMP || "").trim();
  const service = String(env.RENDER_SERVICE_NAME || env.SERVICE_NAME || "").trim();

  return {
    commit: commit || "unknown",
    buildTime: buildTime || null,
    environment,
    service: service || null,
  };
}
