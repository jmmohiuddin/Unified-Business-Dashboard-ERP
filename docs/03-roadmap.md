# 03 — Delivery roadmap

Six phases. Each has objectives, scope, acceptance criteria, test cases and risks.

Timings assume **two engineers plus a designer**, and are calendar estimates, not
effort estimates. If it is one person, roughly double.

---

## Phase 0 — Foundation ✅ **DONE**

*Everything in this phase is built, running and verified.*

**Delivered**
- 85-table tenant-isolated schema across 10 bounded contexts
- RLS generated from the schema, `FORCE`d, verified by a failing-build check
- Double-entry ledger with DB-enforced balance invariant
- 16-role RBAC with business-unit and self scoping
- Semantic metric layer: 21 typed, permission-checked metrics
- Deterministic seed: 7 businesses, 200 days, 3,366 documents, 22,781 journal lines
- Dashboard, portfolio and receivables screens; design system with dark mode
- 229-check verification suite: metric snapshots, transactional write layer, end-to-end, and a 68-check security regression net
- Write layer: payments, bills, invoices, POS, credit notes and refunds, stock counts, bookings, jobs, cheques — transactional, idempotent, audited
- Security: argon2id, TOTP MFA, rate limiting, field-level PII encryption with key rotation, encrypted backups, right-to-erasure
- Notifications inbox, token-authenticated public API, daily executive briefing

**Acceptance criteria — all met**

| # | Criterion | Result |
|---|---|---|
| 0.1 | Cross-tenant read returns zero rows | ✅ |
| 0.2 | Cross-tenant write is rejected by the DB | ✅ |
| 0.3 | Every journal balances | ✅ 0 unbalanced |
| 0.4 | Accounting equation holds | ✅ diff 0.0000 |
| 0.5 | Full dashboard sweep < 500 ms | ✅ 106 ms |
| 0.6 | Each role sees only permitted metrics/businesses | ✅ verified across 5 roles |
| 0.7 | Production build passes with no type errors | ✅ |

---

## Phase 1 — Make it real (4–6 weeks)

**Objective:** the owner's actual data is in the system and one business runs on
it daily. *Nothing else matters until this is true.*

### Scope
1. **Security hardening — before any deploy**
   - argon2id password hashing (replaces the placeholder in `verifyPassword`)
   - TOTP MFA for owner/accountant roles
   - Rate limiting on auth; security headers + CSP; secrets in a manager
2. **Data migration** — spreadsheet/CSV importers with a dry-run diff for:
   opening balances, customers, active leases, outstanding debts, stock counts,
   employees. Reconciliation report the owner signs off before go-live.
3. **Salon end-to-end** — appointment calendar, walk-in POS, day close with cash
   variance, commission statement per stylist.
4. **Operational baseline** — backups with a *restore drill*, error tracking,
   uptime monitoring, audit-log write path.

### Acceptance criteria
| # | Criterion | Test |
|---|---|---|
| 1.1 | Migrated trial balance matches the accountant's figure to the currency unit | Reconciliation report |
| 1.2 | A stylist completes book → serve → pay → commission unaided | Observed session, no help |
| 1.3 | Day close reports cash variance and blocks on unexplained gaps > ৳500 | Deliberate ৳500 short |
| 1.4 | Backup restored into a clean database reproduces the trial balance | Quarterly drill |
| 1.5 | No plaintext or reversible password anywhere | Code review + DB inspection |
| 1.6 | Salon runs for 14 consecutive days with no parallel paper record | Adoption log |

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
- **Rentals**: unit board, lease lifecycle, **automated monthly rent run**, tenant
  statement, deposit tracking. *Highest cash ROI per unit of work — mostly
  automation, minimal behaviour change.*
- **Field service**: dispatch board, job card, materials from van stock, photo
  capture, customer signature, AMC auto-scheduling.
- **Retail + e-commerce**: barcode POS, IMEI capture and warranty lookup,
  installment plans with collateral, channel order sync, COD settlement.
- **Construction**: project board, progress claims, retention, subcontractor bills.
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
| 5.2 | Tenant data export and hard delete complete within SLA (GDPR-equivalent) |
| 5.3 | Load test: 1,000 concurrent tenants, p95 dashboard < 800 ms |

---

## Cross-cutting test strategy

| Level | Scope | Tooling | Gate |
|---|---|---|---|
| Unit | Posting rules, commission, tax, RBAC resolution | Vitest | Every PR |
| **Metric snapshot** | All metrics vs the deterministic seed | `npm run test:metrics` | Every PR — *catches silent definition drift, the most dangerous class of ERP bug* |
| Integration | Auth, RLS, ledger integrity, RBAC | `npm run test:e2e` | Every PR |
| RLS conformance | Every tenant table has enforced isolation | `npm run db:rls` | Build fails otherwise |
| E2E journeys | Book→pay, rent run, job→invoice | Playwright | Pre-release |
| AI eval | Fixed question set vs known-good answers | Custom harness | Every model or prompt change |
| Load | 1,000 tenants | k6 | Pre-Phase-5 |

The metric snapshot suite deserves emphasis. The failure mode that destroys trust
in an ERP is not a crash — it is a number that quietly changes meaning. Because
the seed is deterministic, "revenue this month = ৳7.54 L" is an assertable fact.

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
| R9 | Query performance degrades with volume | Med | Med | `kpi_snapshots`, ANALYZE discipline, partitioning path documented |
| R10 | Key-person dependency on one engineer | Med | Med | Reasoning is in the code comments and these docs, not in someone's head |
