import { generatePdfFromHtml } from "../services/pdfService.js";

function safeFilename(name) {
  const base = String(name || "report")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return base.endsWith(".pdf") ? base : `${base || "report"}.pdf`;
}

/**
 * POST /api/reports/pdf
 * Body: { html, filename?, assetBaseUrl?, options? }
 */
export async function postReportPdf(req, res) {
  try {
    const { html, filename, assetBaseUrl, options } = req.body || {};
    if (!html || typeof html !== "string") {
      return res.status(400).json({ message: "html is required" });
    }

    const buffer = await generatePdfFromHtml(html, {
      assetBaseUrl,
      ...(options && typeof options === "object" ? options : {}),
    });

    const file = safeFilename(filename);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
    res.setHeader("Content-Length", String(buffer.length));
    return res.send(buffer);
  } catch (err) {
    console.error("[reportPdf] generation failed:", err);
    return res.status(500).json({
      message: err?.message || "PDF generation failed",
    });
  }
}
