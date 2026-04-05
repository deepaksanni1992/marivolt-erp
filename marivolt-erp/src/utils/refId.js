/** Normalize populated or raw ObjectId for forms and API. */
export function refId(val) {
  if (val == null || val === "") return "";
  if (typeof val === "object" && val._id != null) return String(val._id);
  return String(val);
}
