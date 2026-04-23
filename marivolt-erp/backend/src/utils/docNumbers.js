export async function nextSequentialNumber(Model, field, prefix, extraFilter = {}) {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const re = new RegExp(`^${prefix}-${d}-`);
  const count = await Model.countDocuments({ ...extraFilter, [field]: { $regex: re } });
  return `${prefix}-${d}-${String(count + 1).padStart(4, "0")}`;
}
