/**
 * Download / validate WinSW binary for Marivolt Print Agent.
 * Does not embed secrets. Binary is gitignored.
 *
 * Prefer reusing a local checksum-valid binary over downloading.
 */
import fs from "fs";
import https from "https";
import http from "http";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";
import {
  SERVICE_BIN_DIR,
  WINSW_EXE_NAME,
  getBundledWinswPath,
  getWinswExePath,
  getServiceRuntimeDir,
} from "./common.mjs";
import { WINSW_RELEASE, winswDownloadErrorMessage } from "./winsw-release.mjs";

export {
  WINSW_RELEASE,
  winswDownloadErrorMessage,
};

/** @deprecated use WINSW_RELEASE.version */
export const WINSW_VERSION = WINSW_RELEASE.version;
/** @deprecated use WINSW_RELEASE.downloadUrl */
export const WINSW_DOWNLOAD_URL = WINSW_RELEASE.downloadUrl;

const DEFAULT_TIMEOUT_MS = 120_000;

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/**
 * @returns {{ ok: true, sha256: string, bytes: number } | { ok: false, reason: string }}
 */
export function validateWinswBinary(filePath, release = WINSW_RELEASE) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, reason: "missing" };
  }
  let st;
  try {
    st = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!st.isFile() || st.size <= 0) {
    return { ok: false, reason: "empty" };
  }
  if (release.expectedBytes && st.size !== release.expectedBytes) {
    return {
      ok: false,
      reason: `size_mismatch expected=${release.expectedBytes} actual=${st.size}`,
    };
  }
  const digest = sha256File(filePath);
  if (digest.toLowerCase() !== String(release.sha256).toLowerCase()) {
    return { ok: false, reason: "checksum_mismatch", sha256: digest, bytes: st.size };
  }
  return { ok: true, sha256: digest, bytes: st.size };
}

/**
 * Download URL to destPath (temp). Verifies HTTP 200, non-empty, optional size.
 * Follows redirects. Deletes dest on failure.
 */
export function downloadToFile(url, destPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const transport = options.transport; // injectable for tests: (url, opts, cb) => ClientRequest-like
  const maxRedirects = options.maxRedirects ?? 5;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      safeUnlink(destPath);
      reject(err);
    };
    const ok = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const get = (currentUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch {
        fail(new Error(winswDownloadErrorMessage("invalid-url")));
        return;
      }
      const lib = transport
        ? null
        : parsed.protocol === "http:"
          ? http
          : https;
      const requestFn = transport || lib.get.bind(lib);

      const req = requestFn(
        currentUrl,
        {
          headers: { "User-Agent": "MarivoltPrintAgent", Accept: "*/*" },
          timeout: timeoutMs,
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              fail(new Error(winswDownloadErrorMessage(status)));
              return;
            }
            const next = new URL(res.headers.location, currentUrl).href;
            get(next, redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            fail(new Error(winswDownloadErrorMessage(status)));
            return;
          }

          const file = fs.createWriteStream(destPath);
          res.pipe(file);
          file.on("finish", () => {
            file.close(() => {
              try {
                const size = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;
                if (size <= 0) {
                  safeUnlink(destPath);
                  fail(new Error("Downloaded WinSW file was empty. No service was installed."));
                  return;
                }
                ok({ path: destPath, bytes: size, status });
              } catch (e) {
                safeUnlink(destPath);
                fail(e);
              }
            });
          });
          file.on("error", (err) => {
            safeUnlink(destPath);
            fail(err);
          });
          res.on("error", (err) => {
            safeUnlink(destPath);
            fail(err);
          });
        }
      );

      req.on("timeout", () => {
        try {
          req.destroy(new Error("timeout"));
        } catch {
          /* ignore */
        }
        fail(
          new Error(
            `Unable to download the WinSW service wrapper. The download timed out after ${timeoutMs}ms. No service was installed. Check internet access or update the pinned WinSW release.`
          )
        );
      });
      req.on("error", (err) => {
        if (/timeout/i.test(String(err?.message || err))) {
          fail(
            new Error(
              `Unable to download the WinSW service wrapper. The download timed out after ${timeoutMs}ms. No service was installed. Check internet access or update the pinned WinSW release.`
            )
          );
          return;
        }
        fail(
          new Error(
            `Unable to download the WinSW service wrapper. Network error while fetching the configured release URL. No service was installed. Check internet access or update the pinned WinSW release.`
          )
        );
      });
    };

    safeUnlink(destPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    get(url, maxRedirects);
  });
}

/**
 * HEAD/GET probe for preflight. Returns { ok, status }.
 */
export function probeWinswUrl(url = WINSW_RELEASE.downloadUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const transport = options.transport;

  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, status: "invalid-url" });
      return;
    }
    const lib = transport ? null : parsed.protocol === "http:" ? http : https;
    const requestFn = transport || ((u, o, cb) => lib.request(u, { ...o, method: "HEAD" }, cb));

    const req = requestFn(
      url,
      {
        method: transport ? undefined : "HEAD",
        headers: { "User-Agent": "MarivoltPrintAgent" },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        res.resume();
        if (status >= 300 && status < 400 && res.headers.location) {
          probeWinswUrl(new URL(res.headers.location, url).href, options).then(resolve);
          return;
        }
        resolve({ ok: status === 200, status });
      }
    );
    req.on("timeout", () => {
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, status: "timeout" });
    });
    req.on("error", () => resolve({ ok: false, status: "network-error" }));
    if (typeof req.end === "function" && !transport) req.end();
  });
}

export function findLocalWinswCandidates() {
  return [getBundledWinswPath(), getWinswExePath()].filter(Boolean);
}

/**
 * Return first local path that passes checksum validation, or null.
 */
export function findValidLocalWinsw(release = WINSW_RELEASE) {
  for (const p of findLocalWinswCandidates()) {
    const v = validateWinswBinary(p, release);
    if (v.ok) return { path: p, ...v };
  }
  return null;
}

/**
 * Ensure WinSW exists under service/bin as MarivoltPrintAgent.exe with valid checksum.
 * Reuses local binaries when valid. Downloads only when needed.
 *
 * @returns {Promise<string>} path to bundled/service/bin binary
 */
export async function ensureWinswBinary({
  force = false,
  release = WINSW_RELEASE,
  downloadFn = downloadToFile,
} = {}) {
  fs.mkdirSync(SERVICE_BIN_DIR, { recursive: true });
  const dest = path.join(SERVICE_BIN_DIR, WINSW_EXE_NAME);

  if (!force) {
    const local = findValidLocalWinsw(release);
    if (local) {
      if (path.resolve(local.path) !== path.resolve(dest)) {
        fs.copyFileSync(local.path, dest);
        const again = validateWinswBinary(dest, release);
        if (!again.ok) {
          safeUnlink(dest);
          throw new Error(
            `Local WinSW binary copied but failed validation (${again.reason}). No service was installed.`
          );
        }
      }
      console.log(`Using existing WinSW ${release.version} (SHA-256 verified): ${dest}`);
      return dest;
    }
    // Remove invalid local copies so we do not reuse a corrupted download
    for (const p of findLocalWinswCandidates()) {
      if (fs.existsSync(p)) {
        const v = validateWinswBinary(p, release);
        if (!v.ok) {
          console.log(`Removing invalid WinSW candidate (${v.reason}): ${p}`);
          safeUnlink(p);
        }
      }
    }
  } else {
    safeUnlink(dest);
  }

  const tmp = path.join(SERVICE_BIN_DIR, `${WINSW_EXE_NAME}.download`);
  safeUnlink(tmp);
  console.log(`Downloading WinSW ${release.version} (${release.assetFileName})…`);
  console.log(release.downloadUrl);

  try {
    await downloadFn(release.downloadUrl, tmp, { timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (e) {
    safeUnlink(tmp);
    // Preserve our curated messages; wrap unknown ones
    const msg = String(e?.message || e);
    if (/Unable to download the WinSW service wrapper/i.test(msg)) throw e;
    throw new Error(winswDownloadErrorMessage("error"));
  }

  const check = validateWinswBinary(tmp, release);
  if (!check.ok) {
    safeUnlink(tmp);
    if (check.reason === "checksum_mismatch") {
      throw new Error(
        `Unable to download the WinSW service wrapper. SHA-256 checksum mismatch for ${release.assetFileName}. No service was installed. Update the pinned WinSW release or place a verified binary in service/bin.`
      );
    }
    throw new Error(
      `Unable to download the WinSW service wrapper. Downloaded file failed validation (${check.reason}). No service was installed.`
    );
  }

  safeUnlink(dest);
  fs.renameSync(tmp, dest);
  console.log(`Saved and verified ${dest}`);
  console.log(`WinSW ${release.version} SHA-256 OK`);
  return dest;
}

/** Ensure ProgramData runtime copy exists and is valid (after bundled ensure). */
export function copyVerifiedWinswToRuntime(bundledPath = getBundledWinswPath(), release = WINSW_RELEASE) {
  const check = validateWinswBinary(bundledPath, release);
  if (!check.ok) {
    throw new Error(`WinSW binary invalid before runtime copy (${check.reason}). No service was installed.`);
  }
  fs.mkdirSync(getServiceRuntimeDir(), { recursive: true });
  const runtimeExe = getWinswExePath();
  fs.copyFileSync(bundledPath, runtimeExe);
  const again = validateWinswBinary(runtimeExe, release);
  if (!again.ok) {
    safeUnlink(runtimeExe);
    throw new Error(`WinSW runtime copy failed validation (${again.reason}). No service was installed.`);
  }
  return runtimeExe;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  ensureWinswBinary({ force: process.argv.includes("--force") }).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
