/**
 * PDF-P1 — Shared Chromium browser + bounded concurrency for commercial PDF generation.
 * Narrow scope: not a general browser automation framework.
 */
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

export const PDF_ERROR_CODES = Object.freeze({
  PDF_QUEUE_TIMEOUT: "PDF_QUEUE_TIMEOUT",
  PDF_BROWSER_LAUNCH_FAILED: "PDF_BROWSER_LAUNCH_FAILED",
  PDF_BROWSER_DISCONNECTED: "PDF_BROWSER_DISCONNECTED",
  PDF_PAGE_RENDER_FAILED: "PDF_PAGE_RENDER_FAILED",
  PDF_RENDER_TIMEOUT: "PDF_RENDER_TIMEOUT",
});

export class PdfServiceError extends Error {
  constructor(code, message, { statusCode = 500 } = {}) {
    super(message || code);
    this.name = "PdfServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function getPdfConcurrencyConfig() {
  return {
    maxConcurrentPages: envInt("PDF_MAX_CONCURRENT_PAGES", 2),
    queueTimeoutMs: envInt("PDF_QUEUE_TIMEOUT_MS", 30000),
    renderTimeoutMs: envInt("PDF_RENDER_TIMEOUT_MS", 30000),
  };
}

function isRenderHost() {
  return (
    process.env.PDF_USE_SPARTICUZ === "true" ||
    Boolean(process.env.RENDER) ||
    Boolean(process.env.RENDER_EXTERNAL_URL)
  );
}

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

/** @type {import('puppeteer-core').Browser | null} */
let sharedBrowser = null;
/** @type {Promise<import('puppeteer-core').Browser> | null} */
let launchPromise = null;
let shutdownHooksRegistered = false;
let shuttingDown = false;

/** Concurrency semaphore */
let activePages = 0;
/** @type {Array<{ resolve: Function, reject: Function, enqueuedAt: number }>} */
const waitQueue = [];

export function __pdfManagerTestState() {
  return {
    hasBrowser: Boolean(sharedBrowser),
    browserConnected: Boolean(sharedBrowser?.isConnected?.()),
    launchPending: Boolean(launchPromise),
    activePages,
    queueLength: waitQueue.length,
    shuttingDown,
  };
}

async function resolveExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return chromium.executablePath();
}

async function launchNewBrowser() {
  try {
    const executablePath = await resolveExecutablePath();
    const onRender = isRenderHost();
    const browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: onRender ? [...chromium.args, ...LAUNCH_ARGS] : LAUNCH_ARGS,
      defaultViewport: null,
    });
    browser.on("disconnected", () => {
      if (sharedBrowser === browser) {
        sharedBrowser = null;
      }
    });
    return browser;
  } catch (err) {
    throw new PdfServiceError(
      PDF_ERROR_CODES.PDF_BROWSER_LAUNCH_FAILED,
      err?.message || "Failed to launch Chromium for PDF generation",
      { statusCode: 503 },
    );
  }
}

/**
 * Lazily acquire a healthy shared browser. Concurrent callers share one launch promise.
 */
export async function getBrowser() {
  if (shuttingDown) {
    throw new PdfServiceError(
      PDF_ERROR_CODES.PDF_BROWSER_DISCONNECTED,
      "PDF browser is shutting down",
      { statusCode: 503 },
    );
  }
  if (sharedBrowser?.isConnected()) {
    return { browser: sharedBrowser, launched: false };
  }
  sharedBrowser = null;
  if (!launchPromise) {
    launchPromise = launchNewBrowser()
      .then((b) => {
        sharedBrowser = b;
        return b;
      })
      .finally(() => {
        launchPromise = null;
      });
  }
  const browser = await launchPromise;
  if (!browser?.isConnected()) {
    sharedBrowser = null;
    throw new PdfServiceError(
      PDF_ERROR_CODES.PDF_BROWSER_DISCONNECTED,
      "PDF browser disconnected after launch",
      { statusCode: 503 },
    );
  }
  return { browser, launched: true };
}

export function clearSharedBrowser() {
  sharedBrowser = null;
}

/**
 * Acquire a concurrency slot (bounded queue). Always pair with releaseConcurrencySlot.
 */
export function acquireConcurrencySlot() {
  const { maxConcurrentPages, queueTimeoutMs } = getPdfConcurrencyConfig();
  if (activePages < maxConcurrentPages) {
    activePages += 1;
    return Promise.resolve({ queueWaitMs: 0 });
  }
  return new Promise((resolve, reject) => {
    const entry = {
      enqueuedAt: Date.now(),
      settle(ok, value) {
        if (entry._done) return;
        entry._done = true;
        clearTimeout(entry.timer);
        if (ok) resolve(value);
        else reject(value);
      },
      timer: null,
      _done: false,
    };
    entry.timer = setTimeout(() => {
      const idx = waitQueue.indexOf(entry);
      if (idx >= 0) waitQueue.splice(idx, 1);
      entry.settle(
        false,
        new PdfServiceError(
          PDF_ERROR_CODES.PDF_QUEUE_TIMEOUT,
          "PDF generation queue timed out — try again shortly",
          { statusCode: 503 },
        ),
      );
    }, queueTimeoutMs);
    waitQueue.push(entry);
  });
}

export function releaseConcurrencySlot() {
  activePages = Math.max(0, activePages - 1);
  pumpQueue();
}

function pumpQueue() {
  const { maxConcurrentPages } = getPdfConcurrencyConfig();
  while (activePages < maxConcurrentPages && waitQueue.length) {
    const next = waitQueue.shift();
    if (!next) break;
    activePages += 1;
    const waited = Date.now() - next.enqueuedAt;
    next.settle(true, { queueWaitMs: waited });
  }
}

/**
 * Run work with an isolated page. Closes the page in finally.
 * @param {(page: import('puppeteer-core').Page, meta: { browserLaunched: boolean, queueWaitMs: number, browserAcquireMs: number }) => Promise<T>} fn
 */
export async function withPdfPage(fn) {
  let slotAcquired = false;
  let queueWaitMs = 0;
  let page = null;
  let browserLaunched = false;
  let browserAcquireMs = 0;

  try {
    const slot = await acquireConcurrencySlot();
    slotAcquired = true;
    queueWaitMs = slot.queueWaitMs || 0;

    const t0 = Date.now();
    let browser;
    try {
      const got = await getBrowser();
      browser = got.browser;
      browserLaunched = got.launched;
    } catch (err) {
      throw err;
    }
    browserAcquireMs = Date.now() - t0;

    try {
      page = await browser.newPage();
    } catch (err) {
      // Browser-level failure — clear cache so next request relaunches
      clearSharedBrowser();
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      throw new PdfServiceError(
        PDF_ERROR_CODES.PDF_BROWSER_DISCONNECTED,
        err?.message || "Failed to open PDF page",
        { statusCode: 503 },
      );
    }

    return await fn(page, { browserLaunched, queueWaitMs, browserAcquireMs });
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
    if (slotAcquired) releaseConcurrencySlot();
  }
}

export async function shutdownBrowser() {
  shuttingDown = true;
  // Reject queued waiters
  while (waitQueue.length) {
    const entry = waitQueue.shift();
    try {
      entry.settle(
        false,
        new PdfServiceError(
          PDF_ERROR_CODES.PDF_BROWSER_DISCONNECTED,
          "PDF browser shutting down",
          { statusCode: 503 },
        ),
      );
    } catch {
      /* ignore */
    }
  }
  const b = sharedBrowser;
  sharedBrowser = null;
  if (b) {
    try {
      await b.close();
    } catch {
      /* ignore */
    }
  }
  shuttingDown = false;
}

export function registerPdfShutdownHooks() {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;
  const handler = () => {
    shutdownBrowser().catch(() => {});
  };
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}

/** Test-only: force reset manager state. */
export async function __resetPdfManagerForTests() {
  await shutdownBrowser();
  activePages = 0;
  waitQueue.length = 0;
  launchPromise = null;
  shuttingDown = false;
}
