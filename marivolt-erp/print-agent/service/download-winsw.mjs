/**
 * Download WinSW (Windows Service Wrapper) into service/bin if missing.
 * Does not embed secrets. Binary is gitignored.
 */
import fs from "fs";
import https from "https";
import path from "path";
import { pathToFileURL } from "url";
import { SERVICE_BIN_DIR, WINSW_EXE_NAME } from "./common.mjs";

/** Official WinSW v3 release asset (x64). Pin version for reproducibility. */
export const WINSW_VERSION = "v3.0.0";
export const WINSW_DOWNLOAD_URL =
  "https://github.com/winsw/winsw/releases/download/v3.0.0/WinSW-x64.exe";

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "MarivoltPrintAgent" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        reject(new Error(`Download failed HTTP ${res.statusCode} for ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(dest)));
    });
    req.on("error", (err) => {
      try {
        file.close();
        fs.unlinkSync(dest);
      } catch {
        /* ignore */
      }
      reject(err);
    });
  });
}

export async function ensureWinswBinary({ force = false } = {}) {
  fs.mkdirSync(SERVICE_BIN_DIR, { recursive: true });
  const dest = path.join(SERVICE_BIN_DIR, WINSW_EXE_NAME);
  if (fs.existsSync(dest) && !force) {
    const st = fs.statSync(dest);
    if (st.size > 50_000) return dest;
  }
  const tmp = `${dest}.download`;
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  console.log(`Downloading WinSW ${WINSW_VERSION}…`);
  console.log(WINSW_DOWNLOAD_URL);
  await download(WINSW_DOWNLOAD_URL, tmp);
  fs.renameSync(tmp, dest);
  console.log(`Saved ${dest}`);
  return dest;
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
