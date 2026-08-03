# Marivolt Windows Print Agent

Outbound HTTPS agent for Rongta USB/network labels via the Windows named printer / spooler.
Supports **multiple agents** and **multiple printers** per company/warehouse.

Phase 1 print transport uses **RAW** datatype through the Windows spooler (`WritePrinter` / `pDataType = RAW`).
TSPL bytes are sent unaltered - not driver-rendered GDI text.

Manual development mode remains fully supported:

```powershell
cd "<print-agent-folder>"
npm start
```

Production warehouse PCs should use the **Windows Service** (WinSW) so the agent starts with Windows and runs without an open PowerShell window.

---

## Paths

| Item | Path |
|------|------|
| Config | `C:\ProgramData\MarivoltPrintAgent\config.json` |
| Logs | `C:\ProgramData\MarivoltPrintAgent\logs\` (`agent.log`, `agent-error.log`, dated files) |
| Service runtime (WinSW) | `C:\ProgramData\MarivoltPrintAgent\service\` |

Do not put secrets in the source folder. Never log the agent secret, bootstrap token, or Authorization headers.

---

## First-launch (register agent)

1. In ERP (Admin): **Settings -> Label Printing** -> set an **Agent bootstrap token** and Save.
2. Note your **Company ID**.
3. On the warehouse PC, install **Node.js 18+**.
4. Install the Rongta driver and confirm a Windows test print to **RP4xx Series 200DPI TSPL** (or your exact queue name).
5. Open PowerShell (normal user is fine for first-launch):

```powershell
cd "<print-agent-folder>"
npm start
```

6. On first run (no config yet), the agent will:
   - Auto-detect computer name, OS / Windows version, and available Windows printers
   - Ask for Backend URL, Company ID, Warehouse, Friendly Agent Name, Bootstrap token
   - Let you pick a Windows printer
   - Self-register and write `%ProgramData%\MarivoltPrintAgent\config.json`

7. Restrict ACL on the config folder (example):

```powershell
# Run as Administrator - tighten to the service account after you choose Option A/B/C below
icacls "C:\ProgramData\MarivoltPrintAgent" /inheritance:r
icacls "C:\ProgramData\MarivoltPrintAgent" /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
icacls "C:\ProgramData\MarivoltPrintAgent\config.json" /grant:r "Administrators:F" "SYSTEM:F"
```

8. Map the ERP printer to this agent in Label Settings before production jobs.

### Manual setup (admin-registered agent)

1. ERP: **Register Print Agent** -> copy `agentId` + one-time `secret`.
2. Create printer mapping (company/warehouse + agent + exact Windows printer name).
3. Copy `config.example.json` to `%ProgramData%\MarivoltPrintAgent\config.json` and fill values.
4. `npm start` (manual) or install the Windows Service below.

---

## Production: Windows Service install

**Service name:** `MarivoltPrintAgent`
**Display name:** Marivolt Print Agent
**Description:** Background service for receiving Marivolt ERP label jobs and printing them through configured Windows printer queues.

### Exact steps

1. Install the Rongta driver.
2. Confirm a Windows test print to the label queue.
3. Register/bootstrap the agent (`npm start` once) so `config.json` exists.
4. Confirm `C:\ProgramData\MarivoltPrintAgent\config.json` is valid.
5. **Open PowerShell as Administrator.**
6. Preflight, then install and start the service:

```powershell
cd "<print-agent-folder>"
npm run service:preflight
npm run service:install
```

If the service is already installed and you intend to replace it:

```powershell
npm run service:install -- --reinstall
```

WinSW pin: stable **v2.12.0** asset `WinSW-x64.exe` (SHA-256 verified). Offline/manual fallback: place the official `WinSW-x64.exe` renamed to `MarivoltPrintAgent.exe` in `print-agent\service\bin\` (must match the pinned checksum) or under `%ProgramData%\MarivoltPrintAgent\service\`.

7. Confirm status:

```powershell
npm run service:status
npm run service:verify-printer
```

8. Restart Windows.
9. Confirm the ERP agent becomes **ONLINE** automatically (no PowerShell open).
10. Run ERP **Test Connection**.
11. Run ERP **Test Print** (expect one 100 x 50 mm label).

### Service management commands

| Command | Purpose |
|---------|---------|
| `npm run service:preflight` | Admin/config/Node/WinSW URL/writable dirs checks (no install) |
| `npm run service:install` | Preflight, download/verify WinSW, install, auto-start, recovery, start |
| `npm run service:start` | Start |
| `npm run service:stop` | Stop |
| `npm run service:restart` | Restart |
| `npm run service:status` | Local status (no secret printed) |
| `npm run service:uninstall` | Stop + remove service; **keeps** config and logs |
| `npm run service:uninstall -- --purge` | Also remove `%ProgramData%\...\service` runtime |
| `npm run service:verify-printer` | Confirm configured printer is visible to this account |
| `npm start` | Manual foreground mode (unchanged) |
| `npm run test-print` | Local spooler test |

If not elevated, install/control commands print:

> Administrator privileges are required. Open PowerShell as Administrator and run this command again.

### Startup and recovery

- Startup: **Automatic** (delayed)
- Crash recovery: restart after **10s**, then **30s**, then **60s**; failure count resets after ~1 hour of stability
- Stop timeout: **45 seconds** (graceful: stop leasing, finish or safely abandon, final heartbeat when possible)

### Printer visibility self-check

On startup the agent enumerates Windows printers and logs whether the configured printer is found.

- Missing printer -> log **PRINTER UNAVAILABLE**; agent stays **ONLINE** and continues heartbeat
- Do not assume a printer visible to your interactive user is visible to **LocalSystem**

---

## Service account and printer access

Windows services often cannot see user-installed printer queues.

### Option A - Dedicated local service account (recommended)

1. Create a local user (e.g. `WarehousePrint`) with "Log on as a service".
2. Install / share the label printer so that account can print.
3. Install with:

```powershell
$env:MARIVOLT_SERVICE_ACCOUNT = ".\WarehousePrint"
$env:MARIVOLT_SERVICE_PASSWORD = "<password>"
npm run service:install
```

4. Run `npm run service:verify-printer` under that account when possible.

### Option B - Existing warehouse Windows user

Use when the queue exists only for that user:

```powershell
$env:MARIVOLT_SERVICE_ACCOUNT = ".\WarehouseUser"
$env:MARIVOLT_SERVICE_PASSWORD = "<password>"
npm run service:install
```

Or change the account later: `services.msc` -> Marivolt Print Agent -> Log On.

### Option C - LocalSystem

Default when `MARIVOLT_SERVICE_ACCOUNT` is unset. Only use if the printer is installed **machine-wide** and verified:

```powershell
npm run service:verify-printer
```

A printer visible only to the logged-in user is **not** automatically visible to LocalSystem.

---

## Behaviour

- Heartbeat updates last seen, computer name, agent version, Windows version, available printers.
- Lease **one** job at a time -> print -> report result (unless concurrency changes elsewhere).
- Temporary network errors: bounded retry/backoff (3 attempts).
- Backend outage: loop continues; does not crash-loop the service solely for offline backend.
- Graceful stop: SIGINT / SIGTERM / service stop - stop leasing; report UNCERTAIN when physical output cannot be determined.
- Logs: `agent.log`, `agent-error.log`, plus dated files; ~10 MB rotate; retain ~14 days.

---

## Optional system tray (Phase 2)

A tray companion is **not** required for printing and is not part of the core service process.
Status colours (if implemented later): green = online + printer OK; yellow = online + printer unavailable; red = stopped / backend down.

---

## Warehouse deployment package

Prefer copying only the print-agent tree (not the full ERP repo):

```powershell
cd print-agent
npm run package:windows-service
```

Output: `print-agent/dist/windows-service/` - zip the inner `print-agent` folder for each PC. See `dist/windows-service/README.md`.

Requirements on the PC: Node.js 18+, admin rights for service install, existing `config.json` after bootstrap.

---

## Fallback: Task Scheduler (not preferred)

Use only if a true Windows Service cannot be installed:

1. Task Scheduler -> Create Task (not basic).
2. Run whether user is logged on or not (where policy allows).
3. Trigger: At startup (or At logon).
4. Action: `node` with arguments pointing to `src\index.js`.
5. Start in: the print-agent folder.
6. Settings: restart on failure; hide window if possible.

Primary production path remains the **Windows Service**.

---

## Security

- Secrets stay only in ProgramData `config.json`.
- No agent secret in service command-line arguments or WinSW XML.
- No secrets in logs (Bearer tokens redacted).
- Service install requires Administrator.
- Existing agent rotation/revocation continues to work.
- Production API requires HTTPS for agent calls.

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| Service not starting | `npm run service:status`; logs under `...\logs\`; Node path still valid |
| WinSW download HTTP 404 / fail | Confirm pin in `service/winsw-release.mjs`; run `npm run service:preflight`; or place verified `MarivoltPrintAgent.exe` in `service\bin\` |
| Config missing | Complete interactive `npm start` once; confirm `config.json` |
| Wrong service account | Reinstall with `MARIVOLT_SERVICE_ACCOUNT` or change Log On in Services |
| Printer visible to user but not service | Machine-wide install or Option A/B; `service:verify-printer` |
| Printer offline | Agent stays ONLINE; ERP shows printer unavailable; fix queue / cable |
| Backend unavailable | Logs show `backend_unavailable`; service keeps retrying |
| Secret revoked | Re-register / rotate secret in ERP; update `config.json` |
| Spooler stopped | Start "Print Spooler" Windows service |
| Log location | `C:\ProgramData\MarivoltPrintAgent\logs\` |
| Reinstall | `npm run service:uninstall` then `npm run service:install` |

---

## Manual acceptance checklist

On a Windows test PC:

1. Existing manual `npm start` works
2. Stop manual agent
3. Install service as Administrator
4. Service status is RUNNING
5. ERP agent becomes ONLINE
6. ERP Test Connection succeeds
7. ERP Test Print prints one 100 x 50 mm label
8. Close all PowerShell windows - agent remains ONLINE
9. Restart PC - agent returns ONLINE automatically
10. Printer-offline state is reported without service crash
11. Reconnect printer and confirm recovery
12. Stop service -> ERP OFFLINE; start service -> ONLINE
13. Uninstall service -> config/logs remain

---

## Tests

```powershell
cd print-agent
npm test
node --check src/index.js
node --check service/install-service.mjs
```
