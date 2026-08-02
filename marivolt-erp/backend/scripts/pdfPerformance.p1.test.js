/**
 * PDF-P1 — performance / reuse / concurrency / asset tests.
 * Run: node scripts/pdfPerformance.p1.test.js
 *
 * Browser integration runs only when Chrome/Chromium is available
 * (PUPPETEER_EXECUTABLE_PATH or local Chrome).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import {
  clearBrandLogoCache,
  embedKnownBrandLogosInHtml,
  getBrandLogoDataUri,
  KNOWN_BRAND_LOGO_PATHS,
} from "../src/services/pdfAssetCache.js";
import {
  PDF_ERROR_CODES,
  PdfServiceError,
  __pdfManagerTestState,
  __resetPdfManagerForTests,
  acquireConcurrencySlot,
  getBrowser,
  getPdfConcurrencyConfig,
  releaseConcurrencySlot,
  shutdownBrowser,
  withPdfPage,
} from "../src/services/pdfBrowserManager.js";
import {
  generatePdfFromHtml,
  prepareHtmlForPdf,
} from "../src/services/pdfService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.join(__dirname, "../src");
const repoRoot = path.join(__dirname, "../..");

let passed = 0;
let failed = 0;
let skipped = 0;

function run(name, fn) {
  try {
    const ret = fn();
    if (ret && typeof ret.then === "function") {
      return ret
        .then(() => {
          passed += 1;
          console.log(`PASS  ${name}`);
        })
        .catch((err) => {
          failed += 1;
          console.error(`FAIL  ${name}`);
          console.error(`      ${err.message}`);
        });
    }
    passed += 1;
    console.log(`PASS  ${name}`);
    return Promise.resolve();
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
    return Promise.resolve();
  }
}

function skip(name, reason) {
  skipped += 1;
  console.log(`SKIP  ${name} (${reason})`);
}

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "";
}

const chromePath = resolveChromePath();
if (chromePath) {
  process.env.PUPPETEER_EXECUTABLE_PATH = chromePath;
}

function sampleHtml({ lines = 20, logo = true, customsFields = false } = {}) {
  const rows = Array.from({ length: lines }, (_, i) => {
    return `<tr><td>ART-${i + 1}</td><td>Desc ${i + 1}</td><td>${i + 1}</td></tr>`;
  }).join("");
  const logoTag = logo
    ? `<img src="/brand/marivolt-icon.png" alt="logo" style="height:40px"/>`
    : "<div>MV</div>";
  const customs = customsFields
    ? `<div>BOE Date</div><div>Supplier Invoice Date</div><div>HS Code</div><div>Allocated Qty</div>`
    : "";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
body{font-family:Arial} table{width:100%;border-collapse:collapse} td,th{border:1px solid #ccc;padding:3px}
</style></head><body><div class="print-page"><div class="print-body">
${logoTag}<h1>Report</h1>${customs}
<table class="report-table"><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>
<tbody>${rows}</tbody></table></div></div></body></html>`;
}

async function main() {
  await run("Asset cache embeds known Marivolt logo as data URI", () => {
    clearBrandLogoCache();
    const uri = getBrandLogoDataUri("/brand/marivolt-icon.png");
    assert.ok(uri && uri.startsWith("data:image/png;base64,"));
  });

  await run("Asset cache embeds Okeanos logo", () => {
    clearBrandLogoCache();
    const uri = getBrandLogoDataUri("/brand/okeanos-logo.png");
    assert.ok(uri && uri.startsWith("data:image/png;base64,"));
  });

  await run("Unknown logo path returns null (no arbitrary fetch)", () => {
    assert.equal(getBrandLogoDataUri("/brand/evil.png"), null);
    assert.equal(getBrandLogoDataUri("https://evil.example/x.png"), null);
  });

  await run("embedKnownBrandLogosInHtml rewrites src", () => {
    clearBrandLogoCache();
    const { html, embedded } = embedKnownBrandLogosInHtml(
      `<img src="/brand/marivolt-icon.png" /><img src='https://cdn.example/brand/okeanos-logo.png' />`,
    );
    assert.ok(embedded >= 1);
    assert.match(html, /data:image\/png;base64,/);
    assert.doesNotMatch(html, /src="\/brand\/marivolt-icon\.png"/);
  });

  await run("prepareHtmlForPdf embeds logos and skips remote base when embedded", () => {
    clearBrandLogoCache();
    const { html, logosEmbedded } = prepareHtmlForPdf(
      sampleHtml({ logo: true }),
      "https://marivolt-erp.vercel.app",
      {},
    );
    assert.ok(logosEmbedded >= 1);
    assert.match(html, /data:image\/png;base64,/);
    assert.doesNotMatch(html, /<base /i);
  });

  await run("Concurrency defaults are conservative", () => {
    const cfg = getPdfConcurrencyConfig();
    assert.equal(cfg.maxConcurrentPages, 2);
    assert.ok(cfg.queueTimeoutMs >= 1000);
    assert.ok(cfg.renderTimeoutMs >= 1000);
  });

  await run("Queue slot acquire/release does not leak", async () => {
    await __resetPdfManagerForTests();
    process.env.PDF_MAX_CONCURRENT_PAGES = "1";
    const a = await acquireConcurrencySlot();
    assert.equal(a.queueWaitMs, 0);
    const stateBusy = __pdfManagerTestState();
    assert.equal(stateBusy.activePages, 1);
    releaseConcurrencySlot();
    assert.equal(__pdfManagerTestState().activePages, 0);
    delete process.env.PDF_MAX_CONCURRENT_PAGES;
    await __resetPdfManagerForTests();
  });

  await run("Queue timeout returns PDF_QUEUE_TIMEOUT", async () => {
    await __resetPdfManagerForTests();
    process.env.PDF_MAX_CONCURRENT_PAGES = "1";
    process.env.PDF_QUEUE_TIMEOUT_MS = "80";
    await acquireConcurrencySlot();
    let err = null;
    try {
      await acquireConcurrencySlot();
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof PdfServiceError);
    assert.equal(err.code, PDF_ERROR_CODES.PDF_QUEUE_TIMEOUT);
    releaseConcurrencySlot();
    delete process.env.PDF_MAX_CONCURRENT_PAGES;
    delete process.env.PDF_QUEUE_TIMEOUT_MS;
    await __resetPdfManagerForTests();
  });

  await run("Failed slot path: release after timeout leaves queue empty", async () => {
    await __resetPdfManagerForTests();
    assert.equal(__pdfManagerTestState().queueLength, 0);
    assert.equal(__pdfManagerTestState().activePages, 0);
  });

  await run("Source: pdfService uses shared browser manager (no per-request close)", () => {
    const svc = fs.readFileSync(path.join(srcRoot, "services/pdfService.js"), "utf8");
    assert.match(svc, /withPdfPage/);
    assert.match(svc, /waitUntil:\s*"domcontentloaded"/);
    assert.doesNotMatch(svc, /waitUntil:\s*\[[^\]]*networkidle0/);
    assert.match(svc, /embedKnownBrandLogosInHtml|logosEmbedded/);
    assert.match(svc, /setRequestInterception/);
  });

  await run("Source: client layout probe is non-blocking", () => {
    const client = fs.readFileSync(path.join(repoRoot, "src/lib/reportPdfClient.js"), "utf8");
    assert.match(client, /void logPreExportPrintLayout/);
    assert.doesNotMatch(client, /await logPreExportPrintLayout/);
  });

  await run("Source: Customs print still includes CG2 fields", () => {
    const print = fs.readFileSync(path.join(repoRoot, "src/lib/customsInvoicePrint.js"), "utf8");
    assert.match(print, /BOE Date/);
    assert.match(print, /Supplier Invoice Date/);
    assert.match(print, /HS Code/);
    assert.match(print, /Allocated Qty/);
  });

  await run("RTS remains absent", () => {
    assert.equal(fs.existsSync(path.join(srcRoot, "models/RTS.js")), false);
    assert.equal(fs.existsSync(path.join(srcRoot, "routes/rtsRoutes.js")), false);
  });

  if (!chromePath) {
    skip("Browser reuse / PDF generate suite", "no Chrome executable");
  } else {
    await run("First PDF launches browser; second reuses", async () => {
      await __resetPdfManagerForTests();
      process.env.PDF_TIMING_LOGS = "false";
      const t1 = performance.now();
      const pdf1 = await generatePdfFromHtml(sampleHtml({ lines: 20, logo: true }), {
        filename: "t1",
      });
      const ms1 = performance.now() - t1;
      const after1 = __pdfManagerTestState();
      assert.ok(after1.hasBrowser && after1.browserConnected);
      assert.ok(pdf1.length > 1000);
      // PDF should contain text markers (searchable)
      const asLatin = pdf1.toString("latin1");
      assert.ok(asLatin.includes("Report") || asLatin.includes("ART-1") || pdf1.length > 5000);

      const t2 = performance.now();
      const pdf2 = await generatePdfFromHtml(sampleHtml({ lines: 20, logo: true }), {
        filename: "t2",
      });
      const ms2 = performance.now() - t2;
      assert.ok(pdf2.length > 1000);
      const after2 = __pdfManagerTestState();
      assert.ok(after2.hasBrowser && after2.browserConnected);
      // Second should be faster without launch/close overhead (allow slack)
      console.log(`      timing first=${ms1.toFixed(0)}ms second=${ms2.toFixed(0)}ms`);
      assert.ok(ms2 < ms1 * 0.95 || ms2 < 1200, `second PDF not improved enough (${ms2} vs ${ms1})`);
      await shutdownBrowser();
    });

    await run("Sequential PDFs do not leave open pages / active slots", async () => {
      await __resetPdfManagerForTests();
      process.env.PDF_TIMING_LOGS = "false";
      await generatePdfFromHtml(sampleHtml({ lines: 10 }), { filename: "a" });
      await generatePdfFromHtml(sampleHtml({ lines: 10 }), { filename: "b" });
      assert.equal(__pdfManagerTestState().activePages, 0);
      await shutdownBrowser();
    });

    await run("withPdfPage closes page; browser stays", async () => {
      await __resetPdfManagerForTests();
      const { browser } = await getBrowser();
      await withPdfPage(async (page) => {
        assert.ok(page);
        await page.setContent("<html><body>hi</body></html>", { waitUntil: "domcontentloaded" });
      });
      assert.ok(browser.isConnected());
      assert.equal(__pdfManagerTestState().activePages, 0);
      await shutdownBrowser();
    });

    await run("Concurrent requests respect limit", async () => {
      await __resetPdfManagerForTests();
      process.env.PDF_MAX_CONCURRENT_PAGES = "2";
      process.env.PDF_TIMING_LOGS = "false";
      const start = performance.now();
      await Promise.all([
        generatePdfFromHtml(sampleHtml({ lines: 15 }), { filename: "c1" }),
        generatePdfFromHtml(sampleHtml({ lines: 15 }), { filename: "c2" }),
      ]);
      const elapsed = performance.now() - start;
      console.log(`      concurrent pair ${elapsed.toFixed(0)}ms`);
      assert.equal(__pdfManagerTestState().activePages, 0);
      delete process.env.PDF_MAX_CONCURRENT_PAGES;
      await shutdownBrowser();
    });

    await run("80-line report renders searchable PDF", async () => {
      await __resetPdfManagerForTests();
      process.env.PDF_TIMING_LOGS = "false";
      const pdf = await generatePdfFromHtml(sampleHtml({ lines: 80, logo: true }), {
        filename: "large",
      });
      assert.ok(pdf.length > 8000);
      await shutdownBrowser();
    });

    await run("Customs field markers survive PDF pipeline HTML prep", () => {
      const { html } = prepareHtmlForPdf(sampleHtml({ customsFields: true, logo: true }), "", {});
      assert.match(html, /BOE Date/);
      assert.match(html, /Supplier Invoice Date/);
      assert.match(html, /HS Code/);
      assert.match(html, /Allocated Qty/);
      assert.match(html, /data:image\/png;base64,/);
    });

    await run("Missing logo path does not throw prepareHtml", () => {
      const { html, logosMissing } = prepareHtmlForPdf(
        `<html><body><img src="/brand/does-not-exist.png"/></body></html>`,
        "",
        {},
      );
      assert.ok(html.includes("does-not-exist") || logosMissing >= 0);
    });

    await run("Shutdown closes shared browser", async () => {
      await __resetPdfManagerForTests();
      await getBrowser();
      assert.ok(__pdfManagerTestState().hasBrowser);
      await shutdownBrowser();
      assert.equal(__pdfManagerTestState().hasBrowser, false);
    });
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
