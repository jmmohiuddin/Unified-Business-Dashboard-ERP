# 03 — Delivery roadmap

Six phases. Each has objectives, scope, acceptance criteria, test cases and risks.

Timings assume **two engineers plus a designer**, and are calendar estimates, not
effort estimates. If it is one person, roughly double.

> **Rank.** Background document (MASTER_PROJECT_STATE §1). Where this conflicts with
> PRD-02 or TRD-03, they win. The **Phase 1–3 scope below is still the delivery plan**;
> the Phase 0 figures are historical and are marked where they have moved.
>
> **Currency.** This is a **Dubai/UAE** product: **AED**, and **PDPL** (Federal Decree-Law
> 45/2021), not GDPR. Three acceptance criteria were denominated in Bangladeshi taka and
> one cited GDPR; they are corrected below. Any surviving `৳`, lakh/crore scale, or GDPR
> citation in this file is a bug, not a translation choice.
>
> **Reconciled** 2026-08-21 against `058aef0`.

---

## Phase 0 — Foundation ✅ **DONE**

*Everything in this phase is built, running and verified.*

**Delivered** *(figures re-measured 2026-08-21; the original Phase-0 numbers are shown
struck through where the build has since moved past them)*
- ~~85~~ **101**-table tenant-isolated schema across 10 bounded contexts (95 tenant-scoped + 6 global)
- RLS generated from the schema, `FORCE`d, verified by a failing-build check — now **490 statements generated into the migration chain**, not applied out of band
- Double-entry ledger with DB-enforced balance invariant, and an **exact-decimal** application gate (the original shipped a float epsilon — MASTER_AUDIT ARCH-002)
- 16-role RBAC with business-unit and self scoping, ~~122~~ **125** permissions
- Semantic metric layer: ~~21~~ **26** typed, permission-checked metrics
- Deterministic seed: 7 businesses, 200 days, ~~3,366~~ **4,151** documents, ~~22,781~~ **28,106** journal lines
- Dashboard, portfolio and receivables screens; design system with dark mode
- ~~227~~ **660**-check verification suite: 394 unit, 26 metric snapshots, 41 write-layer, 101 end-to-end, 88 security regression, 10 smoke — plus six CI guards (money, routes, migration drift, RLS drift, type-check, docs)
- Write layer: payments, bills, invoices, POS, credit notes and refunds, stock counts, bookings, jobs, cheques — transactional, idempotent, audited
- Security: argon2id, TOTP MFA **enforced by role**, rate limiting with lockout decay, field-level PII encryption with key rotation, encrypted backups (fail-closed), right-to-erasure, a boot gate that probes `pg_roles` rather than comparing URL strings
- Notifications inbox, token-authenticated public API, daily executive briefing

**Acceptance criteria — all met**

| # | Criterion | Result |
|---|---|---|
| 0.1 | Cross-tenant read returns zero rows | ✅ |
| 0.2 | Cross-tenant write is rejected by the DB | ✅ |
| 0.3 | Every journal balances | ✅ 0 unbalanced |
| 0.4 | Accounting equation holds | ✅ diff 0.0000 |
| 0.5 | Full dashboard sweep < 500 ms | ✅ **155 ms** at 26 metrics (was 106 ms at 21) |
| 0.6 | Each role sees only permitted metrics/businesses | ✅ verified across 5 roles |
| 0.7 | Production build passes with no type errors | ✅ |

---

## Phase 1 — Make it real (4–6 weeks)

**Objective:** the owner's actual data is in the system and one business runs on
it daily. *Nothing else matters until this is true.*

### Scope
1. ✅ **Security hardening — before any deploy**
   - argon2id password hashing (replaces the placeholder in `verifyPassword`)
   - TOTP MFA for owner/accountant roles — now **enforced**, not offered
     (`MFA_REQUIRED_ROLES` in `apps/web/src/lib/mfa.ts`), `3282b7c`
   - Rate limiting on auth; security headers + CSP; secrets in a manager
     — *secrets are still environment variables, not a KMS/HSM*
2. 🟡 **Data migration** — spreadsheet/CSV importers with a dry-run diff for:
   opening balances, customers, active leases, outstanding debts, stock counts,
   employees. Reconciliation report the owner signs off before go-live.
   *Built as FR-D01 (`f539684`); no real books imported and no reconciliation signed,
   because Q-8 gates real data entering the system at all.*
3. 🟡 **Salon end-to-end** — appointment calendar, walk-in POS, day close with cash
   variance, commission statement per stylist. *Day close shipped as FR-M07. The
   commission statement is a hard-coded 25% in the salon page's own SQL rather than the
   `commission_rules` engine — MASTER_AUDIT PROD-010.*
4. 🟡 **Operational baseline** — backups with a *restore drill*, error tracking,
   uptime monitoring, audit-log write path. *Restore drill runs in CI; `reportError` with
   redaction and the alert sink are wired at boot. **No collector, no RUM and no external
   uptime monitor are configured**, and there is still **no staging environment** — the
   largest remaining operational gap.*

### Acceptance criteria
| # | Criterion | Test | State |
|---|---|---|---|
| 1.1 | Migrated trial balance matches the accountant's figure **to the fils** | Reconciliation report | Importer built (FR-D01, `f539684`); **no reconciliation has been signed** — decision D5 is the gate |
| 1.2 | A stylist completes book → serve → pay → commission unaided | Observed session, no help | Not attempted. Commission has a screen but it bypasses the commission engine — MASTER_AUDIT PROD-010 |
| 1.3 | Day close reports cash variance and blocks on unexplained gaps > **AED 500** | Deliberate **AED 500** short | Blind close built (FR-M07, `f539684`). **The AED 500 figure is a placeholder** — the real threshold is **Q-11**, owned by the owner, and is parked as `it.todo` at `services/cash-sessions.test.ts:720` rather than guessed |
| 1.4 | Backup restored into a clean database reproduces the trial balance | Quarterly drill | ✅ `npm run backup:verify` runs on every CI build. **Offsite replication is still absent** — MASTER_AUDIT SEC-009, blocked on Q-8 |
| 1.5 | No plaintext or reversible password anywhere | Code review + DB inspection | ✅ argon2id. **Separate from this criterion and still true: the published `demo1234` still authenticates on the live deployment** |
| 1.6 | Salon runs for 14 consecutive days with no parallel paper record | Adoption log | Not started. Gated on Q-8 — no real data may enter the system yet |

*Criterion 1.3 was written as `৳500`. The currency is **AED**; the amount is unverified and
belongs to Q-11.*

### Risks
| Risk | Sev | Mitigation |
|---|---|---|
| **Staff quietly keep using paper** | **Critical** | Criterion 1.6 is the real gate. Owner stops accepting paper on a fixed date. Measure daily active use, not features shipped. |
| Migrated data is wrong → trust never forms | Critical | Accountant signs the reconciliation before go-live; dry-run diff on every import |
| Restores were never tested | High | Drill in Phase 1, not "later" |
| Placeholder auth reaches production | Critical | Deploy gate; CI check that rejects the placeholder |

---

## Phase 2 — The remaining businesses (8–10 weeks)

**Objective:** all seven businesses operating in the system.

### Scope
- 🟡 **Rentals**: unit board, lease lifecycle, **automated monthly rent run**, tenant
  statement, deposit tracking. *Highest cash ROI per unit of work — mostly
  automation, minimal behaviour change.* **Lease lifecycle and the rent run shipped**
  as FR-R01/R02 (`f539684`): `services/rentals.ts`, `/rentals/lease/new`,
  `/rentals/lease/[id]`, `/rentals/rent-run`. Tenant statement and deposit tracking
  are not built.
- **Field service**: dispatch board, job card, materials from van stock, photo
  capture, customer signature, AMC auto-scheduling.
- **Retail + e-commerce**: barcode POS, IMEI capture and warranty lookup,
  installment plans with collateral, channel order sync, COD settlement.
- ~~**Construction**: project board, progress claims, retention, subcontractor bills.~~
  **Dropped** by decision **D6** (PRD-02 §5.3, NG11). The `projects` tables remain in the
  schema with no metric, UI or story — see MASTER_AUDIT *Traceability gaps*.
- **HR**: attendance capture, payroll run with commission and advance deduction.

### Acceptance criteria
| # | Criterion |
|---|---|
| 2.1 | Rent run generates all invoices for a month in one action, reconciling to the lease schedule |
| 2.2 | Reminders fire at −3 days and +7 days without manual intervention |
| 2.3 | A technician completes a job offline and it syncs without duplication |
| 2.4 | Scanning an IMEI returns the sale, warranty status and repair history in < 2 s |
| 2.5 | Payroll matches a hand-calculated control sample exactly, including commission and advances |
| 2.6 | Occupancy, job SLA and stock metrics reconcile to their drill-downs to the unit |

### Risks
| Risk | Sev | Mitigation |
|---|---|---|
| Field staff cannot or will not use the app | High | Phone-shaped UI, offline-first, ≤3 taps to complete a job; pilot with one technician |
| Offline sync conflicts | High | Append-only job events with client-generated UUIDv7; server reconciles, never overwrites |
| Scope sprawl across five modules at once | Med | Ship one business fully before starting the next |

---

## Phase 3 — Automation and AI (6–8 weeks)

**Objective:** the system does work rather than only recording it.

### Scope
1. **Automation runner** — executes the rules already modelled in `automations`.
   Cron + event triggers, dedupe keys, per-day caps, approval gates, full run log.
2. **Document ingestion** *(the highest-value AI feature)* — photograph a supplier
   bill → Claude extracts structured data → **draft** document for human
   confirmation. Never auto-posts. Confidence drives how loudly it asks.
3. **Daily executive briefing** — scheduled job composing the metric layer into a
   short narrative pushed at 08:00.
4. **Conversational analyst** — chat over `metricsAsAiTools()`. Streaming, with
   every answer showing the metrics and values behind it.
5. **Deterministic detectors** (explicitly *not* LLM): cash variance, margin
   collapse, SLA breach, stock-out risk, lease expiry, churn banding.

### Acceptance criteria
| # | Criterion |
|---|---|
| 3.1 | No automation can message the same recipient twice for the same event (dedupe key) |
| 3.2 | Any automation touching > 100 recipients requires explicit approval |
| 3.3 | Every automation run is explainable: what matched, what it did, why |
| 3.4 | Bill extraction ≥ 90% field accuracy on 100 real documents; **0 auto-posted** |
| 3.5 | AI answers score ≥ 95% on a fixed eval set run against the deterministic seed |
| 3.6 | Every AI figure links to the metric and rows that produced it |
| 3.7 | AI cost per tenant per month tracked and capped |

### Risks
| Risk | Sev | Mitigation |
|---|---|---|
| **A runaway automation messages thousands of customers** | **Critical** | Per-day caps, approval gates, dedupe keys, dry-run mode, kill switch — all modelled in `automations` already |
| AI states a confidently wrong number | High | Semantic layer only; no SQL generation; evidence on every claim; eval suite in CI |
| AI cost scales with usage unpredictably | Med | Per-tenant budget, cached briefings, small model for routing |
| Owner over-trusts AI advice | Med | Insights are framed as "here is what I found and why", never as instructions; every one is dismissible with feedback |

---

## Phase 4 — Mobile (6 weeks)

**Objective:** field staff and the owner work from a phone.

- **`/api/v1` route handlers over `packages/core`** — one implementation of every
  metric and rule, consumed by web, mobile and AI.
- **Expo app, deliberately narrow**: technician job list, offline job completion,
  photo capture, attendance punch, owner briefing + approvals.

The owner's full dashboard stays on responsive web. Duplicating twenty screens
natively buys almost nothing.

| # | Acceptance criterion |
|---|---|
| 4.1 | A full day of jobs completes with no connectivity and syncs cleanly |
| 4.2 | Attendance punch captures GPS and timestamp, and cannot be back-dated by staff |
| 4.3 | Cold start to job list < 3 s on a mid-range Android device |

---

## Phase 5 — Commercial SaaS (8–12 weeks)

Self-serve signup and tenant provisioning; subscription billing and plan gating;
onboarding wizard with industry templates; white-label branding; public API with
keys and scopes; per-tenant usage metering; SOC-2-track controls.

The multi-tenant foundation means this is largely additive — which was the point
of paying its cost in Phase 0.

| # | Acceptance criterion |
|---|---|
| 5.1 | A new tenant self-provisions and reaches a working dashboard in < 10 minutes |
| 5.2 | Tenant data export and hard delete complete within SLA (**PDPL** — Federal Decree-Law 45/2021 — not GDPR; note the 15-year in-UAE retention obligation on real-estate records pulls against "hard delete", which is why erasure is pseudonymisation that retains tax invoices) |
| 5.3 | Load test: 1,000 concurrent tenants, p95 dashboard < 800 ms |

---

## Cross-cutting test strategy

*Tooling column reconciled to what is actually installed and running, 2026-08-21.*

| Level | Scope | Tooling | Gate | State |
|---|---|---|---|---|
| Unit | Posting rules, commission, tax, RBAC resolution | Vitest | Every PR | ✅ 394 tests + 15 `it.todo`, no DB, no server |
| **Metric snapshot** | All metrics vs the deterministic seed | `npm run test:metrics` | Every PR — *catches silent definition drift, the most dangerous class of ERP bug* | 🟡 26 metrics run, but shape-only — see QA-004 above |
| Write layer | Every service entry point, transactionally | `npm run test:writes` | Every PR | ✅ 41 |
| Integration | Auth, RLS, ledger integrity, RBAC, UAE VAT treatment | `npm run test:e2e` | Every PR | ✅ 101 |
| Security regression | Known issues cannot reopen | `npm run test:security` | Every PR | ✅ 88 |
| Post-deploy smoke | Is the thing that just shipped serving? | `npm run smoke` | Every PR + after deploy | ✅ 10 |
| RLS conformance | Every tenant table has enforced isolation | `npm run db:rls` + `npm run check:rls` | Build fails otherwise | ✅ Generated from the schema into the migration chain and drift-gated; every tenant table has RLS enabled, `FORCE`d and policied |
| Static guards | Money floats, dead links, schema drift, types, doc counts | `check:money`, `check:routes`, `check:migrations`, `typecheck`, `check:docs` | Every PR | ✅ six guards |
| Backup restore | Encrypt → decrypt → restore → reconcile | `npm run backup:verify` | Every PR | ✅ |
| E2E journeys | Book→pay, rent run, job→invoice | ~~Playwright~~ — **not installed.** `scripts/e2e.mjs` is a hand-rolled HTTP suite against a running server; there is no browser driver, so nothing exercises client-side behaviour | Pre-release | ⬜ |
| AI eval | Fixed question set vs known-good answers | Custom harness | Every model or prompt change | ⬜ Not built. The assistant is disabled pending an API key (decision D2) |
| Load | 1,000 tenants | k6 | Pre-Phase-5 | ⬜ Not installed |

The metric snapshot suite deserves emphasis. The failure mode that destroys trust
in an ERP is not a crash — it is a number that quietly changes meaning. Because
the seed is deterministic (`makeRng(20260806)`, anchored at `2026-08-06`), "revenue
month-to-date = **AED 133k**" is an assertable fact.

**It is not currently asserted.** `packages/core/src/metrics/smoke.ts:47` checks only
`Number.isFinite(res.value)`, so the 26 "snapshots" verify shape, not value — the exact
failure this paragraph warns about. Tracked as MASTER_AUDIT **QA-004**, still open. Value
fixtures do exist for the UAE engines, the ledger and the write layer; the metric
definitions are the gap.

*The original read `"revenue this month = ৳7.54 L"` — a taka figure on a lakh scale, from
the pre-UAE draft. `formatMoneyCompact` keys its scale off the currency, so "AED 12 L"
cannot render.*

---

## Consolidated risk register

| # | Risk | Sev | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | Staff do not adopt; data is incomplete | **Critical** | High | Adoption is a Phase 1 gate, not a hope. Walk-ins need no customer record; staff need no login. Measure daily use. |
| R2 | Migrated opening data is wrong | Critical | Med | Accountant sign-off before go-live |
| R3 | Cross-tenant leak | Critical | Low | RLS + FORCE + non-owner role + generated policies + failing-build check + E2E |
| R4 | Runaway automation | Critical | Med | Caps, approvals, dedupe, kill switch |
| R5 | AI states a wrong figure | High | Med | Semantic layer; no SQL; evidence links; eval suite |
| R6 | Ledger corruption | High | Low | DB-enforced balance; immutable journals; reversal not deletion |
| R7 | Building all 11 "businesses" separately | High | — | **Already mitigated**: collapsed to 5 domains |
| R8 | Scope sprawl from the 21-item AI list | High | High | Ranked; 3 features in Phase 3; rest deferred explicitly |
| R9 | Query performance degrades with volume | Med | Med | `kpi_snapshots` is now written by a nightly cron and read by the trend layer (was seed-only); pagination shipped on the five largest list screens. **Caching has not**: 40 files still declare `force-dynamic`, so every load recomputes every metric — MASTER_AUDIT ARCH-008. ANALYZE discipline and the partitioning path remain documented, not implemented |
| R10 | Key-person dependency on one engineer | Med | Med | Reasoning is in the code comments and these docs, not in someone's head |
| **R11** | **Q-8 unanswered indefinitely** — Neon `ap-southeast-1` vs PDPL cross-border transfer, against a 15-year in-UAE retention obligation on real-estate records | **Critical** | Med | **This blocks Phase 1 entirely**, not just the backup design: no real data may enter the system until it is answered. Needs a data-protection adviser, and it has no engineering workaround. If the answer is "no", the fix is a UAE-region database, which is a migration and a cost decision |
| **R12** | **The published demo credentials are never rotated before real data lands** | **Critical** | Med | `demo1234` still authenticates on the live deployment and is a literal in a public git history. The seed now refuses to write it remotely, which prevents recurrence and fixes nothing already there. Rotation is a manual step on the OPS-07 cutover checklist and nothing enforces it |
| **R13** | **A migration corrupts production because nothing rehearsed it** | High | Med | Migrations are reviewable SQL, drift-gated, and applied to a throwaway Postgres on every PR — but Vercel previews share the production database, so there is **no staging**. Needs a second Neon branch and a preview-scoped `APP_DATABASE_URL`; the cost is the owner's call |
| **R14** | **A metric formula is wrong and its own snapshot confirms it forever** | High | Med | MASTER_AUDIT QA-004, open. The snapshot suite asserts finiteness, not value. Mitigation is hand-calculated fixtures per metric, as already done for the UAE engines |
