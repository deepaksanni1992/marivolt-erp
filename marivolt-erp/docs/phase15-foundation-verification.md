# Phase-15 Foundation Verification

## Lightweight Smoke Validation

Run:

`npm run smoke:phase15`

Required env vars:

- `PHASE15_TOKEN` (Bearer token)
- `PHASE15_COMPANY_ID` (active company scope)

Optional env var:

- `PHASE15_OTHER_COMPANY_ID` (for wrong-company token scope check)

Current smoke coverage:

- template auto-seeding non-duplication
- thread create with linked documents
- status transitions (`OPEN -> WAITING_REPLY -> CLOSED -> OPEN`) and invalid transition rejection
- filters (`party`, `documentNo`, `status`)
- portal visibility filter (`visibility=CUSTOMER|SUPPLIER|INTERNAL`)
- token safety (`invalid`, `expired`, and optional `wrong company scope`)
- linked document ID validation (`documentId` must be a valid ObjectId if provided)

