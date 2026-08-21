# MASTER_AUDIT

**Version** 1.1 · **Findings dated** 2026-08-13 · **Statuses reconciled** 2026-08-21
**Baseline** commit `6a12c2f` (pre-remediation) · **Reconciled against** `058aef0` (tip of `main`)

> ## ⚠️ READ THIS BEFORE ACTING ON ANY ENTRY BELOW
>
> **Every *finding* in this register describes commit `6a12c2f`, not the current code.**
> This is a snapshot of what a pre-remediation codebase looked like, kept deliberately
> intact. The **Status** column is the only part that tracks the present.
>
> Three pull requests have merged since the findings were written — `3282b7c` (audit
> remediation wave 1), `f539684` (PRD wave 2) and `058aef0` (reverse-charge reachability) —
> and a fourth wave is in flight on `feature/prd-wave-3` and is **not** reflected here.
>
> Of the 46 findings: **28 closed ✅ · 10 partly closed 🟡 · 8 still open ⬜.**
> A 🟡 is not a soft ✅ — it means a named part of the finding is demonstrably still true,
> and that part is stated in the row.
>
> **Nothing has been deleted.** A closed finding is worth more than a deleted one: it
> records the failure mode, the evidence that found it and the change that fixed it. But
> the *Evidence* and *Current* rows are frozen at the baseline, so reading one as a
> description of today's code will be wrong.
>
> This has already happened twice on this project. Check the Status column, then check the
> code.
>
> **Attribution note.** Waves 1 and 2 were squash-merged, so the individual commits named in
> their own docblocks (`871cb5c`, `d217041`, `ae9635a`, `74cf8a8`, `2b096e0`, `8efb426` …)
> are **not ancestors of `main`**. Closures below cite the squash commit that is.

Consolidated findings from the Phase 0 discovery sweep: three parallel evidence-gathering
passes over the data model, the frontend, and security/ops, reconciled against PRD-02,
TRD-03, PDD-04, WF-05 and OPS-07.

**Evidence rule.** Every finding cites a file, a command output, or a database query.
Where something could not be verified it is marked `UNVERIFIED` rather than asserted.
Four findings in this register **correct claims previously published by this project**;
they are marked ⚠️ and are the most important entries here, because a wrong assurance is
worse than a known gap.

**Severity.** P0 blocker · P1 critical · P2 high · P3 medium · P4 low.

**Status.** ✅ closed · 🟡 partly closed, with the surviving part named · ⬜ open. Severities
are the baseline assessment and are **not** re-scored; a closed P0 stays a P0 so the record
of what was once wrong is not flattened by hindsight.

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
| **Status** | ✅ **Closed** `832209e`, guard `check:routes` in CI. Verified 2026-08-21: *"All 128 internal links resolve to real routes (42 live routes scanned)"*, covering 25 `drilldownHref` values. The catch-all calls `notFound()` for everything but the one live roadmap slug, and the smoke test asserts a missing route is a real 404. The guard was later widened past the metric registry to every `href` in the web app's TSX — it had reported green while two live 404s shipped from template literals it could not see. |

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
| **Status** | ✅ **Closed** `f539684` (FR-M06). `packages/core/src/services/interco.ts` posts both legs in one transaction; `interco.test.ts` covers it. The reciprocal accounts exist in the seeded chart — `INTERCO_DUE_FROM` (1700, *Due from Group Companies*) and `INTERCO_DUE_TO` (2700, *Due to Group Companies*) — and the screen is at `/businesses/interco`, reachable from the **Business** nav group. **Q-12 remains open**: whether inter-business services are priced at cost or arm's length is parked as `it.todo` at `interco.test.ts:534`, so the pricing basis is configurable and recorded, not assumed. |

### ARCH-002 ⚠️ · The ledger balance gate is float arithmetic

| | |
|---|---|
| **Category** | Correctness |
| **Evidence** | `packages/core/src/services/context.ts:213-220` — `debits`/`credits` accumulated with `reduce((t,l) => t + (l.debit ?? 0), 0)`, compared as `Math.abs(debits - credits) > 0.005`. 12 hand-rolled epsilons across services (`context.ts` 0.005; `payments.ts` 0.005 ×2, 0.01 ×3; `credit-notes.ts` 0.01 ×3; `inventory.ts` 0.0001, 0.01; `purchasing.ts` 0.01). |
| **Current** | The DB trigger is real, but the application gate that produces the journal is a float tolerance. `payments.ts` additionally clamps with `GREATEST(0, …)`, which **silently absorbs** an over-allocation rather than detecting it. |
| **Expected** | Exact decimal comparison; no epsilons. |
| **Severity** | **P0** |
| **Recommendation** | Epic B (ADR-001). |
| **Status** | ✅ **Closed** `f316425`…`5b0470e`, guarded by `check:money` (`91698bb`) in CI. `services/context.ts:376` is now `if (!eq(debits, credits))` — exact decimal, all 12 epsilons removed. The `GREATEST(0, …)` clamp is gone from payments and purchasing: an over-allocation is refused exactly, never absorbed. |

---

## Security

| ID | Finding | Evidence | Sev | Status |
|---|---|---|---|---|
| **SEC-001** | Backup encryption **failed open** — `encryptBackups = Boolean(key)` wrote a plaintext dump with a warning when `BACKUP_ENCRYPTION_KEY` was unset, and `config.ts` never validated that key. Key derivation used a hardcoded salt `"nexus-backup-v1"` shared by every deployment. | `scripts/backup.mjs:42-47,125-131` | **P0** | ✅ `8683e2f` |
| **SEC-002** | The sign-in page prefilled `owner@sumon.test` / `demo1234` and listed every seeded account, unconditionally — the deployed site published working credentials to anyone who loaded it. | `/login` HTTP 200 with credentials in body | **P0** | 🟡 **Partly closed.** Rendering gated `1f61a97`; smoke asserts absence; `3282b7c` added `resolveSeedPassword` (`seed/index.ts:82`), which now *refuses to seed users at all* against a non-localhost target unless a generated `SEED_PASSWORD` is supplied, and refuses outright if that password is the published one. **The already-seeded accounts were never rotated: `demo1234` still authenticates on the live deployment and is a literal in a public repository.** Open until rotation. |
| **SEC-003** | Fail-closed boot check was dead code. | see ARCH-001 | **P0** | ✅ `d417c11` |
| **SEC-004** | `/api/wps/:month` returned the decrypted IBAN of every active employee with no rate limit, no business-unit scoping and no `try/catch`; the month is a free path parameter spanning ~1,000 URLs. | `apps/web/src/app/api/wps/[month]/route.ts` | **P1** | ✅ `1c50e83` |
| **SEC-005** | **0 of 14** mutating server actions were rate-limited — payments, credit notes with cash refunds, bill payments, stock variance to P&L. | `grep rateLimit apps/web/src/lib/actions.ts` → no hits | **P1** | ✅ `02d0cdf` |
| **SEC-006** | No user management exists. A user cannot be invited, re-roled or deactivated from the product; offboarding requires a direct database edit, and live sessions survive it. | no `/settings/users` route; `revokeAllSessions` callable only by the user themselves | **P1** | ✅ **Closed** `8284635` (`/settings/users`, deactivation revokes every live session — write-layer suite proves *"0 left, 7 revoked"*), extended by `3282b7c` (`assertRoleCeiling` in `services/users.ts:82` — nobody may grant or take away rank they do not hold) and by `f539684` (FR-P01 invites: `createInvite`/`acceptInvite`, the `user_invites` table and `/invite/[tenant]/[token]`). The invite was the obvious hole in the ceiling and is measured against the same rank check — see `services/invites.test.ts`. |
| **SEC-007** | Boot check compares `APP_DATABASE_URL !== DATABASE_URL` **as strings**. Two URLs differing only by a query string or trailing slash pass while connecting as the same `BYPASSRLS` owner. CI is a live demonstration. | `config.ts:93`; `rolbypassrls` appears **0 times** in the repo | **P2** | ✅ **Closed** `3282b7c`. `apps/web/src/instrumentation.ts:235` now asks the database what it actually connected as — `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user` — instead of comparing URL strings. An INDETERMINATE result (unreachable DB, `pg_roles` unavailable) is handled explicitly rather than treated as a pass. |
| **SEC-008** | No confirmation on any journal-posting write. Eight single-click paths post irreversibly, including cheque **Bounce** as a bare table-row button and credit-note **refund**. | `grep Modal\|Dialog\|confirm` → 0 hits | **P2** | ✅ **Closed** `eb3d0e2`. `ActionForm` takes a `confirm` prop (`components/action-form.tsx:182`), rendered as a styled two-step rather than `window.confirm`, and the copy states the *effect* rather than asking "are you sure?" |
| **SEC-009** | Backups are local-disk only; no offsite replication, no retention policy. Incompatible with the 15-year real-estate retention obligation. | `scripts/backup.mjs` — no S3/GCS/rsync | **P1** | ⬜ **Still open**, blocked on Q-8. Re-verified 2026-08-21: `scripts/backup.mjs` still contains no S3, GCS or rsync path. |
| **SEC-010** | Security event stream emits structured JSON to stdout with **no collector**. | no log drain configured | **P2** | ✅ **Closed** `d50750d` + `3282b7c`. `setErrorSink` and `setAlertSink` existed but were called only from a unit test and never at all respectively; `instrumentation.ts:45` now calls `installSinks(core.setErrorSink, core.setAlertSink)` at boot. Redaction runs before the sink either way, so an Emirates ID or a connection string never reaches a vendor SDK. **A vendor collector is still one adapter away** — the wiring is done, the destination is a deployment decision. |
| **SEC-011** | `pruneRateLimits()` is documented as "call from the nightly job" and is **never called**; `rate_limit_hits` grows unbounded. | no scheduler exists | **P3** | ✅ **Closed** `3282b7c`. The `maintenance` cron (`api/cron/[job]/route.ts:501`) calls `pruneRateLimits()` and `pruneExpiredSessions()` and reports real counts — the same commit fixed the outbox marking undelivered messages `success`, which was the same class of bug. |

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
| **ARCH-003** | Schema deploys via `drizzle-kit push --force`. **Zero `.sql` files exist**; the configured `out: "./drizzle"` directory is absent. No reviewable artefact, no down path, no schema version — for a system holding financial records. | `packages/db/package.json`; `find . -name "*.sql"` → empty | **P0** | ✅ **Closed** `cf62574`, RLS folded into the chain by `c0feaf5`. The chain is `0000_baseline`, `0001_job_runs`, `0002_prd_wave_2`, `9999_rls_policies` (490 statements), applied by `db:migrate` and drift-gated by `check:migrations` + `check:rls` in CI. |
| **ARCH-004** | **No scheduler, no worker, no cron.** The automation runner, notification outbox, daily briefing and KPI snapshots are all manual CLIs. The automation CLI selects `LIMIT 1` tenant, so it is not multi-tenant even if scheduled. | no `vercel.json` crons, no GH `schedule:` | **P1** | ✅ **Closed** `995ac82` (decision D-2e: job table + Vercel Cron, lock = partial unique index on `job_runs`), corrected by `3282b7c` — the snapshot job stamped the wrong day under the tenant timezone, and the outbox reported `success` for messages it never delivered. **Five** crons are declared: `snapshots`, `briefing`, `automation`, `outbox`, `maintenance`. **Requires `CRON_SECRET` in Vercel** or every endpoint stays fail-closed and nothing runs. |
| **ARCH-005** | **No observability**: no error tracking, no RUM, no uptime monitor, no `/health`. A production 500 is invisible. | `grep sentry\|otel\|datadog` → no hits | **P1** | 🟡 **Partly closed.** `/api/health` and the post-deploy smoke test `995ac82`; `reportError` with redaction `d50750d`; sinks installed at boot `3282b7c` (see SEC-010). **No vendor collector, no RUM and no external uptime monitor are configured** — the hooks are live, the destinations are not. |
| **ARCH-006** | `kpi_snapshots` is written **by the seed only** and read by **nothing**; no job maintains it. It looks populated in the demo, which is worse than empty. | `grep kpi_snapshots` → seed inserts only | **P2** | ✅ **Closed** `995ac82` (the `snapshots` cron writes it, keyed by the `kpi_snapshots_uq` unique constraint) + `f539684` (FR-V03: `metrics/snapshots.ts` — `readSnapshotTrends`, `buildTrend`, `withTrend` — so the owner sees direction, not only today's number). Timezone and metric-parity defects in that job were fixed by `3282b7c`. |
| **ARCH-007** | No optimistic locking. `version` appears **zero times** across all 10 schema files; concurrency handled ad-hoc with `SELECT … FOR UPDATE`. | `grep -rn version packages/db/src/schema/` → empty | **P2** | ⬜ **Still open.** Re-verified 2026-08-21: no `version` column exists in any schema file, so TRD-03 §17.2's *"all mutable business tables: `version integer not null default 0`"* (ADR-012) is unimplemented. |
| **ARCH-008** | All 21 pages are `force-dynamic`; every load recomputes every metric. No pagination anywhere — `/receivables` ships 284 KB at seed volume. | 13 `.slice(0,N)` truncations with no way to see the rest | **P2** | 🟡 **Partly closed.** `f539684` added the pagination primitive (`components/page.tsx:347` — `PAGE_SIZES`, `pageSlice`, `Pagination`), wired into the five largest list screens: receivables, purchases, CRM, inventory, services. **The caching half is untouched** — 40 files still declare `force-dynamic`, so every load still recomputes every metric. ADR-004's freshness model is not built. |
| **ARCH-009** | **0 of 11** tables required by TRD-03 §17.1 exist. Notably `cash_register_sessions` **does** exist with `openingFloat`/`expectedCash`/`countedCash`/`variance` — but no service touches it and there is **no `cash_over_short` account**, so till variance can never reach the ledger. | schema sweep | **P1** | 🟡 **Superseded in substance.** The *capability* shipped: `services/cash-sessions.ts` (FR-M07, blind close) posts variance to account **5820 `CASH_OVER_SHORT`**, which now exists in the seeded chart, and `/finance/cash` is in the **Money** nav group. The named tables did not: only `legal_entities` and `job_runs` exist as specified, the rest were built on `cash_register_sessions` and ordinary journals. **TRD-03 §17.1 is now a stale plan rather than an open gap** — it should be reconciled to what was built, or the divergence ratified. |
| **ARCH-010** | `postJournal` takes `accountKey` as a plain `string` with no union type — a typo fails only at runtime. | `services/context.ts:203` | **P3** | ⬜ **Still open.** Re-verified 2026-08-21: `services/context.ts:348` is still `accountKey: string`. |
| **ARCH-011** | CI never runs the root `typecheck`; `packages/core` and `packages/db` are only checked incidentally by `next build`. | `.github/workflows/ci.yml` | **P2** | ✅ **Closed** `3d11c52` — the *Type-check all workspaces* step found 18 latent errors on introduction and now gates every PR. |

---

## Quality assurance

| ID | Finding | Evidence | Sev | Status |
|---|---|---|---|---|
| **QA-002** | **No unit-test framework exists.** No vitest/jest/playwright in any `package.json` or `package-lock.json`; zero `*.test.ts` files. All ~227 assertions require Postgres; 166 also require a live HTTP server. | dependency + file sweep | **P0** | ✅ **Closed** `3d11c52`, grown by `3282b7c` and `f539684`. Vitest runs **394 unit tests + 15 `it.todo` across 15 files** with no database and no server, in under a second. Total verification surface is **660** (was 294). |
| **QA-003** | The UAE tax and gratuity engines — whose output goes to a regulator — have **no isolated tests**. `calculateCorporateTax` has **zero coverage of any kind**: no e2e reference, no service reference. Small Business Relief boundaries, the relief expiry, the 375k threshold and loss carry-forward are all untested. | symbol sweep across all four suites | **P0** | ✅ **Closed** `bdbef24` (hand-calculated fixtures), extended by `f539684` (`uae/vat.test.ts` for apportionment, reverse charge and the annual wash-up). The two questions nobody here can answer are parked as `it.todo` rather than guessed — see **Q-1b** (apportionment basis, AED 6,667/quarter) and **Q-2b** (gross-misconduct forfeiture, AED 83,835.62). Q-2b was *demoted from a passing assertion*, which is the correct direction of travel for an unverified rule. |
| **QA-004** | Metric "tests" assert shape, not value — `if (!Number.isFinite(res.value)) throw`. A formula wrong on day one is confirmed by its own snapshot forever. | `metrics/smoke.ts` | **P1** | ⬜ **Still open.** Re-verified 2026-08-21: `metrics/smoke.ts:47` is still `if (!Number.isFinite(res.value)) throw`. Value assertions now exist for the UAE engines, the trend builder, the ledger and the write layer — but **not for the 26 metric definitions**, which are what the dashboard, the public API and the AI all read. This is the highest-value unclosed QA finding. |
| **QA-005** | Three server actions have **no UI**: `createInvoiceAction`, `createJobAction`, `createPurchaseOrderAction`. The nav reads "Bills & POs" but a purchase order cannot be raised, and there is no invoice-creation screen at all. | route/action cross-reference | **P2** | ⬜ **Still open.** Re-verified 2026-08-21: all three remain in `lib/actions.ts` (lines 185, 273, 393) with no `.tsx` caller. Wave 2 added manual entry, cash entry and the rent run, none of which reaches these three. |

---

## UX / design

| ID | Finding | Evidence | Sev | Status |
|---|---|---|---|---|
| **UX-001** | **Zero** `error.tsx`, `loading.tsx`, `not-found.tsx`, `global-error.tsx` across 19 pages. `Suspense` in exactly one file. One failing metric breaks the whole page. `TileSkeleton` was built and is **never rendered**. | file sweep | **P1** | ✅ **Closed** `d74ecd9`, extended by `f539684`. **33** such files now exist, including a root `global-error.tsx` and `not-found.tsx`, an `(app)`-level `error.tsx`, and a `loading.tsx` on every list screen wave 2 added. |
| **UX-002** | **13 of 18** PDD-04 primitives absent — no Button component (a `.btn` class used 23 ways), no Modal, ConfirmDialog, Toast, Pagination, MoneyInput. **`aria-live`: 0 occurrences.** | component sweep | **P2** | 🟡 **Partly closed.** Confirmation shipped as `ActionForm`'s `confirm` prop (`eb3d0e2`, SEC-008) and `Pagination` shipped in `f539684` (ARCH-008). **`aria-live` is still 0 occurrences** across the whole web app — re-verified 2026-08-21 — so no async result is announced to a screen reader. Button, Modal, Toast and MoneyInput remain absent. |
| **UX-003** | Two styling systems: **120** `style={{}}` sites alongside Tailwind v4, because tokens are CSS custom properties Tailwind classes do not reach. Three near-identical tone→style maps duplicated across two files. | `grep -c 'style={{'` | **P3** | ⬜ **Open and worse.** Re-verified 2026-08-21: **246** `style={{` sites, up from 120. Wave 2's fifteen new screens all followed the existing pattern, which is the correct thing for a feature branch to do and the wrong direction for this finding. |
| **UX-004** | `Sparkline` derives its SVG gradient id from `points.length` + rounded max, and is rendered **once per business unit in a loop** — colliding ids silently make one gradient win for both. | `components/ui.tsx:146-192`, `businesses/page.tsx:110` | **P2** | ✅ **Closed** `8d0285a`. `components/ui.tsx:265` takes an explicit `id`, unique per rendered instance (`useId()` is unavailable in a server component, so it is passed in rather than derived). |
| **UX-005** | `BarRow` uses `Math.abs(value)` for bar width, so a **negative value renders as a positive-length bar**, indistinguishable from a positive one. | `components/ui.tsx:195-232` | **P2** | ✅ **Closed** `8d0285a`. `components/ui.tsx:306-312` — the sign now drives the rendering, and the comment records why. |
| **UX-006** | The accountant's three primary screens (VAT201, P&L, gratuity) have **no navigation entry** — reachable only by drill-down. Cheques are filed under rentals. Nav is a flat 10-item list designed around one persona. | `layout.tsx:9-23` | **P2** | ✅ **Closed** `f539684`. `(app)/layout.tsx` is now four labelled groups per WF-05 §1.2 — **Money / Business / Compliance / Reports** — carrying 20 entries, each gated on the permission of the metric that feeds it. VAT, P&L and gratuity all have entries. Grouping deliberately moved no route; the §5.2 restructure is separate work. |
| **UX-007** | `recharts` and `lucide-react` are declared dependencies with **zero import sites**; icons are Unicode glyphs with poor screen-reader semantics. | dependency sweep | **P3** | 🟡 **Half closed.** `8d0285a` removed both dependencies — re-verified 2026-08-21, neither appears in `apps/web/package.json`. **Icons are still Unicode glyphs** (`◱ ◳ ▤ ⇄ …` in the nav table), so the screen-reader half of the finding stands, and with `aria-live` at 0 (UX-002) nothing compensates. |
| **UX-008** | WCAG 2.2 AA not met and never assessed: 23 `aria-*`, 5 `<label>` across 19 screens, no focus-visible tokens, contrast never verified. Dark mode is OS-only — `data-theme` is set nowhere and there is no toggle. | a11y sweep | **P3** | ⬜ **Still open**, Phase 4. No accessibility work has been done in any of the three waves; the screen count it applies to has grown from 19 to 33. |

---

## Product

| ID | Finding | Sev | Status |
|---|---|---|---|
| **PROD-002** | No data-import path. No real books can enter the system; every other capability is theoretical until this exists. | **P0** | ✅ **Closed** `f539684` (FR-D01). `packages/core/src/services/import/**`, the `import_batches` / `import_batch_rows` tables, and the screens at `/settings/import` and `/settings/import/[batchId]`, reachable from the **Reports** nav group on `journal:post`. **D5 still stands as a go-live gate**: the accountant's signed reconciliation is a decision, not a feature, and no reconciliation has been signed. |
| **PROD-003** | No month-end close. `assertPeriodOpen` exists and is called by `postJournal`, but **no UI can close a period**, so the guard is unreachable code and the accountant cannot complete her core monthly job. | **P0** | ✅ **Closed** `f539684` (FR-C01). `services/periods.ts` + `/accounting/close`, in the **Compliance** nav group on `period:read`. `assertPeriodOpen` is now reachable code. |
| **PROD-004** | No manual/cash entry of any kind — the mechanism by which a shadow spreadsheet appears and adoption fails. | **P0** | ✅ **Closed** `f539684` (FR-M01–M09). `services/manual-entry.ts` plus six screens under `/cash` (journal, received, paid, owner-in, owner-out) in the **Money** nav group — deliberately placed beside the money screens, not in settings, because an adoption gate buried in settings is not a gate. Cash sessions with blind close (FR-M07) at `/finance/cash`. |
| **PROD-005** | Read/write asymmetry: rentals, CRM, leases and payroll are read-only. Users must still do the work elsewhere, which guarantees parallel record-keeping. | **P1** | 🟡 **Partly closed.** `f539684` gave rentals a write path (FR-R01/R02: `services/rentals.ts`, `/rentals/lease/new`, `/rentals/lease/[id]`, `/rentals/rent-run`). **CRM and payroll are still read-only** — payroll in particular still goes through the database, and Q-7 (the WPS SIF layout) blocks the run. |
| **PROD-006** | The technician persona has no product. The schema supports jobs, visits, photos and van stock fully; the API is read-only, so the app is unbuildable. | **P1** | ⬜ **Still open**, Phase 3. `/api/v1` still exposes reads only. |
| **PROD-007** | Automation is inert: 10 rules evaluate, no delivery provider is connected, no scheduler runs them. | **P1** | 🟡 **Partly closed.** The scheduler exists and runs them (ARCH-004); `3282b7c` stopped the outbox marking undelivered messages `success`, which was the failure mode that made "inert" hard to see. **No delivery provider is connected** — the default provider logs instead of sending, on purpose, and plugging in Twilio or Unifonic is one `DeliveryProvider` implementation. |
| **PROD-008** | No trend or history anywhere (see ARCH-006). The owner sees today's number but not its direction. | **P1** | ✅ **Closed** `f539684` (FR-V03) — see ARCH-006. |
| **PROD-009** | UAE e-invoicing (mandatory 1 Jul 2027, ASP appointed by 31 Mar 2027) is absent from the product **and was missed entirely by the prior audit**. | **P1** | 🟡 **Placeholder only** — `f539684` (FR-C07). `packages/core/src/einvoice/**` (scope, readiness, deadline, PINT AE serialiser, validator, provider interface) and a readiness screen at `/compliance/e-invoicing`. **Nothing transmits.** Three `it.todo`s in `einvoice.test.ts` are blocked on Q-3 (penalty schedule), Q-4 (final PINT AE mandatory field list) and Q-6 (which entities hold which licences). **The statutory deadlines are unchanged and no ASP has been appointed.** |
| **PROD-010** | Commission is computed and has no screen — the single thing that most drives barber engagement. | **P3** | 🟡 **Partly addressed, and this needs a decision.** `/salon` renders a "Stylist commission" strip — but it is a **hard-coded 25% of `estimated_value` computed in the page's own SQL** (`salon/page.tsx:78`), not the `commission_rules`/`commission_entries` engine the schema models. That is two sources of truth for a number staff are paid on. Either wire the screen to the engine or delete the engine. |
| **PROD-011** | 7 of 8 `[...slug]` roadmap placeholders are unreachable, shadowed by real routes. Dead code that misleads readers. | **P4** | ✅ **Closed** `832209e`. The catch-all's `ROADMAP` is down to a single live key (`ecommerce`); everything else calls `notFound()`. See **E-3** in MASTER_PROJECT_STATE — that surviving stub still names "Daraz", a marketplace with no UAE presence. |

---

## Traceability gaps

Built with no traceable requirement — candidates for removal or ratification: `projects`
(construction) tables with no metric/UI/story, `saved_views` with no UI,
`document_extractions` (bill-OCR schema, no implementation), `exchange_rates` with no rate
source, and a 16-role/122-permission model serving nine users.

**Status 2026-08-21:** unchanged, and the permission model has grown — **125 permissions**
across 16 roles, not 122, because waves 1–2 added keys for periods, cash sessions,
inter-company, imports and invites. `commission_rules` / `commission_entries` should be
added to this list: see PROD-010, where the salon screen bypasses the engine entirely.

Required but traceable to no code: ~~data import, period close, rent run, manual entry,
inter-company runtime~~ — all five shipped in `f539684`. **Still traceable to no code:**
e-invoicing *transmission* (the serialiser and readiness model exist; nothing sends),
offline mobile, the payroll run, and CRM writes.
