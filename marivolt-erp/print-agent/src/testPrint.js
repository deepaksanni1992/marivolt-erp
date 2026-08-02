import { loadConfig, logLine } from "./config.js";
import { createTransport } from "./adapters/windowsRawSpooler.js";

const sampleTspl = [
  "SIZE 100 mm,50 mm",
  "GAP 3 mm,0",
  "DIRECTION 1",
  "CLS",
  'TEXT 20,20,"0",0,2,2,"MARIVOLT TEST"',
  'TEXT 20,70,"0",0,1,1,"Print Agent OK"',
  'BARCODE 80,120,"128",80,0,0,2,4,"TEST123"',
  'TEXT 80,210,"0",0,1,1,"TEST123"',
  "PRINT 1,1",
  "",
].join("\r\n");

async function main() {
  const cfg = loadConfig();
  if (!cfg.windowsPrinterName) {
    throw new Error("Set windowsPrinterName in config.json for test-print");
  }
  const transport = createTransport(cfg.connectionType);
  logLine(`Test print → ${cfg.windowsPrinterName}`);
  const result = await transport.printRaw(Buffer.from(sampleTspl, "utf8"), cfg.windowsPrinterName);
  logLine(`Test print result: ${JSON.stringify(result)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
