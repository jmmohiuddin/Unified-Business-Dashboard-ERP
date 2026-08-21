# MASTER_PROJECT_STATE

**Living document.** The current known state of the Nexus project — what governs, what is
true, what is open. Updated as work lands; every other document is either a specification
(what should be) or an audit (what was found). This one answers *"where are we right now?"*

**Last updated:** 2026-08-21 · **Baseline commit:** `058aef0` (tip of `main`)

Every count below was re-measured against this tree on 2026-08-21 by running the suite or
querying the database, not carried forward from the previous revision. Where a figure could
not be measured it says so. A fourth wave (`feature/prd-wave-3`) is in flight and is
**deliberately not reflected here** — nothing on that branch has merged.

---

## 1. Document authority

Where two documents disagree, the one higher in this table wins.

| Rank | Document | Version | Governs |
|---|---|---|---|
| 1 | [PRD-02](PRD-02-product-requirements.md) | 2.0 | Product requirements, MVP definition, priorities, non-goals |
| 2 | [TRD-03](TRD-03-technical-requirements.md) | 2.0 | Architecture, ADRs, data model, API, testing, deployment |
| 3 | [PDD-04](PDD-04-product-design.md) | 2.0 | Design system, IA, visualisation, manual-entry UX |
| 4 | [WF-05](WF-05-wireframes.md) | 1.0 | Screen structure and the five-state matrix |
| 5 | [OPS-07](OPS-07-golive-runbook.md) | 1.0 | Phase 0 exit gate, deploy checklist, cutover, SOP |
| — | [MASTER_AUDIT](MASTER_AUDIT.md) | 1.0 | Findings register (evidence, not intent) |
| — | [PRODUCT-TECHNICAL-MASTER](PRODUCT-TECHNICAL-MASTER.md) | 1.0 | **SUPERSEDED** — retained for history. See §2. |
| — | `00-`…`05-` docs | 1.x | Background. Superseded where they conflict with the above. |

### Missing documents

| ID | Status | Consequence |
|---|---|---|
| **RES-01** (Research) | **Not supplied** | Cited as the evidence base for findings F-01…F-14 throughout PRD-02 and TRD-03. Those requirements cannot be traced to their evidence. |
| **MCP-06** (MCP Server) | **Not supplied** | Referenced by FR-P07 and ADR-011 for "full tool surface, schemas, error contract and deployment". |

## 2. Supersession of the reverse-engineered audit

`PRODUCT-TECHNICAL-MASTER.md` (9 Aug 2026) was written by reading the code and inferring
requirements. PRD-02 replaces its §7 PRD entirely. It also contained **four false claims**,
all corrected in MASTER_AUDIT and in the document itself:

| Its claim | Reality |
|---|---|
| "no dead ends" in dashboard drill-downs | 15 of 21 drilldown targets have no route |
| security is "fail-closed" | the validator had zero callers — fixed in `d417c11` |
| inter-company is "modelled" | no runtime path exists; seed only |
| ledger balance is DB-enforced | true, but the app gate is a float epsilon |

It also **missed the UAE e-invoicing mandate entirely** — the only requirement in the
project with a statutory deadline.

Three of those four claims are now *true*, which does not make them any less false when
they were published: drill-downs all resolve and are CI-gated (`832209e`, `check:routes`),
the boot gate runs and probes `pg_roles` (`d417c11`, `3282b7c`), inter-company has a real
service and reciprocal accounts (`f539684`), and the ledger gate is exact decimal
(`5b0470e`). The entry stays because the failure being recorded is *asserting without
evidence*, not the specific gap. E-invoicing remains a placeholder — see PROD-009.

---

## 3. Where the build actually is

### Phase 0 gate (TRD-03 §26 / OPS-07 §1)

| Item | State |
|---|---|
| Backups fail closed, per-backup salt | ✅ `8683e2f` |
| Boot config gate actually runs | ✅ `d417c11` |
| Demo credentials gated | ✅ `1f61a97` (rendering) + `3282b7c` (`resolveSeedPassword` refuses to seed users to a non-local target). **Not rotated** — see §6 |
| WPS export: rate limit, BU scope, error boundary | ✅ `1c50e83` |
| Every mutating action rate-limited | ✅ `02d0cdf` |
| Specifications landed | ✅ `b6ba9f9` |
| Decimal money arithmetic, 12 epsilons removed | ✅ `f316425`…`5b0470e` |
| Money guard in CI | ✅ `91698bb` |
| Vitest + hand-calculated `uae/` fixtures | ✅ `3d11c52`, `bdbef24` |
| Root `typecheck` in CI (found 18 latent errors) | ✅ `3d11c52` |
| Dead drill-downs fixed; missing routes 404 | ✅ `832209e` |
| Error + loading states | ✅ `d74ecd9` |
| Versioned migrations + drift guard | ✅ `cf62574` |
| User management + session revocation | ✅ `8284635` |
| Scheduler with run log and job lock | ✅ `995ac82` |
| `/health` + post-deploy smoke | ✅ `995ac82`, smoke wired to CI |
| Confirmation on irreversible writes | ✅ `eb3d0e2` |
| Error reporting with redaction | ✅ `reportError` at 8 sites, 13 unit tests, `d50750d`. **The sinks are now actually installed** — `3282b7c` added `installSinks(core.setErrorSink, core.setAlertSink)` to `instrumentation.ts:45`; before that `setErrorSink` was called only from its own test and `setAlertSink` never at all, so the hooks documented here were not connected to anything. A vendor collector is still one adapter away; the redaction runs first either way, so an Emirates ID or connection string never reaches it |
| MFA enforced rather than offered | ✅ `3282b7c` — `MFA_REQUIRED_ROLES` covers `super_admin`, `owner`, `accountant`, `general_manager`; `login/page.tsx:142` blocks the session rather than suggesting enrolment |
| RLS-bypass boot probe | ✅ `3282b7c` — `instrumentation.ts:235` asks `pg_roles` what the connection actually is, instead of comparing `APP_DATABASE_URL` and `DATABASE_URL` as strings (audit SEC-007) |
| Prune jobs actually called | ✅ `3282b7c` — the `maintenance` cron runs `pruneRateLimits()` and `pruneExpiredSessions()` and reports real counts (audit SEC-011) |
| **Staging environment** | ⬜ **not done, and it is the largest remaining operational gap.** Migrations are reviewable and drift-gated, and CI applies them to a throwaway Postgres on every PR — but nothing proves them against a copy of PRODUCTION data before they touch it. Vercel preview deployments share the production database, so they are not staging. Needs a second Neon branch plus a preview-scoped `APP_DATABASE_URL`; the plan and the cost are the owner's call |
| RLS generated INTO migrations | ✅ `9999_rls_policies.sql`, **490 statements** (was 461), applied by `db:migrate` and drift-gated by `check:rls`. Role creation stays a runtime step because it carries a password and a migration is committed to a public repo |
| Offsite backup replication | ⬜ **still absent.** `scripts/backup.mjs` has no S3/GCS/rsync path; backups remain on local disk. Blocked on Q-8 |

### What landed after the Phase 0 gate

Three pull requests have merged since the previous revision of this document. They are
listed here because §3 previously described a build that no longer exists.

| PR | Commit | What it closed |
|---|---|---|
| #1 Audit remediation wave 1 | `3282b7c` | The published `demo1234` seed gate; MFA enforced by role rather than offered; the `pg_roles`/`rolbypassrls` RLS-bypass boot probe (SEC-007); error and alert sinks actually installed (SEC-010); a rate limit on `/api/v1/me`; the `changeRole` privilege ceiling; RLS split per command; PII rotation; idempotency keyed to intent; atomic journal numbering; input-VAT recoverability by tax code; supplier advances; three credit-note defects; the snapshot cron's timezone and metric-parity bugs; the prune jobs (SEC-011); lockout decay; the demo-date default inversion; eleven dead CSS hover states |
| #2 PRD wave 2 | `f539684` | FR-C01 period close · FR-M01–M09 manual/cash entry · FR-M07 cash sessions with blind close · FR-M06 inter-company · FR-R01/R02 leases and rent run · FR-D01 data import · FR-C02/C03 VAT residual wiring and reverse charge · FR-P01 invites · FR-C07 e-invoicing placeholder · FR-V03 snapshot trends · FR-P09 pagination |
| #4 Reverse-charge reachability | `058aef0` | Wave 2 shipped a reverse charge no production bill could trigger, because nothing recorded what a bill actually was. This records it |

Individual commits from waves 1 and 2 (`871cb5c`, `d217041`, `ae9635a`, `74cf8a8` …) are
**not ancestors of `main`** — both branches were squash-merged. Cite `3282b7c`, `f539684`
and `058aef0` when attributing a fix, or `git log --all` will be needed to resolve it.

### Schema

| | Then | Now |
|---|---|---|
| Tables | 96 | **101** — 95 tenant-isolated, 6 global (`job_runs`, `permissions`, `rate_limit_hits`, `role_permissions`, `sessions`, `users`) |
| RLS statements | 461 | **490** |
| Migration chain | — | `0000_baseline`, `0001_job_runs`, `0002_prd_wave_2`, `9999_rls_policies` |

New tables: `import_batches`, `import_batch_rows`, `legal_entities`, `vat_returns`,
`user_invites`.

**The working tree is ahead of these figures.** `feature/prd-wave-3` is in flight and has
added a fourth migration (`0003_prd_wave_3`), taking the *local database* to **103 tables /
97 tenant-isolated / 500 RLS statements**. That branch has **not merged**, and nothing on it
is documented as delivered anywhere in this file. The README's table count differs from the
101 above for one reason: `check:docs` compares it against the live database rather than
against a commit, so it necessarily tracks whatever is applied. **This document is pinned to
`058aef0`; the README is pinned to whatever Postgres currently holds.** When wave 3 merges,
reconcile both — and treat a table appearing as evidence of a migration, never of a feature.

TRD-03 §17.1 named eleven new tables. Two of them exist under the specified name
(`legal_entities`, `job_runs`); the wave-2 features were built on differently-shaped tables
instead — `cash_register_sessions` rather than `cash_points`/`cash_sessions`, ordinary
journals rather than `manual_entries`/`interco_transfers`/`interco_balances`. The
capabilities shipped; the table list in TRD-03 §17.1 is now a stale plan, not a gap.
**§17.2's `version integer` column is not implemented anywhere** — see ARCH-007.

### Verification surface

Re-measured 2026-08-21 by running every suite against `main`. Previous revision: 294.

| Suite | Was | Count | Runs against |
|---|---|---|---|
| **Unit (Vitest)** | 51 | **394** (+ 15 `it.todo`, 409 total, 15 files) | nothing — no DB, no server |
| Metric snapshots | 26 | 26 | seeded DB |
| Write layer | 41 | 41 | seeded DB |
| End-to-end | 98 | **101** | running server |
| Security regression | 68 | **88** | running server |
| Smoke | 10 | 10 | running server |
| **Total** | 294 | **660** | |

`npm test` chains five of these and reports **650**; the smoke test is a separate CI step,
which is where the remaining 10 come from. The backup-and-restore drill
(`npm run backup:verify`) and the briefing composition are further CI steps that assert
rather than count.

> **If you run `npm run test:unit` today you will not get 394.** The working tree carries
> the unmerged `feature/prd-wave-3`; a run at 2026-08-21 10:33 reported **526 passed | 18
> todo across 19 files**. That number is not in the table because the table describes
> `058aef0`, and unmerged tests verify nothing that has shipped. It is recorded here so the
> discrepancy reads as a known one rather than as drift. Update the table when wave 3
> merges, from a run taken at that moment.

**Six guards, all in CI**, not five — the previous revision both under-counted them and
mis-described one:

| Guard | Command | Needs |
|---|---|---|
| Money | `check:money` | nothing — float arithmetic on money paths |
| Routes | `check:routes` | nothing — 128 internal links across 42 live routes, incl. 25 metric drill-downs |
| Migration drift | `check:migrations` | nothing — schema matches its committed SQL |
| RLS policy drift | `check:rls` | nothing — regenerates every policy from the schema and diffs it against the committed migration (490 statements at `058aef0`) |
| Type-check | `typecheck` | nothing — all workspaces |
| Docs | `check:docs` | **a seeded database** — it queries `pg_tables`, so it is not static and CI runs it after `db:seed` |

Fifteen unit tests are `it.todo`, blocked on Q-1, Q-1b, Q-2, Q-2b, Q-11, Q-12 and on
service-layer work that does not exist yet, rather than guessed.

**One known limitation of this surface.** `packages/core/src/metrics/smoke.ts:47` still
asserts only `Number.isFinite(res.value)` — the 26 "metric snapshots" check shape, not
value. A metric whose formula is wrong on day one is still confirmed by its own snapshot
forever. Value assertions now exist for the UAE engines, the trend builder and the ledger
(unit + e2e), but not for the metric definitions themselves. This is MASTER_AUDIT QA-004,
and it is **open**.

---

### Four things three waves of work did NOT change

Listed together because each is easy to assume closed by association with the work above,
and none of them is:

| | State |
|---|---|
| **The live demo passwords are unrotated** | `demo1234` still authenticates on the deployed site and is a literal in a public git history. The *seed* now refuses to write it to a remote database; the accounts already seeded there are untouched. |
| **Q-8 — PDPL cross-border** | Neon `ap-southeast-1` (Singapore) against a 15-year in-UAE retention obligation on real-estate records. **This still gates real data entering the system**, which means it gates everything the product is for. |
| **No staging environment** | Vercel preview deployments share the production database, so they are not staging. Nothing proves a migration against a copy of production data before it touches production. Still the largest operational gap. |
| **No offsite backup replication** | Backups are encrypted, drilled and restorable — and on local disk only. Blocked on Q-8, because where the copy may legally live is the unanswered part. |

---

## 4. Open questions

Ownership matters more than the question. An unowned question is not open, it is ignored.

| # | Question | Owner | Blocks | State |
|---|---|---|---|---|
| **Q-8** | Does hosting in Neon `ap-southeast-1` (Singapore) satisfy PDPL cross-border transfer, given the 15-year in-UAE retention obligation on real-estate records? | Data-protection adviser | **Real data entering the system**; offsite backup design | Open — highest impact |
| **Q-1** | Standalone parking VAT treatment; whether to apply for floorspace apportionment | Tax adviser | VAT fixtures, pilot go-live | Open |
| **Q-1b** | **VAT apportionment basis.** The implemented standard method apportions on **supplies value** (taxable supplies ÷ total supplies). Executive Regulation Cabinet Decision 52/2017 **Art. 55** may instead require the ratio to be computed from **input-tax amounts** (input tax attributable to taxable supplies ÷ that plus input tax attributable to exempt supplies). On the worked case in `uae/vat.test.ts` the two bases recover 10,000 and 16,667 — **AED 6,667 apart in a single quarter**, past the AED 10,000 voluntary-disclosure threshold within two. Nobody on this project has read the regulation text. Both inputs the alternative needs are already on `VatReturnInput`, so the change is small once the answer is known | Tax adviser (same owner as Q-1) | The VAT201 residual figure on every return | Open — parked as `it.todo` in `packages/core/src/uae/vat.test.ts:449`, deliberately not guessed |
| **Q-2** | Resignation vs termination gratuity position under the 2022 law | MOHRE / employment lawyer | Gratuity fixtures | Open |
| **Q-2b** | **Gross-misconduct gratuity forfeiture.** `calculateGratuity` returns AED 0 for an Article 44 dismissal. That was unambiguously the rule under Art. 120/139 of the **superseded** Federal Law 8/1980; **Federal Decree-Law 33/2021 Art. 44 permits summary dismissal without notice but appears not to extinguish the Art. 51 end-of-service benefit — UNVERIFIED.** Worth **AED 83,835.62** on a ten-year employee at an AED 10,000 basic (255 days × 328.767123). The behaviour is left as it stands deliberately: flipping it would be guessing in the other direction, and paying a gratuity the law does not require is as hard to unwind as withholding one it does | MOHRE / employment lawyer (same owner as Q-2) | Any real termination; the gratuity register | Open — demoted from a *passing assertion* to `it.todo` in `packages/core/src/uae/uae.test.ts:236`, and marked as an assumption in `uae/gratuity.ts:190`, the register page and `docs/05-uae-localisation.md` |
| Q-3 | Exact e-invoicing penalty schedule | Primary source | FR-C07 scoping | Open |
| Q-4 | Final PINT AE mandatory field list | MOF data dictionary | Serialiser | Open |
| Q-5 | Can a cleared UAE cheque be returned? | The group's bank | Cheque state machine | Open |
| Q-6 | Which entities hold which licences; revenue vs thresholds | Owner + accountant | E-invoicing, corporate tax | Open |
| Q-7 | Exact WPS SIF layout for the group's agent | WPS agent | Payroll run | Open |
| Q-9 | Willingness to pay beyond this group | Owner | Phase 5 only | Deferred by decision D1 |
| Q-10 | Owner-ledger staleness and materiality thresholds | Owner + accountant | FR-M05 defaults | Open |
| Q-11 | Cash variance threshold for manager acknowledgement | Owner | FR-M07 default | Open |
| Q-12 | Inter-business services at cost or arm's length | Owner + tax adviser | FR-M06, transfer pricing | Open — decide early |

**Engineering-owned, added during this cycle:**

| # | Question | Blocks |
|---|---|---|
| E-1 | TRD-03 ADR-011 asserts a 2026-07-28 MCP spec removing the `initialize` handshake and a "v2 beta" SDK. Unverifiable from here and beyond the assistant's knowledge cutoff — must be checked against the live specification. | Any MCP work (Phase 2) |
| E-2 | PDD-04 §3.2 gives business-unit slot 6 (Mobile shop) the same hex `#008300` in light and dark, unlike every other slot. Probable error. | Palette implementation |
| E-3 | The `ecommerce` roadmap stub in `apps/web/src/app/(app)/[...slug]/page.tsx` still names **"Daraz + Facebook catalogue sync"**. Daraz is a South/South-East Asian marketplace with no UAE presence — a surviving Bangladesh-era assumption in the one roadmap placeholder that is still reachable. Needs the owner's actual channel list (Noon, Amazon.ae, Instagram?) | Phase 3 e-commerce scoping |

---

## 5. Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | Internal tool first; multi-tenant foundation retained, Phase 5 gated | PRD-02 §5.1 B7 |
| D2 | AI assistant funded, scoped to three capabilities | PRD-02 FR-P06. **Reverses** the disable in `1fb5578` — re-enable is Phase 2 work, not yet done |
| D3 | Pilot is the property portfolio, gated on completeness not duration | PRD-02 §3.1 |
| D4 | Arabic deferred to Phase 4, treated as market credibility | PRD-02 §16 |
| D5 | The accountant's signed reconciliation is a go-live gate | PRD-02 FR-D01 |
| D6 | Construction module dropped (NG11); e-commerce schema retained, no surface | PRD-02 §5.3 |
| **D-2e** | **Scheduler runtime: job table + Vercel Cron**, not ADR-003's process host + Redis. For nine users, one tenant and five daily jobs, a worker buys a second deploy target, a second secret set and a second thing that can be down. The lock is a partial unique index on `job_runs`, verified with two concurrent invocations (200 / 409). **Graduation trigger:** sub-minute scheduling, or outbox volume beyond a few hundred a day. | Implemented `995ac82` — reversible |

---

## 6. Known live state

| Fact | Detail |
|---|---|
| Production | Vercel + Neon `ap-southeast-1`; database `neondb` |
| Production data | **Seeded demo data only.** No real records exist yet. |
| Demo credentials | No longer rendered on the sign-in page (`1f61a97`); the smoke test asserts their absence; and `resolveSeedPassword` (`3282b7c`) now **refuses to seed users at all** against a non-localhost target unless a generated `SEED_PASSWORD` is supplied. None of that rotates what is already there: **`demo1234` still authenticates on the live deployment and is a literal in a public repository.** Rotate before real data. |
| Scheduled jobs | **Five** crons declared in `vercel.json` — `snapshots`, `briefing`, `automation`, `outbox`, `maintenance`. **`CRON_SECRET` must be set in Vercel** or the endpoints stay disabled (fail-closed) and nothing runs. |
| DB roles | `neondb_owner` has `BYPASSRLS` (migrations only); `nexus_app` is `NOBYPASSRLS` (the app) |
| Repo | Public |
