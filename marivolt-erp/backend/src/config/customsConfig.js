/** Feature flag — when false, customs hooks and API are no-ops / disabled. */
export function isCustomsEnabled() {
  return String(process.env.CUSTOMS_ENABLED || "").trim().toLowerCase() === "true";
}
