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

The drill and the replication step answer two different questions — "does this
restore" and "does a copy exist anywhere else" — so the job reports both, and
the failing one gets the last word.

```
✓ Restore drill passed. The backup is usable.
⚠ No offsite copy — replication is not configured.
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

### Seed credentials never reach a remote database
The seed mints a fixed-plaintext API token so the `/api/v1` suite has something
to authenticate with. That constant lives in a committed, publicly readable
file, and a bearer token is resolved *before* login, MFA and the rate limiter —
so seeding it into any reachable deployment publishes full owner access.

This is not hypothetical: it happened to this project. The demo token was seeded
into the live Neon database and, for a short window, `Authorization: Bearer
nxk_demo_…` returned all 122 owner permissions from the public URL. It has been
revoked, and the seed now refuses to create it unless the target database host
is `localhost`.

The gate is deliberately on the **database host**, not `NODE_ENV`. `NODE_ENV` is
unset on a developer laptop, so a `NODE_ENV !== "production"` check would have
cheerfully minted the token while seeding a cloud database from that laptop —
exactly the path that caused the incident. "Am I pointed at localhost?" is the
question that actually protects the deployment; "am I in production?" is not.

The same reasoning applies to the demo passwords (`demo1234`). They are fine on
a laptop and unacceptable on anything reachable. A deployment carrying seed data
is a demo, and should be treated as public.

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
AES-256-GCM, streaming, keyed separately from the application, with a random
per-backup salt. The plaintext dump is deleted immediately after encryption.
`npm run backup:verify` decrypts **the stored artefact** and restores it —
proving the thing that actually goes offsite is usable, not just that `pg_dump`
ran. Without `BACKUP_ENCRYPTION_KEY` the job **refuses to run**: there is no
plaintext path, because an unencrypted dump is the easiest way to bypass every
field-level control above. A key that is short, low-entropy, placeholder-shaped
or equal to the one `.env.example` publishes is refused on the same grounds.

### Offsite replication
`scripts/backup-replicate.mjs`. S3-compatible object storage — AWS, Cloudflare
R2, Backblaze B2, MinIO, Wasabi — over the REST API with SigV4 signing and **no
vendor SDK**. Five HTTP verbs and ~120 lines of signing, against ~80 transitive
packages that would each hold read access to the most sensitive file the
business owns. The trade is stated where it costs something: there is no
multipart upload, so an artefact over the 5 GiB single-PUT limit is **refused
loudly** rather than truncated.

**Encryption happens before upload, and the order is enforced, not assumed.**

```
pg_dump → .dump  ·  encrypt → .dump.enc  ·  unlink .dump  ·  THEN upload
```

The upload path re-reads the first six bytes and refuses anything that is not
`NEXBK1`/`NEXBK2` ciphertext. That guard exists because a refactor that swaps
the unlink and the upload reads perfectly well and would publish every party,
salary and Emirates ID in the business to an object store. The provider holds
ciphertext; `BACKUP_ENCRYPTION_KEY` never leaves the machine.

**The replica is verified, not assumed.** An HTTP 200 says the request was
accepted, not that the bytes on the far side are the bytes that were sent. After
the PUT the object is read back in full and its SHA-256 compared end to end
(`BACKUP_S3_VERIFY=head` relaxes this to size + ETag and says so in the output
rather than reporting the stronger check). The upload itself is independently
integrity-checked: `x-amz-content-sha256` carries the real payload hash, which
the server validates against the body it received.

**Replication is off by default and loud when it fails.** It turns on only when
`BACKUP_S3_BUCKET` is set; once set, every other variable is mandatory, because
a half-configured target is a backup that reports success and goes nowhere. If
replication is configured and does not complete, `npm run backup` **exits
non-zero** — a green backup whose only copy is on the machine it protects is the
same defect as an outbox marking undelivered messages `success`. With
replication unconfigured the job still succeeds locally and says exactly what
did not happen:

```
⚠ REPLICATION: NOT CONFIGURED — nothing was uploaded.
  This backup exists only at ./backups on this machine. The disk that
  loses the database loses this file with it, and the 15-year UAE
  retention obligation is not met by local disk.
```

### Retention policy
Driven by the **fifteen-year** retention obligation on UAE real-estate and
tenancy records. Grandfather-father-son, applied identically to local disk and
to the offsite copy:

| Tier | Kept | Default |
|---|---|---|
| Daily | every backup | last 30 days |
| Weekly | newest per ISO week | last 26 weeks |
| Monthly | newest per calendar month | last 24 months |
| **Yearly** | **newest per calendar year** | **15 years — the obligation** |
| Expired | eligible for deletion | beyond 15 years |

The first three rows are operational and tunable. The floor is legal:
`BACKUP_RETENTION_FLOOR_YEARS` may be **raised** but any value below 15 is
refused, so a mistyped variable on one host cannot delete evidence the business
is required to be able to produce. Beyond the floor, deletion is permitted
rather than mandatory-forever — PDPL data minimisation argues for eventually
letting go of personal data the law no longer requires.

Three refusals sit on top of the tiers, because retention bugs are discovered
years later, when the deleted thing is the thing being asked for:

- the **most recent** backup is never a prune candidate under any policy;
- a **floor guard** promotes back to `keep` any backup that is the only
  survivor for its calendar year inside the floor. This is not theoretical:
  ISO weeks straddle the new year, so `2025-12-31` and `2026-01-02` share week
  `2026-W01` and week-bucketing alone would prune the older one — emptying
  calendar 2025 if it held nothing else;
- a file whose name this tool did not generate is **never deleted**.

Pruning is `off` by default; `BACKUP_PRUNE=local|remote|both` opts in and
`BACKUP_PRUNE_DRY_RUN=true` (or `--plan`) reports the decision without acting.
Every entry carries a reason, because "why did you delete that" is a question
this will be asked during an audit.

```
· Retention — offsite (https://…/nexus/)
  10 kept · 4 pruned
  − nexus-2026-06-10T02-00-00.dump.enc  (superseded within week 2026-W24)
  − nexus-2019-07-01T02-00-00.dump.enc  (superseded within year 2019)
  − nexus-2009-06-01T02-00-00.dump.enc  (older than the 15-year retention floor)
```

Object-store **versioning and object lock** are recommended on top of this and
are not configured by this code: the credentials the backup job holds can delete
what the job uploaded, which is the wrong shape for a fifteen-year archive
facing ransomware. That is a bucket-policy decision for whoever provisions the
target.

### Where the backups live is an open legal question — Q-8
`BACKUP_S3_REGION` and `BACKUP_S3_ENDPOINT` are **required and have no
default**, and this is deliberate.

Q-8 is unresolved: whether storing UAE personal data outside the UAE satisfies
PDPL cross-border transfer rules for records carrying a fifteen-year in-UAE
retention obligation. The question applies to the backup target at least as
much as to the primary database — a backup is a complete copy of every party,
salary and Emirates ID in the business, at rest, for fifteen years, and the
primary is already in Neon `ap-southeast-1` (Singapore).

**This code does not choose a region and will not disguise a choice as a
default.** `ap-southeast-1` is not a neutral fallback; it is a legal decision
about where UAE personal data comes to rest. Whoever sets those two variables is
the person accepting that decision, and it should be taken with advice, not by
copying an example. Until Q-8 has an answer, that is the honest state: the
mechanism is built and the location is not chosen.

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
| Offsite backup replication | **Built** — S3-compatible target, verified by read-back, with a 15-year retention floor. Not *enabled*: no region has been chosen, pending Q-8 |
| Immutable backup storage | Versioning and object lock are recommended in § Retention policy and are a bucket-policy decision, not configured here |
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

The remaining gaps are operational (scanning, log shipping, choosing a backup
region, a pen test) rather than architectural. The controls that are expensive to retrofit
— isolation model, permission model, ledger integrity, idempotency, consent —
are in place.
