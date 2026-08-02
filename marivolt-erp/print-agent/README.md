# Marivolt Windows Print Agent (Phase 1)

Outbound HTTPS agent for Rongta USB labels via Windows named printer / spooler.

## Setup

1. In ERP (Admin): **Register Print Agent** → copy `agentId` + one-time `secret`.
2. Create printer mapping: company + warehouse + agentId + Windows printer name.
3. On the warehouse PC:

```
mkdir "%ProgramData%\MarivoltPrintAgent"
copy config.example.json "%ProgramData%\MarivoltPrintAgent\config.json"
```

4. Edit `config.json` with backend URL, agentId, secret, and exact Windows printer name.
5. Restrict ACL on `config.json` to the service account only.
6. Install Node 18+, then:

```
cd print-agent
npm start
```

7. Test:

```
npm run test-print
```

8. Optional: Task Scheduler → At logon → `node src/index.js` with working directory = this folder.

## Security

- Agent uses `Authorization: Bearer <secret>` + `X-Print-Agent-Id` (not user JWT).
- Outbound HTTPS only — no inbound ports.
- Agent only receives jobs assigned to its agentId / company.
