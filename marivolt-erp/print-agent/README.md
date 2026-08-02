# Marivolt Windows Print Agent (Phase 1)

Outbound HTTPS agent for Rongta USB labels via Windows named printer / spooler.

## Print transport

Phase 1 uses **RAW** datatype through the Windows spooler (`WritePrinter` / `pDataType = RAW`).
TSPL bytes are sent unaltered — not driver-rendered GDI text.

## Setup

1. In ERP (Admin): **Settings → Label Printing → Register Print Agent** → copy `agentId` + one-time `secret`.
2. Create printer mapping: company + warehouse + agentId + **exact** Windows printer name.
3. On the warehouse PC:

```
mkdir "%ProgramData%\MarivoltPrintAgent"
copy config.example.json "%ProgramData%\MarivoltPrintAgent\config.json"
```

4. Edit `config.json` with backend URL (`https://…`), agentId, secret, and Windows printer name.
5. Restrict ACL on `config.json` to the service account only (Properties → Security).
6. Install Node 18+, then:

```
cd print-agent
npm start
```

7. Test:

```
npm run test-print
```

8. Windows startup: Task Scheduler → At logon → Action `node` → Arguments `src/index.js` → Start in = this folder.

## Behaviour

- Heartbeat → lease **one** job → print → report result (no concurrent leases unless you run multiple agent processes).
- Temporary network errors: bounded retry/backoff (3 attempts).
- Backend outage: loop continues; does not crash.
- Graceful stop: Ctrl+C finishes the current loop iteration; do not kill mid-WritePrinter if avoidable.
- Logs: `%ProgramData%\MarivoltPrintAgent\logs\agent-YYYY-MM-DD.log` (daily files; rotate/delete old logs manually).

## Security

- Agent uses `Authorization: Bearer <secret>` + `X-Print-Agent-Id` (not user JWT).
- Outbound HTTPS only — no inbound ports.
- Agent only receives jobs assigned to its agentId / company.
- Production API rejects non-HTTPS agent calls.
