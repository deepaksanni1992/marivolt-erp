# Marivolt Windows Print Agent (Phase 1 + enterprise multi-agent)

Outbound HTTPS agent for Rongta USB/network labels via Windows named printer / spooler.
Supports **multiple agents** and **multiple printers** per company/warehouse.

## Print transport

Phase 1 uses **RAW** datatype through the Windows spooler (`WritePrinter` / `pDataType = RAW`).
TSPL bytes are sent unaltered — not driver-rendered GDI text.

## First-launch (recommended)

1. In ERP (Admin): **Settings → Label Printing** → set an **Agent bootstrap token** and Save.
2. Note your **Company ID** (from admin / company record).
3. On the warehouse PC, install Node 18+, then:

```
cd print-agent
npm start
```

4. On first run (no config yet), the agent will:
   - Auto-detect computer name, OS / Windows version, and available Windows printers
   - Ask for Backend URL, Company ID, Warehouse, Friendly Agent Name, Bootstrap token
   - Let you pick a Windows printer
   - Self-register and write `%ProgramData%\MarivoltPrintAgent\config.json`

5. Restrict ACL on `config.json` to the service account only.

6. Test from ERP: Agent Dashboard → **Test Connection** / **Test Print**.

## Manual setup (admin-registered agent)

1. ERP: **Register Print Agent** → copy `agentId` + one-time `secret`.
2. Create printer mapping (company/warehouse + agent + exact Windows printer name).
3. Copy `config.example.json` to `%ProgramData%\MarivoltPrintAgent\config.json` and fill values.
4. `npm start`

## Behaviour

- Heartbeat updates last seen, computer name, agent version, Windows version, available printers.
- Lease **one** job at a time → print → report result.
- Jobs are routed in ERP by: explicit printer → warehouse default → warehouse assigned → company default.
- Temporary network errors: bounded retry/backoff (3 attempts).
- Backend outage: loop continues; does not crash.
- Graceful stop: Ctrl+C finishes the current loop iteration.
- Logs: `%ProgramData%\MarivoltPrintAgent\logs\agent-YYYY-MM-DD.log`

## Windows startup

Task Scheduler → At logon → Action `node` → Arguments `src/index.js` → Start in = this folder.

## Security

- Agent uses `Authorization: Bearer <secret>` + `X-Print-Agent-Id` (not user JWT).
- Bootstrap registration uses a **company-scoped** bootstrap token (hashed at rest; optional warehouse/expiry/max-uses).
- Stable `installationId` UUID prevents duplicate agents on repeated bootstrap.
- Outbound HTTPS only — no inbound ports.
- Production API rejects non-HTTPS agent and bootstrap calls.
- Disabled agents cannot poll, lease, or report.
- Discovery never auto-creates ERP printer mappings — admin must map printers.
