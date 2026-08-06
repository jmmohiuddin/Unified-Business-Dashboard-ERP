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
npm run setup      # install, create db, push schema, apply RLS, seed
npm run dev        # http://localhost:3100
```

Sign in as `owner@sumon.test` / `demo1234`, or pick any role from the list on the
sign-in screen — each one sees a genuinely different dashboard.

```bash
npm test           # 227 checks: metrics, writes, end-to-end, security
```

---

## What actually works right now

| | |
|---|---|
| **94 tables** | 88 tenant-isolated + 6 global, across 10 bounded contexts |
| **Tenant isolation** | PostgreSQL RLS, `FORCE`d, generated from the schema — cross-tenant read *and* write proven blocked |
| **Double-entry ledger** | 28,077 journal lines, balance enforced by a database trigger |
| **26 metrics** | Typed, permission-checked semantic layer — full dashboard sweep in **~150 ms** |
| **24 routes** | Dashboard, businesses, receivables, purchases, rentals, cheques, services, salon, inventory, CRM, compliance, VAT201, P&L, gratuity, inbox, security settings, public API |
| **16 roles** | Verified: a barber sees only the salon and is denied revenue figures |
| **UAE compliance** | VAT201 with input apportionment, AED 160k gratuity liability, 113-cheque PDC register, licence/visa/Ejari watchlist, WPS SIF export |
| **AI assistant** | Built — Claude tool-calling over the metric layer, no SQL access, evidence on every answer. **Currently disabled** pending an API key; see [Known gaps](#known-gaps) |
| **Automation engine** | 10 rules evaluating live; dry-run by default, dedupe keys, per-rule caps, approval gates |
| **Demo data** | 7 Dubai businesses, 200 days, 4,163 documents, 2,234 appointments, 826 jobs, 41 leases |
| **Writes** | Payment & bill, invoice + POS, credit note & refund, supplier bill + stock receipt, stock count, book chair, raise/complete job, cheque lifecycle — transactional, idempotent, audited |
| **Notifications** | In-app inbox with unread bell — the read side of the automation loop |
| **API** | Token-authenticated `/api/v1` over the same metric layer, permission-bound per token — mobile-ready |
| **Security** | argon2id, TOTP MFA, rate limits + silent lockout, CSP/HSTS, audit log, **PII encrypted at rest** with rotatable keys, encrypted backups, right-to-erasure |
| **Tests** | 26 metric · 35 write-layer · 98 end-to-end · 68 security = **227 checks**, all passing |

Every navigation entry and every dashboard drill-down leads to a real screen —
there are no dead ends. What is *not* built is listed under
[Known gaps](#known-gaps) rather than hidden behind a plausible-looking mock.

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
packages/db          Schema, RLS generator, tenant-scoped client, Dubai seed
packages/core
  metrics/           Semantic layer — 26 typed, permission-checked metrics
  security/          PII encryption, config validation, event stream, erasure
  services/          Write layer — payments, bills, invoices, credit notes,
                     stock, bookings, jobs, notifications, outbox
  briefing.ts        Daily executive briefing composed from the metric layer
  uae/               Gratuity, WPS SIF, VAT return, corporate tax
  automation/        Rule engine with dry-run, dedupe and caps
  rbac.ts format.ts  Authorisation and presentation — no React, no Next
apps/web             Next.js 16 App Router dashboard
scripts              DB setup, backup + restore drill, E2E suite
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
npm run db:reset       # drop, recreate, push, secure, seed
npm run db:rls         # regenerate RLS policies — fails if any table is unprotected
npm run test           # 227 checks across four suites
npm run test:security  # 68 security-regression probes against the running app
npm run automations    # dry-run every automation rule
npm run outbox         # dry-run outbound delivery, showing consent suppressions
npm run backup:verify  # encrypt, decrypt, restore, prove the numbers reconcile
npm run briefing       # compose the daily executive briefing (--commit to save)
npm run keygen         # generate production key material
npm run pii:rotate     # re-encrypt identity documents under a new key
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
- The seed's fixed API token is no longer minted against a non-localhost
  database, and the one that briefly reached production has been revoked.
  [Reasoning](docs/04-security.md#seed-credentials-never-reach-a-remote-database)

**Security — what is left is infrastructure, not code**
- Backups are encrypted but stay on local disk — offsite replication needs a
  bucket and a retention policy.
- The security event stream is structured and ready; no collector consumes it.
- Keys live in environment variables, not a KMS/HSM.
- No penetration test has been performed. The 68-check regression suite is a net
  against reopening known issues, not a substitute for an adversarial human.
- No SSO/SAML.

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
  jobs and the cheque lifecycle are wired. Purchase-order approval flows, payroll
  runs and inter-warehouse transfers still go through the database.
- FTA VAT201 submission, e-invoicing, Ejari and DEWA integrations are not built.

Full list with phases in [the roadmap](docs/03-roadmap.md) and
[security](docs/04-security.md).
