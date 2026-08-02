/**
 * PDF-P1 — In-memory cache for known commercial report logos.
 * Loads bytes once from the frontend public/brand assets shipped with the monorepo.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Allowed brand logo paths (relative URL keys used in report HTML). */
export const KNOWN_BRAND_LOGO_PATHS = Object.freeze([
  "/brand/marivolt-icon.png",
  "/brand/okeanos-logo.png",
]);

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

/** @type {Map<string, { dataUri: string, bytes: number, sourcePath: string }>} */
const cache = new Map();

function resolvePublicBrandDir() {
  // backend/src/services → ../../public/brand (marivolt-erp/public/brand)
  return path.resolve(__dirname, "../../../public/brand");
}

function logoBasename(relPath) {
  return path.basename(String(relPath || "").replace(/\\/g, "/"));
}

/**
 * Resolve a known logo to a data URI (cached). Returns null if missing/unknown.
 */
export function getBrandLogoDataUri(relPath) {
  const key = normalizeLogoKey(relPath);
  if (!key) return null;
  if (cache.has(key)) return cache.get(key).dataUri;

  const basename = logoBasename(key);
  const filePath = path.join(resolvePublicBrandDir(), basename);
  try {
    if (!fs.existsSync(filePath)) {
      console.warn(`[pdfAssets] logo file missing: ${basename}`);
      return null;
    }
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_BY_EXT[ext] || "application/octet-stream";
    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    cache.set(key, { dataUri, bytes: buf.length, sourcePath: basename });
    return dataUri;
  } catch (err) {
    console.warn(`[pdfAssets] failed to load logo ${basename}:`, err?.message || err);
    return null;
  }
}

export function normalizeLogoKey(relPath) {
  const raw = String(relPath || "").trim();
  if (!raw) return "";
  // Accept absolute URL ending with known path, or relative /brand/...
  for (const known of KNOWN_BRAND_LOGO_PATHS) {
    if (raw === known || raw.endsWith(known) || raw.includes(known)) {
      return known;
    }
  }
  return "";
}

/**
 * Rewrite known logo src attributes to cached data URIs.
 * Leaves unknown images unchanged.
 */
export function embedKnownBrandLogosInHtml(html) {
  let doc = String(html || "");
  let embedded = 0;
  let missing = 0;

  for (const known of KNOWN_BRAND_LOGO_PATHS) {
    const dataUri = getBrandLogoDataUri(known);
    if (!dataUri) {
      // Count references that would have needed this logo
      const reCheck = new RegExp(known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      if (reCheck.test(doc)) missing += 1;
      continue;
    }
    // Match src="/brand/..." or src='...' or src without quotes ending path
    const escaped = known.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `(src\\s*=\\s*)(["'])([^"']*${escaped}[^"']*)\\2`,
      "gi",
    );
    const before = doc;
    doc = doc.replace(re, (_m, attr, quote) => {
      embedded += 1;
      return `${attr}${quote}${dataUri}${quote}`;
    });
    // Also bare path appearances in url(...) if any
    if (doc === before && doc.includes(known)) {
      doc = doc.split(known).join(dataUri);
      embedded += 1;
    }
  }

  return { html: doc, embedded, missing };
}

/** Test helper: clear cache. */
export function clearBrandLogoCache() {
  cache.clear();
}

export function brandLogoCacheStats() {
  return {
    entries: cache.size,
    keys: [...cache.keys()],
    totalBytes: [...cache.values()].reduce((s, v) => s + (v.bytes || 0), 0),
  };
}
