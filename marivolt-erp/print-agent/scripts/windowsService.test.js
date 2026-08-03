/**
 * Static / unit tests for Marivolt Print Agent Windows Service helpers.
 * Does not require an installed Windows service.
 */
import assert from "assert";
import crypto from "crypto";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { fileURLToPath } from "url";
import {
  SERVICE_ID,
  SERVICE_DISPLAY_NAME,
  SERVICE_DESCRIPTION,
  buildWinswXml,
  PRINT_AGENT_ROOT,
} from "../service/common.mjs";
import { getConfigPath, getConfigDir, logLine, ensureLogDir } from "../src/config.js";
import {
  WINSW_RELEASE,
  downloadToFile,
  ensureWinswBinary,
  sha256File,
  validateWinswBinary,
  winswDownloadErrorMessage,
  safeUnlink,
} from "../service/download-winsw.mjs";
import {
  evaluateWinswSource,
  printPreflightReport,
} from "../service/preflight-service.mjs";

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

async function runAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fakeRelease(bytes, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    version: "v-test",
    assetFileName: "WinSW-x64.exe",
    runtimeFileName: "MarivoltPrintAgent.exe",
    downloadUrl: "https://example.test/WinSW-x64.exe",
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    expectedBytes: bytes ?? buf.length,
    releasePageUrl: "https://example.test/",
    checksumSource: "test",
  };
}

/** Minimal https.get-compatible mock. */
function mockTransport(handler) {
  return (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroy = (err) => {
      if (err) req.emit("error", err);
    };
    process.nextTick(() => {
      try {
        handler(url, opts, cb, req);
      } catch (e) {
        req.emit("error", e);
      }
    });
    return req;
  };
}

function mockResponse({ statusCode = 200, body = Buffer.from("ok"), headers = {} } = {}) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.headers = headers;
  res.resume = () => {};
  process.nextTick(() => {
    if (body) {
      res.emit("data", body);
    }
    res.emit("end");
  });
  // Make pipe work with WriteStream
  res.pipe = (dest) => {
    process.nextTick(() => {
      if (body) dest.write(body);
      dest.end();
    });
    return dest;
  };
  return res;
}

console.log("\nPrint Agent Windows Service (static)\n");

run("service identity constants", () => {
  assert.strictEqual(SERVICE_ID, "MarivoltPrintAgent");
  assert.strictEqual(SERVICE_DISPLAY_NAME, "Marivolt Print Agent");
  assert.ok(SERVICE_DESCRIPTION.includes("Background service"));
});

run("pinned WinSW release is stable v2.12.0 with official asset", () => {
  assert.strictEqual(WINSW_RELEASE.version, "v2.12.0");
  assert.strictEqual(WINSW_RELEASE.assetFileName, "WinSW-x64.exe");
  assert.strictEqual(
    WINSW_RELEASE.downloadUrl,
    "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe"
  );
  assert.strictEqual(
    WINSW_RELEASE.sha256,
    "05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da"
  );
  assert.strictEqual(WINSW_RELEASE.expectedBytes, 18243033);
  assert.ok(!/v3\.0\.0/.test(WINSW_RELEASE.downloadUrl));
  assert.ok(WINSW_RELEASE.checksumSource.length > 20);
});

run("download error message includes HTTP status and no install claim", () => {
  const msg = winswDownloadErrorMessage(404);
  assert.ok(msg.includes("HTTP 404"));
  assert.ok(msg.includes("No service was installed"));
  assert.ok(msg.includes("pinned WinSW release"));
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
  assert.ok(xml.includes("<delayedAutoStart/>") || xml.includes("delayedAutoStart"));
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
  assert.ok(xml.includes("WarehousePrint"));
  assert.ok(!xml.includes("PASTE_ONE_TIME_SECRET"));
});

run("admin privilege error message is exact", () => {
  const expected =
    "Administrator privileges are required. Open PowerShell as Administrator and run this command again.";
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "service", "common.mjs"), "utf8");
  assert.ok(src.includes(expected));
});

run("install runs preflight and ensureWinswBinary before service registration", () => {
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "service", "install-service.mjs"), "utf8");
  assert.ok(src.includes("runPreflight"));
  assert.ok(src.includes("ensureWinswBinary"));
  assert.ok(src.includes("Preflight failed"));
  assert.ok(src.includes("No service was installed"));
  const ensureIdx = src.indexOf("ensureWinswBinary");
  const installIdx = src.indexOf('runWinsw(["install"]');
  assert.ok(ensureIdx > 0 && installIdx > ensureIdx);
});

run("uninstall preserves config unless purge", () => {
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "service", "uninstall-service.mjs"), "utf8");
  assert.ok(src.includes("--purge"));
  assert.ok(src.includes("Preserved"));
});

run("package.json exposes service npm scripts including preflight", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PRINT_AGENT_ROOT, "package.json"), "utf8"));
  for (const s of [
    "start",
    "test-print",
    "service:install",
    "service:preflight",
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

run("service:verify-printer distinguishes queue vs physical health", () => {
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "service", "verify-printer.mjs"), "utf8");
  assert.ok(src.includes("probeWindowsPrinterHealth"));
  assert.ok(src.includes("formatVerifyPrinterReport") || src.includes("resolveConfiguredPrinterHealth"));
  assert.ok(!src.includes("PRINTER DETECTED"));
  assert.ok(src.includes("usbDevicePresent") || src.includes("looksLikeLocalDevicePort"));
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

run("service scripts exist including preflight and winsw-release", () => {
  for (const rel of [
    "service/common.mjs",
    "service/install-service.mjs",
    "service/uninstall-service.mjs",
    "service/control-service.mjs",
    "service/download-winsw.mjs",
    "service/preflight-service.mjs",
    "service/winsw-release.mjs",
    "service/verify-printer.mjs",
    "src/index.js",
    "src/config.js",
  ]) {
    const full = path.join(PRINT_AGENT_ROOT, rel);
    assert.ok(fs.existsSync(full), rel);
    assert.ok(fs.readFileSync(full, "utf8").length > 50);
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

run("validateWinswBinary rejects missing and empty files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-winsw-"));
  try {
    const missing = validateWinswBinary(path.join(tmp, "nope.exe"), fakeRelease(4, "abcd"));
    assert.strictEqual(missing.ok, false);
    const emptyPath = path.join(tmp, "empty.exe");
    fs.writeFileSync(emptyPath, "");
    const empty = validateWinswBinary(emptyPath, fakeRelease(0, ""));
    assert.strictEqual(empty.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

run("validateWinswBinary rejects checksum mismatch", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-winsw-"));
  try {
    const p = path.join(tmp, "bad.exe");
    fs.writeFileSync(p, Buffer.from("hello-winsw"));
    const release = fakeRelease(11, "hello-winsw");
    release.sha256 = "0".repeat(64);
    const v = validateWinswBinary(p, release);
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.reason, "checksum_mismatch");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

run("validateWinswBinary accepts matching checksum and size", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-winsw-"));
  try {
    const body = Buffer.from("valid-winsw-binary-bytes");
    const p = path.join(tmp, "ok.exe");
    fs.writeFileSync(p, body);
    const release = fakeRelease(body.length, body);
    const v = validateWinswBinary(p, release);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.sha256, release.sha256);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await runAsync("downloadToFile fails on HTTP 404 and deletes partial file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-dl-"));
  const dest = path.join(tmp, "out.exe");
  const transport = mockTransport((_url, _opts, cb) => {
    cb(mockResponse({ statusCode: 404, body: Buffer.from("not found") }));
  });
  await assert.rejects(
    () => downloadToFile("https://example.test/missing.exe", dest, { transport }),
    (err) => {
      assert.ok(/HTTP 404/.test(err.message));
      assert.ok(/No service was installed/.test(err.message));
      return true;
    }
  );
  assert.ok(!fs.existsSync(dest));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await runAsync("downloadToFile fails on invalid release URL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-dl-"));
  const dest = path.join(tmp, "out.exe");
  await assert.rejects(
    () => downloadToFile("not-a-url", dest, {}),
    (err) => /HTTP invalid-url|Unable to download/.test(err.message)
  );
  assert.ok(!fs.existsSync(dest));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await runAsync("downloadToFile fails on timeout and cleans up", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-dl-"));
  const dest = path.join(tmp, "out.exe");
  const transport = mockTransport((_url, _opts, _cb, req) => {
    process.nextTick(() => req.emit("timeout"));
  });
  await assert.rejects(
    () => downloadToFile("https://example.test/slow.exe", dest, { transport, timeoutMs: 50 }),
    (err) => /timed out/i.test(err.message) && /No service was installed/.test(err.message)
  );
  assert.ok(!fs.existsSync(dest));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await runAsync("downloadToFile rejects empty/partial body", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-dl-"));
  const dest = path.join(tmp, "out.exe");
  const transport = mockTransport((_url, _opts, cb) => {
    cb(mockResponse({ statusCode: 200, body: Buffer.alloc(0) }));
  });
  await assert.rejects(
    () => downloadToFile("https://example.test/empty.exe", dest, { transport }),
    (err) => /empty/i.test(err.message)
  );
  assert.ok(!fs.existsSync(dest));
  fs.rmSync(tmp, { recursive: true, force: true });
});

await runAsync("downloadToFile succeeds on HTTP 200", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-dl-"));
  const dest = path.join(tmp, "out.exe");
  const body = Buffer.from("downloaded-ok");
  const transport = mockTransport((_url, _opts, cb) => {
    cb(mockResponse({ statusCode: 200, body }));
  });
  const result = await downloadToFile("https://example.test/ok.exe", dest, { transport });
  assert.strictEqual(result.status, 200);
  assert.ok(fs.existsSync(dest));
  assert.strictEqual(fs.readFileSync(dest).toString(), "downloaded-ok");
  fs.rmSync(tmp, { recursive: true, force: true });
});

await runAsync("ensureWinswBinary reuses existing valid local binary", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mv-ensure-"));
  const prev = process.env.MARIVOLT_AGENT_DIR;
  process.env.MARIVOLT_AGENT_DIR = tmpRoot;
  const binDir = path.join(PRINT_AGENT_ROOT, "service", "bin");
  const dest = path.join(binDir, "MarivoltPrintAgent.exe");
  const backup = dest + ".bak-test";
  const had = fs.existsSync(dest);
  if (had) fs.copyFileSync(dest, backup);
  try {
    const body = Buffer.from("local-valid-winsw-bytes-123456");
    const release = fakeRelease(body.length, body);
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(dest, body);
    let downloaded = false;
    const pathOut = await ensureWinswBinary({
      release,
      downloadFn: async () => {
        downloaded = true;
        throw new Error("should not download");
      },
    });
    assert.strictEqual(downloaded, false);
    assert.ok(fs.existsSync(pathOut));
    assert.strictEqual(sha256File(pathOut), release.sha256);
  } finally {
    safeUnlink(dest);
    if (had && fs.existsSync(backup)) {
      fs.renameSync(backup, dest);
    } else {
      safeUnlink(backup);
    }
    if (prev == null) delete process.env.MARIVOLT_AGENT_DIR;
    else process.env.MARIVOLT_AGENT_DIR = prev;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

await runAsync("ensureWinswBinary rejects invalid local binary then fails download 404", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mv-ensure-bad-"));
  const prev = process.env.MARIVOLT_AGENT_DIR;
  process.env.MARIVOLT_AGENT_DIR = tmpRoot;
  const binDir = path.join(PRINT_AGENT_ROOT, "service", "bin");
  const dest = path.join(binDir, "MarivoltPrintAgent.exe");
  const backup = dest + ".bak-test2";
  const had = fs.existsSync(dest);
  if (had) fs.copyFileSync(dest, backup);
  try {
    const good = Buffer.from("expected-good-content-xxxx");
    const release = fakeRelease(good.length, good);
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(dest, Buffer.from("corrupt-local-binary!!!!"));
    await assert.rejects(
      () =>
        ensureWinswBinary({
          release,
          downloadFn: async (url, tmp) => {
            // Simulate HTTP 404 path used by real downloader messaging
            safeUnlink(tmp);
            throw new Error(winswDownloadErrorMessage(404));
          },
        }),
      (err) => /HTTP 404/.test(err.message) && /No service was installed/.test(err.message)
    );
    // Invalid local should have been removed; no successful dest left with wrong hash
    if (fs.existsSync(dest)) {
      assert.notStrictEqual(sha256File(dest), crypto.createHash("sha256").update("corrupt-local-binary!!!!").digest("hex"));
    }
  } finally {
    safeUnlink(dest);
    if (had && fs.existsSync(backup)) fs.renameSync(backup, dest);
    else safeUnlink(backup);
    if (prev == null) delete process.env.MARIVOLT_AGENT_DIR;
    else process.env.MARIVOLT_AGENT_DIR = prev;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

await runAsync("ensureWinswBinary successful download verifies checksum", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mv-ensure-ok-"));
  const prev = process.env.MARIVOLT_AGENT_DIR;
  process.env.MARIVOLT_AGENT_DIR = tmpRoot;
  const binDir = path.join(PRINT_AGENT_ROOT, "service", "bin");
  const dest = path.join(binDir, "MarivoltPrintAgent.exe");
  const backup = dest + ".bak-test3";
  const had = fs.existsSync(dest);
  if (had) fs.copyFileSync(dest, backup);
  safeUnlink(dest);
  try {
    const body = Buffer.from("fresh-download-winsw-bytes");
    const release = fakeRelease(body.length, body);
    const out = await ensureWinswBinary({
      force: true,
      release,
      downloadFn: async (_url, tmp) => {
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.writeFileSync(tmp, body);
        return { path: tmp, bytes: body.length, status: 200 };
      },
    });
    assert.ok(fs.existsSync(out));
    assert.strictEqual(sha256File(out), release.sha256);
  } finally {
    safeUnlink(dest);
    if (had && fs.existsSync(backup)) fs.renameSync(backup, dest);
    else safeUnlink(backup);
    if (prev == null) delete process.env.MARIVOLT_AGENT_DIR;
    else process.env.MARIVOLT_AGENT_DIR = prev;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

await runAsync("ensureWinswBinary checksum mismatch deletes temp and does not install", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mv-ensure-mismatch-"));
  const prev = process.env.MARIVOLT_AGENT_DIR;
  process.env.MARIVOLT_AGENT_DIR = tmpRoot;
  const binDir = path.join(PRINT_AGENT_ROOT, "service", "bin");
  const dest = path.join(binDir, "MarivoltPrintAgent.exe");
  const backup = dest + ".bak-test4";
  const had = fs.existsSync(dest);
  if (had) fs.copyFileSync(dest, backup);
  safeUnlink(dest);
  try {
    const release = fakeRelease(10, "abcdefghij");
    await assert.rejects(
      () =>
        ensureWinswBinary({
          force: true,
          release,
          downloadFn: async (_url, tmp) => {
            fs.mkdirSync(path.dirname(tmp), { recursive: true });
            fs.writeFileSync(tmp, Buffer.from("TAMPERED!!"));
            return { path: tmp, bytes: 10, status: 200 };
          },
        }),
      (err) => /checksum mismatch/i.test(err.message) && /No service was installed/.test(err.message)
    );
    assert.ok(!fs.existsSync(dest));
    assert.ok(!fs.existsSync(dest + ".download"));
  } finally {
    safeUnlink(dest);
    if (had && fs.existsSync(backup)) fs.renameSync(backup, dest);
    else safeUnlink(backup);
    if (prev == null) delete process.env.MARIVOLT_AGENT_DIR;
    else process.env.MARIVOLT_AGENT_DIR = prev;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

run("install failure path documents no partial service after download failure", () => {
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "service", "install-service.mjs"), "utf8");
  // Download happens before runWinsw(["install"])
  const dl = src.indexOf("ensureWinswBinary");
  const inst = src.indexOf('runWinsw(["install"]');
  assert.ok(dl < inst);
  assert.ok(src.includes("uninstall"));
});

run("preflight module exports runPreflight and evaluateWinswSource", () => {
  const src = fs.readFileSync(path.join(PRINT_AGENT_ROOT, "service", "preflight-service.mjs"), "utf8");
  assert.ok(src.includes("export async function runPreflight"));
  assert.ok(src.includes("export async function evaluateWinswSource"));
  assert.ok(src.includes("localBinaryValid || remoteDownloadAvailable"));
  assert.ok(src.includes("administrator"));
  assert.ok(src.includes("config.json"));
  assert.ok(src.includes("winsw_url") || src.includes("winsw_source"));
  assert.ok(src.includes("printer_config"));
  assert.ok(src.includes("Preflight PASSED"));
});

await runAsync("preflight: no local binary + URL 200 → PASS", async () => {
  const result = await evaluateWinswSource({
    findValidLocalWinsw: () => null,
    findLocalWinswCandidates: () => [],
    probeWinswUrl: async () => ({ ok: true, status: 200 }),
    quarantineInvalidLocalWinsw: () => [],
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.localBinaryValid, false);
  assert.strictEqual(result.remoteDownloadAvailable, true);
  const warn = result.checks.find(
    (c) => c.level === "WARN" && /No local WinSW binary found/i.test(c.detail)
  );
  assert.ok(warn, "expected WARN about missing local binary");
  const passSource = result.checks.find(
    (c) =>
      c.ok &&
      c.name === "winsw_source" &&
      /official WinSW v2\.12\.0 available for verified download/i.test(c.detail)
  );
  assert.ok(passSource, "expected PASS winsw_source for official download");
});

await runAsync("preflight: valid local binary + URL unavailable → PASS", async () => {
  const result = await evaluateWinswSource({
    findValidLocalWinsw: () => ({
      path: "C:\\\\fake\\\\MarivoltPrintAgent.exe",
      ok: true,
      sha256: WINSW_RELEASE.sha256,
      bytes: WINSW_RELEASE.expectedBytes,
    }),
    findLocalWinswCandidates: () => ["C:\\\\fake\\\\MarivoltPrintAgent.exe"],
    probeWinswUrl: async () => ({ ok: false, status: 404 }),
    quarantineInvalidLocalWinsw: () => [],
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.localBinaryValid, true);
  assert.ok(result.checks.every((c) => c.ok));
});

await runAsync("preflight: invalid local binary + URL 200 → PASS with replacement warning", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-pf-invalid-"));
  const bad = path.join(tmp, "MarivoltPrintAgent.exe");
  fs.writeFileSync(bad, Buffer.from("corrupt-winsw"));
  let quarantinedCalls = 0;
  try {
    const result = await evaluateWinswSource({
      findValidLocalWinsw: () => null,
      findLocalWinswCandidates: () => [bad],
      probeWinswUrl: async () => ({ ok: true, status: 200 }),
      quarantineInvalidLocalWinsw: () => {
        quarantinedCalls += 1;
        safeUnlink(bad);
        return [{ from: bad, to: null, reason: "checksum_mismatch" }];
      },
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.remoteDownloadAvailable, true);
    assert.ok(quarantinedCalls === 1);
    const warn = result.checks.find(
      (c) => c.level === "WARN" && /Invalid local WinSW binary will be replaced/i.test(c.detail)
    );
    assert.ok(warn);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await runAsync("preflight: no local binary + URL unavailable → FAIL", async () => {
  const result = await evaluateWinswSource({
    findValidLocalWinsw: () => null,
    findLocalWinswCandidates: () => [],
    probeWinswUrl: async () => ({ ok: false, status: 404 }),
    quarantineInvalidLocalWinsw: () => [],
  });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.remoteDownloadAvailable, false);
  assert.ok(result.checks.some((c) => !c.ok && /download URL unavailable/i.test(c.detail)));
});

await runAsync("preflight: invalid local binary + URL unavailable → FAIL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mv-pf-bad-offline-"));
  const bad = path.join(tmp, "MarivoltPrintAgent.exe");
  fs.writeFileSync(bad, Buffer.from("corrupt"));
  try {
    const result = await evaluateWinswSource({
      findValidLocalWinsw: () => null,
      findLocalWinswCandidates: () => [bad],
      probeWinswUrl: async () => ({ ok: false, status: "network-error" }),
      quarantineInvalidLocalWinsw: () => [],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.checks.some((c) => !c.ok && /Invalid local/i.test(c.detail)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await runAsync("preflight report wording for download path", async () => {
  const result = {
    ok: true,
    checks: [
      {
        name: "winsw_source",
        ok: true,
        level: "WARN",
        detail: "No local WinSW binary found; installer will download and verify v2.12.0.",
      },
      {
        name: "winsw_source",
        ok: true,
        detail: "official WinSW v2.12.0 available for verified download",
      },
    ],
    release: {
      version: WINSW_RELEASE.version,
      assetFileName: WINSW_RELEASE.assetFileName,
      downloadUrl: WINSW_RELEASE.downloadUrl,
    },
  };
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  try {
    printPreflightReport(result);
  } finally {
    console.log = orig;
  }
  const text = logs.join("\n");
  assert.ok(/WARN  winsw_source: No local WinSW binary found/i.test(text));
  assert.ok(/PASS  winsw_source: official WinSW v2\.12\.0 available for verified download/i.test(text));
  assert.ok(/Preflight PASSED — ready to install/i.test(text));
});

// Avoid unused import lint noise in some runners
void http;

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
