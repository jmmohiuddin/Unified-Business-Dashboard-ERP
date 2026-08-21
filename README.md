# Nexus — a unified operating system for a multi-business owner

One dashboard, one ledger and one customer list across a salon, a mobile shop, an
online store, apartments, parking, field services and contracting.

**Localised for Dubai:** AED · 5% VAT with exempt residential rent · post-dated
cheques · end-of-service gratuity · WPS payroll · corporate tax with Small
Business Relief · Ejari and trade-licence tracking.

**Status:** a working, verified foundation — not a finished ERP. See
[what is built vs. specified](docs/00-strategy.md#4-production-ready--an-honest-position).

---

## Quick start

Requires **Node 22+** and **PostgreSQL 16+** (local install or `docker compose up -d`).

```bash
cp .env.example .env
npm run setup      # install, create db, apply migrations, apply RLS, seed
npm run dev        # http://localhost:3100
```

Sign in as `owner@sumon.test` / `demo1234`, or pick any role — each one sees a
genuinely different dashboard. The credential list only renders in demo mode; the
seed **refuses to write this password to anything but a local database**.

```bash
npm test           # 650 checks: unit, metrics, writes, end-to-end, security
npm run smoke      # 10 more, against a running server — 660 in CI
```

Counts are as of the last merge. A working tree with an unmerged branch checked out
will report more; the suites print their own totals, and those are the authority.

---

## What actually works right now

| | |
|---|---|
| **103 tables** | 97 tenant-isolated + 6 global (`job_runs`, `permissions`, `rate_limit_hits`, `role_permissions`, `sessions`, `users`), across 10 bounded contexts. `npm run check:docs` fails the build if this number drifts from the database |
| **Tenant isolation** | PostgreSQL RLS, `FORCE`d, generated from the schema into the migration chain — 500 statements, 99 policies, drift-gated by `check:rls`. Every one of the 97 tenant tables has RLS enabled, forced, and at least one policy. Cross-tenant read *and* write proven blocked |
| **Double-entry ledger** | 28,106 journal lines, balance enforced by a database trigger |
| **26 metrics** | Typed, permission-checked semantic layer — full dashboard sweep in **155 ms** |
| **33 screens** | In four nav groups (Money / Business / Compliance / Reports), plus sign-in, MFA challenge and invite acceptance. 5 API route handlers |
| **16 roles** | 125 permissions. Verified: a barber sees only the salon and is denied revenue figures |
| **UAE compliance** | VAT201 with input apportionment and reverse charge, AED 160k gratuity liability, 111-cheque PDC register, licence/visa/Ejari watchlist, WPS SIF export, period close, e-invoicing readiness |
| **Wave 2 features** | Period close · manual and cash entry · cash sessions with blind close · inter-company · lease lifecycle and rent run · CSV data import · invites · snapshot trends · pagination |
| **AI assistant** | Built — Claude tool-calling over the metric layer, no SQL access, evidence on every answer. **Currently disabled** pending an API key; see [Known gaps](#known-gaps) |
| **Automation engine** | 10 rules evaluating live; dry-run by default, dedupe keys, per-rule caps, approval gates |
| **Demo data** | 7 Dubai businesses, 200 days, 4,151 documents, 2,199 appointments, 824 jobs, 41 leases — deterministic, anchored at 2026-08-06 |
| **Writes** | Payment & bill, invoice + POS, credit note & refund, supplier bill + stock receipt, stock count, book chair, raise/complete job, cheque lifecycle, manual & cash entry, cash session close, inter-company transfer, lease + rent run, period close, CSV import — transactional, idempotent, audited |
| **Notifications** | In-app inbox with unread bell — the read side of the automation loop |
| **API** | Token-authenticated `/api/v1` over the same metric layer, permission-bound per token — mobile-ready |
| **Security** | argon2id, TOTP MFA **enforced** for owner/accountant/GM/super-admin, rate limits on auth, writes and API, lockout with decay, CSP/HSTS, audit log, **PII encrypted at rest** with rotatable keys, a fail-closed boot check that asks `pg_roles` whether it has RLS bypass, a privilege ceiling on role changes and invites, encrypted backups (fail-closed), right-to-erasure |
| **Tests** | 394 unit (+15 `it.todo`) · 26 metric · 41 write-layer · 101 end-to-end · 88 security · 10 smoke = **660 checks**, plus six CI guards: money, routes, migration drift, RLS drift, types, docs |

**Every navigation entry and every dashboard drill-down leads to a real screen.** That was
[not true once](docs/MASTER_AUDIT.md) — 15 of 21 drill-downs had no route, four on the main
dashboard, and the suite could not see it because it never followed one and the catch-all
answered every unmatched path with HTTP 200. Both are fixed, and `npm run check:routes` now
gates every pull request: *"All 128 internal links resolve to real routes (42 live routes
scanned)"*, covering all 25 metric drill-downs. A missing route is a real 404.

What is *not* built is listed under [Known gaps](#known-gaps) rather than hidden behind a
plausible-looking mock. The full findings register, including which entries are now closed
and by which commit, is [MASTER_AUDIT](docs/MASTER_AUDIT.md).

> **On the table and RLS counts.** `check:docs` compares this README against the *live
> database*, so those two figures track the working tree, which currently carries an
> unmerged feature branch. Every other claim on this page describes merged work only.
> A table existing is not a feature shipping — see
> [MASTER_PROJECT_STATE](docs/MASTER_PROJECT_STATE.md), which is pinned to a commit rather
> than to a database and is the document to trust on what is actually delivered.

---

## Four decisions worth knowing before reading the code

**1. Eleven businesses are five domains.**
Plumbing, electrical, handyman, AC, cleaning and construction-maintenance share
one lifecycle — customer → site → visit → technician + materials → invoice — so
they are one `field_service` business with a `service_kind` column. A parking bay
is a rentable unit with a lease, exactly like an apartment. This removed ~60% of
the build surface. [Reasoning](docs/00-strategy.md#1-the-brief-lists-eleven-businesses-there-are-five-domains)

**2. The AI cannot write SQL.**
Anthropic's own analytics team went from 21% to ~95% accuracy by adding a semantic
layer, not a better model — accuracy is a context problem, not a code-generation
problem. So the dashboard and the AI call the *same* 26 typed metric functions.
They cannot disagree about what "revenue" means, every AI claim carries the metric
and value behind it, and the model cannot invent a join or reach another tenant.
[Reasoning](docs/00-strategy.md#2-twenty-one-ai-features-is-a-roadmap-for-shipping-none-of-them)

**3. Your own company servicing your own building is a first-class flow.**
When the AC business repairs your rental flat, one balanced journal records real
revenue for one business and real cost for the other, netting to zero at group
level. Without it the property looks more profitable than it is. Nobody asked for
this; it is the most valuable thing in the model for a portfolio owner. The UAE
twist: Properties makes *exempt* supplies, so it cannot reclaim the 5% VAT
Tech Services charges — it is expensed, not recovered.
[Diagram](docs/02-data-model.md#inter-company-flow)

**4. UAE localisation changes the schema, not just the currency symbol.**
Residential rent is VAT-**exempt** while parking is standard-rated, so input VAT
must be apportioned. Tenancies are settled with post-dated cheques, which are
neither cash nor receivables and need their own lifecycle table. Gratuity accrues
daily on *basic* salary only, which forces pay to be stored as components. Get
any of these wrong and the numbers are confidently incorrect rather than
obviously broken. [Detail](docs/05-uae-localisation.md)

---

## Repository layout

```
packages/db          Schema (103 tables), RLS generator, versioned migrations,
                     tenant-scoped client, deterministic Dubai seed
packages/core
  metrics/           Semantic layer — 26 typed, permission-checked metrics,
                     plus snapshots.ts for trends
  security/          PII encryption, config validation, event stream, error
                     reporting with redaction, erasure
  services/          Write layer — payments, bills, invoices, credit notes,
                     stock, bookings, jobs, notifications, outbox, periods,
                     manual-entry, cash-sessions, interco, rentals, import/
  einvoice/          PINT AE serialiser, validator, readiness, ASP interface
  briefing.ts        Daily executive briefing composed from the metric layer
  uae/               Gratuity, WPS SIF, VAT return, corporate tax
  automation/        Rule engine with dry-run, dedupe and caps
  rbac.ts format.ts  Authorisation and presentation — no React, no Next
apps/web             Next.js 16 App Router dashboard
  instrumentation.ts Fail-closed boot gate — probes pg_roles, installs sinks
  lib/actions/       Per-feature server actions
scripts              DB setup, backup + restore drill, E2E suite, CI guards
docs                 Strategy, architecture, data model, roadmap, security, UAE
```

Nothing outside `packages/core/src/uae/` hard-codes a VAT rate, a gratuity
formula or a filing format — a second jurisdiction is a sibling directory.

`packages/core` importing nothing from React or Next is a deliberate boundary: the
mobile app and the AI worker consume the same functions the web app does, so there
is exactly one implementation of "record a payment" — and therefore one set of
rounding rules, one permission check and one audit path.

---

## Documentation

| | |
|---|---|
| **[★ MASTER_PROJECT_STATE](docs/MASTER_PROJECT_STATE.md)** | **Start here** — what governs, where the build is, what is open |
| [MASTER_AUDIT](docs/MASTER_AUDIT.md) | Findings register with evidence, including four corrections to previously published claims. **The findings describe commit `6a12c2f`; only the Status column tracks the present** — 28 closed, 10 partly closed, 8 open |
| [PRD-02](docs/PRD-02-product-requirements.md) · [TRD-03](docs/TRD-03-technical-requirements.md) · [PDD-04](docs/PDD-04-product-design.md) · [WF-05](docs/WF-05-wireframes.md) · [OPS-07](docs/OPS-07-golive-runbook.md) | The governing v2.0 specifications |
| [Product & Technical Master](docs/PRODUCT-TECHNICAL-MASTER.md) | **Superseded** by PRD-02/TRD-03; retained for history |
| [00 — Strategy](docs/00-strategy.md) | Where the brief is wrong, what is missing, what to drop |
| [01 — Architecture](docs/01-architecture.md) | Stack choices with the alternatives they beat |
| [02 — Data model](docs/02-data-model.md) | ER diagrams, unification decisions, DB-enforced invariants |
| [03 — Roadmap](docs/03-roadmap.md) | Six phases, acceptance criteria, test cases, risk register |
| [04 — Security](docs/04-security.md) | Threat model; built vs. designed, stated plainly |
| [05 — UAE localisation](docs/05-uae-localisation.md) | VAT exemption, PDCs, gratuity, WPS, corporate tax, compliance dates |

---

## Commands

```bash
npm run dev            # dev server on :3100
npm run build          # production build (type-checked)
npm run db:reset       # drop, recreate, migrate, secure, seed
npm run db:migrate     # apply versioned migrations
npm run db:rls         # regenerate RLS policies — fails if any table is unprotected
npm run test           # 650 checks across five suites
npm run test:unit      # 394 Vitest checks — no database, no server, under a second
npm run test:security  # 88 security-regression probes against the running app
npm run smoke          # post-deploy: is the thing that just shipped serving? (10)
npm run automations    # dry-run every automation rule
npm run outbox         # dry-run outbound delivery, showing consent suppressions
npm run backup:verify  # encrypt, decrypt, restore, prove the numbers reconcile
npm run briefing       # compose the daily executive briefing (--commit to save)
npm run keygen         # generate production key material
npm run pii:rotate     # re-encrypt identity documents under a new key

# The six CI guards
npm run check:money      # no float arithmetic on money paths
npm run check:routes     # every internal link and drill-down resolves
npm run check:migrations # schema matches its committed SQL
npm run check:rls        # the 490 RLS statements match the schema
npm run check:docs       # this README's table count matches the database
npm run typecheck        # every workspace, not just what next build touches
```

Both jobs are **dry-run by default** — they only write when you say so:

```bash
npm run automations -- --commit
```

---

## Known gaps

Stated so nothing is mistaken for an oversight:

**This deployment is a demo, and should be treated as public**
- It carries seed data with published sign-in credentials (`demo1234`). Anyone
  with the URL can sign in and see the demo tenant. That is intended for a demo
  and unacceptable for real books — reseed with real data, rotate every
  credential in `.env`, and disable the demo logins before that changes.
  **The seeding path is now closed and the existing accounts are not:**
  `resolveSeedPassword` refuses to write users to a non-localhost target without
  a generated `SEED_PASSWORD`, and refuses outright if that password is the
  published one — but nothing rotated what was already seeded, so `demo1234`
  still authenticates.
- The seed's fixed API token is no longer minted against a non-localhost
  database, and the one that briefly reached production has been revoked.
  [Reasoning](docs/04-security.md#seed-credentials-never-reach-a-remote-database)

**Before real data can enter the system at all**
- **PDPL cross-border transfer is unresolved.** The database is Neon
  `ap-southeast-1` (Singapore), against a 15-year *in-UAE* retention obligation
  on real-estate records. This is open question Q-8 in
  [MASTER_PROJECT_STATE](docs/MASTER_PROJECT_STATE.md), it is owned by a
  data-protection adviser, and it gates go-live — not just the backup design.
- **There is no staging environment.** Vercel preview deployments share the
  production database, so they are not staging. Migrations are reviewable SQL,
  drift-gated, and applied to a throwaway Postgres on every PR, but nothing
  proves them against a copy of production data first.

**Security — what is left is infrastructure, not code**
- Backups are encrypted, and a decrypt-and-restore drill runs in CI. They stay
  on **local disk**: offsite replication needs a bucket and a retention policy,
  and where that copy may legally live is Q-8.
- The security event stream and error reporter are structured, redacted and
  **wired at boot** — `installSinks` runs in `instrumentation.ts`. No vendor
  collector consumes them yet; that is one adapter and a deployment decision.
- No RUM, and no external uptime monitor. `/api/health` exists and answers.
- Keys live in environment variables, not a KMS/HSM.
- No penetration test has been performed. The 88-check regression suite is a net
  against reopening known issues, not a substitute for an adversarial human.
- No SSO/SAML.
- **No optimistic locking.** No `version` column exists on any table; concurrency
  is handled ad-hoc with `SELECT … FOR UPDATE`. Tracked as ARCH-007.
- **`aria-live` appears zero times** and icons are Unicode glyphs, so async
  results are not announced to a screen reader. WCAG 2.2 AA has never been
  assessed. Tracked as UX-002 / UX-008, Phase 4.

In place and verified: argon2id, TOTP MFA, rate limiting with silent lockout,
CSP/HSTS, append-only audit log, **AES-256-GCM field encryption for identity
documents** with a blind index and online key rotation, encrypted backups with a
decrypt-and-restore drill, session capping and sign-out-everywhere, PDPL-shaped
right to erasure, and `npm audit` gating CI. Detail and reasoning in
[docs/04-security.md](docs/04-security.md).

**Functional**
- **No SMS/WhatsApp/email provider is connected.** The outbox, consent ledger,
  quiet hours and retry logic are all built and tested; plugging in Twilio or
  Unifonic is an implementation of one `DeliveryProvider` interface. The default
  provider logs instead of sending, on purpose.
- **The AI assistant is switched off in this deployment.** No `ANTHROPIC_API_KEY`
  is provisioned, so `/assistant` redirects to the dashboard and the nav entry is
  commented out. The implementation is intact in `apps/web/src/lib/assistant.ts`;
  re-enabling is a key plus two reverts, documented in the page stub. When on, it
  answers one question at a time — threading and streaming are still to come.
- The public `/api/v1` exposes reads (metrics, identity). Write endpoints reuse
  the same service layer but are not yet surfaced over HTTP; there is no native
  mobile client — the API is the enablement for one.
- Write coverage is broad but not total: payments, bills, invoices, POS, credit
  notes and refunds, supplier bills with stock receipt, stock counts, bookings,
  jobs, the cheque lifecycle, manual and cash entry, cash-session close,
  inter-company transfers, the lease lifecycle and rent run, period close and
  CSV import are wired. **Purchase-order approval, payroll runs, CRM writes and
  inter-warehouse transfers still go through the database.** Three server
  actions — `createInvoiceAction`, `createJobAction`,
  `createPurchaseOrderAction` — still have no screen at all (audit QA-005).
- **The metric snapshot suite asserts shape, not value.** All 26 metrics run on
  every PR, but the check is `Number.isFinite(value)` — a formula wrong on day
  one would be confirmed by its own snapshot. Hand-calculated fixtures do exist
  for the UAE tax and gratuity engines, the ledger and the write layer. Tracked
  as QA-004, and it is the highest-value open gap in the test suite.
- **E-invoicing is a placeholder.** The PINT AE serialiser, validator, scope
  rules, readiness model and ASP interface exist and are tested; **nothing
  transmits**, and no ASP has been appointed. The mandate is 1 Jul 2027 with an
  ASP appointed by 31 Mar 2027. Three of its tests are `it.todo`, blocked on the
  final MOF field list and the penalty schedule.
- **Two UAE tax positions are assumed, not confirmed**, and are marked as
  assumptions everywhere they are visible rather than asserted as fact: whether
  Federal Decree-Law 33/2021 removed the gross-misconduct gratuity forfeiture
  (worth AED 83,835.62 on a ten-year employee — Q-2b), and whether VAT input
  apportionment runs on supplies value or input-tax amounts under Executive
  Regulation Art. 55 (AED 6,667 divergence in a single quarter — Q-1b). Both
  need a written professional opinion, not a better guess.
- FTA VAT201 *submission*, Ejari and DEWA integrations are not built.

Full list with phases in [the roadmap](docs/03-roadmap.md) and
[security](docs/04-security.md).
