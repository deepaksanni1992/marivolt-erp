# Marivolt Print Agent — Windows Service package

Independent warehouse deployment package (no full ERP repository required).

## Contents

After `npm run package:windows-service` from the print-agent source tree:

```
windows-service/
  VERSION
  README.md                 (this file)
  MANUAL_ACCEPTANCE.md
  print-agent/              (runtime + service scripts)
    package.json
    config.example.json
    README.md
    src/
    service/
    scripts/
```

## Install on a warehouse PC

1. Install **Node.js 18+** (LTS).
2. Install Rongta driver; confirm Windows test print.
3. Copy the `print-agent` folder from this package to e.g. `C:\Marivolt\print-agent`.
4. Bootstrap once (creates config under ProgramData):

```powershell
cd C:\Marivolt\print-agent
npm start
```

5. Open **PowerShell as Administrator**:

```powershell
cd C:\Marivolt\print-agent
npm run service:preflight
npm run service:install
npm run service:status
npm run service:verify-printer
```

WinSW is pinned to stable **v2.12.0** (`WinSW-x64.exe`). Manual fallback: copy the official asset as `service\bin\MarivoltPrintAgent.exe` after verifying SHA-256 against `service/winsw-release.mjs`.

6. Confirm ERP agent ONLINE; Test Connection; Test Print.
7. Restart Windows and confirm ONLINE without opening PowerShell.

## Service identity

- Service name: `MarivoltPrintAgent`
- Display name: Marivolt Print Agent
- Config: `C:\ProgramData\MarivoltPrintAgent\config.json`
- Logs: `C:\ProgramData\MarivoltPrintAgent\logs\`

## Service account

See main `print-agent/README.md` Options A / B / C. Default is LocalSystem — only valid when the printer queue is machine-wide.

```powershell
$env:MARIVOLT_SERVICE_ACCOUNT = ".\WarehousePrint"
$env:MARIVOLT_SERVICE_PASSWORD = "<password>"
npm run service:install
```

## Uninstall

```powershell
npm run service:uninstall
# optional: npm run service:uninstall -- --purge
```

Config and logs under ProgramData are preserved by default.

## Phase 2

System tray UI is optional and not required for printing.
