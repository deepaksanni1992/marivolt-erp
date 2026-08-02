import {
  generatePdfFromHtml,
  PdfServiceError,
  PDF_ERROR_CODES,
} from "../services/pdfService.js";

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
      filename,
      reportType: filename || "report",
      ...(options && typeof options === "object" ? options : {}),
    });

    const file = safeFilename(filename);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${file}"`);
    res.setHeader("Content-Length", String(buffer.length));
    return res.send(buffer);
  } catch (err) {
    const code = err?.code || PDF_ERROR_CODES.PDF_PAGE_RENDER_FAILED;
    const status =
      err instanceof PdfServiceError
        ? err.statusCode || 500
        : code === PDF_ERROR_CODES.PDF_QUEUE_TIMEOUT
          ? 503
          : 500;
    console.error("[reportPdf] generation failed:", code, err?.message || err);
    return res.status(status).json({
      message: err?.message || "PDF generation failed",
      code,
    });
  }
}
