# 08 — Staging

The environment that OPS-07 §1.3, §2.1, §2.5 and §3.1 have always assumed and
that has never existed. This document is half design and half checklist; the
checklist in § 6 is the part only the owner can execute.

**Status: not yet standing up.** The pipeline is committed and switched off. It
is off deliberately and it says so loudly — see § 5.

---

## 1. Why a preview deployment is not staging

Every Vercel preview deployment of this repository connects to the **production
database**. That is not a suspicion; it is stated in `README.md` and it is the
reason two rows of the deploy checklist have never been ticked.

A preview is a complete copy of the application with every server action
enabled. A branch that half-rewrites the rent run posts real journals into the
real ledger. A migration under review that contains a `TRUNCATE` destroys real
records. The RLS gate does not help, because the tenant is the same real tenant
and `nexus_app` is behaving exactly as designed.

So the requirement is not "a second URL". It is **a second database, holding
production-shaped data that is not production data, that every migration
crosses before production sees it.**

Three separate things follow from that, and they are the three sections below:
a fence so that nothing can be confused about which database it is on (§ 2), a
copy procedure that does not create a second production system (§ 4), and a
pipeline that proves the migration before promotion (§ 5).

---

## 2. The environment fence

`scripts/check-env.mjs` answers one question that nothing in the system
previously asked:

> Which environment does this deployment believe it is, and is the database it
> is connected to the one that belief implies?

The existing boot gate in `packages/core/src/security/config.ts` asks a
different and narrower question — whether `APP_DATABASE_URL` resolves to the
same *role* as `DATABASE_URL`, which would mean RLS is a no-op. That check is
correct and is unaffected by this one. It passes cleanly when a preview is
connected to production as `nexus_app`, which is precisely the accident.

Neither half of the question can be inferred, so both are declared.

| Variable | Secret? | Set where | What it is |
| --- | --- | --- | --- |
| `NEXUS_ENV` | no | every environment, and CI | `production` \| `staging` \| `preview` \| `development` \| `test` |
| `NEXUS_PRODUCTION_DB_HOST` | **no** | **every environment**, including the ones that must never reach production | production's hostname, or `host/database` |
| `NEXUS_PRODUCTION_KEY_DIGEST` | no | every environment | SHA-256 of production's `PII_INDEX_KEY`, hex |

`NEXUS_ENV` cannot be derived from `VERCEL_ENV`, and this is the detail that
catches people out: **a dedicated Vercel project for staging reports
`VERCEL_ENV=production` for its own deployments.** Staging genuinely is that
project's production. Anything reading `VERCEL_ENV` as the answer would label
staging "production" — the exact confusion being guarded.

`NEXUS_PRODUCTION_DB_HOST` is a hostname and nothing else. It is deliberately
non-secret and is echoed into build logs and CI annotations, which is why the
guard refuses a value containing `://` or `@`: pasting the whole production
connection string in there would put a password somewhere designed to be
public. A fence set only on the safe side of the gap is not a fence, so it goes
on preview and staging too — those are the environments it exists to stop.

`NEXUS_PRODUCTION_KEY_DIGEST` catches the other half of the same accident: a
staging environment created by copying production's environment variables
wholesale, which leaves it able to decrypt every Emirates ID, passport and IBAN
it holds. It is a one-way digest of 32 random bytes, so it is not a secret
either. Compute it against production:

```bash
node -e 'console.log(require("crypto").createHash("sha256").update(process.env.PII_INDEX_KEY).digest("hex"))'
```

### What it refuses

Fatal in **every** environment, not only production — the whole class of bug is
"this is not the environment you think it is", so deciding how seriously to take
it from `NODE_ENV` would be circular:

- a deployment declaring anything other than `production` whose
  `APP_DATABASE_URL` or `DATABASE_URL` is behind the production fence;
- a deployment declaring `production` whose database is **not** behind the
  fence (production serving from a copy: real invoices written into a database
  the next staging refresh overwrites);
- a Vercel preview deployment claiming to be production;
- a non-production deployment holding production's `PII_INDEX_KEY`;
- an unparseable database URL, because "the check could not be evaluated" must
  never present as "the check passed";
- an absent fence when `NEXUS_ENV` is `staging` or `preview`.

That last asymmetry is deliberate. Production connected to production is the
default state of the world, so an absent fence there is a lost confirmation and
draws a warning. Staging or preview connected to production is the accident
itself, and there an unverifiable answer is refused. On a laptop
(`development`, `test`) the fence is silently optional, for the same reason
`config.ts` downgrades its own checks there: a fresh clone has to run.

The comparison is on the **parsed** connection target — lowercased host,
defaulted port, stripped path — not the raw string, for the reason documented at
length in `config.ts`: a trailing slash, an added `?sslmode=verify-full` or a
change of host casing must not be able to make two identical connections compare
unequal and silence a gate. There is a fixture for exactly that.

### Where it runs

| Place | Effect |
| --- | --- |
| `.github/workflows/ci.yml` | `--self-test` on every PR — 16 fixtures asserting the exact set of failures each accident produces. Plus a live check against CI's own environment. |
| `.github/workflows/staging.yml`, before `db:migrate` | If `STAGING_DATABASE_URL` carries production's hostname, the migration never runs. This is the load-bearing one. |
| `.github/workflows/staging.yml`, before the production promotion | The same fence the other way round: refuses to promote if `PRODUCTION_DATABASE_URL` does not point at the declared production host. |
| Vercel build command | Checklist item 11. A confused deployment fails to build and therefore never serves — a stronger guarantee than a boot crash, which still leaves a deployment that exists and can be aliased. |

The self-test is the part that matters in CI. Running the guard on a
correctly-configured runner proves only that a healthy environment passes; the
fixtures prove that each specific accident is still caught, and they assert the
exact set of failing keys so a rule widened until everything trips fails too.

```
$ node scripts/check-env.mjs --self-test
  ✓ production on the production database
  ✓ staging on its own branch
  ✓ THE ACCIDENT — a preview pointed at production
  ✓ staging pointed at production, with the fence set
  ✓ staging pointed at production through cosmetic URL differences
  … 16 fixtures — the fence catches what it claims to.
```

### What is not fenced yet

The **runtime** half. A long-lived instance whose environment changed under it
still starts. Closing that needs three lines in
`apps/web/src/instrumentation.ts`, which is owned elsewhere — see § 8.

---

## 3. Topology

```
Neon project (production)
├── branch  main            ← production          NEXUS_ENV=production
├── branch  staging         ← staging             NEXUS_ENV=staging
└── branch  refresh-YYYY-MM ← quarantine, transient (§ 4)

Vercel team
├── project  nexus          ← production, deploys main
└── project  nexus-staging  ← staging,    deployed by .github/workflows/staging.yml
```

A Neon **branch** rather than a separate database, for two reasons. It is
copy-on-write, so a refresh from production is near-instant and costs storage
only for what diverges. And it lands on a different endpoint hostname, which is
what makes the fence in § 2 discriminating: `ep-prod-….neon.tech` and
`ep-staging-….neon.tech` are visibly different strings in a place an operator
looks.

Staging gets its **own** `nexus_app` role and its own password
(`STAGING_APP_ROLE_PASSWORD` → `APP_ROLE_PASSWORD`), because `npm run db:rls`
creates that role at runtime and it is not part of the committed migration
chain. A fresh Neon branch has the policies but not the role — the same trap
`instrumentation.ts` documents.

### Q-8 applies here, unresolved

The production database is in a Neon region outside the UAE, against a fifteen-
year in-UAE retention obligation on real-estate records. That is **Q-8**, it is
owned by a data-protection adviser, and it gates go-live.

**A staging branch inherits the question and does not answer it.** It is a
second copy of the same records — anonymised, but still derived from them, and
personal data that has been pseudonymised rather than irreversibly anonymised is
still personal data under PDPL. A branch also lives in its parent's region by
construction, so choosing "somewhere else" for staging is not available without
moving production too.

**No region is chosen here.** Checklist item 1 is to get an interim written
position from the adviser before any production-derived data is copied, exactly
as it is for production itself. If the answer is that the data may not leave the
UAE, it changes where *both* databases live, and staging should not be built
first in the wrong place.

---

## 4. Copying production data, and anonymising it before it lands

**A staging database holding real customer records, Emirates IDs and IBANs is a
second production system with weaker access controls and a wider audience.**
Everything in this section exists because of that sentence.

### The order is the control

Restore into a **quarantine branch that no application is connected to**, scrub
it there, then repoint staging at it. Restoring into staging and cleaning up
afterwards leaves a window — minutes or days — in which a live, less-guarded
deployment is serving real personal data, and there is no way to prove nobody
looked.

```
1. Neon: branch production → refresh-YYYY-MM        (nothing connects to it)
2. Generate a fresh keyring for staging             npm run keygen
3. Run the anonymisation pass against refresh-…     (as the owner role)
4. Run the verification queries. They must return zero rows.
5. Repoint the staging Vercel project's DATABASE_URL / APP_DATABASE_URL
6. npm run db:rls against the new branch            (creates its nexus_app role)
7. Delete the previous staging branch
```

Step 4 is a gate, not a report. Step 7 matters: an old staging branch is an
un-scrubbed copy if the pass ever failed halfway.

### Use what exists; do not write a second PII inventory

`packages/core/src/security/erasure.ts` already holds the authoritative answer
to "which columns identify a person", reviewed against PDPL art. 15 and the FTA
and MOHRE retention carve-outs. `erasePartyPii` names them explicitly for
`parties`, `documents`, `interactions`, `party_contacts` and `employees`. **That
column list is the specification for the staging scrub.** If a column is added
to one, it must be added to the other.

What must **not** happen is calling `erasePartyPii` in a loop. It is the
right-to-erasure path and is the wrong tool three times over:

- it refuses on live obligations (`assessErasure` blockers) — an unpaid balance,
  a current lease, an employee inside the five-year retention window — which is
  true of most of a production dataset, so most rows would simply be skipped;
- it writes `audit_log` rows, `communication_consents` opt-outs and
  `is_credit_blocked = true`, all of which change how staging behaves;
- it **nulls** rather than substitutes. A staging copy with no phone numbers,
  no IBANs and no Emirates IDs takes the empty branch through the rent run, the
  WPS file and the e-invoice, so the dry-run proves nothing.

### Substitute, do not null

The scrub replaces each identifying value with a synthetic one **of the same
shape**, written through `packages/core/src/security/pii.ts` using **staging's**
keyring:

| Need | Use |
| --- | --- |
| Write an encrypted column | `encryptPii(value, stagingKeyring)` |
| Write the matching blind index | `blindIndex(value, stagingKeyring)` |
| Write the `…_hint` column | `maskHint(value)` |
| All three at once | `protect(value)` |
| Generate the staging keyring | `generateKey()` / `npm run keygen` |
| Assert nothing survived | `isPiiEnvelope`, `keyIdOf`, `PII_ENVELOPE_VERSION` |

Synthetic values must be **deterministic per row and unique**, e.g. derived from
the row's UUID. `employees.emirates_id_bidx` and `parties.national_id_bidx`
carry unique indexes and a constant would collide; `erasePartyPii` nulls them
for exactly this reason and the scrub cannot.

Because the substitution re-encrypts, staging never needs production's keys —
which is what makes the `NEXUS_PRODUCTION_KEY_DIGEST` check in § 2 an assertion
about a real invariant rather than a nag.

### The inventory

Verified against the live schema, not the documentation.

**Directly identifying — substitute:**

| Table | Columns |
| --- | --- |
| `parties` | `display_name`, `legal_name`, `primary_phone`, `whatsapp`, `email`, `address_line`, `notes`, `national_id_enc/_bidx/_hint`, `tax_id_enc/_hint` |
| `party_contacts` | `name`, `phone`, `email` |
| `employees` | `full_name`, `phone`, `email`, `national_id`, `photo_url`, `home_lat`, `home_lng`, `emirates_id_enc/_bidx/_hint`, `passport_number_enc/_bidx/_hint`, `visa_number_enc`, `labour_card_number_enc`, `iban_enc/_hint`, `wps_person_id`, `wps_routing_code` |
| `users` | `email`, `phone`, `full_name`, `avatar_url` |
| `leads` | `email`, `phone` |
| `legal_entities` | `legal_name`, `registered_address` |
| `locations`, `sites` | `address_line`, `phone`, `lat`, `lng`, `access_notes` |
| `cheques` | `drawer_name` |
| `appointments` | `walk_in_phone` |
| `documents` | `party_name_snapshot` — the denormalised copy. Missing it makes the whole exercise cosmetic; `erasePartyPii` overwrites it for the same reason. |
| `notifications` | `recipient_address`, `body` |

**Credentials and sessions — delete or replace, never copy:**

| Table | Action |
| --- | --- |
| `users.password_hash` | Replace with one known staging password, or null it and use the invite flow. Copying production hashes means a production credential authenticates against staging. |
| `users.mfa_secret_enc`, `users.recovery_codes_enc` | Null. A copied TOTP secret is a production second factor sitting in a lower-trust system. |
| `sessions` | `DELETE`. Every row is a live production session token hash plus an IP. |
| `api_tokens` | `DELETE`. Membership-bound, and the hash is all an attacker needs to match against. |
| `user_invites` | `DELETE` — carries `email` and a `token_hash`. |

**Free text and blobs that quote the records — the ones that get forgotten:**

| Table | Column | Why |
| --- | --- | --- |
| `audit_log` | `diff`, `ip_address`, `user_agent` | The diff is a before/after of every edited row, so it contains the names, phones and addresses that were just scrubbed from the tables themselves. |
| `import_batch_rows` | `previous` | Snapshots of prior state from the opening-balance and data imports — the rawest personal data in the system. |
| `interactions` | `subject`, `body` | Free-text notes about named people. |
| `ai_messages`, `ai_conversations` | `content`, `title` | The assistant quotes ledger rows back verbatim. |
| `document_extractions` | `extracted`, `file_url` | OCR output from real invoices and identity documents. |
| `attachments` | `file_name`, `storage_key` | Filenames leak names; the storage key still points at the **production** object store, which no staging deployment should be able to reach. |
| `campaigns` | `template_body` | |
| `documents`, `units`, `budget_lines`, `vat_returns`, `job_visits` | `notes` | |

For most of these, `NULL` or a constant is correct — nothing about a dry-run
depends on the text of an old note. `audit_log.diff` and
`import_batch_rows.previous` are the two where deleting the rows outright is
usually simpler and is fine, provided the import dry-run is re-run rather than
inspected historically.

**Outbound side effects.** After the scrub there are no real email addresses,
phone numbers or WhatsApp identifiers left, and that — not a configuration flag
— is the real control on staging messaging a real tenant. Belt and braces: the
staging project should have no delivery-provider credential and no
`ANTHROPIC_API_KEY`, and its e-invoice configuration must not carry production's
MLS credentials.

### Verification, and where it lives

The last step of every refresh, and it must return zero rows:

```sql
-- No production key material survived the re-encryption.
SELECT count(*) FROM employees WHERE emirates_id_enc IS NOT NULL
  AND emirates_id_enc NOT LIKE 'p1.' || :staging_key_id || '.%';

-- No live credentials were copied.
SELECT (SELECT count(*) FROM sessions) + (SELECT count(*) FROM api_tokens)
     + (SELECT count(*) FROM user_invites);

-- Nothing addressable survived.
SELECT count(*) FROM notifications WHERE recipient_address NOT LIKE '%@staging.invalid';
SELECT count(*) FROM parties WHERE email IS NOT NULL AND email NOT LIKE '%@staging.invalid';
```

The `@staging.invalid` convention is deliberate: `.invalid` is reserved by
RFC 2606 and can never resolve, so a misconfigured mailer fails rather than
delivering to a stranger.

### This scrub has not been written

It is a script, roughly 300 lines, and it belongs at
`scripts/anonymise-staging.mjs` with unit-tested substitution helpers next to
`pii.ts`. It is **not** part of this change and nothing in the repository
performs it today. It is checklist item 7, and it is the item with real
engineering in it. Until it exists, **no production data may be copied to
staging**, and a staging database seeded with `npm run db:seed` — synthetic from
the start — is the correct interim state. That interim state is enough to prove
migrations and run the smoke test; it is **not** enough for the OPS-07 §3.1
week −2/−1 reconciliation, which by definition needs the real figures.

---

## 5. What the pipeline does

`.github/workflows/staging.yml`, on every push to `main` and on manual dispatch.

| Job | What it does | Which OPS-07 row |
| --- | --- | --- |
| `fence` | `check-env.mjs --self-test`. No secrets. Stops the run if the guard itself is broken. | — |
| `preflight` | Decides whether staging is configured. | — |
| `migrate` | Fence check → baseline row counts and trial balance → `db:migrate` → `db:rls` → the same measurements again. | §2.2 row 1, §2.5 rows 1–2 |
| `deploy` | `vercel pull/build/deploy` against the staging project. | §2.1 row 3 |
| `smoke` | `scripts/smoke.mjs` against the URL that job just deployed. | §2.1 row 3, §2.2 row 5 |
| `verdict` | One named check that fails unless all three succeeded. Require it in branch protection. | §2.1 |
| `promote` | Off by default. Production migration + deploy + smoke, behind a GitHub environment approval. | ADR-002 action 4, §2.2 |

Three details worth knowing:

**The migration is its own step, before the deploy.** OPS-07 §2.2 row 1 says a
migration is never a side effect of the application deploy, and the reason is
visible in this workflow: the row counts and the trial balance are measured
between the two, so there is a point at which a human can look and stop.

**The trial balance must be identical before and after** (§2.5 row 2). A
migration that moves money fails the run. The escape hatch is a
`workflow_dispatch` input, not a repository variable — a variable is a setting
somebody flips once and forgets, which disarms the check permanently, whereas an
input exists only on a run a human deliberately started and is recorded against
that run. It is a statement about **one** migration, not a mode.

**Row counts are exact.** `n_live_tup` drifts from reality between vacuums, and
a count that is approximately right is no use in a before-and-after comparison.

### Off, and saying so

Until the repository variable `STAGING_ENABLED` is `true`, `preflight` writes a
warning annotation and a job summary naming every OPS-07 row that remains
untickable, and stops. Nothing downstream runs; nothing reports success.

The alternative — a workflow that skips quietly because its secrets are absent —
is the "green but doing nothing" pattern this project has spent a week removing,
and it is worse here than elsewhere: the whole point of the pipeline is to be
the evidence for a checklist row, so a green run that proved nothing is a
forged tick.

Once `STAGING_ENABLED` is `true`, a missing secret is a **hard failure**, not a
skip.

### What the pipeline still cannot promise

- **It does not gate production today.** Vercel deploys `main` to production
  from the git integration the moment it is pushed, so staging runs *beside* the
  production deploy rather than in front of it. Closing that is checklist items
  8–10: disable git auto-deploy on the production project, set
  `PROMOTE_FROM_CI`, and make `Staging verdict` a required check.
- **`environment: production` is only an approval gate once required reviewers
  are configured.** GitHub creates the environment implicitly and unprotected if
  it does not exist, so an unconfigured repository gets a job that *looks* gated
  and is not. Checklist item 9, and the single most forgettable step here.
- **A migration reversal has no automated path** (§2.5 row 3). The workflow
  proves a migration applies to production-shaped data and does not move the
  trial balance. Whether it can be undone is still a human writing a down
  script and running it against staging by hand.

---

## 6. Owner checklist

Ordered. Nothing here can be done from the repository, and none of it has been
done. Costs are indicative — check current pricing.

| # | Do | Where | Cost |
| --- | --- | --- | --- |
| 1 | **Get an interim written position on Q-8** before any production-derived data is copied anywhere. A staging branch is a second copy of the same records and inherits the question (§ 3). If the answer moves production, do not build staging in the old region first. | Data-protection adviser | — |
| 2 | Set repository **variables** `NEXUS_PRODUCTION_DB_HOST` (production's Neon hostname, e.g. `ep-….aws.neon.tech`) and `NEXUS_PRODUCTION_KEY_DIGEST` (§ 2). Both non-secret. | GitHub → Settings → Secrets and variables → Actions → Variables | free |
| 3 | Set `NEXUS_ENV`, `NEXUS_PRODUCTION_DB_HOST` and `NEXUS_PRODUCTION_KEY_DIGEST` on the **existing production** Vercel project: `NEXUS_ENV=production` for Production, `NEXUS_ENV=preview` for Preview. | Vercel → nexus → Settings → Environment Variables | free |
| 4 | Create the Neon branch **`staging`** from `main`. | Neon console | Neon Free allows ~10 branches / 0.5 GB; the Launch plan is ~USD 19/mo and is likely already in play for production. Copy-on-write, so a branch adds storage only for what diverges. |
| 5 | Create the Vercel project **`nexus-staging`** from the same repository. Production Branch `main`, **Root Directory copied from the production project** (documented as `apps/web` — read it off the dashboard rather than trusting this line; see § 8), git auto-deploy **disabled**, since `staging.yml` deploys it. | Vercel | No extra seat on an existing Pro team; usage only. Hobby is free but prohibits commercial use. |
| 6 | Set the staging project's environment variables: `NEXUS_ENV=staging`, `NEXUS_PRODUCTION_DB_HOST`, `NEXUS_PRODUCTION_KEY_DIGEST`, its own `DATABASE_URL` / `APP_DATABASE_URL` (staging branch), **its own** `AUTH_SECRET`, `PII_ENCRYPTION_KEYS`, `PII_INDEX_KEY`, `BACKUP_ENCRYPTION_KEY` (`npm run keygen`), `TRUST_PROXY=true`. Do **not** set `NEXUS_DEMO_MODE`, `ANTHROPIC_API_KEY`, or any delivery-provider credential. | Vercel → nexus-staging | free |
| 7 | **Engineering, not owner:** build `scripts/anonymise-staging.mjs` per § 4 and unit-test the substitution helpers. Until it exists, seed staging with `npm run db:seed` and copy nothing. | repository | ~1 day |
| 8 | Add repository **secrets**: `STAGING_DATABASE_URL`, `STAGING_APP_DATABASE_URL`, `STAGING_APP_ROLE_PASSWORD`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID_STAGING`. | GitHub → Secrets | free |
| 9 | Create the GitHub **environment `production`** and add **required reviewers**. Without this the promote job is unprotected (§ 5). | GitHub → Settings → Environments | free |
| 10 | Set `STAGING_ENABLED=true`. Push to `main` and watch the run. From here a missing secret fails loudly. | GitHub Variables | free |
| 11 | Set the **Build Command** on both Vercel projects to `node ../../scripts/check-env.mjs && next build` (the `../../` assumes Root Directory `apps/web`; from the repository root it is `node scripts/check-env.mjs && npm run build`). This is what makes a confused deployment fail to build. Expect preview deployments to start failing until step 3 is done — that is the guard working. | Vercel → Settings → Build & Development | free |
| 12 | Make `Staging verdict` a **required status check** on `main`. | GitHub → branch protection | free |
| 13 | *Optional, and the real gate:* disable git auto-deploy for `main` on the production project, add `PRODUCTION_DATABASE_URL`, `PRODUCTION_APP_DATABASE_URL`, `VERCEL_PROJECT_ID_PRODUCTION`, and set `PROMOTE_FROM_CI=true`. Production then deploys only through the approved promote job. | Vercel + GitHub | free |

**Rough additional running cost: USD 0–25 per month**, dominated by whether the
Neon plan needs to move up for the extra branch storage. The Vercel project adds
no seat.

Steps 1–6 and 8–12 are hands-and-accounts work, perhaps two hours. Step 7 is the
one that is real engineering, and step 1 is the one that can invalidate the
others.

---

## 7. Refreshing staging afterwards

Monthly, and before each of the OPS-07 §3.1 week −2 and week −1 dry-runs.
Follow § 4 in order — quarantine branch, scrub, verify, repoint, `db:rls`,
delete the old branch. The verification queries are a gate.

Two rules that are easy to break under time pressure:

1. **Never point staging at production "just for a moment"** to reproduce
   something. The fence will refuse, and the fence is right; the honest path is
   a read-only query against production by someone entitled to run it.
2. **Never copy production environment variables into staging.** That is what
   `NEXUS_PRODUCTION_KEY_DIGEST` exists to catch, and it will.

---

## 8. Handoff — what this change could not do

| Item | Owner | Detail |
| --- | --- | --- |
| Runtime fence | whoever owns `apps/web/src/instrumentation.ts` | `register()` should evaluate the same rules after `assertConfiguration` and before the RLS probe, and throw on a fatal. Today the fence runs at build and migrate time only, so a long-lived instance whose environment changed under it still serves. The logic is exported as `checkEnvironment(env)` from `scripts/check-env.mjs`; it should be lifted into `packages/core/src/security/config.ts` next to `checkConfiguration` rather than imported from `scripts/`. |
| `vercel.json` is at the repository root, but the Vercel project's Root Directory is `apps/web` | whoever owns the cron wiring | TRD-03 §deployment and PRODUCT-TECHNICAL-MASTER both record Root Directory `apps/web`; commit `b0aba50` removed the root `vercel.json` for that reason and `995ac82` re-added one there for the cron schedules. If the Root Directory setting is still `apps/web`, Vercel reads `apps/web/vercel.json` and **the five cron schedules in the root file are not registered**. Worth ten seconds in the Vercel dashboard to confirm; it is not a staging problem and was not changed here. |
| `README.md` "There is no staging environment" | docs owner | Still accurate. It becomes wrong at checklist item 10, not at this commit. |
| The anonymiser | engineering | § 4, checklist item 7. |

---

## 9. Related

`docs/OPS-07-golive-runbook.md` §1.3, §2.1, §2.5, §3.1 · `docs/TRD-03-technical-requirements.md`
ADR-002 · `docs/04-security.md` · `packages/core/src/security/config.ts` ·
`packages/core/src/security/erasure.ts` · `packages/core/src/security/pii.ts` ·
`scripts/check-env.mjs` · `scripts/smoke.mjs` · `.github/workflows/staging.yml`
