/**
 * Build an independently installable Windows Service deployment folder under
 * print-agent/dist/windows-service/ (without cloning the full ERP repo).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dist", "windows-service");
const PKG = path.join(OUT, "print-agent");

const COPY_FILES = [
  "package.json",
  "config.example.json",
  "README.md",
  "src/index.js",
  "src/config.js",
  "src/detect.js",
  "src/testPrint.js",
  "src/adapters/base.js",
  "src/adapters/windowsRawSpooler.js",
  "service/common.mjs",
  "service/install-service.mjs",
  "service/uninstall-service.mjs",
  "service/control-service.mjs",
  "service/download-winsw.mjs",
  "service/verify-printer.mjs",
  "scripts/windowsService.test.js",
  "scripts/package-windows-service.mjs",
];

function copyFile(rel) {
  const src = path.join(ROOT, rel);
  const dest = path.join(PKG, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function main() {
  fs.rmSync(PKG, { recursive: true, force: true });
  fs.mkdirSync(PKG, { recursive: true });
  fs.mkdirSync(path.join(PKG, "service", "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(PKG, "service", "bin", ".gitkeep"),
    "# WinSW binary downloaded by npm run service:install\n",
    "utf8"
  );

  for (const rel of COPY_FILES) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      console.warn(`skip missing: ${rel}`);
      continue;
    }
    copyFile(rel);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  fs.writeFileSync(path.join(OUT, "VERSION"), `${pkg.version}\n`, "utf8");

  console.log(`Packaged print-agent → ${PKG}`);
  console.log(`VERSION ${pkg.version}`);
  console.log("Zip the print-agent/ folder inside dist/windows-service for warehouse PCs.");
}

main();
