/**
 * Turn Mongo duplicate key (E11000) errors into actionable API messages.
 */
const LEGACY_GLOBAL_KEY_HINT = new Set(["name", "supplierName", "supplierCode", "email"]);

export function formatDuplicateKeyError(err, entityLabel = "Record") {
  if (Number(err?.code) !== 11000) {
    return err?.message || String(err);
  }
  const kv = err.keyValue && typeof err.keyValue === "object" ? err.keyValue : {};
  const hint = Object.entries(kv)
    .map(([k, v]) => `${k}: "${v}"`)
    .join(", ");
  const keys = Object.keys(kv);
  const looksLikeLegacyGlobalUnique =
    keys.length === 1 && LEGACY_GLOBAL_KEY_HINT.has(keys[0]) && !Object.prototype.hasOwnProperty.call(kv, "companyId");
  const migrateHint = looksLikeLegacyGlobalUnique
    ? " If companies MAR and OKE should keep independent supplier/customer lists, run from the backend folder: npm run migrate:isolate-masters."
    : "";
  return `${entityLabel} already exists (${hint || "duplicate key"}). Use Edit or change the unique value(s).${migrateHint}`;
}
