# Phase S0 — Auth & perimeter security deployment

## What changed

- Public `POST /api/auth/register` returns **410** (`REGISTRATION_DISABLED`).
- Admin user creation: authenticated `POST /api/auth/users` with role/company policy.
- Analytics always uses `req.companyId` (ignores `?company=` overrides).
- Exact-origin CORS via `CORS_ALLOWED_ORIGINS` (no `*.vercel.app` wildcard in production).
- Auth rate limits on login, TOTP verify, company select, admin user create.
- Company list/get/update membership checks.
- Seed script requires env credentials; refuses production without safety flag.

## Required environment variables

```bash
# Exact browser origins (comma-separated). Example:
CORS_ALLOWED_ORIGINS=https://marivolt-erp.vercel.app

# Optional legacy single origin (also allowlisted if set)
# CLIENT_URL=https://marivolt-erp.vercel.app

# Reverse proxy hops (Render = 1)
TRUST_PROXY_HOPS=1

# Auth rate limits (optional; defaults shown)
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_LOGIN_MAX=10
AUTH_RATE_LIMIT_TOTP_MAX=10
AUTH_RATE_LIMIT_SELECT_COMPANY_MAX=30
AUTH_RATE_LIMIT_ADMIN_CREATE_WINDOW_MS=3600000
AUTH_RATE_LIMIT_ADMIN_CREATE_MAX=20

# Seed only if you still need seedUsers.js
SEED_ADMIN_EMAIL=
SEED_ADMIN_PASSWORD=
SEED_ADMIN_COMPANY_ID=
# SEED_ADMIN_NAME=Admin
# SEED_ADMIN_USERNAME=
# SEED_ADMIN_ROLE=admin
# SEED_ALLOW_PRODUCTION=true   # required when NODE_ENV=production
# SEED_RESET_PASSWORDS=true    # only when intentionally resetting password
```

## Safe deployment order

1. Set `CORS_ALLOWED_ORIGINS` (and rate-limit env if customising).
2. Set seed env vars only if seed remains necessary.
3. Deploy application changes.
4. Confirm `POST /api/auth/register` returns **410**.
5. **Manually rotate** previously exposed seed-account passwords (see checklist).
6. Revoke or expire existing sessions where practical (force re-login; JWT has no server revocation list).
7. Test login and TOTP.
8. Test company isolation (reports user cannot pass another company id).
9. Review security / activity logs for failed logins and CORS rejects.

## Manual production credential rotation checklist

Previous versions of `seedUsers.js` contained plaintext seed passwords in git history.
Those passwords must be treated as compromised.

Affected account patterns (mask; rotate every match in production):

| Masked identity | Typical role | Action |
|-----------------|--------------|--------|
| `a***@marivoltz.com` (username `advitya`) | admin | Disable or rotate password; verify TOTP ownership |
| `k***@marivoltz.com` (username `kalpesh`) | accounts_logistics | Rotate password; review recent logins |
| `h***@marivoltz.com` (username `himanshu`) | purchase_sales | Rotate password; review recent logins |

Checklist:

1. Identify affected users in the User collection by username/email pattern above.
2. Disable inactive/obsolete accounts (`isActive=false`) or rotate passwords via a trusted admin path.
3. Force re-authentication (users must log in again; old JWTs expire within token TTL).
4. Verify TOTP is owned by the real user; admin-reset 2FA if device ownership is uncertain.
5. Review recent login activity (`/api/admin/activity` or UserActivity).
6. Remove obsolete accounts that should not exist.
7. Confirm passwords were never reused on other systems; rotate there too if so.
8. Do **not** re-run seed with `SEED_RESET_PASSWORDS` against production unless intentionally recovering a break-glass account.

## Admin user creation API

`POST /api/auth/users` (Bearer + company context; roles: `super_admin` | `company_admin` | `admin`)

Allowed body fields:

- `name`, `username`, `email`
- `password` or `temporaryPassword` (min 10 chars)
- `role` (server-validated allowlist)
- `companyIds` or `allowedCompanies` (non-empty; membership-validated)
- `defaultCompanyId` (optional; must be in assigned companies)
- `isActive` (optional; default true)

Rejected if present: `passwordHash`, TOTP fields, `permissionOverrides`, `roleIds`, audit/system fields.

## Verification after deploy

```bash
curl -i -X POST "$API/api/auth/register" -H "Content-Type: application/json" -d "{\"email\":\"x@y.com\",\"password\":\"toolongpass\"}"
# expect 410 REGISTRATION_DISABLED

npm --prefix backend test
npm --prefix backend run verify
```
