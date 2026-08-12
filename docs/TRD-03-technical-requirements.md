# Nexus — Technical Requirements Document

**Document** TRD-03 · **Version** 2.0 · **Date** 12 August 2026
**Status** For engineering ratification
**Implements** PRD-02 v2.0 · **Informed by** RES-01
**Baseline** Reverse-engineered audit of 9 August 2026, commit 650b580

* * *

## 0. Position

The audit's verdict on the architecture is worth quoting because this document does not contradict it: *"Yes, structurally. No, operationally."* The layering, the tenant isolation, the database-enforced invariants and the security posture are good enough to carry real financial records and better than most systems at this stage. What is not good enough is the operational envelope around them.

This TRD therefore has an unusual shape. It changes very little about the architecture and a great deal about what surrounds it. Section 2 lists what is explicitly frozen. Sections 3 onward are fourteen architecture decision records covering everything that must change, followed by the data model additions, the API contract, the testing strategy and the deployment topology.

The single most important structural fact in the codebase — `packages/core` importing nothing from React or Next — is what makes the worker process, the mobile app and the MCP server small jobs rather than rewrites. Every decision below is made in a way that preserves it.

Table of Contents

* * *

## 1. System overview

A TypeScript monorepo with three packages and one hard rule: the domain core imports nothing from React or Next, so web, API, CLI jobs, the scheduler, the MCP server and a future mobile app all consume one implementation of every business rule.

```
packages/db      Schema across 10 bounded contexts, RLS generator, tenant client, seed
packages/core    Framework-free domain layer
  metrics/       Typed, permission-checked semantic layer
  services/      Write layer, one uniform shape per write
  security/      PII encryption, config validation, event stream, erasure
  uae/           Gratuity, WPS, VAT, corporate tax — pure functions
  automation/    Rule engine with dry-run, dedupe, caps
  rbac.ts        Permission resolution
apps/web         Next.js App Router, 21 pages, 14 server actions, read API
scripts          Setup, backup drill, checks
```

**Additions in this version**

```
packages/core
  services/manual/     Typed manual-entry objects
  services/interco/    Double-sided inter-business posting
  money/               Decimal arithmetic primitives
  einvoice/            PINT AE serialiser and provider interface
apps/worker            Process host: scheduler, outbox, snapshots, briefing
apps/mcp               MCP server over Streamable HTTP
packages/charts        Server-renderable chart primitives
```

* * *

## 2. Frozen — do not change

The audit's section 29.2 lists things not to do. They are restated here as constraints on every decision in this document.

| # | Frozen | Why |
| --- | --- | --- |
| FR-1 | The layering. `packages/core` imports no React and no Next | It is what makes mobile, workers and MCP cheap. Verified by build |
| FR-2 | PostgreSQL with row-level security as the isolation strategy | There is no equivalent elsewhere. RLS is generated from the schema, FORCEd, and the app connects as a NOBYPASSRLS role |
| FR-3 | Database-enforced invariants over application-enforced ones | The balance trigger, 264 foreign keys and 1,426 checks mean an application bug cannot corrupt the ledger |
| FR-4 | Permissions checked in the service, not the UI | The UI hides; the service refuses. This is what makes the API and the MCP server safe by construction |
| FR-5 | The semantic metric layer as the single definition of every number | Dashboard, API and assistant cannot disagree about what revenue means |
| FR-6 | No LLM-generated SQL | Accuracy and tenant isolation both depend on it |
| FR-7 | React Server Components plus server actions plus query-param state | No client-state library. Do not import Redux or Zustand to solve a problem that does not exist |
| FR-8 | Soft deletes and reversal rather than deletion | Legally necessary |
| FR-9 | The uniform write shape | validate, permission, idempotency, period check, number allocation, post journal, audit — all in one transaction. A new write inherits all of it by construction |

* * *

## 3. ADR-001 · Decimal money arithmetic

**Status** Accepted · **Severity** Critical · **Traces to** TD-01, ID-04, R3

### Context

The database stores money as `numeric(18,4)`. JavaScript reads it with `Number()` or `parseFloat`, sums in IEEE-754 doubles, and writes back via `.toFixed(4)`. The audit found 28 money-related sites across 8 service files. The tell is in `credit-notes.ts:120`, which compares `alreadyCredited + total > Number(inv.total) + 0.01` — a hand-rolled epsilon, which is what people write when they have discovered float drift empirically and patched around it.

In an ERP, "usually correct" is a defect. Accumulated rounding across many lines can produce fils-level drift or, worse, a journal the balance trigger rejects at commit time — which surfaces as an opaque failure to the user.

### Decision

Adopt `decimal.js` as the money type throughout `packages/core`. Money never exists as a `number` between reading it from the database and writing it back.

### Options considered

| Option | Complexity | Precision | Ecosystem | Verdict |
| --- | --- | --- | --- | --- |
| `decimal.js` | Low | Arbitrary precision, configurable rounding | Mature, widely used with Postgres numeric | **Chosen** |
| `big.js` | Low | Arbitrary precision, smaller API | Smaller bundle, fewer features | Viable, less capable on rounding modes |
| Native `BigInt` in minor units | Medium | Exact | No decimal semantics; every rate calculation needs manual scaling | Rejected — VAT at 5 percent and apportionment ratios make this painful |
| Postgres-side arithmetic only | High | Exact | Pushes business logic into SQL, violating FR-1 | Rejected |

### Implementation

```
packages/core/src/money/
  Money.ts        Branded type wrapping Decimal, 4 dp, ROUND_HALF_EVEN
  parse.ts        fromDb(string) -> Money, toDb(Money) -> string
  ops.ts          add, sub, mul, div, allocate, sum, compare, isZero
  allocate.ts     Largest-remainder allocation so splits sum exactly
```

Four rules:

1. `postgres-js` returns `numeric` as a string. Never call `Number()` on it. A lint rule forbids `Number(` and `parseFloat(` on any identifier matching a money naming convention, and forbids importing `Money` into a context that then arithmetics with `+`.
2. Rounding is `ROUND_HALF_EVEN` at 4 decimal places for storage, `ROUND_HALF_UP` at 2 for display. Both are stated once, in the module.
3. Any operation that splits an amount — VAT apportionment, payment allocation across invoices, inter-business cost sharing — uses `allocate`, which uses largest-remainder so the parts sum exactly to the whole. This is the single most common source of one-fils discrepancies and it must be solved once.
4. The hand-rolled `+ 0.01` epsilons are deleted, not migrated. Exact comparison replaces them.

### Consequences

Easier: every future write is exact by construction; the balance trigger stops being a safety net that occasionally fires and becomes a formality.

Harder: the migration touches every service. The 227 existing checks are the safety net — run them after each file.

Revisit: never. This is a foundational representation choice and reversing it is more expensive than making it.

### Action items

1. Add `packages/core/src/money` with unit tests including a property test asserting `sum(allocate(x, weights)) === x` for random inputs.
2. Migrate services one file at a time, running the full check suite between each.
3. Add the lint rule and gate CI on it.
4. Delete every epsilon comparison.

* * *

## 4. ADR-002 · Versioned migrations

**Status** Accepted · **Severity** High · **Traces to** TD-06, DB-6, R14

### Context

Schema is deployed via `drizzle-kit push`, which diffs the live schema and applies changes directly. There is no reviewable artefact, no down path, and no guarantee two environments converged identically. The audit's assessment is correct: right for prototyping, wrong for a system holding financial records.

### Decision

Switch to `drizzle-kit generate` producing committed SQL migration files. CI blocks any merge where the generated migration does not match the schema. Production applies migrations as an explicit, gated step, never as a side effect of deploy.

### Consequences

Easier: schema history is reviewable in pull requests; environments provably converge; a bad change has a down path.

Harder: schema changes gain a step. The RLS generator must run after migration and its output must itself be a committed migration, so that a table added without an RLS policy fails CI rather than shipping unprotected. The existing `npm run db:rls` build gate stays and gains a second job: assert every `tenant_id` table has an enforced policy in the *migrated* schema, not the *declared* one.

### Action items

1. Baseline the current schema as migration `0000_baseline.sql`.
2. Generate RLS policies into migrations rather than applying at runtime.
3. Add a CI job: generate, diff against committed, fail on drift.
4. Add a production migration gate requiring explicit approval.
5. Add a CI check asserting the table count matches the documented figure, closing TD-11.

* * *

## 5. ADR-003 · Process host for scheduled and background work

**Status** Accepted · **Severity** High · **Traces to** TD-15, BL-010

### Context

Three subsystems are built and inert: the automation rule engine, the notification outbox, and the daily briefing. A fourth is needed: nightly KPI snapshots. All four currently require a human to run a CLI command. An automation platform that only runs when someone remembers to run it does not automate anything.

Vercel's serverless model cannot host a long-running worker. This is the same constraint identified on a sibling project, and the same answer applies.

### Decision

A hybrid runtime. Vercel continues to host `apps/web` — pages, server actions and the read API. A separate small process host runs `apps/worker`\: a scheduler, the outbox drain, the snapshot job and the briefing composer. Redis provides the queue and the distributed lock.

### Options considered

| Option | Fit | Cost | Operational burden | Verdict |
| --- | --- | --- | --- | --- |
| Vercel Cron only | Fits scheduled jobs; cannot hold a long-running consumer or retry with backoff across invocations | Lowest | Lowest | Rejected — the outbox needs a durable consumer |
| Process host plus Redis (Railway, Fly, Render) | Fits all four workloads; one small always-on process | \~USD 10 to 25 per month | Low | **Chosen** |
| Neon-backed job table with advisory locks, polled by Vercel Cron | Avoids Redis; polling granularity is coarse | Low | Medium | Viable fallback if a process host is unacceptable |
| Full container platform | Overkill at this scale | Higher | Higher | Rejected |

### Implementation

```
apps/worker
  scheduler.ts    Cron expressions, one owner per job via Redis lock
  jobs/
    automation.ts   Run the 10 rules. Honours dry-run, dedupe, caps
    outbox.ts       Drain notification outbox through the delivery provider
    snapshots.ts    Write kpi_snapshots for every metric per BU per day
    briefing.ts     Compose and deliver the daily briefing
    einvoice.ts     Transmit queued e-invoices, poll MLS, retry with backoff
  runlog.ts       Every run writes started, finished, outcome, counts
```

Every job is idempotent, holds a lock so two hosts cannot double-run, and writes to a run log that is visible in the product. A job that has not run when expected raises an exception on the dashboard — silence is not success.

### Consequences

Easier: three built subsystems start working; the KPI history that unblocks every trend feature becomes possible.

Harder: a second deployment target, a second set of environment variables, a second thing that can be down. The `/health` endpoint in ADR-009 covers both.

* * *

## 6. ADR-004 · Snapshot-backed dashboards and caching

**Status** Accepted · **Severity** High · **Traces to** TD-04, ID-06, TD-20, DB-3, BL-014

### Context

All 21 pages carry `force-dynamic`. Every page load runs the full metric set against Postgres. The audit is explicit that this was a default rather than a decision. It is simultaneously the primary scalability bottleneck and a direct hosting cost. Separately, `kpi_snapshots` is written by the seed and read by nothing — write-only dead data that also misleads, because the table looks populated in the demo.

### Decision

A three-tier read strategy per metric, declared on the metric itself.

| Tier | Behaviour | Applies to |
| --- | --- | --- |
| `live` | Always computed on request | Cash position, action items, anything the user just changed |
| `snapshot` | Read from `kpi_snapshots`, with a live fallback if the snapshot is stale beyond a threshold | Trends, per-business profit, occupancy, gratuity liability |
| `cached` | Tag-based cache, revalidated by the write that invalidates it | Compliance watchlist, VAT position, slow-changing lists |

The metric declaration gains a `freshness` field. `revalidateTag` is called from the service layer on write, so invalidation is a property of the write rather than something a page author remembers.

### Consequences

Easier: dashboards get faster and cheaper; trend charts become possible at all; the snapshot table stops being a lie.

Harder: two sources of truth for the same number, which is exactly the hazard the semantic layer exists to prevent. Mitigation: the snapshot is written *by* the same metric function, never by a parallel SQL query, and a nightly check asserts snapshot equals live for a sample of metrics.

### Action items

1. Add `freshness` to the metric type; default `live` so nothing changes silently.
2. Build the snapshot job in `apps/worker`.
3. Backfill snapshots from journal history for the migrated period.
4. Add the snapshot-versus-live consistency check to CI.
5. Remove `force-dynamic` per route as each is converted.

* * *

## 7. ADR-005 · Manual-entry service design

**Status** Accepted · **Severity** Critical · **Traces to** FR-M01 to FR-M12 · **New**

### Context

The product has no write path for cash, owner funds, or informal settlement. The PRD makes this the adoption gate. The naive implementation is a journal-entry form; research says that is exactly wrong, because the people who need it will never construct a double entry.

### Decision

Five typed entry objects, each mapping to a fixed journal shape the user never sees, plus a float and day-close object. One generic manual journal exists for the accountant, gated on a permission.

```
packages/core/src/services/manual/
  cashReceipt.ts
  cashPayment.ts
  ownerContribution.ts
  ownerDrawing.ts
  interBusinessTransfer.ts   -> delegates to services/interco
  cashSession.ts             open, close, variance
  manualJournal.ts           accountant only
  reverse.ts                 shared reversal
  templates.ts
```

Every one follows the existing uniform write shape, so each inherits idempotency, permission checking, period assertion, audit and atomicity for free. This is the payoff of the architecture the audit praised.

### The journal shapes, stated once

| Object | Debit | Credit |
| --- | --- | --- |
| Cash receipt, allocated | Cash-in-hand, cash point | Accounts receivable |
| Cash receipt, unallocated | Cash-in-hand, cash point | Revenue, plus output VAT where applicable |
| Cash payment, expense | Expense account, plus input VAT where recoverable | Cash-in-hand |
| Cash payment, exempt-supply BU | Expense account inclusive of irrecoverable VAT | Cash-in-hand |
| Cash payment, against a bill | Accounts payable | Cash-in-hand |
| Owner contribution | Bank or cash-in-hand | Owner capital contributed |
| Owner drawing | Owner drawings | Bank or cash-in-hand |
| Float replenishment | Cash-in-hand, cash point | Bank |
| Day-close variance, short | Cash over and short, cash point | Cash-in-hand |
| Day-close variance, over | Cash-in-hand | Cash over and short, cash point |

The exempt-supply row is the same rule the bill path already implements and is described in the audit as the single most important UAE rule in the system. It must be shared code, not reimplemented.

### Chart of accounts additions

Per business unit: `cash_in_hand.{cash_point}`, `owner_capital_contributed`, `owner_drawings`, `cash_over_short.{cash_point}`, `due_from.{business_unit}`, `due_to.{business_unit}`.

Cash over and short sits in other income and expense, below operating profit, deliberately. It is a detective control, and burying it in miscellaneous expense destroys the clustering signal that makes it useful.

### Blind count

`closeCashSession` accepts `countedAmount` and returns the expected amount only in the response, never before. The expected figure must not be present in any payload sent to the client while the session is open. This is enforced by the metric's permission declaration, not by the UI hiding a field.

### Consequences

Easier: the adoption gate becomes achievable; the assistant and MCP server get a small, safe write surface because each object is a narrow typed function rather than a general journal.

Harder: six new services and a chart-of-accounts extension. Mitigated by the uniform write shape.

* * *

## 8. ADR-006 · Double-sided inter-business posting

**Status** Accepted · **Severity** Critical · **Traces to** FR-M06, P2, F-03 · **New**

### Context

Inter-company self-service as a normal flow is the product's defensible wedge. The audit says it is modelled — one balanced journal, revenue for one business unit, cost for the other, netting to zero at group level. The research says the standard pattern is reciprocal due-to and due-from accounts created at the point of the transaction, and that the documented failure mode is balances going stale for years and netting being skipped once three or more entities are involved.

The audit's model is correct for the single-journal case. It does not produce a per-pair reciprocal balance that can be reconciled, aged and settled.

### Decision

Inter-business transactions post as a single database transaction containing both legs, and maintain reciprocal `due_from` and `due_to` balances per business-unit pair.

```
interBusinessTransfer({
  payingBusinessUnitId,
  benefitingBusinessUnitId,
  amount: Money,
  nature: 'cash_advance' | 'shared_cost' | 'service_performed',
  pricingBasis?: 'at_cost' | 'arms_length',
  armsLengthRate?: Money,
  jobId?: string,
  ...
})
```

Invariants, asserted in code and in a scheduled check:

1. Both legs exist or neither does. One transaction, no exceptions.
2. For every ordered pair (A, B), `due_from(A→B) === due_to(B→A)` at all times.
3. Group-level consolidated profit is unchanged by any transfer. The elimination is derived, not stored.
4. Where `nature` is `service_performed` and `pricingBasis` is `arms_length`, the rate and its basis are recorded on the document. This exists because a single owner running six businesses that transact with each other creates connected-person transactions under UAE corporate tax, which carry arm's-length documentation obligations. A balanced journal is not sufficient evidence.

### Consolidation

Group consolidated profit and loss is computed as the sum of business-unit results minus eliminations, where eliminations are derived by matching the reciprocal pairs. It is never a stored figure. A metric `group_pnl_consolidated` returns both the gross and eliminated views, because the owner needs to see the elimination, not just its effect.

### Ageing and settlement

Reciprocal balances carry an ageing view. A balance older than a configurable threshold appears in the compliance watchlist and the dashboard exception list. A settlement action reverses both sides symmetrically and is itself audited.

### Consequences

Easier: the wedge becomes demonstrable rather than asserted; transfer-pricing documentation has a source.

Harder: two more account families per business-unit pair. At six operating businesses that is 30 ordered pairs, though only the pairs that actually transact get accounts, created lazily.

* * *

## 9. ADR-007 · E-invoicing architecture

**Status** Accepted · **Severity** High, statutory · **Traces to** FR-C07 · **New**

### Context

UAE e-invoicing is mandatory for businesses of this size from 1 July 2027, with an accredited service provider appointment due 31 March 2027. The model is a decentralised five-corner Peppol network: supplier, supplier's ASP, network, buyer's ASP, buyer, with both ASPs reporting to the FTA. Nexus cannot connect to the network directly; the ASP relationship is the compliance mechanism. The standard is PINT AE, a UAE localisation of the Peppol International Invoice, delivered as XML.

### Decision

Mirror the existing `DeliveryProvider` pattern exactly. A serialiser boundary plus a provider interface, with a no-op default and one real implementation before Q1 2027.

```
packages/core/src/einvoice/
  pintae/
    serialise.ts     Document -> PINT AE XML
    validate.ts      Structural validation before transmission
    fields.ts        Mandatory field map, versioned against the data dictionary
  provider.ts        interface EInvoiceProvider
  providers/
    noop.ts          Logs, does not transmit. Default
    <asp>.ts         The chosen ASP's API
  outbox.ts          Queue, transmit, record MLS, retry with backoff
  status.ts          MLS state machine
```

### Phase 1 placeholder, required now

Three cheap things that make Q1 2027 a configuration task rather than a rebuild:

1. A `legal_entities` table with TIN, trade licence and registration details, and a mapping from business unit to legal entity. Business units and legal entities are not the same thing and the schema currently conflates them.
2. Documents render through the serialiser boundary rather than directly, even when the serialiser is a no-op.
3. The provider interface exists with the no-op implementation wired in.

### Scope discipline

Business-to-consumer is currently out of scope for the mandate. Salon walk-ins, retail counter sales and direct e-commerce orders continue to produce a compliant local tax invoice and are not transmitted. In scope: commercial leases, corporate parking contracts, wholesale phone sales, B2B services, and intra-group recharges — the last subject to confirmation of the intra-group relief noted in the June 2026 version 1.1 update.

### Open dependencies

Q-3 penalty schedule, Q-4 final field list, Q-6 which entities hold which licences and their revenue against the AED 50 million threshold. None blocks the placeholder.

* * *

## 10. ADR-008 · Testing framework and strategy

**Status** Accepted · **Severity** Critical · **Traces to** TD-02, ID-07, R4

### Context

There are 227 passing checks and no unit-test framework. The checks are bespoke scripts asserting end-to-end behaviour. The audit's assessment is exactly right and worth restating: *the riskiest code in the system received the weakest form of verification, while page rendering received the strongest.* The tax and gratuity engines are verified only by asserting that a snapshot over synthetic data has not changed. If the formula was wrong on day one, every test agrees with the error forever.

### Decision

Adopt Vitest. Start with `uae/`, `money/` and `rbac`. Port the existing write-layer checks into Vitest as integration tests. Keep the metric snapshot, e2e and security suites, which are genuinely good.

### The test pyramid, target state

| Level | Tool | Gate | Scope |
| --- | --- | --- | --- |
| Unit | Vitest | Every pull request | `uae/`, `money/`, `rbac`, `interco` invariants, chart data transforms |
| Property | Vitest with fast-check | Every pull request | Allocation sums exactly; journals balance for random valid inputs |
| Integration | Vitest, ported from `test.ts` | Every pull request | Every service write, against a real database |
| Metric snapshot | Existing | Every pull request | Definition drift |
| End-to-end HTTP | Existing | Every pull request | Auth, roles, API |
| Security regression | Existing, 68 checks | Every pull request | Cross-tenant, headers, lockout, PII |
| Browser | Playwright | Pre-release | Book to pay, rent run, cash entry to day close, job to invoice |
| Accessibility | axe-core in Playwright | Pre-release | Phase 4 |
| Load | k6 | Pre-scale | Phase 4 |
| Contract | OpenAPI plus schemathesis | When writes ship | Phase 3 |

### The fixtures that matter most

Hand-calculated, not generated, and reviewed by the accountant before they are committed:

- **Gratuity:** under one year; exactly one year; three years; exactly five years; seven years; the two-year cap; rehire after payout. Gated on Q-2 — do not write a resignation-versus-termination fixture until the current position is confirmed, because a test written against a stale rule enshrines the error permanently.
- **VAT:** fully taxable; fully exempt; mixed apportionment under the output-based method; mixed under the floorspace method; zero-rated export; reverse charge on imported services; the annual wash-up adjustment.
- **Corporate tax:** below the AED 375,000 nil band; Small Business Relief applied; relief expired for a period ending on or after 31 December 2026; above the nil band.
- **Money:** allocation of an indivisible amount across three weights; VAT at 5 percent on an odd amount; a hundred-line document summing exactly.

### Action items

1. Add Vitest with a database-backed integration setup.
2. Write `money/` unit and property tests first — they underpin ADR-001.
3. Write `uae/` fixtures with accountant review, blocking on Q-1 and Q-2.
4. Port write-layer checks.
5. Gate CI on all of the above.

* * *

## 11. ADR-009 · Observability

**Status** Accepted · **Severity** High · **Traces to** TD-07, TD-19, R8

### Context

No error tracking, no real-user monitoring, no uptime monitoring, no tracing, no log sink. The security event stream emits structured JSON to stdout and nobody collects it. The audit's consequence statement is unimprovable: *if the deployed app throws a 500 right now, nobody finds out. If a metric silently returns a wrong number, nobody finds out. If the owner stops using the app, nobody finds out.*

### Decision

| Concern | Tool | Requirement |
| --- | --- | --- |
| Errors and traces | Sentry | A production 500 alerts within five minutes |
| Real-user monitoring | Vercel Analytics plus Web Vitals | p75 by route |
| Uptime | External monitor against `/health` | Both web and worker |
| Log sink | Vercel log drain to a collector | The security event stream reaches a queryable destination |
| Product analytics | Event stream per PRD section 12.4 | Instrumented before Phase 1 go-live, not after |
| Job health | Run log in the product | A job that did not run raises a dashboard exception |

`/health` returns database reachability, migration version, worker last-heartbeat, and the age of the most recent snapshot. A post-deploy smoke test hits it and one authenticated page, and fails the deploy if either fails.

### The redaction requirement

The existing event stream redacts password, token, IBAN and Emirates ID patterns. That redaction must be applied at the Sentry boundary too, before any payload leaves the process. Financial and personal data in an error report is a PDPL exposure, not just an untidiness.

* * *

## 12. ADR-010 · Charting and visualisation runtime

**Status** Accepted · **Severity** Medium · **Traces to** FR-V02, PDD-04 · **New**

### Context

The product currently hand-rolls `Sparkline` and `BarRow` as SVG, ships `recharts` without meaningfully using it, and needs to grow into waterfall, bullet, calendar heatmap, small multiples and Sankey. The pages are React Server Components; adding a client-only charting library to every dashboard section undoes the server-rendering benefit.

### Decision

A two-layer approach in a new `packages/charts`.

**Layer 1 — server-rendered static SVG.** Observable Plot generates SVG markup synchronously with no DOM dependency, so a server component can emit the chart as markup with zero client JavaScript. This covers everything above the fold: KPI sparklines, profit by business unit, cash trend, waterfall, bullet graphs, calendar heatmap, small multiples.

**Layer 2 — client interactive, loaded on demand.** Only where a chart genuinely needs interaction — receivables ageing drill-down, the inter-business Sankey — a client component loads. Sankey specifically comes from ECharts, which has it built in alongside calendar heatmap and funnel, avoiding a bespoke D3 implementation.

### Options considered

| Library | Bundle | Server rendering | Accessibility | Verdict |
| --- | --- | --- | --- | --- |
| Observable Plot | Small, modular | Emits SVG synchronously — the best fit for RSC | Moderate | **Layer 1** |
| ECharts | Large but tree-shakeable | Client; has Sankey, calendar heatmap, funnel built in, plus decal patterns as a colour-blind-safe alternative to hue | Good, with ARIA and decal options | **Layer 2, on demand** |
| Recharts | \~370 KB, SVG | Client only; per-point DOM nodes degrade with volume | Baseline | **Remove** — currently installed and barely used |
| Nivo | \~40 KB core | Client | Strongest ARIA and keyboard support of the set | Considered; ECharts wins on chart-type coverage |
| visx | Modular primitives | Most straightforward to server-render | None built in; hand-built | Rejected — too much bespoke work |

### Constraints on every chart

Enforced in the primitives, not left to the caller:

- No gauges, no speedometers, no donut rings. The bullet graph exists specifically to replace them.
- No pie charts. Profit can be negative and a pie cannot represent that; and angle is judged poorly against length.
- No dual axes. Two independently scaled series on one chart implies a correlation that is not there.
- No three-dimensional anything.
- Sign is never conveyed by colour alone. A symbol or a label carries it redundantly.
- Chart elements meet 3:1 non-text contrast; chart text meets 4.5:1. Both themes, checked in CI.
- Every chart component requires a `conclusion` prop — a plain-language sentence stating what the chart shows. A chart without a conclusion does not compile.

That last constraint is the mechanism by which the owner's request for explanation over display becomes structural rather than aspirational.

### Action items

1. Create `packages/charts` with the primitive set from PDD-04.
2. Remove `recharts`.
3. Add a CI contrast check across both themes.
4. Make `conclusion` a required prop at the type level.

* * *

## 13. ADR-011 · MCP server runtime and authorisation

**Status** Accepted · **Severity** Medium · **Traces to** FR-P07, MCP-06 · **New**

### Context

The owner wants to query and record through Claude on his phone. The semantic metric layer — the architectural centrepiece — is already a set of typed, permission-checked functions. Exposing it over MCP is a small job precisely because of FR-1 and FR-4.

The protocol moved substantially. The current specification is 2026-07-28. The `initialize` handshake and `Mcp-Session-Id` session model are eliminated; every request carries protocol version and capabilities in `_meta`; servers can be fully stateless. Roots, Sampling and Logging are deprecated in favour of Multi Round-Trip Requests. Legacy HTTP-plus-SSE transport is deprecated in favour of Streamable HTTP.

### Decision

`apps/mcp`, a stateless Streamable HTTP server built on the `@modelcontextprotocol/server` v2 beta, deployed alongside `apps/worker` on the process host, importing `packages/core` directly.

**Authorisation.** OAuth 2.1 resource server. The server validates tokens and never issues them. It publishes Protected Resource Metadata under RFC 9728 and returns 401 with `WWW-Authenticate` pointing at it. Tokens are audience-bound under RFC 8707 and rejected if not issued for this server. Issuer validation under RFC 9207 on code exchange.

**The critical property**, and the reason this is safe: a token resolves to a membership, and a membership resolves to a role and a scope. Every tool call runs inside `withTenant` with permissions checked in the service. **A token can never exceed what its human can do.** This already holds for the existing read API and is the single design decision that makes an MCP server over financial data defensible.

**Confused deputy.** The server never uses its own credentials on a caller's behalf. The one path where isolation depends on application code — `adminDb()` in `api-auth.ts`, needed because the tenant is unknown until the token resolves — is the same path the read API uses. It is bounded to a single lookup, and it gets a dedicated test asserting it cannot return a row outside the token's tenant.

**Writes.** Every write tool returns a proposal, not a result. Confirmation is a second, distinct tool call carrying the proposal identifier. Nothing posts on the first call. This is stated in the tool description and enforced in the handler.

**Tool result content is untrusted.** Anything returned from a tool can carry instructions. The server returns structured content with a fixed shape, never free text assembled from user-supplied data, and the assistant prompt states that tool output is data.

Full tool surface, schemas, error contract and deployment in MCP-06.

* * *

## 14. ADR-012 · Optimistic locking

**Status** Accepted · **Severity** Medium · **Traces to** TD-10, EC-01

### Context

Two users editing the same invoice: last write wins, silently. At nine users this is unlikely; with the accountant and the property manager both working a month-end it is not.

### Decision

A `version` integer on every mutable business row. Writes carry the expected version and compare-and-set. A mismatch returns a typed conflict error naming who changed it and when, so the UI can offer a reload rather than an apology.

Applies to `documents`, `payments`, `leases`, `cheques`, `employees`, `units`, `jobs`, `appointments`. Immutable rows — journals, journal lines, audit log — do not need it and must not get it.

* * *

## 15. ADR-013 · Error codes and internationalisation boundary

**Status** Accepted · **Severity** Medium · **Traces to** TD-16

### Context

`ServiceError` messages are user-facing English strings created in the domain layer. This couples domain to presentation and blocks Arabic entirely, which is a Phase 4 commitment.

### Decision

`ServiceError` carries a stable machine code and a structured params object. Message text lives in the presentation layer, keyed by code. The domain never contains a sentence a user reads.

```ts
throw new ServiceError('PAYMENT_OVER_ALLOCATED', {
  documentNumber, attempted, available
})
```

This is worth doing before Arabic rather than during it, because retrofitting message extraction across a codebase is substantially more expensive than not creating the problem.

* * *

## 16. ADR-014 · Field mobile architecture

**Status** Accepted, Phase 3 · **Severity** Medium · **Traces to** PD-01, D4, F-11

### Context

Kamal is a primary persona with no product. The schema supports him fully — jobs, visits, lines, photos, van stock as warehouses. The API is read-only, so the app is currently unbuildable.

### Decision

Expo, consuming a token-authenticated write API, with an offline-first local store.

**Conflict handling: lock-on-claim.** When a technician checks in to a job, the job locks for edits by anyone else until check-out or timeout. This eliminates the conflict class rather than resolving it. Of the three approaches observed in production field apps — automatic timestamp resolution, manual merge review, and lock-on-check-in — lock-on-claim is the only one that does not require building a merge interface, and for a team this size that is decisive.

**Cache window:** 14 days of assigned jobs, following the pattern of the strongest implementation for pre-scheduled work.

**Photos:** unlimited local capture, queued, uploaded on reconnect with a resumable protocol. Payloads of 45 to 120 MB per day are normal.

**Design constraints, from ruggedised UX research and non-negotiable:** tap targets 48 to 56 px because gloves reduce effective precision to 20 to 25 mm; primary status text at 7:1 contrast with a high-contrast mode as a first-class toggle, because consumer screens are unreadable at Dubai daylight levels; a three-tap ceiling for any essential action; critical controls in the bottom 40 percent of the screen because the other hand holds a tool.

**Job completion triggers the inter-business transfer** where the job's site is a property owned by another business unit. This is the wedge, executed automatically, at the moment the work finishes.

* * *

## 17. Data model additions

All additions are tenant-scoped and inherit row-level security from the generator. No new global tables.

### 17.1 New tables

| Table | Context | Purpose |
| --- | --- | --- |
| `legal_entities` | tenancy | TIN, trade licence, registration, fiscal year end. A business unit maps to one legal entity. Required for e-invoicing and per-entity corporate tax |
| `cash_points` | operations | A named physical cash location belonging to a business unit. Float level, responsible role |
| `cash_sessions` | operations | Open and close, opening float, counted amount, expected amount, variance, closer, acknowledger |
| `manual_entries` | accounting | The typed entry header: type, business unit, cash point, amount, date, note, photo reference, reversal link |
| `interco_balances` | accounting | Materialised reciprocal balance per ordered business-unit pair, with last-movement date for ageing |
| `interco_transfers` | accounting | Transfer header: paying and benefiting units, nature, pricing basis, arm's-length rate and basis, job reference |
| `entry_templates` | platform | Saved manual-entry shapes |
| `einvoice_documents` | documents | Per-document transmission state, MLS status, ASP reference, retry count, last error |
| `apportionment_settings` | accounting | Method in force, FTA approval reference, effective period |
| `vat_adjustments` | accounting | Annual wash-up computations and their postings |
| `job_runs` | platform | Scheduler run log: job, started, finished, outcome, counts |

### 17.2 Column additions

| Table | Column | Reason |
| --- | --- | --- |
| All mutable business tables | `version integer not null default 0` | ADR-012 |
| `business_units` | `legal_entity_id` | ADR-007 |
| `documents` | `einvoice_required boolean`, `einvoice_document_id` | ADR-007 |
| `cheques` | `partial_paid_amount numeric(18,4)`, extended status domain | FR-R03 |
| `metrics` registry | `freshness` | ADR-004 |
| `leases` | apportionment fields for mid-period renewal | EC-04 |

### 17.3 Concerns carried forward

| # | Concern | Action |
| --- | --- | --- |
| DB-1 | `journal_lines` unpartitioned | Partition plan documented in Phase 4; no action now at 28k rows |
| DB-2 | Unique indexes with nullable columns defeat `ON CONFLICT` | Audit every partial unique index; document the pattern; the stock-count bug was one instance and others remain |
| DB-3 | `kpi_snapshots` write-only | Resolved by ADR-004 |
| DB-4 | No optimistic locking | Resolved by ADR-012 |
| DB-5 | `exchange_rates` unused | Leave. Multi-currency is deferred and the table costs nothing |
| DB-6 | Push-based schema deployment | Resolved by ADR-002 |

* * *

## 18. API architecture

### 18.1 Current state

| Surface | Auth | Consumers |
| --- | --- | --- |
| Server actions, 14 | Session cookie | Web UI |
| `/api/v1`, 2 endpoints | Bearer token | External, future mobile |
| `/api/wps/[month]` | Session | Payroll download |

The token model is genuinely good: membership-bound, SHA-256 hashed at rest, scopes narrow and never widen the user's permissions, optional expiry, revocable. Keep it exactly as it is.

### 18.2 Required changes

| # | Change | Priority |
| --- | --- | --- |
| API-1 | Rate-limit `/api/v1/me`. It is currently unprotected while `/metrics` is limited, and it is the cheapest endpoint to enumerate tokens against | P0, TD-18 |
| API-2 | Uniform error envelope across every route: `{ error: { code, message, details } }`. Shapes currently differ between routes | P1 |
| API-3 | Cursor pagination on every list-returning endpoint | P1 |
| API-4 | Idempotency-Key header support, exposing what the service layer already does internally | P1 |
| API-5 | OpenAPI 3.1 specification, generated from the zod schemas rather than hand-written | P1 |
| API-6 | Write endpoints, scoped to what the technician app needs: job start, job complete, visit, photo upload, attendance | P2, Phase 3 |
| API-7 | CORS policy, explicitly configured rather than absent | P2 |
| API-8 | Webhooks for lifecycle events | P3 |

### 18.3 Write endpoint principles

When write endpoints ship in Phase 3, three rules:

1. Every write requires an `Idempotency-Key`. Not optional — the client is a phone on a bad connection.
2. Every write returns the full resulting object, not an acknowledgement, so an offline client can reconcile without a follow-up read.
3. Every write is versioned per ADR-012 and returns a typed conflict on mismatch.

* * *

## 19. Security architecture

Security is the strongest dimension of the project. This section changes little and closes what the audit found open.

### 19.1 Preserved

argon2id at m\=64 MiB, t\=3, p\=4 · TOTP MFA with recovery codes and an encrypted enrolment stash · HttpOnly session cookies with a session cap and revoke-all · database-backed rate limiting with silent lockout · RLS FORCEd, generated from schema, NOBYPASSRLS app role, build-gated · 122 permissions checked in services · AES-256-GCM field encryption with keyed HMAC blind index and online key rotation · HSTS with preload · per-request CSP nonce with strict script-src and `frame-ancestors 'none'` · parameterised queries throughout · append-only audit log · fail-closed config validation that refuses to boot on defaults · PDPL-shaped pseudonymising erasure that retains tax invoices.

### 19.2 Open items and their resolution

| # | Weakness | Resolution | Priority |
| --- | --- | --- | --- |
| S-1 | Public demo credentials on a public URL | Take the demo down or move it behind a gate before real data lands | P0 |
| S-2 | Neon owner role has BYPASSRLS | The config check compares exact string equality only. Strengthen to assert the connected role has `rolbypassrls = false` at boot, by querying `pg_roles`. This closes the gap that string comparison leaves | P0 |
| S-3 | `/api/v1/me` unrate-limited | API-1 | P0 |
| S-9 | No user management; offboarding is a database edit and sessions survive | FR-P01 | P0 |
| S-4 | Keys in environment variables | Acceptable at this stage. Revisit at Phase 4 | P2 |
| S-5 | Backups on local disk only | **Escalated.** Real estate records carry a fifteen-year retention obligation and should be held in the UAE unless otherwise permitted. Offsite encrypted replication with a retention policy and a documented restore drill is a Phase 0 item | **P0** |
| S-6 | Security event stream has no collector | ADR-009 | P1 |
| S-7 | No penetration test | Phase 4 | P2 |
| S-10 | No explicit CSRF token on server actions | Next provides origin checks. Verify explicitly and document | P2 |
| S-11 | `adminDb()` bypass in `api-auth.ts` | Necessary. Bound it to one lookup, add a dedicated test asserting it cannot return a row outside the resolved tenant | P1 |
| S-12 | No confirmation on financial writes | FR-P12 | P1 |

### 19.3 New surfaces

| Surface | Controls |
| --- | --- |
| Worker process | No inbound HTTP except `/health`. Same NOBYPASSRLS database role. Secrets from the same validated config module |
| MCP server | ADR-011. Resource server only, audience-bound tokens, permissions in services, proposal-then-confirm for writes, every invocation audited with resolved identity and parameters |
| Delivery provider | Caps, dedupe, approval gates and dry-run default already exist and must be honoured by the real implementation. A kill switch stops all outbound delivery |
| E-invoicing provider | Outbound only, to one allowlisted host. Credentials scoped to transmission. Documents logged with hashes |

### 19.4 PDPL procedural gaps

The technical controls are strong; the procedural ones do not exist. Required before real data: a record of processing activities; data processing agreements with Vercel, Neon, the process host, the delivery provider, the ASP and Anthropic; a documented 72-hour breach response; and a cross-border transfer position for a database in ap-southeast-1 rather than the UAE.

* * *

## 20. Performance and scalability

### 20.1 Current behaviour

| Load | Behaviour | Bottleneck |
| --- | --- | --- |
| 100 users, 1 tenant | Fine. \~150 ms metric sweep | None |
| 10,000 users, \~100 tenants | Degrades. Every page recomputes every metric | Connection count and repeated computation. Receivables already ships 284 KB uncached |
| 100,000+ | Fails without rework | Serverless connection exhaustion; unpartitioned journal lines; no replicas; RLS evaluation per row |

### 20.2 Required before real volume

| # | Action | ADR |
| --- | --- | --- |
| PF-1 | Snapshot-backed dashboards with tiered freshness | ADR-004 |
| PF-2 | Cursor pagination on every list | API-3 |
| PF-3 | Connection pooling discipline for serverless | Phase 4 |
| PF-4 | Partition `journal_lines` by period | Phase 4, documented now |
| PF-5 | Load test with k6 against realistic volume | Phase 4 |

### 20.3 Targets

| Metric | Target |
| --- | --- |
| Dashboard p95, warm | Under 500 ms |
| Dashboard p95, under load test | Under 800 ms |
| Any list page transfer | Under 100 KB |
| Manual cash entry, submit to confirmation | Under 1 second |
| Worker job, snapshot sweep | Under 60 seconds for all metrics across all business units |
| MCP tool call p95 | Under 1.5 seconds |

* * *

## 21. The decimal migration plan

ADR-001 is the highest-risk change in Phase 0 because it touches every service. This is the sequence.

1. **Land `packages/core/src/money` with tests first.** Nothing else changes. Property tests must pass before any service is touched.
2. **Change the driver boundary.** Confirm `postgres-js` returns `numeric` as a string and that nothing coerces it. Add a runtime assertion in development that throws if a money field arrives as a `number`.
3. **Migrate one service per commit**, in ascending order of risk: inventory, then purchasing, then sales, then payments, then credit notes. Credit notes last, because it holds the epsilon comparison and is the most sensitive.
4. **Run the full 227-check suite after every commit.** These checks are the safety net and this is what they are for.
5. **Then migrate `uae/`.** By this point the money primitives are proven, so the tax engines change representation only, not logic — and the new unit tests from ADR-008 are written against the migrated code, not the old.
6. **Add the lint rule last**, once no violations remain, and gate CI.

Rollback: each commit is independently revertible because the money module is additive until the lint rule lands.

* * *

## 22. Deployment topology

### 22.1 Target

| Concern | Current | Target |
| --- | --- | --- |
| Web | Vercel, root directory `apps/web` | Unchanged |
| Worker | None | Process host with Redis. Always-on, single instance with a lock |
| MCP | None | Same process host, separate service |
| Database | Neon, ap-southeast-1 | Unchanged. Confirm PDPL position |
| Roles | `neondb_owner` for migrations, `nexus_app` NOBYPASSRLS for the app | Unchanged. Add the boot-time `rolbypassrls` assertion |
| Environments | Production and preview | **Add staging.** No staging exists today and the migration gate needs somewhere to prove itself |
| Migrations | `db:push` at deploy | Explicit gated step, ADR-002 |
| Backups | Encrypted, local disk, verified restore drill | **Add offsite replication with retention.** S-5 |
| CI | Audit, build, 227 checks, briefing, backup drill | Add: unit tests, migration drift check, contrast check, table-count check, post-deploy smoke |
| Observability | None | ADR-009 |

### 22.2 Environment variables

Twelve exist across production and preview, correctly typed as sensitive. Additions: `REDIS_URL`, `SENTRY_DSN`, `DELIVERY_PROVIDER_*`, `EINVOICE_PROVIDER_*`, `MCP_OAUTH_ISSUER`, `MCP_RESOURCE_IDENTIFIER`, `ANTHROPIC_API_KEY`.

The existing fail-closed config module validates all of them. Extend it, and keep its refusal to boot in production when `APP_DATABASE_URL` equals `DATABASE_URL` — strengthened per S-2.

* * *

## 23. Dependency changes

| Dependency | Action | Reason |
| --- | --- | --- |
| `decimal.js` | Add | ADR-001 |
| `vitest`, `@vitest/coverage-v8`, `fast-check` | Add | ADR-008 |
| `@sentry/nextjs` | Add | ADR-009 |
| `@observablehq/plot` | Add | ADR-010 layer 1 |
| `echarts` | Add, lazily imported | ADR-010 layer 2 |
| `ioredis` | Add, worker only | ADR-003 |
| `@modelcontextprotocol/server` | Add, MCP only | ADR-011 |
| `@anthropic-ai/sdk` | **Keep** | The assistant is being funded. The audit's recommendation to remove it was conditional on the feature staying disabled |
| `recharts` | **Remove** | Barely used; superseded by ADR-010 |
| `lucide-react` | **Adopt properly** | Currently installed while the navigation uses Unicode glyphs. Pick one — icons carry poor screen-reader semantics as glyphs and are unclear at small sizes |
| `drizzle-kit` | Keep, change invocation | ADR-002 |

* * *

## 24. Technical debt register — disposition

Every item from the audit, with its resolution.

| # | Debt | Resolution | Phase |
| --- | --- | --- | --- |
| TD-01 | Money in IEEE-754 floats | ADR-001 | 0 |
| TD-02 | No unit-test framework | ADR-008 | 0 |
| TD-03 | Zero error boundaries and loading states | FR-P04 | 0 |
| TD-04 | `force-dynamic` everywhere | ADR-004 | 1 to 2 |
| TD-05 | No pagination | API-3, FR-P09 | 1 |
| TD-06 | Push-based schema deployment | ADR-002 | 0 |
| TD-07 | No observability | ADR-009 | 0 |
| TD-08 | Dead placeholder entries | Delete | 0 |
| TD-09 | Inline styles alongside Tailwind | PDD-04. Consolidate on Tailwind plus tokens | 2 |
| TD-10 | No optimistic locking | ADR-012 | 1 |
| TD-11 | README stale on table count | Fix, plus a CI count check | 0 |
| TD-12 | Anthropic SDK shipped while disabled | **Superseded.** The assistant is funded | — |
| TD-13 | Inconsistent icon strategy | Adopt lucide | 2 |
| TD-14 | `recharts` unused | Remove; ADR-010 | 2 |
| TD-15 | No scheduler | ADR-003 | 0 |
| TD-16 | English strings in the domain layer | ADR-013 | 2 |
| TD-17 | Session resolved from the database per request | Short-TTL cache with revocation awareness. Note the interaction with FR-P01: deactivation must invalidate the cache, not just the session row | 1 |
| TD-18 | `/me` unrate-limited | API-1 | 0 |
| TD-19 | No `/health`, no post-deploy smoke | ADR-009 | 0 |
| TD-20 | `kpi_snapshots` unmaintained | ADR-004 | 1 |

* * *

## 25. Risk register — technical

| # | Risk | Probability | Impact | Mitigation | Contingency |
| --- | --- | --- | --- | --- | --- |
| TR-1 | Decimal migration introduces a regression in a service | Medium | Critical | 227 checks as a net; one service per commit; property tests land first | Revert the commit; the module is additive until the lint rule |
| TR-2 | A tax engine is wrong and unit tests written against the same wrong assumption confirm it | Medium | Critical | Fixtures are hand-calculated and accountant-reviewed, not generated. Q-1 and Q-2 block the relevant fixtures | Voluntary disclosure; recompute affected periods |
| TR-3 | Migration to versioned migrations desynchronises an environment | Low | High | Baseline first; staging proves every migration; CI blocks drift | Restore from verified backup |
| TR-4 | Worker double-runs a job and duplicates notifications or postings | Medium | High | Redis lock; every job idempotent; dedupe keys already exist | Kill switch; audit and reverse |
| TR-5 | Inter-business balances diverge | Medium | High | Both legs in one transaction; scheduled reciprocity check; CI assertion | Reconciliation report; correcting entries |
| TR-6 | Snapshot and live metric disagree | Medium | Medium | Snapshots written by the same metric function; nightly sample comparison | Fall back to live; the tier is a per-metric flag |
| TR-7 | MCP token leakage grants data access | Low | Critical | Audience-bound tokens; scopes narrow only; permissions in services; short expiry; revocable | Revoke; rotate; audit the invocation log |
| TR-8 | The assistant proposes a plausible but wrong entry and it is confirmed | Medium | High | Proposal shows the plain-language effect before confirmation; ambiguity produces a question; every entry is reversible and audited | Reverse; review the conversation log |
| TR-9 | E-invoicing ASP integration slips past the deadline | Medium | High | Placeholder in Phase 1 makes the integration a configuration task; ASP appointed by Q1 2027 | Manual submission through the ASP portal while the integration completes |
| TR-10 | Retention obligation unmet when real property data lands | High if unaddressed | High | Offsite replication in Phase 0 | Do not migrate property data until it is in place |
| TR-11 | Key-person dependency | High | High | This document set is the mitigation | — |

* * *

## 26. Definition of technically done, Phase 0

- Zero float arithmetic on money anywhere in `packages/core`, enforced by lint in CI.
- `uae/`, `money/` and `rbac` have unit tests with hand-calculated, accountant-reviewed fixtures. Blocked fixtures are explicitly marked pending against Q-1 and Q-2, not silently omitted.
- Every route has an error boundary and a loading state. A single failing metric degrades one section.
- A production 500 alerts a human within five minutes. `/health` exists. A smoke test runs after every deploy.
- Every schema change is a reviewable committed migration. CI blocks drift. A staging environment exists and every migration passes through it.
- The scheduler runs automation, outbox, briefing and snapshots, with a run log visible in the product.
- A user can be deactivated from inside the product and every session they hold is invalidated immediately.
- `/api/v1/me` is rate-limited.
- Backups replicate offsite with a documented retention policy and a verified restore.
- The public demo is behind a gate or taken down.
- All 227-plus checks green, plus the new unit suite.
