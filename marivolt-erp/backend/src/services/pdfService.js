import puppeteerCore from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const DEFAULT_MARGIN = { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" };

function escapeBaseHref(url) {
  return String(url || "")
    .trim()
    .replace(/\/$/, "")
    .replace(/"/g, "%22");
}

/**
 * Ensures a full HTML document and injects <base href> so /brand/* assets resolve on the server.
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

function useSparticuzChromium() {
  return (
    process.env.PDF_USE_SPARTICUZ === "true" ||
    Boolean(process.env.RENDER) ||
    Boolean(process.env.RENDER_EXTERNAL_URL) ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME)
  );
}

async function launchBrowser() {
  const args = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"];

  if (useSparticuzChromium()) {
    return puppeteerCore.launch({
      args: [...chromium.args, ...args],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  }

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return puppeteerCore.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args,
    });
  }

  const puppeteer = await import("puppeteer");
  return puppeteer.default.launch({ headless: true, args });
}

/**
 * Generate a searchable text PDF from HTML using Puppeteer page.pdf().
 *
 * @param {string} html - Full or partial HTML document
 * @param {object} options
 * @param {string} [options.assetBaseUrl] - Frontend origin for logos (/brand/*)
 * @param {string} [options.format] - Paper format (default A4)
 * @param {boolean} [options.printBackground] - Default true
 * @param {object} [options.margin] - Page margins
 * @param {boolean} [options.landscape] - Landscape orientation
 * @param {number} [options.timeoutMs] - setContent timeout
 * @returns {Promise<Buffer>}
 */
export async function generatePdfFromHtml(html, options = {}) {
  const prepared = prepareHtmlForPdf(html, options.assetBaseUrl);
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    await page.setContent(prepared, {
      waitUntil: ["load", "networkidle0"],
      timeout: options.timeoutMs ?? 90000,
    });

    const pdfOptions = {
      format: options.format || "A4",
      printBackground: options.printBackground !== false,
      margin: options.margin || DEFAULT_MARGIN,
      preferCSSPageSize: Boolean(options.preferCSSPageSize),
      landscape: Boolean(options.landscape),
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
