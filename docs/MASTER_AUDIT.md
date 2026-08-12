# MASTER_AUDIT

**Version** 1.0 · **Date** 2026-08-13 · **Baseline** commit `6a12c2f` (pre-remediation)

Consolidated findings from the Phase 0 discovery sweep: three parallel evidence-gathering
passes over the data model, the frontend, and security/ops, reconciled against PRD-02,
TRD-03, PDD-04, WF-05 and OPS-07.

**Evidence rule.** Every finding cites a file, a command output, or a database query.
Where something could not be verified it is marked `UNVERIFIED` rather than asserted.
Four findings in this register **correct claims previously published by this project**;
they are marked ⚠️ and are the most important entries here, because a wrong assurance is
worse than a known gap.

**Severity.** P0 blocker · P1 critical · P2 high · P3 medium · P4 low.

---

## Corrections to previously published claims

### QA-001 ⚠️ · Dashboard drill-downs lead to pages that do not exist

| | |
|---|---|
| **Category** | Correctness / UX / documentation integrity |
| **Source** | Frontend sweep; verified directly |
| **Evidence** | 21 `drilldownHref` values in `packages/core/src/metrics/*.ts`; **15 have no route file**. Dead: `/accounting/cash`, `/accounting/cash-forecast`, `/accounting/tax`, `/crm/customers`, `/ecommerce/orders`, `/hr/performance`, `/inventory/reorder`, `/inventory/stock`, `/purchases/payables`, `/rentals/units`, `/sales/installments`, `/sales/invoices`, `/sales/receivables`, `/salon/appointments`, `/services/jobs`. Four are rendered **on the main dashboard**: `overdue_debt`, `revenue_today`, `customers_total`, `channel_performance`. |
| **Current** | `README.md` states *"every navigation entry and every dashboard drill-down leads to a real screen — there are no dead ends."* The `[...slug]` catch-all renders "Page not found" **at HTTP 200** — `notFound()` is never called. The e2e suite contains **zero** references to drilldowns, so the defect class is invisible to 227 checks. |
| **Expected** | Every drilldown resolves, or the metric declares none. A missing route returns 404. A CI check asserts this. |
| **Business impact** | The owner clicking the KPIs he opens the app for — overdue debt, revenue today — lands on "Page not found". This is the product's core loop. |
| **Technical impact** | HTTP 200 on missing routes defeats status-code assertions; `GET path === 200` proves nothing. |
| **Severity** | **P1** |
| **Dependencies** | None |
| **Recommendation** | Repoint each dead target at the screen that already serves it (`/sales/receivables` → `/receivables`); `notFound()` in the catch-all; static CI check. → Epic D2/C2 |

### ARCH-001 ⚠️ · The fail-closed configuration check never ran

| | |
|---|---|
| **Category** | Security / architecture |
| **Evidence** | `grep -rn "assertConfiguration\|checkConfiguration"` across `packages`, `apps`, `scripts` returned **only the definition file**. No `instrumentation.ts` existed. |
| **Current (at baseline)** | `packages/core/src/security/config.ts` docblock: *"So the app refuses to start."* It did not. `PRODUCT-TECHNICAL-MASTER.md` asserted "fail-closed" security in **four** places on the strength of a function with zero callers. |
| **Expected** | The validator runs once at boot and throws in production. |
| **Business impact** | The single highest-impact misconfiguration in the system (`APP_DATABASE_URL` pointing at the `BYPASSRLS` owner) had no runtime guard. |
| **Severity** | **P0** |
| **Status** | ✅ **Fixed** `d417c11`. Verified in both directions; the fix also exposed that CI's `AUTH_SECRET` contained the blocklisted token `secret` and would have failed every CI run. |

### PROD-001 ⚠️ · Inter-company — the product's stated wedge — has no runtime implementation

| | |
|---|---|
| **Category** | Product / correctness |
| **Evidence** | `packages/core/src/**` contains **no** reference to `INTERCO_DUE_FROM`, `INTERCO_DUE_TO`, `counterpartyBusinessUnitId`, or journal source `inter_company`. The only construction site is the seed generator, `packages/db/src/seed/index.ts:1017-1052`. `completeJob` (`services/operations.ts:320`) computes `internal: Boolean(job.unit_id)` and returns it; `completeJobAction` **discards it**. |
| **Current** | Two `documents` columns, one enum value, and demo data. No service, no reciprocal balance, no settlement, no elimination. |
| **Expected** | PRD-02 FR-M06/D7: both legs in one transaction, `due_from(A→B) === due_to(B→A)` always, group profit unchanged, arm's-length basis recorded. |
| **Business impact** | The differentiator the whole product is justified by — "your AC company services your own flat and both sides are recorded" — cannot happen. The property still looks more profitable than it is. |
| **Technical impact** | `PRODUCT-TECHNICAL-MASTER.md` and **PRD-02 §2.2 (P2) both record this as "Modelled"**. PRD-02 inherited the error from the audit. |
| **Severity** | **P1** |
| **Recommendation** | Correct the status in both documents; implement per TRD-03 ADR-006. Phase 1. |

### ARCH-002 ⚠️ · The ledger balance gate is float arithmetic

| | |
|---|---|
| **Category** | Correctness |
| **Evidence** | `packages/core/src/services/context.ts:213-220` — `debits`/`credits` accumulated with `reduce((t,l) => t + (l.debit ?? 0), 0)`, compared as `Math.abs(debits - credits) > 0.005`. 12 hand-rolled epsilons across services (`context.ts` 0.005; `payments.ts` 0.005 ×2, 0.01 ×3; `credit-notes.ts` 0.01 ×3; `inventory.ts` 0.0001, 0.01; `purchasing.ts` 0.01). |
| **Current** | The DB trigger is real, but the application gate that produces the journal is a float tolerance. `payments.ts` additionally clamps with `GREATEST(0, …)`, which **silently absorbs** an over-allocation rather than detecting it. |
| **Expected** | Exact decimal comparison; no epsilons. |
| **Severity** | **P0** |
| **Recommendation** | Epic B (ADR-001). |

---

## Security

| ID | Finding | Evidence | Sev | Status |
|---|---|---|---|---|
| **SEC-001** | Backup encryption **failed open** — `encryptBackups = Boolean(key)` wrote a plaintext dump with a warning when `BACKUP_ENCRYPTION_KEY` was unset, and `config.ts` never validated that key. Key derivation used a hardcoded salt `"nexus-backup-v1"` shared by every deployment. | `scripts/backup.mjs:42-47,125-131` | **P0** | ✅ `8683e2f` |
| **SEC-002** | The sign-in page prefilled `owner@sumon.test` / `demo1234` and listed every seeded account, unconditionally — the deployed site published working credentials to anyone who loaded it. | `/login` HTTP 200 with credentials in body | **P0** | ✅ `1f61a97` (gated; **`demo1234` still authenticates and is in git history — rotate before real data**) |
| **SEC-003** | Fail-closed boot check was dead code. | see ARCH-001 | **P0** | ✅ `d417c11` |
| **SEC-004** | `/api/wps/:month` returned the decrypted IBAN of every active employee with no rate limit, no business-unit scoping and no `try/catch`; the month is a free path parameter spanning ~1,000 URLs. | `apps/web/src/app/api/wps/[month]/route.ts` | **P1** | ✅ `1c50e83` |
| **SEC-005** | **0 of 14** mutating server actions were rate-limited — payments, credit notes with cash refunds, bill payments, stock variance to P&L. | `grep rateLimit apps/web/src/lib/actions.ts` → no hits | **P1** | ✅ `02d0cdf` |
| **SEC-006** | No user management exists. A user cannot be invited, re-roled or deactivated from the product; offboarding requires a direct database edit, and live sessions survive it. | no `/settings/users` route; `revokeAllSessions` callable only by the user themselves | **P1** | ⬜ Epic D3 |
| **SEC-007** | Boot check compares `APP_DATABASE_URL !== DATABASE_URL` **as strings**. Two URLs differing only by a query string or trailing slash pass while connecting as the same `BYPASSRLS` owner. CI is a live demonstration. | `config.ts:93`; `rolbypassrls` appears **0 times** in the repo | **P2** | ⬜ Epic D8 |
| **SEC-008** | No confirmation on any journal-posting write. Eight single-click paths post irreversibly, including cheque **Bounce** as a bare table-row button and credit-note **refund**. | `grep Modal\|Dialog\|confirm` → 0 hits | **P2** | ⬜ Epic D7 |
| **SEC-009** | Backups are local-disk only; no offsite replication, no retention policy. Incompatible with the 15-year real-estate retention obligation. | `scripts/backup.mjs` — no S3/GCS/rsync | **P1** | ⬜ blocked on Q-8 |
| **SEC-010** | Security event stream emits structured JSON to stdout with **no collector**. | no log drain configured | **P2** | ⬜ Epic D6 |
| **SEC-011** | `pruneRateLimits()` is documented as "call from the nightly job" and is **never called**; `rate_limit_hits` grows unbounded. | no scheduler exists | **P3** | ⬜ Epic D5 |

**Data-exposure framing.** Production (`neondb`) and the local database (`nexus`) both hold
**seeded demo data only**. None of the above was an active breach. An earlier draft of this
register described the plaintext dumps as exposing "every customer record" on the strength
of a `strings` count — that evidence was wrong (`pg_dump -Fc` is gzip; `pg_restore -l`
identifies the archive as this laptop's dev database). The defects were real and each would
be severe the moment real data lands; the breach framing was not.

---

## Architecture

| ID | Finding | Evidence | Sev | Status |
|---|---|---|---|---|
| **ARCH-003** | Schema deploys via `drizzle-kit push --force`. **Zero `.sql` files exist**; the configured `out: "./drizzle"` directory is absent. No reviewable artefact, no down path, no schema version — for a system holding financial records. | `packages/db/package.json`; `find . -name "*.sql"` → empty | **P0** | ⬜ Epic D4 |
| **ARCH-004** | **No scheduler, no worker, no cron.** The automation runner, notification outbox, daily briefing and KPI snapshots are all manual CLIs. The automation CLI selects `LIMIT 1` tenant, so it is not multi-tenant even if scheduled. | no `vercel.json` crons, no GH `schedule:` | **P1** | ⬜ Epic D5 |
| **ARCH-005** | **No observability**: no error tracking, no RUM, no uptime monitor, no `/health`. A production 500 is invisible. | `grep sentry\|otel\|datadog` → no hits | **P1** | ⬜ Epic D6 |
| **ARCH-006** | `kpi_snapshots` is written **by the seed only** and read by **nothing**; no job maintains it. It looks populated in the demo, which is worse than empty. | `grep kpi_snapshots` → seed inserts only | **P2** | ⬜ Epic D5 |
| **ARCH-007** | No optimistic locking. `version` appears **zero times** across all 10 schema files; concurrency handled ad-hoc with `SELECT … FOR UPDATE`. | `grep -rn version packages/db/src/schema/` → empty | **P2** | ⬜ ADR-012 |
| **ARCH-008** | All 21 pages are `force-dynamic`; every load recomputes every metric. No pagination anywhere — `/receivables` ships 284 KB at seed volume. | 13 `.slice(0,N)` truncations with no way to see the rest | **P2** | ⬜ ADR-004 |
| **ARCH-009** | **0 of 11** tables required by TRD-03 §17.1 exist. Notably `cash_register_sessions` **does** exist with `openingFloat`/`expectedCash`/`countedCash`/`variance` — but no service touches it and there is **no `cash_over_short` account**, so till variance can never reach the ledger. | schema sweep | **P1** | ⬜ Phase 1 |
| **ARCH-010** | `postJournal` takes `accountKey` as a plain `string` with no union type — a typo fails only at runtime. | `services/context.ts:203` | **P3** | ⬜ |
| **ARCH-011** | CI never runs the root `typecheck`; `packages/core` and `packages/db` are only checked incidentally by `next build`. | `.github/workflows/ci.yml` | **P2** | ⬜ Epic C3 |

---

## Quality assurance

| ID | Finding | Evidence | Sev | Status |
|---|---|---|---|---|
| **QA-002** | **No unit-test framework exists.** No vitest/jest/playwright in any `package.json` or `package-lock.json`; zero `*.test.ts` files. All ~227 assertions require Postgres; 166 also require a live HTTP server. | dependency + file sweep | **P0** | ⬜ Epic C1 |
| **QA-003** | The UAE tax and gratuity engines — whose output goes to a regulator — have **no isolated tests**. `calculateCorporateTax` has **zero coverage of any kind**: no e2e reference, no service reference. Small Business Relief boundaries, the relief expiry, the 375k threshold and loss carry-forward are all untested. | symbol sweep across all four suites | **P0** | ⬜ Epic C1 |
| **QA-004** | Metric "tests" assert shape, not value — `if (!Number.isFinite(res.value)) throw`. A formula wrong on day one is confirmed by its own snapshot forever. | `metrics/smoke.ts` | **P1** | ⬜ Epic C1 |
| **QA-005** | Three server actions have **no UI**: `createInvoiceAction`, `createJobAction`, `createPurchaseOrderAction`. The nav reads "Bills & POs" but a purchase order cannot be raised, and there is no invoice-creation screen at all. | route/action cross-reference | **P2** | ⬜ Phase 1 |

---

## UX / design

| ID | Finding | Evidence | Sev | Status |
|---|---|---|---|---|
| **UX-001** | **Zero** `error.tsx`, `loading.tsx`, `not-found.tsx`, `global-error.tsx` across 19 pages. `Suspense` in exactly one file. One failing metric breaks the whole page. `TileSkeleton` was built and is **never rendered**. | file sweep | **P1** | ⬜ Epic D1 |
| **UX-002** | **13 of 18** PDD-04 primitives absent — no Button component (a `.btn` class used 23 ways), no Modal, ConfirmDialog, Toast, Pagination, MoneyInput. **`aria-live`: 0 occurrences.** | component sweep | **P2** | ⬜ Phase 1 |
| **UX-003** | Two styling systems: **120** `style={{}}` sites alongside Tailwind v4, because tokens are CSS custom properties Tailwind classes do not reach. Three near-identical tone→style maps duplicated across two files. | `grep -c 'style={{'` | **P3** | ⬜ |
| **UX-004** | `Sparkline` derives its SVG gradient id from `points.length` + rounded max, and is rendered **once per business unit in a loop** — colliding ids silently make one gradient win for both. | `components/ui.tsx:146-192`, `businesses/page.tsx:110` | **P2** | ⬜ Epic D8 |
| **UX-005** | `BarRow` uses `Math.abs(value)` for bar width, so a **negative value renders as a positive-length bar**, indistinguishable from a positive one. | `components/ui.tsx:195-232` | **P2** | ⬜ Epic D8 |
| **UX-006** | The accountant's three primary screens (VAT201, P&L, gratuity) have **no navigation entry** — reachable only by drill-down. Cheques are filed under rentals. Nav is a flat 10-item list designed around one persona. | `layout.tsx:9-23` | **P2** | ⬜ Phase 1 |
| **UX-007** | `recharts` and `lucide-react` are declared dependencies with **zero import sites**; icons are Unicode glyphs with poor screen-reader semantics. | dependency sweep | **P3** | ⬜ Epic D8 |
| **UX-008** | WCAG 2.2 AA not met and never assessed: 23 `aria-*`, 5 `<label>` across 19 screens, no focus-visible tokens, contrast never verified. Dark mode is OS-only — `data-theme` is set nowhere and there is no toggle. | a11y sweep | **P3** | ⬜ Phase 4 |

---

## Product

| ID | Finding | Sev | Status |
|---|---|---|---|
| **PROD-002** | No data-import path. No real books can enter the system; every other capability is theoretical until this exists. | **P0** | ⬜ Phase 1 |
| **PROD-003** | No month-end close. `assertPeriodOpen` exists and is called by `postJournal`, but **no UI can close a period**, so the guard is unreachable code and the accountant cannot complete her core monthly job. | **P0** | ⬜ Phase 1 |
| **PROD-004** | No manual/cash entry of any kind — the mechanism by which a shadow spreadsheet appears and adoption fails. | **P0** | ⬜ Phase 1 |
| **PROD-005** | Read/write asymmetry: rentals, CRM, leases and payroll are read-only. Users must still do the work elsewhere, which guarantees parallel record-keeping. | **P1** | ⬜ Phase 1 |
| **PROD-006** | The technician persona has no product. The schema supports jobs, visits, photos and van stock fully; the API is read-only, so the app is unbuildable. | **P1** | ⬜ Phase 3 |
| **PROD-007** | Automation is inert: 10 rules evaluate, no delivery provider is connected, no scheduler runs them. | **P1** | ⬜ Epic D5 |
| **PROD-008** | No trend or history anywhere (see ARCH-006). The owner sees today's number but not its direction. | **P1** | ⬜ Epic D5 |
| **PROD-009** | UAE e-invoicing (mandatory 1 Jul 2027, ASP appointed by 31 Mar 2027) is absent from the product **and was missed entirely by the prior audit**. | **P1** | ⬜ Phase 2 |
| **PROD-010** | Commission is computed and has no screen — the single thing that most drives barber engagement. | **P3** | ⬜ Phase 2 |
| **PROD-011** | 7 of 8 `[...slug]` roadmap placeholders are unreachable, shadowed by real routes. Dead code that misleads readers. | **P4** | ⬜ Epic D8 |

---

## Traceability gaps

Built with no traceable requirement — candidates for removal or ratification: `projects`
(construction) tables with no metric/UI/story, `saved_views` with no UI,
`document_extractions` (bill-OCR schema, no implementation), `exchange_rates` with no rate
source, and a 16-role/122-permission model serving nine users.

Required but traceable to no code: data import, period close, rent run, manual entry,
inter-company runtime, e-invoicing, offline mobile.
