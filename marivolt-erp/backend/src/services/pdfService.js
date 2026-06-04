import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import {
  PDF_EXPORT_PAGE_HEIGHT,
  PDF_EXPORT_PAGE_WIDTH,
  PDF_EXPORT_WIDE_CSS,
} from "../constants/pdfExportCss.js";

/** Browser Print preview window (unchanged) */
export const PRINT_PREVIEW_VIEWPORT = { width: 1200, height: 900, deviceScaleFactor: 1 };

/** Viewport for wide export PDF layout (~420mm at 96dpi) */
export const PDF_EXPORT_VIEWPORT = { width: 1600, height: 900, deviceScaleFactor: 1 };

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

/**
 * HTML prep for PDF: base href for logos; optional wide export-only CSS (not Print preview).
 */
export function prepareHtmlForPdf(html, assetBaseUrl = "", { wideExport = false } = {}) {
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

  if (wideExport) {
    doc = injectWideExportStyles(doc);
    doc = tagBodyForWideExport(doc);
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
  console.log(`[reportPdf] ${label} layout metrics:`, metrics);
  if (metrics.tableOverflow) {
    console.warn(`[reportPdf] ${label}: table wider than container`, metrics);
  }
  return metrics;
}

/**
 * Generate a searchable text PDF from report HTML.
 */
export async function generatePdfFromHtml(html, options = {}) {
  const wideExport = Boolean(options.wideExport || (options.width && options.height));
  const prepared = prepareHtmlForPdf(html, options.assetBaseUrl, { wideExport });
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    const viewport = options.viewport || (wideExport ? PDF_EXPORT_VIEWPORT : PRINT_PREVIEW_VIEWPORT);
    await page.setViewport(viewport);
    await page.setContent(prepared, {
      waitUntil: ["load", "networkidle0"],
      timeout: options.timeoutMs ?? 90000,
    });

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

    const pdfBytes = await page.pdf(pdfOptions);
    return Buffer.from(pdfBytes);
  } finally {
    await browser.close();
  }
}

export { PDF_EXPORT_PAGE_WIDTH, PDF_EXPORT_PAGE_HEIGHT };
