import { api } from "./api.js";
import { logReportTableOverflowCheck } from "./reportTableLayout.js";

function sanitizeFilename(name) {
  const base = String(name || "report")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.endsWith(".pdf") ? base : `${base || "report"}.pdf`;
}

/**
 * Request a searchable text PDF from the backend (Puppeteer page.pdf).
 */
export async function downloadSearchableReportPdf({
  html,
  filename = "report",
  options = {},
}) {
  const assetBaseUrl =
    typeof window !== "undefined" ? window.location.origin : "";

  const res = await api.post(
    "/reports/pdf",
    {
      html,
      filename,
      assetBaseUrl,
      options: {
        format: "A4",
        printBackground: true,
        ...options,
      },
    },
    { responseType: "blob", timeout: 120000 },
  );

  const blob = res.data;
  const contentType = String(res.headers?.["content-type"] || blob?.type || "");
  if (!(blob instanceof Blob) || contentType.includes("application/json")) {
    let message = "PDF generation failed";
    try {
      const text = await blob.text();
      const parsed = JSON.parse(text);
      message = parsed.message || message;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }

  const downloadName = sanitizeFilename(filename);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = downloadName;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Open report HTML in a new tab for browser print preview (physical printer). */
export function openReportHtmlPreview(html) {
  const win = window.open("", "_blank", "width=1200,height=900");
  if (!win) {
    window.alert(
      "Your browser blocked the pop-up. Allow pop-ups for this site to print or preview the report.",
    );
    return null;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  win.addEventListener("load", () => {
    logReportTableOverflowCheck(win.document);
  });
  return win;
}

/**
 * Deliver a report: searchable PDF download (exportPdf) or print preview window.
 * @param {string} html
 * @param {{ exportPdf?: boolean, filename?: string, pdfOptions?: object }} opts
 */
export function deliverReportHtml(html, { exportPdf = false, filename = "report", pdfOptions = {} } = {}) {
  if (exportPdf) {
    return downloadSearchableReportPdf({ html, filename, options: pdfOptions });
  }
  openReportHtmlPreview(html);
  return Promise.resolve();
}
