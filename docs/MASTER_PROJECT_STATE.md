# MASTER_PROJECT_STATE

**Living document.** The current known state of the Nexus project — what governs, what is
true, what is open. Updated as work lands; every other document is either a specification
(what should be) or an audit (what was found). This one answers *"where are we right now?"*

**Last updated:** 2026-08-13 · **Baseline commit:** `eb3d0e2`

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

---

## 3. Where the build actually is

### Phase 0 gate (TRD-03 §26 / OPS-07 §1)

| Item | State |
|---|---|
| Backups fail closed, per-backup salt | ✅ `8683e2f` |
| Boot config gate actually runs | ✅ `d417c11` |
| Demo credentials gated | ✅ `1f61a97` |
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
| **Sentry / error tracking** | ⬜ **not done** — `/health` and the smoke test cover liveness; there is still no exception aggregation, so a handled-but-wrong 500 in production is invisible |
| **Staging environment** | ⬜ **not done** — migrations are reviewable and drift-gated, but nothing proves them on a copy before production |
| **RLS generated INTO migrations** | ⬜ **not done** — `db:rls` still runs as a separate idempotent step after migrate. The build gate still fails if any tenant table lacks a policy, so isolation is not weakened |
| Offsite backup replication | ⬜ blocked on Q-8 |

### Verification surface

| Suite | Count | Runs against |
|---|---|---|
| **Unit (Vitest)** | **54** | nothing — no DB, no server |
| Metric snapshots | 26 | seeded DB |
| Write layer | 41 | seeded DB |
| End-to-end | 98 | running server |
| Security regression | 68 | running server |
| Smoke | 10 | running server |
| **Total** | **297** | |

Plus five static guards that need neither: money (float arithmetic on money
paths), routes (every drill-down resolves), migrations (schema drift), docs
(README table count), and the root type-check across all workspaces.

Five unit tests are `it.todo`, blocked on Q-1 and Q-2 rather than guessed.

---

## 4. Open questions

Ownership matters more than the question. An unowned question is not open, it is ignored.

| # | Question | Owner | Blocks | State |
|---|---|---|---|---|
| **Q-8** | Does hosting in Neon `ap-southeast-1` (Singapore) satisfy PDPL cross-border transfer, given the 15-year in-UAE retention obligation on real-estate records? | Data-protection adviser | **Real data entering the system**; offsite backup design | Open — highest impact |
| **Q-1** | Standalone parking VAT treatment; whether to apply for floorspace apportionment | Tax adviser | VAT fixtures, pilot go-live | Open |
| **Q-2** | Resignation vs termination gratuity position under the 2022 law | MOHRE / employment lawyer | Gratuity fixtures | Open |
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
| **D-2e** | **Scheduler runtime: job table + Vercel Cron**, not ADR-003's process host + Redis. For nine users, one tenant and four daily jobs, a worker buys a second deploy target, a second secret set and a second thing that can be down. The lock is a partial unique index on `job_runs`, verified with two concurrent invocations (200 / 409). **Graduation trigger:** sub-minute scheduling, or outbox volume beyond a few hundred a day. | Implemented `995ac82` — reversible |

---

## 6. Known live state

| Fact | Detail |
|---|---|
| Production | Vercel + Neon `ap-southeast-1`; database `neondb` |
| Production data | **Seeded demo data only.** No real records exist yet. |
| Demo credentials | No longer rendered on the sign-in page (`1f61a97`), and the smoke test asserts they are absent. `demo1234` still authenticates and is published in git history — rotate before real data. |
| Scheduled jobs | Four crons declared in `vercel.json`. **`CRON_SECRET` must be set in Vercel** or the endpoints stay disabled (fail-closed) and nothing runs. |
| DB roles | `neondb_owner` has `BYPASSRLS` (migrations only); `nexus_app` is `NOBYPASSRLS` (the app) |
| Repo | Public |
