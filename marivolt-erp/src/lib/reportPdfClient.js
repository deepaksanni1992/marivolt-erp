import { api } from "./api.js";
import {
  findOverflowingReportTables,
  logReportTableOverflowCheck,
  PRINT_PREVIEW_VIEWPORT_WIDTH,
} from "./reportTableLayout.js";

function sanitizeFilename(name) {
  const base = String(name || "report")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.endsWith(".pdf") ? base : `${base || "report"}.pdf`;
}

/**
 * Measure layout in a hidden iframe at the same width as Print preview (1200px).
 */
export function logPreExportPrintLayout(html) {
  if (typeof document === "undefined") return Promise.resolve(null);

  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("title", "report-pdf-layout-probe");
    iframe.style.cssText = `position:fixed;left:-9999px;top:0;width:${PRINT_PREVIEW_VIEWPORT_WIDTH}px;height:900px;border:0;visibility:hidden;pointer-events:none`;
    document.body.appendChild(iframe);

    const finish = () => {
      try {
        const idoc = iframe.contentDocument;
        const container =
          idoc?.querySelector(".print-page") ||
          idoc?.querySelector(".print-body") ||
          idoc?.body;
        const table = idoc?.querySelector(
          ".report-table, table.report-lines-table, table.po-lines-table, table.data-table",
        );
        const metrics = {
          containerClientWidth: container?.clientWidth ?? 0,
          tableClientWidth: table?.clientWidth ?? 0,
          tableScrollWidth: table?.scrollWidth ?? 0,
          tableOverflow:
            (table?.scrollWidth ?? 0) > (table?.clientWidth ?? 0) + 1,
        };
        console.log("[reportPdf] client pre-export layout (print preview width):", metrics);
        if (metrics.tableOverflow) {
          console.warn(
            "[reportPdf] table.scrollWidth > table.clientWidth before export",
            metrics,
          );
        }
        resolve(metrics);
      } catch (e) {
        console.warn("[reportPdf] pre-export layout probe failed:", e);
        resolve(null);
      } finally {
        document.body.removeChild(iframe);
      }
    };

    let done = false;
    const runOnce = () => {
      if (done) return;
      done = true;
      finish();
    };
    iframe.onload = runOnce;
    const idoc = iframe.contentDocument;
    idoc.open();
    idoc.write(html);
    idoc.close();
    requestAnimationFrame(runOnce);
  });
}

/**
 * Request a searchable text PDF from the backend (Puppeteer page.pdf).
 * Uses the same HTML as Print preview; server applies print media + matching viewport.
 *
 * Layout probe: diagnostic only and non-blocking (PDF-P1). Does not delay download.
 * Set options.probeLayout=true to force a fire-and-forget probe log.
 */
export async function downloadSearchableReportPdf({
  html,
  filename = "report",
  options = {},
}) {
  const assetBaseUrl =
    typeof window !== "undefined" ? window.location.origin : "";

  // PDF-P1: do not await — probe must never block PDF generation.
  const isDev =
    typeof import.meta !== "undefined" &&
    import.meta.env &&
    Boolean(import.meta.env.DEV);
  if (options.probeLayout === true || isDev) {
    void logPreExportPrintLayout(html);
  }

  const res = await api.post(
    "/reports/pdf",
    {
      html,
      filename,
      assetBaseUrl,
      options: {
        printBackground: true,
        preferCSSPageSize: true,
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
  const win = window.open("", "_blank", `width=${PRINT_PREVIEW_VIEWPORT_WIDTH},height=900`);
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
    const issues = findOverflowingReportTables(win.document);
    const container =
      win.document.querySelector(".print-page") ||
      win.document.querySelector(".print-body");
    const table = win.document.querySelector(
      ".report-table, table.report-lines-table, table.po-lines-table, table.data-table",
    );
    console.log("[reportPdf] print preview layout:", {
      containerClientWidth: container?.clientWidth,
      tableClientWidth: table?.clientWidth,
      tableScrollWidth: table?.scrollWidth,
      overflow: issues.length > 0,
    });
  });
  return win;
}

/**
 * Deliver a report: searchable PDF download (exportPdf) or print preview window.
 * Both paths use the same html string — no alternate PDF report template.
 */
export function deliverReportHtml(html, { exportPdf = false, filename = "report", pdfOptions = {} } = {}) {
  if (exportPdf) {
    return downloadSearchableReportPdf({ html, filename, options: pdfOptions });
  }
  openReportHtmlPreview(html);
  return Promise.resolve();
}
