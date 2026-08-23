/**
 * Build an independently installable Windows Service deployment folder under
 * print-agent/dist/windows-service/ (without cloning the full ERP repo).
 *
 * Note: MarivoltPrintAgent.exe in ProgramData is WinSW (service wrapper), not a
 * Node binary. The agent is Node + src/*.js. This package copies the Node agent
 * tree; WinSW is downloaded/verified by service:install on the target PC.
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
  "src/jobProcessor.js",
  "src/printSafety.js",
  "src/printTiming.js",
  "src/windowsPrintJobStatus.js",
  "src/testPrint.js",
  "src/adapters/base.js",
  "src/adapters/windowsRawSpooler.js",
  "service/common.mjs",
  "service/install-service.mjs",
  "service/uninstall-service.mjs",
  "service/control-service.mjs",
  "service/download-winsw.mjs",
  "service/verify-printer.mjs",
  "service/winsw-release.mjs",
  "service/preflight-service.mjs",
  "scripts/windowsService.test.js",
  "scripts/printerHealth.test.js",
  "scripts/printSafety.test.js",
  "scripts/printTiming.test.js",
  "scripts/spoolJobIdCompletion.test.js",
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

  const missing = [];
  for (const rel of COPY_FILES) {
    if (!fs.existsSync(path.join(ROOT, rel))) {
      missing.push(rel);
      console.warn(`skip missing: ${rel}`);
      continue;
    }
    copyFile(rel);
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  fs.writeFileSync(path.join(OUT, "VERSION"), `${pkg.version}\n`, "utf8");

  const readme = `# Marivolt Print Agent ${pkg.version} — Windows deployment package

## Architecture

\`MarivoltPrintAgent.exe\` under \`%ProgramData%\\MarivoltPrintAgent\\service\\\` is **WinSW**
(Windows Service Wrapper). It launches:

\`\`\`text
node.exe  <this-folder>/src/index.js
\`\`\`

Config and identity live in:

\`\`\`text
%ProgramData%\\MarivoltPrintAgent\\config.json
\`\`\`

Do not replace WinSW with Node source. Update the \`print-agent\` folder (this package), then restart the service.

## Install (new PC)

1. Install Node.js 18+.
2. Copy this \`print-agent\` folder to a stable path.
3. Bootstrap once: \`npm start\` (creates config.json).
4. Admin PowerShell: \`npm run service:install\`

## Upgrade (existing service)

1. Stop service: \`npm run service:stop\` (from the print-agent folder, Admin).
2. Replace print-agent source files with this package (keep ProgramData config).
3. Start service: \`npm run service:start\`
4. Confirm logs show \`Marivolt Print Agent ${pkg.version}\`.

WinSW EXE is unchanged unless you intentionally re-run \`service:install -- --reinstall\`.
`;
  fs.writeFileSync(path.join(OUT, "README.md"), readme, "utf8");

  // Manifest for operators
  const fileList = [];
  function walk(dir, prefix = "") {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.join(prefix, name).replace(/\\/g, "/");
      if (fs.statSync(full).isDirectory()) walk(full, rel);
      else fileList.push(rel);
    }
  }
  walk(PKG);
  fs.writeFileSync(
    path.join(OUT, "MANIFEST.txt"),
    [`version=${pkg.version}`, `files=${fileList.length}`, ...fileList.sort()].join("\n") + "\n",
    "utf8"
  );

  console.log(`Packaged print-agent → ${PKG}`);
  console.log(`VERSION ${pkg.version}`);
  console.log(`Files ${fileList.length}${missing.length ? ` (missing skipped: ${missing.length})` : ""}`);
  console.log("Zip the print-agent/ folder inside dist/windows-service for warehouse PCs.");
}

main();
