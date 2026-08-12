# MASTER_PROJECT_STATE

**Living document.** The current known state of the Nexus project — what governs, what is
true, what is open. Updated as work lands; every other document is either a specification
(what should be) or an audit (what was found). This one answers *"where are we right now?"*

**Last updated:** 2026-08-13 · **Baseline commit:** `02d0cdf`

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
| Decimal money arithmetic | ⬜ Epic B |
| Unit tests on `uae/`, `money/`, `rbac` | ⬜ Epic C |
| Error + loading states on every route | ⬜ Epic D |
| Observability, `/health`, post-deploy smoke | ⬜ Epic D |
| Versioned migrations, staging | ⬜ Epic D |
| Scheduler with run log | ⬜ Epic D |
| User management + session revocation | ⬜ Epic D |
| Offsite backup replication | ⬜ blocked on Q-8 |

### Verification surface

| Suite | Count | Runs against |
|---|---|---|
| Metric snapshots | 26 | seeded DB |
| Write layer | 35 | seeded DB |
| End-to-end | 98 | running server |
| Security regression | 68 | running server |
| **Unit** | **0** | — none exists yet (Epic C) |

**All 227 currently require Postgres; 166 also require a live HTTP server.**

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
| **D-2e** | **Scheduler runtime: pending.** TRD-03 ADR-003 specifies a process host + Redis; the recommendation on the table is ADR-003's own documented fallback (job table + Vercel Cron) for a 9-user, one-tenant, daily-granularity workload. | Awaiting owner sign-off |

---

## 6. Known live state

| Fact | Detail |
|---|---|
| Production | Vercel + Neon `ap-southeast-1`; database `neondb` |
| Production data | **Seeded demo data only.** No real records exist yet. |
| Demo credentials | No longer rendered on the sign-in page (`1f61a97`). `demo1234` still authenticates and is published in git history — rotate before real data. |
| DB roles | `neondb_owner` has `BYPASSRLS` (migrations only); `nexus_app` is `NOBYPASSRLS` (the app) |
| Repo | Public |
