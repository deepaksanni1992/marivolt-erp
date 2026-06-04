import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import { buildPdfExportCss } from "../constants/pdfExportCss.js";

const DEFAULT_MARGIN = { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" };

const PDF_EXPORT_VIEWPORT = { width: 1400, height: 1800, deviceScaleFactor: 1 };

const PDF_EXPORT_ITEM_MARGIN = {
  top: "10mm",
  right: "10mm",
  bottom: "12mm",
  left: "10mm",
};

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

function injectPdfExportStyles(doc, landscape = false) {
  if (/<style[^>]*id=["']pdf-export-styles["']/i.test(doc)) {
    return doc;
  }
  const exportCss = buildPdfExportCss(landscape);
  const styleTag = `<style id="pdf-export-styles">${exportCss}</style>`;
  if (/<head[\s>]/i.test(doc)) {
    return doc.replace(/<head([^>]*)>/i, `<head$1>${styleTag}`);
  }
  return doc.replace(
    /<html([^>]*)>/i,
    `<html$1><head><meta charset="utf-8"/>${styleTag}</head>`,
  );
}

function tagBodyForPdfExport(doc) {
  return doc.replace(/<body([^>]*)>/i, (match, attrs) => {
    if (/class\s*=/i.test(attrs)) {
      if (/pdf-export-page/i.test(attrs)) return match;
      return `<body${attrs.replace(/class=(["'])([^"']*)\1/i, (_, q, cls) => `class=${q}${cls} pdf-export-page${q}`)}>`;
    }
    return `<body${attrs} class="pdf-export-page">`;
  });
}

/**
 * Ensures a full HTML document, injects <base href> and export-only PDF layout CSS.
 */
export function prepareHtmlForPdf(html, assetBaseUrl = "", { landscape = false } = {}) {
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

  doc = injectPdfExportStyles(doc, landscape);
  doc = tagBodyForPdfExport(doc);
  return doc;
}

function isRenderHost() {
  return (
    process.env.PDF_USE_SPARTICUZ === "true" ||
    Boolean(process.env.RENDER) ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

/**
 * Resolve Chromium binary without installing full puppeteer (no Chrome download at npm install).
 */
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

/**
 * Generate a searchable text PDF from HTML using Puppeteer page.pdf().
 */
export async function generatePdfFromHtml(html, options = {}) {
  const landscape = Boolean(options.landscape);
  const prepared = prepareHtmlForPdf(html, options.assetBaseUrl, { landscape });
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setViewport(options.viewport || PDF_EXPORT_VIEWPORT);
    await page.setContent(prepared, {
      waitUntil: ["load", "networkidle0"],
      timeout: options.timeoutMs ?? 90000,
    });

    const overflowTables = await page.evaluate(() => {
      const sel =
        ".report-table, table.report-lines-table, table.po-lines-table, table.data-table";
      return [...document.querySelectorAll(sel)]
        .map((table, index) => ({
          index,
          scrollWidth: table.scrollWidth,
          clientWidth: table.clientWidth,
          className: table.className,
        }))
        .filter((t) => t.scrollWidth > t.clientWidth + 1);
    });
    if (overflowTables.length) {
      console.warn(
        "[reportPdf] Table wider than container (right border may clip):",
        overflowTables,
      );
    }

    const pdfOptions = {
      format: options.format || "A4",
      printBackground: options.printBackground !== false,
      margin: options.margin || (landscape ? PDF_EXPORT_ITEM_MARGIN : DEFAULT_MARGIN),
      preferCSSPageSize:
        options.preferCSSPageSize !== undefined
          ? Boolean(options.preferCSSPageSize)
          : landscape,
      landscape,
    };

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
