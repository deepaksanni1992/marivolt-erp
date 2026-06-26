# Per-user Two-Factor Authentication (TOTP)

Each ERP user has their **own** Authenticator setup. Secrets are never shared between users.

## Design principles

| Rule | Implementation |
|------|----------------|
| One user = one unique TOTP secret | `generateUserTotpSecret()` per user at setup |
| Secret stored only on that user | `User.twoFactorSecret` (encrypted, `select: false`) |
| QR code per user | `POST /auth/2fa/setup` — authenticated user only |
| QR label shows user + company | `otpauth://` issuer = company name/code, account = email/username |
| No cross-user verification | Login loads **that** user's secret via `userId` from ticket |
| Admin sees enable/disable only | `GET /auth/users` exposes `twoFactorEnabled`, never secret |
| Admin reset | `POST /auth/users/:id/reset-2fa` clears **only** that user's fields |
| Legacy users | `twoFactorEnabled: false` (default) → password-only login |

## User model fields

```js
twoFactorEnabled: Boolean        // default false
twoFactorSecret: String          // AES-256-GCM encrypted, select: false
twoFactorEnabledAt: Date
twoFactorLastVerifiedAt: Date
```

## Environment

```env
TOTP_ENCRYPTION_KEY=replace-with-strong-totp-encryption-key
```

Falls back to `JWT_SECRET` in development if unset (not recommended for production).

## User flows

### Enable (self-service)

1. User logs in → **Profile / Security** (or Topbar → Security)
2. **Enable Authenticator** → unique secret generated for **this user only**
3. Scan QR in Authenticator app (label includes email/username and company)
4. Enter 6-digit code → `twoFactorEnabled` set true for **this user only**

### Login with 2FA

1. Username/password validated
2. If `user.twoFactorEnabled` → `requires2FA` + short-lived `twoFactorTicket`
3. User enters code → verified against **same user's** `twoFactorSecret` only
4. On success → JWT issued (then company selection if needed)

### Disable (self-service)

Profile / Security → password + current TOTP code → clears **only** that user's 2FA fields.

### Admin reset

Settings → **Users & 2FA** → **Reset 2FA** on a user who lost their phone.  
Clears only that user's fields. Admin never sees the TOTP secret.

## API summary

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/auth/login` | — | Returns `requires2FA` when enabled |
| POST | `/auth/2fa/verify-login` | ticket | Verifies code for ticket's user |
| GET | `/auth/2fa/status` | Bearer | Current user's 2FA status |
| POST | `/auth/2fa/setup` | Bearer | QR for **current user only** |
| POST | `/auth/2fa/confirm` | Bearer | Enable after code check |
| POST | `/auth/2fa/disable` | Bearer | Password + code |
| GET | `/auth/users` | Admin | Includes `twoFactorEnabled` |
| POST | `/auth/users/:id/reset-2fa` | Admin | Reset without exposing secret |

## Testing checklist

1. Deepak enables 2FA  
2. Advity enables 2FA  
3. Confirm different secrets (DB or setup twice)  
4. Login as Deepak with Deepak's code → success  
5. Login as Deepak with Advity's code → fail  
6. Login as Advity with Advity's code → success  
7. Login as Advity with Deepak's code → fail  
8. Admin reset Deepak → Advity unchanged  
9. User without 2FA → normal login  
10. ERP business modules unaffected  

Automated unit test (no DB):

```bash
cd backend && node scripts/twoFactorPerUser.test.js
```

## Security notes

- `twoFactorSecret` is excluded from default queries (`select: false`)
- Setup/confirm/disable endpoints require authenticated session for **self only**
- `twoFactorTicket` JWT purpose `2fa_verify`, 10-minute TTL, bound to `userId`
- Failed verifications logged as `TWO_FACTOR_VERIFY_FAILED`
