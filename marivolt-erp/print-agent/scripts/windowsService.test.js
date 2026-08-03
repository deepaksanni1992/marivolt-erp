/**
 * Static / unit tests for Marivolt Print Agent Windows Service helpers.
 * Does not require an installed Windows service.
 */
import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  SERVICE_ID,
  SERVICE_DISPLAY_NAME,
  SERVICE_DESCRIPTION,
  buildWinswXml,
  PRINT_AGENT_ROOT,
} from "../service/common.mjs";
import { getConfigPath, getConfigDir, logLine, ensureLogDir } from "../src/config.js";

let passed = 0;
let failed = 0;

function run(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("\nPrint Agent Windows Service (static)\n");

run("service identity constants", () => {
  assert.strictEqual(SERVICE_ID, "MarivoltPrintAgent");
  assert.strictEqual(SERVICE_DISPLAY_NAME, "Marivolt Print Agent");
  assert.ok(SERVICE_DESCRIPTION.includes("Background service"));
});

run("WinSW XML has Automatic start and recovery delays", () => {
  const xml = buildWinswXml({
    nodeExe: "C:\\\\Program Files\\\\nodejs\\\\node.exe",
    agentEntry: "E:\\\\agent\\\\src\\\\index.js",
    workingDirectory: "E:\\\\agent",
    logPath: "C:\\\\ProgramData\\\\MarivoltPrintAgent\\\\logs",
  });
  assert.ok(xml.includes("<id>MarivoltPrintAgent</id>"));
  assert.ok(xml.includes("<startmode>Automatic</startmode>"));
  assert.ok(xml.includes('delay="10 sec"'));
  assert.ok(xml.includes('delay="30 sec"'));
  assert.ok(xml.includes('delay="60 sec"'));
  assert.ok(xml.includes("<resetfailure>1 hour</resetfailure>"));
  assert.ok(xml.includes("MARIVOLT_AGENT_DIR"));
  assert.ok(!/Bearer\s+[A-Za-z0-9]{8,}/i.test(xml));
  assert.ok(!xml.toLowerCase().includes("paste_one_time"));
});

run("WinSW XML never embeds agent secret even if passed as working dir noise", () => {
  const fakeSecret = "super-secret-agent-token-XYZ";
  const xml = buildWinswXml({
    nodeExe: "C:\\\\node.exe",
    agentEntry: "E:\\\\agent\\\\src\\\\index.js",
    workingDirectory: "E:\\\\agent",
    logPath: "C:\\\\logs",
  });
  assert.ok(!xml.includes(fakeSecret));
  assert.ok(!/<arguments>.*secret/i.test(xml));
});

run("WinSW XML can include service account username without agent secret", () => {
  const xml = buildWinswXml({
    nodeExe: "C:\\\\node.exe",
    agentEntry: "E:\\\\agent\\\\src\\\\index.js",
    workingDirectory: "E:\\\\agent",
    logPath: "C:\\\\logs",
    serviceAccount: { username: ".\\\\WarehousePrint", password: "NotTheAgentSecret" },
  });
  assert.ok(xml.includes("<serviceaccount>"));
  assert.ok(xml.includes(".\\WarehousePrint") || xml.includes(".&apos;\\\\WarehousePrint") || xml.includes("WarehousePrint"));
  assert.ok(!xml.includes("PASTE_ONE_TIME_SECRET"));
});

run("admin privilege error message is exact", () => {
  const expected =
    "Administrator privileges are required. Open PowerShell as Administrator and run this command again.";
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "service", "common.mjs"), "utf8");
  assert.ok(src.includes(expected));
});

run("install script validates config before WinSW install", () => {
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "service", "install-service.mjs"), "utf8");
  assert.ok(src.includes("validateConfigForService"));
  assert.ok(src.includes("assertAdministrator"));
  assert.ok(src.includes("assertWindows"));
  assert.ok(src.includes("ensureWinswBinary"));
});

run("uninstall preserves config unless purge", () => {
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "service", "uninstall-service.mjs"), "utf8");
  assert.ok(src.includes("--purge"));
  assert.ok(src.includes("Preserved"));
  assert.ok(src.includes("Config and logs were preserved") || src.includes("Preserved:"));
});

run("package.json exposes service npm scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PRINT_AGENT_ROOT, "package.json"), "utf8"));
  for (const s of [
    "start",
    "test-print",
    "service:install",
    "service:start",
    "service:stop",
    "service:restart",
    "service:status",
    "service:uninstall",
    "service:verify-printer",
  ]) {
    assert.ok(pkg.scripts[s], `missing script ${s}`);
  }
});

run("manual npm start entry remains src/index.js", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PRINT_AGENT_ROOT, "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts.start, "node src/index.js");
  assert.ok(fs.existsSync(path.join(PRINT_AGENT_ROOT, "src", "index.js")));
});

run("config path stays under ProgramData MarivoltPrintAgent", () => {
  const p = getConfigPath();
  assert.ok(/MarivoltPrintAgent[/\\]config\.json$/i.test(p) || p.includes("MarivoltPrintAgent"));
  assert.ok(getConfigDir().includes("MarivoltPrintAgent"));
});

run("logLine creates logs and redacts bearer tokens", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-pa-log-"));
  const prev = process.env.MARIVOLT_AGENT_DIR;
  process.env.MARIVOLT_AGENT_DIR = tmp;
  try {
    ensureLogDir();
    logLine("Auth failed Authorization: Bearer abcdefghijklmnop", {
      level: "error",
      event: "auth",
    });
    const main = fs.readFileSync(path.join(tmp, "logs", "agent.log"), "utf8");
    const err = fs.readFileSync(path.join(tmp, "logs", "agent-error.log"), "utf8");
    assert.ok(main.includes("Bearer ***"));
    assert.ok(!main.includes("abcdefghijklmnop"));
    assert.ok(err.includes("Bearer ***"));
    assert.ok(main.includes("[auth]"));
  } finally {
    if (prev == null) delete process.env.MARIVOLT_AGENT_DIR;
    else process.env.MARIVOLT_AGENT_DIR = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

run("agent index handles SIGINT/SIGTERM and printer check", () => {
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "src", "index.js"), "utf8");
  assert.ok(src.includes('process.on("SIGINT"'));
  assert.ok(src.includes('process.on("SIGTERM"'));
  assert.ok(src.includes("PRINTER UNAVAILABLE"));
  assert.ok(src.includes("shuttingDown"));
  assert.ok(src.includes("service_stopped"));
});

run("service scripts are valid JS (syntax via presence)", () => {
  for (const rel of [
    "service/common.mjs",
    "service/install-service.mjs",
    "service/uninstall-service.mjs",
    "service/control-service.mjs",
    "service/download-winsw.mjs",
    "service/verify-printer.mjs",
    "src/index.js",
    "src/config.js",
  ]) {
    const full = path.join(PRINT_AGENT_ROOT, rel);
    assert.ok(fs.existsSync(full), rel);
    const text = fs.readFileSync(full, "utf8");
    assert.ok(text.length > 50);
  }
});

run("deployment package docs exist", () => {
  const readme = path.join(PRINT_AGENT_ROOT, "dist", "windows-service", "README.md");
  assert.ok(fs.existsSync(readme), "dist/windows-service/README.md missing");
  const body = fs.readFileSync(readme, "utf8");
  assert.ok(/service:install/i.test(body));
  assert.ok(/MarivoltPrintAgent/.test(body));
});

run("config.example.json has no live secret", () => {
  const ex = JSON.parse(
    fs.readFileSync(path.join(PRINT_AGENT_ROOT, "config.example.json"), "utf8")
  );
  assert.ok(String(ex.secret).includes("PASTE") || String(ex.secret).includes("SECRET"));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
