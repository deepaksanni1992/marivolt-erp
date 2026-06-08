import { globalSearch } from "../services/globalSearchService.js";

export async function getGlobalSearch(req, res) {
  try {
    const result = await globalSearch(req);
    res.json({
      enabled: true,
      companyCode: req.companyCode || "",
      ...result,
    });
  } catch (err) {
    res.status(400).json({ message: err.message || "Search failed" });
  }
}
