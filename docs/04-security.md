# 04 — Security

Split into **built and verified** and **not built**. Nothing here is aspirational
unless it says so.

---

## Threat model

| Adversary | Goal | Primary control |
|---|---|---|
| Another tenant on the platform | Read or write your data | PostgreSQL RLS beneath application filtering |
| A curious employee | See payroll, margins, other branches | RBAC + business-unit scoping, enforced in the service layer |
| A dishonest employee | Skim cash, adjust stock, take a payment twice | Cash-drawer variance, immutable stock ledger, append-only audit log |
| Credential-stuffing attacker | Take over an account | argon2id, TOTP MFA, IP + per-account rate limits, silent lockout |
| Someone with a stolen database dump | Use the contents | Hashed passwords, hashed sessions, encrypted MFA seeds |
| A compromised app process | Escalate to all tenants | Non-owner DB role, `NOBYPASSRLS`, no DDL grant |
| A misconfigured deploy | Message real customers by accident | Dry-run defaults on every outbound job, consent ledger |

---

## Built and verified

### Passwords — argon2id
`m=64 MiB, t=3, p=4, 32-byte output`, comfortably above the OWASP minimum of
19 MiB / t=2. argon2id specifically: the hybrid that resists both GPU cracking
and side-channel attack.

Verification burns comparable time on a *missing* account, so response latency
cannot be used to enumerate addresses. A malformed stored hash returns `false`
rather than throwing — an exception there would be an oracle distinguishing
"corrupt row" from "wrong password".

```
✓ passwords are argon2id, not a placeholder   $argon2id$v=19$m=65536,t=3
```

### Multi-factor authentication — TOTP
RFC 6238, SHA-1 (what authenticator apps actually implement), 6 digits, 30s
period, ±1 step window. One step, not two: every extra step widens the
brute-force surface and 30 seconds of clock skew is already generous.

- Required for roles that can move money — owner, accountant, general manager.
  The gate is by *capability*, not seniority.
- The seed is **encrypted** (AES-256-GCM), not hashed, because the server needs
  the original to compute the expected code. The key is derived from
  `AUTH_SECRET` and lives outside the database.
- Recovery codes are **hashed** and deleted on use — single use enforced by
  deletion, not a flag.
- Enrolment persists nothing until the user proves they can generate a valid
  code. A half-finished enrolment would lock them out of their own account.
- The pending-MFA state is a separate HMAC-signed cookie with a 10-minute life,
  so there is no code path where a password-only session can be mistaken for a
  full one.

### Rate limiting and lockout
Database-backed, not in-memory: an in-memory limiter resets on deploy and is
per-instance, so it stops nobody the moment you run two containers.

| Surface | Limit |
|---|---|
| Login per IP | 30 / 5 min |
| Login per account | 10 / 5 min |
| MFA code | 8 / 5 min — tighter, because six digits is a small keyspace |
| Account lockout | 8 failures → 15 minutes |

The lockout is **silent**: the login form returns the same generic failure
whether the password was wrong, the account does not exist, or it is locked.
Each distinction is a user-enumeration oracle.

### Security headers
Applied in middleware, so a new page cannot ship without them — the same
reasoning as generating RLS policies from the schema.

```
✓ Content-Security-Policy is set with a script nonce
✓ CSP forbids framing and inline objects
✓ X-Frame-Options: DENY
✓ X-Content-Type-Options: nosniff
✓ Referrer-Policy is restrictive
✓ Permissions-Policy denies camera, mic and geolocation
```

`'unsafe-inline'` on **style-src** is a real, acknowledged weakening — React
injects inline styles and the theme uses inline CSS custom properties. It is
scoped to styles only; `script-src` keeps a per-request nonce, which is where
XSS actually lands. HSTS is set in production only.

### Tenant isolation
- Policies **generated from the schema**, so a new table cannot ship unprotected.
- `FORCE ROW LEVEL SECURITY` on all 88 tenant tables — without it a table owner
  silently ignores its own policies.
- App runs as `nexus_app`: not the owner, `NOBYPASSRLS`, DML only, no DDL.
- Context set with `SET LOCAL` **inside a transaction**, never on pool acquire.
- Global-row tables (`roles`) are readable by all, writable by none — otherwise
  a tenant could mint a platform-wide role and escalate everywhere.

```
✓ no tenant context → zero rows
✓ correct tenant context → rows visible
✓ different tenant context → zero rows
✓ cross-tenant INSERT is rejected by the database
✓ tenant cannot create a platform-global role
```

### Authorisation
16 system roles over a `resource:action` catalogue, with scope levels
`tenant` / `business_unit` / `location` / `self`.

- **Deny beats grant** in override resolution.
- An empty scope list means *no businesses*, not *all businesses* — fail-closed.
- Enforced in `requirePermission` at the top of every service function, before
  any read. The AI assistant is bound by the same checks as the UI.

```
✓ a role without payment:create cannot record a payment
✓ a business-scoped user cannot post into another business
✓ WPS export is denied without payroll:read   barber got 403
```

### Write integrity
- **Idempotency keys** on every mutation. A double-tapped button or a retry
  after a dropped connection replays the original result. Staff record payments
  from basement car parks; this is not theoretical.
- **One transaction** per operation covering the document, its lines, its
  journal, its stock moves and its audit record.
- **Over-allocation rejected** — a payment cannot exceed the invoice balance.
- **Closed periods refuse postings**, so a backdated entry cannot silently
  change a P&L that has already been reported.
- **Unallocated money posts to customer advances** (a liability), never to
  revenue or as a reduction of receivables.

```
✓ a replayed payment returns the original, not a second charge
✓ only one payment row exists after the replay
✓ over-allocating an invoice is rejected
✓ unallocated money posts to customer advances, not revenue
```

### Audit trail
Append-only, written by the service layer on every mutation that touches money,
permissions or customer data. Stores only the **changed fields** — a full-row
copy duplicates PII across thousands of entries and makes the log unreadable to
the person who needs it. Captures actor, role, IP, user agent and request id.

```
✓ every money movement writes an audit record
```

### Outbound messaging — consent before capability
Built before any provider was connected, deliberately. Gates, in order:
consent → quiet hours (21:00–08:00 GST, critical exempt) → contactability →
bounded retries with backoff.

A suppressed message is recorded as **suppressed**, never as failed; conflating
them hides real delivery problems behind a wall of expected skips. Marketing
requires an affirmative opt-in; transactional is permitted unless withdrawn.
The default provider **logs instead of sending** — a misconfigured environment
must not be able to message real people.

```
28 considered · 17 would send · 11 suppressed (no marketing opt-in)
```

### Backups
`npm run backup:verify` takes a backup, restores it into a scratch database and
asserts that document count, journal-line count, total debits, total credits,
gratuity provision and receivables all reproduce **exactly** — and that the
restored ledger still balances. An untested backup is a file you hope is a
backup.

```
✓ documents 4163 · journal lines 28077 · debits = credits
✓ restored ledger balances
✓ Restore drill passed. The backup is usable.
```

### Injection
Every value is a bound parameter. The single `sql.raw` use takes a column name
from a closed internal set. Arrays use explicit `ARRAY[$1::uuid, …]`. Zod
validates all service and metric inputs before execution.

---

### Personal data encrypted at rest
Emirates ID, passport number, IBAN, visa and labour-card numbers on `employees`;
national ID and tax ID on `parties`. AES-256-GCM, per-value random IV, with the
key id as authenticated additional data so an attacker cannot relabel an
envelope to force decryption under a different key.

Three columns per protected field:

| | |
|---|---|
| `_enc` | the envelope, carrying its key id |
| `_bidx` | keyed HMAC-SHA256, truncated to 128 bits — exact lookup only |
| `_hint` | masked last four, so a list renders `••••1234` without decrypting |

**Why a blind index rather than a deterministic cipher:** deterministic
encryption restores `WHERE =` but leaks equality across the whole table and is
open to frequency analysis. A keyed HMAC supports exact match and nothing else —
no ranges, no prefixes. It is keyed, not a plain hash, because an unkeyed hash of
an Emirates ID is brute-forceable in seconds: the format has ~10¹¹ possibilities.

**Rotation is online.** Add a key, set `PII_ACTIVE_KEY_ID`, run
`npm run pii:rotate --commit`. New writes use the new key immediately; old values
decrypt under theirs until migrated. The retired key must stay in the keyring
until the job reports zero. A scheme you cannot rotate is one still using its
first key the day it leaks.

Phone and email are deliberately **not** encrypted: they are operational contact
data needed on every list render and in every message template, and they are
already known to anyone who has received a message from the business. Encrypting
them would cost real performance for no meaningful protection.

```
✓ Emirates ID is stored as an AES-GCM envelope, not plaintext   p1.1.-GjpzQJpV
✓ only a masked hint is stored in the clear                     ••••2115
✓ no Emirates ID pattern survives in a raw dump
✓ no UAE IBAN pattern survives in a raw dump
✓ the compliance page shows masked IDs, never full ones
```

### Fail-closed configuration
The app refuses to start in production on a default `AUTH_SECRET`, a missing or
malformed PII key, or — the one that matters most — an `APP_DATABASE_URL`
identical to `DATABASE_URL`, which would run the app as the table owner and make
every RLS policy a no-op. Development warns instead of crashing, so a fresh
clone still runs.

### Security event stream
Structured JSON on stdout, one object per line, ingestible by any shipper
without an agent. Records what was *attempted*, not just what changed — a
successful login is unremarkable, forty failures then a success is the story.
Redacts anything matching password/token/IBAN/Emirates-ID key patterns and
partially masks emails, because a security log that leaks the credentials it
reports on is worse than none. An `AlertSink` hook takes lockouts, cross-tenant
attempts and recovery-code use straight to a pager.

### Session management
Concurrent sessions capped at five, oldest revoked first — an account with
twenty live sessions is what a compromised credential looks like. "Sign out
everywhere" revokes every token immediately, which is the remedy a password
change does *not* provide.

```
✓ concurrent sessions are capped                        7 logins → 5 live
✓ the oldest session is the one revoked, not the newest
✓ a revoked session is rejected on the very next request
```

### Right to erasure — and why it is not `DELETE`
UAE PDPL art. 15 grants erasure; UAE tax law requires invoices to be kept five
years. Both are satisfied by pseudonymisation: the identifying data is destroyed,
the transaction survives with a tombstoned counterparty. Deleting the invoice
would unbalance the ledger, break a filed VAT return, and expose the business to
a penalty for destroying records.

The function refuses to run on anyone with an outstanding balance, an active
lease or an open job — erasing a tenant mid-tenancy destroys the evidence needed
to enforce the contract. Subject-access export returns identifiers **masked**:
emailing a full Emirates ID to answer a privacy request creates a new exposure
while closing an old one.

```
✓ erasure clears the encrypted ID and its blind index
✓ erasure RETAINS the tax invoices (statutory 5-year retention)   14 kept
✓ the name snapshot on retained invoices is overwritten too
✓ erasure records a hard opt-out on every channel
```

### Encrypted backups
AES-256-GCM, streaming, keyed separately from the application. The plaintext
dump is deleted immediately after encryption. `npm run backup:verify` decrypts
**the stored artefact** and restores it — proving the thing that would actually
go offsite is usable, not just that `pg_dump` ran. Without
`BACKUP_ENCRYPTION_KEY` it still works but warns loudly, because an unencrypted
dump is the easiest way to bypass every field-level control above.

### Dependency scanning and CI
`npm audit --audit-level=high` gates the build. The full suite — build, metrics,
write layer, end-to-end, security regression, backup drill — runs on every pull
request against a real Postgres service. A security check that only runs when
someone remembers is not a control.

Current audit state: **4 moderate, 0 high, 0 critical.** All four are one
advisory (esbuild's dev server) reaching us through `drizzle-kit`, which is a
`devDependency` and is verifiably absent from the production tree
(`npm ls drizzle-kit --omit=dev` → empty). Forcing the fix would downgrade
drizzle-kit by a major version. Accepted and documented rather than silently
suppressed.

---

## Not built

| Control | Status |
|---|---|
| Offsite backup replication | Backups are encrypted but stay on local disk — needs an S3/GCS target and a retention policy |
| Centralised log shipping | Events are structured and ready; no collector is wired |
| SSO / SAML | Not implemented |
| Signed webhooks | Not implemented — no outbound integrations yet |
| Penetration test | Not performed. The regression suite below is a net, not a substitute |
| Hardware-backed key storage (KMS/HSM) | Keys come from environment variables |
| Anomaly detection on the event stream | Events are emitted; nothing consumes them |

### The security regression suite

`npm run test:security` — **68 checks** against the running application:
authentication bypass (six token shapes), user enumeration including a timing
comparison, IDOR and path traversal, SQL injection and reflected XSS,
cross-tenant read/write/DDL, PII at rest *and* in a raw `pg_dump`, transport
headers, rate limiting, session capping, erasure semantics and audit-log
hygiene.

This is **not a penetration test**. A pen test is an adversarial human with time
and creativity. This is a regression net that stops a refactor quietly reopening
something already closed — valuable, and a different thing.

---

## OWASP Top 10 (2021)

| | Status |
|---|---|
| A01 Broken access control | **Addressed** — RLS + RBAC + scoping, fail-closed, verified |
| A02 Cryptographic failures | **Addressed** — argon2id, hashed sessions, encrypted MFA seeds. Field-level PII encryption outstanding |
| A03 Injection | **Addressed** — parameterised everywhere, inputs validated |
| A04 Insecure design | **Addressed** — invariants in the database, AI cannot write SQL, automations dry-run and capped, idempotency on every write |
| A05 Security misconfiguration | **Addressed** — CSP, HSTS, frame denial, hardened DB role |
| A06 Vulnerable components | **Partial** — current versions; automated scanning outstanding |
| A07 Auth failures | **Addressed** — argon2id, TOTP, rate limits, silent lockout, hashed session tokens |
| A08 Data integrity | **Addressed** — double-entry, immutable ledgers, audit trail, verified restores |
| A09 Logging & monitoring | **Partial** — audit log written and queryable; shipping and alerting outstanding |
| A10 SSRF | N/A — no outbound fetches to user-supplied URLs |

The remaining gaps are operational (scanning, log shipping, offsite backups, a
pen test) rather than architectural. The controls that are expensive to retrofit
— isolation model, permission model, ledger integrity, idempotency, consent —
are in place.
