import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

/** Same window size as openReportHtmlPreview() in reportPdfClient.js */
export const PRINT_PREVIEW_VIEWPORT = { width: 1200, height: 900, deviceScaleFactor: 1 };

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
];

function escapeBaseHref(url) {
  return String(url || "")
    .trim()
    .replace(/\/$/, "")
    .replace(/"/g, "%22");
}

/**
 * Minimal HTML prep for PDF: same document as Print preview, plus <base href> for logos only.
 * Does not inject PDF-specific layout CSS (that diverged from Print).
 */
export function prepareHtmlForPdf(html, assetBaseUrl = "") {
  let doc = String(html || "").trim();
  if (!doc) {
    throw new Error("HTML content is required");
  }

  const base =
    String(assetBaseUrl || "").trim() ||
    String(process.env.CLIENT_URL || process.env.FRONTEND_URL || "").trim();
  const baseTag = base ? `<base href="${escapeBaseHref(base)}/">` : "";

  if (!/<!doctype/i.test(doc) && !/<html[\s>]/i.test(doc)) {
    doc = `<!DOCTYPE html><html><head><meta charset="utf-8"/>${baseTag}</head><body>${doc}</body></html>`;
  } else if (baseTag && !/<base\s/i.test(doc)) {
    if (/<head[\s>]/i.test(doc)) {
      doc = doc.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
    } else {
      doc = doc.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8"/>${baseTag}</head>`);
    }
  }

  return doc;
}

function isRenderHost() {
  return (
    process.env.PDF_USE_SPARTICUZ === "true" ||
    Boolean(process.env.RENDER) ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

async function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return chromium.executablePath();
}

async function launchBrowser() {
  const executablePath = await resolveExecutablePath();
  const onRender = isRenderHost();

  return puppeteer.launch({
    headless: true,
    executablePath,
    args: onRender ? [...chromium.args, ...LAUNCH_ARGS] : LAUNCH_ARGS,
    defaultViewport: null,
  });
}

async function logPrintLayoutMetrics(page) {
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
  console.log("[reportPdf] print-layout metrics:", metrics);
  if (metrics.tableOverflow) {
    console.warn(
      "[reportPdf] table.scrollWidth > table.clientWidth — export may not match Print preview",
      metrics,
    );
  }
  return metrics;
}

/**
 * Generate a searchable text PDF from the same HTML/CSS as browser Print preview.
 */
export async function generatePdfFromHtml(html, options = {}) {
  const prepared = prepareHtmlForPdf(html, options.assetBaseUrl);
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    const viewport = options.viewport || PRINT_PREVIEW_VIEWPORT;
    await page.setViewport(viewport);
    await page.setContent(prepared, {
      waitUntil: ["load", "networkidle0"],
      timeout: options.timeoutMs ?? 90000,
    });

    // Apply the same @media print rules as the browser Print dialog
    await page.emulateMediaType("print");
    await logPrintLayoutMetrics(page);

    const preferCSSPageSize = options.preferCSSPageSize !== false;
    const pdfOptions = {
      format: options.format || "A4",
      printBackground: options.printBackground !== false,
      preferCSSPageSize,
      landscape: Boolean(options.landscape),
    };

    if (!preferCSSPageSize && options.margin) {
      pdfOptions.margin = options.margin;
    }

    if (options.width && options.height) {
      delete pdfOptions.format;
      pdfOptions.width = options.width;
      pdfOptions.height = options.height;
    }

    const pdfBytes = await page.pdf(pdfOptions);
    return Buffer.from(pdfBytes);
  } finally {
    await browser.close();
  }
}
