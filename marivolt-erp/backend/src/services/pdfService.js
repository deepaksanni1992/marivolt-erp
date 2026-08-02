import {
  PDF_EXPORT_PAGE_HEIGHT,
  PDF_EXPORT_PAGE_WIDTH,
  PDF_EXPORT_WIDE_CSS,
} from "../constants/pdfExportCss.js";
import { embedKnownBrandLogosInHtml } from "./pdfAssetCache.js";
import {
  PDF_ERROR_CODES,
  PdfServiceError,
  clearSharedBrowser,
  getPdfConcurrencyConfig,
  withPdfPage,
} from "./pdfBrowserManager.js";

/** Browser Print preview window (unchanged) */
export const PRINT_PREVIEW_VIEWPORT = { width: 1200, height: 900, deviceScaleFactor: 1 };

/** Viewport for wide export PDF layout (~420mm at 96dpi) */
export const PDF_EXPORT_VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1 };

function escapeBaseHref(url) {
  return String(url || "")
    .trim()
    .replace(/\/$/, "")
    .replace(/"/g, "%22");
}

function injectWideExportStyles(doc) {
  if (/<style[^>]*id=["']pdf-export-wide-styles["']/i.test(doc)) {
    return doc;
  }
  const styleTag = `<style id="pdf-export-wide-styles">${PDF_EXPORT_WIDE_CSS}</style>`;
  if (/<\/head>/i.test(doc)) {
    return doc.replace(/<\/head>/i, `${styleTag}</head>`);
  }
  return doc.replace(
    /<html([^>]*)>/i,
    `<html$1><head><meta charset="utf-8"/>${styleTag}</head>`,
  );
}

function tagBodyForWideExport(doc) {
  return doc.replace(/<body([^>]*)>/i, (match, attrs) => {
    if (/class\s*=/i.test(attrs)) {
      if (/pdf-export-page/i.test(attrs)) return match;
      return `<body${attrs.replace(/class=(["'])([^"']*)\1/i, (_, q, cls) => `class=${q}${cls} pdf-export-page${q}`)}>`;
    }
    return `<body${attrs} class="pdf-export-page">`;
  });
}

function timingLogsEnabled() {
  const v = String(process.env.PDF_TIMING_LOGS || "true").toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

function logPdfTiming(payload) {
  if (!timingLogsEnabled()) return;
  console.log("[reportPdf][timing]", JSON.stringify(payload));
}

/**
 * HTML prep for PDF: embed known logos as data URIs; optional base href; wide export CSS.
 */
export function prepareHtmlForPdf(html, assetBaseUrl = "", { wideExport = false } = {}) {
  let doc = String(html || "").trim();
  if (!doc) {
    throw new Error("HTML content is required");
  }

  const { html: withLogos, embedded, missing } = embedKnownBrandLogosInHtml(doc);
  doc = withLogos;

  const base =
    String(assetBaseUrl || "").trim() ||
    String(process.env.CLIENT_URL || process.env.FRONTEND_URL || "").trim();
  // Prefer omitting remote base when logos are embedded (avoids Vercel round-trips).
  // Keep base only when logos were not fully embedded and a base is available.
  const needRemoteBase = missing > 0 && Boolean(base);
  const baseTag = needRemoteBase ? `<base href="${escapeBaseHref(base)}/">` : "";

  if (!/<!doctype/i.test(doc) && !/<html[\s>]/i.test(doc)) {
    doc = `<!DOCTYPE html><html><head><meta charset="utf-8"/>${baseTag}</head><body>${doc}</body></html>`;
  } else if (baseTag && !/<base\s/i.test(doc)) {
    if (/<head[\s>]/i.test(doc)) {
      doc = doc.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
    } else {
      doc = doc.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8"/>${baseTag}</head>`);
    }
  }

  if (wideExport) {
    doc = injectWideExportStyles(doc);
    doc = tagBodyForWideExport(doc);
  }

  return { html: doc, logosEmbedded: embedded, logosMissing: missing };
}

/**
 * Block unexpected network: allow only about:/data:/blob: (embedded assets).
 */
async function installRequestGuard(page) {
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    try {
      const url = String(req.url() || "");
      if (
        url.startsWith("data:") ||
        url.startsWith("about:") ||
        url.startsWith("blob:")
      ) {
        req.continue();
        return;
      }
      // Allow document main frame from setContent (often about:blank then data)
      if (req.isNavigationRequest() && (url === "about:blank" || url.startsWith("data:"))) {
        req.continue();
        return;
      }
      req.abort("blockedbyclient");
    } catch {
      try {
        req.abort("failed");
      } catch {
        /* ignore */
      }
    }
  });
}

/**
 * Deterministic readiness: fonts + existing images with bounded wait.
 */
export async function waitForPdfDocumentReady(page, { imageTimeoutMs = 2000 } = {}) {
  await page.evaluate(async (imgTimeout) => {
    try {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
    } catch {
      /* ignore font wait failures */
    }
    const imgs = Array.from(document.images || []);
    await Promise.all(
      imgs.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          const done = () => resolve();
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
          setTimeout(done, imgTimeout);
        });
      }),
    );
    // Optional marker for future reports
    const marker = document.querySelector("[data-report-ready], .report-ready");
    if (marker) {
      /* present — nothing else to wait */
    }
  }, imageTimeoutMs);
}

async function logPrintLayoutMetrics(page, label = "export") {
  const metrics = await page.evaluate(() => {
    const container =
      document.querySelector(".print-page") ||
      document.querySelector(".print-body") ||
      document.body;
    const table = document.querySelector(
      ".report-table, table.report-lines-table, table.po-lines-table, table.data-table",
    );
    const tableClientWidth = table?.clientWidth ?? 0;
    const tableScrollWidth = table?.scrollWidth ?? 0;
    return {
      viewportWidth: window.innerWidth,
      containerClientWidth: container?.clientWidth ?? 0,
      tableClientWidth,
      tableScrollWidth,
      tableOverflow: tableScrollWidth > tableClientWidth + 1,
      tableClassName: table?.className ?? "",
    };
  });
  if (timingLogsEnabled()) {
    console.log(`[reportPdf] ${label} layout metrics:`, metrics);
  }
  if (metrics.tableOverflow) {
    console.warn(`[reportPdf] ${label}: table wider than container`, metrics);
  }
  return metrics;
}

function isBrowserLevelFailure(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    err?.code === PDF_ERROR_CODES.PDF_BROWSER_DISCONNECTED ||
    err?.code === PDF_ERROR_CODES.PDF_BROWSER_LAUNCH_FAILED ||
    msg.includes("target closed") ||
    msg.includes("session closed") ||
    msg.includes("browser has disconnected") ||
    msg.includes("protocol error")
  );
}

/**
 * Generate a searchable text PDF from report HTML (shared Chromium + page isolation).
 */
export async function generatePdfFromHtml(html, options = {}) {
  const wideExport = Boolean(options.wideExport || (options.width && options.height));
  const { renderTimeoutMs } = getPdfConcurrencyConfig();
  const timeoutMs = options.timeoutMs ?? renderTimeoutMs;

  const prepared = prepareHtmlForPdf(html, options.assetBaseUrl, { wideExport });
  const preparedHtml = prepared.html;
  const htmlBytes = Buffer.byteLength(preparedHtml, "utf8");
  const reportType = String(options.reportType || options.filename || "report").slice(0, 80);

  const tTotal0 = Date.now();
  let pageCreateMs = 0;
  let setContentMs = 0;
  let fontsImagesReadyMs = 0;
  let pdfGenerateMs = 0;
  let pageCloseMs = 0;
  let pageCount = null;
  let success = false;
  let errorCode = null;

  try {
    const pdfBuffer = await withPdfPage(async (page, meta) => {
      const tPage0 = Date.now();
      const viewport = options.viewport || (wideExport ? PDF_EXPORT_VIEWPORT : PRINT_PREVIEW_VIEWPORT);
      await page.setViewport(viewport);
      page.setDefaultTimeout(timeoutMs);
      await installRequestGuard(page);
      pageCreateMs = Date.now() - tPage0;

      try {
        const tContent0 = Date.now();
        await page.setContent(preparedHtml, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
        setContentMs = Date.now() - tContent0;

        const tReady0 = Date.now();
        await waitForPdfDocumentReady(page, { imageTimeoutMs: 2000 });
        fontsImagesReadyMs = Date.now() - tReady0;

        await page.emulateMediaType("print");
        await logPrintLayoutMetrics(page, wideExport ? "wide-export" : "export");

        const pdfOptions = {
          printBackground: options.printBackground !== false,
          preferCSSPageSize: options.preferCSSPageSize !== false,
        };

        if (options.width && options.height) {
          pdfOptions.width = options.width;
          pdfOptions.height = options.height;
          pdfOptions.margin = options.margin || {
            top: "8mm",
            right: "8mm",
            bottom: "10mm",
            left: "8mm",
          };
        } else {
          pdfOptions.format = options.format || "A4";
          pdfOptions.landscape = Boolean(options.landscape);
          if (options.margin) {
            pdfOptions.margin = options.margin;
          }
        }

        const tPdf0 = Date.now();
        const pdfBytes = await page.pdf(pdfOptions);
        pdfGenerateMs = Date.now() - tPdf0;

        try {
          pageCount = await page.evaluate(() => {
            // Best-effort; Chromium may not expose page count pre-pdf
            return null;
          });
        } catch {
          pageCount = null;
        }

        success = true;
        logPdfTiming({
          reportType,
          queueWaitMs: meta.queueWaitMs,
          browserAcquireMs: meta.browserAcquireMs,
          browserLaunched: meta.browserLaunched,
          pageCreateMs,
          setContentMs,
          fontsImagesReadyMs,
          pdfGenerateMs,
          pageCloseMs: 0,
          totalMs: Date.now() - tTotal0,
          htmlBytes,
          pageCount,
          logosEmbedded: prepared.logosEmbedded,
          logosMissing: prepared.logosMissing,
          success: true,
        });

        return Buffer.from(pdfBytes);
      } catch (err) {
        if (isBrowserLevelFailure(err)) {
          clearSharedBrowser();
        }
        if (err instanceof PdfServiceError) throw err;
        const timedOut =
          String(err?.message || "").toLowerCase().includes("timeout") ||
          err?.name === "TimeoutError";
        throw new PdfServiceError(
          timedOut ? PDF_ERROR_CODES.PDF_RENDER_TIMEOUT : PDF_ERROR_CODES.PDF_PAGE_RENDER_FAILED,
          timedOut ? "PDF render timed out" : "PDF page render failed",
          { statusCode: timedOut ? 504 : 500 },
        );
      } finally {
        const tClose0 = Date.now();
        // page closed by withPdfPage; record approximate
        pageCloseMs = Date.now() - tClose0;
      }
    });

    return pdfBuffer;
  } catch (err) {
    errorCode = err?.code || PDF_ERROR_CODES.PDF_PAGE_RENDER_FAILED;
    logPdfTiming({
      reportType,
      queueWaitMs: err?.queueWaitMs,
      browserAcquireMs: undefined,
      browserLaunched: undefined,
      pageCreateMs,
      setContentMs,
      fontsImagesReadyMs,
      pdfGenerateMs,
      pageCloseMs,
      totalMs: Date.now() - tTotal0,
      htmlBytes,
      pageCount,
      logosEmbedded: prepared.logosEmbedded,
      logosMissing: prepared.logosMissing,
      success: false,
      errorCode,
    });
    throw err;
  }
}

export { PDF_EXPORT_PAGE_WIDTH, PDF_EXPORT_PAGE_HEIGHT, PDF_ERROR_CODES, PdfServiceError };
