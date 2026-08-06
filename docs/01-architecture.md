# 01 — Technical architecture

Every choice below is stated with the alternatives that were considered and the
reason the alternative lost. Where a decision is genuinely close, that is said.

---

## Decision summary

| Layer | Chosen | Runner-up | Deciding reason |
|---|---|---|---|
| Database | **PostgreSQL 16+** | MySQL, MongoDB | RLS, `numeric`, exclusion constraints, partial indexes, JSONB. An ERP is a relational, transactional, money-handling system — this is not a close call. |
| Multi-tenancy | **Shared schema + RLS** | Schema-per-tenant, DB-per-tenant | Isolation enforced by the database, one migration for all tenants, viable unit economics at thousands of tenants. |
| ORM | **Drizzle** | Prisma, TypeORM, raw SQL | SQL-shaped, zero runtime overhead, no separate engine binary, and it does not fight raw SQL where analytics needs it. |
| Backend | **Next.js Server Components + Server Actions** | Separate NestJS API | One deployable, no duplicated types, no network hop for page data. Trade-off accepted and mitigated — see §4. |
| Frontend | **React 19 / Next 16 App Router** | Remix, SvelteKit, Vue | Server Components genuinely suit a data-dense dashboard; largest hiring pool. |
| Styling | **Tailwind v4 + CSS custom properties** | CSS-in-JS, MUI, shadcn | Zero runtime cost; theming via CSS variables works in RSC without a provider. Component libraries impose a look and fight dense data UI. |
| Charts | **Server-rendered inline SVG** | Recharts, Chart.js, D3 | ~40 KB saved and no hydration for a sparkline. Reach for a library only when interactivity is required. |
| Auth | **Own session layer** | Auth.js, Better Auth, Clerk | Sessions are ~120 lines here and must interlock precisely with tenant context and RLS. Clerk also puts customer PII in a third party. |
| AI | **Claude via a semantic metric layer** | Text-to-SQL, RAG over schema | See [00-strategy §2](00-strategy.md). Accuracy is a context problem. |
| Jobs | **PostgreSQL-backed queue → Redis/BullMQ at scale** | SQS, Temporal, Inngest | You already have transactional Postgres; enqueue in the same transaction as the business change. No lost-job window. |
| Hosting | **Containers on a single region + managed Postgres** | Serverless-everything | Long-running jobs, connection pooling and predictable cost. |

---

## 1. Multi-tenancy: shared schema with Row-Level Security

**Alternatives**

| Model | Isolation | Ops cost at 5,000 tenants | Verdict |
|---|---|---|---|
| Database per tenant | Strongest | 5,000 migrations, 5,000 connection pools | Only for enterprise customers who contractually demand it |
| Schema per tenant | Strong | 5,000 × 85 = 425,000 tables; `pg_class` bloat, planner degradation | Rejected |
| **Shared schema + RLS** | Strong *if enforced correctly* | One migration, one pool | **Chosen** |

**The three ways teams get this wrong, and what is done here**

1. *The app connects as the table owner.* Owners silently ignore their own
   policies. → The app runs as `nexus_app`, which owns nothing and has
   `NOBYPASSRLS`, and every table is `FORCE ROW LEVEL SECURITY`.
2. *Tenant context set on connection acquisition.* A pooled connection outlives
   the request and leaks context into the next tenant's query. → `withTenant()`
   opens an explicit transaction and uses `SET LOCAL` via `set_config(..., true)`.
   There is no other sanctioned way to read tenant data.
   ([`packages/db/src/client.ts`](../packages/db/src/client.ts))
3. *A new table ships without a policy.* → Policies are **generated from the
   schema at runtime**, not hand-maintained, and `apply-rls.ts` fails the build if
   any table with `tenant_id` lacks enforced isolation.
   ([`packages/db/src/sql/rls.ts`](../packages/db/src/sql/rls.ts))

**Two subtleties found while building this**, both now covered by tests:

- `tenants` is tenant-scoped but its key column is `id`, not `tenant_id`, so the
  generator skipped it — leaving the tenant directory world-readable. Handled explicitly.
- Tables with a *nullable* `tenant_id` hold platform-global rows (the system role
  catalogue). `NULL = <uuid>` is `NULL`, so the strict policy hid every system
  role and broke login. They get `USING (... OR tenant_id IS NULL)` but
  `WITH CHECK (tenant_id = current)` — readable by all, writable by none. Without
  that asymmetry any tenant could mint itself a platform-wide role.

**Verified** by `scripts/e2e.mjs`: no context → 0 rows; wrong tenant → 0 rows;
cross-tenant `INSERT` → rejected; global-role creation → rejected.

**Cost of this choice:** every policy check needs `tenant_id` indexed (done
automatically), and a runaway query still affects neighbours. At the point a
customer demands physical isolation, the same schema deploys to a dedicated
database with no code change.

---

## 2. Why the money model looks the way it does

**`numeric(18,4)`, never float, never integer-cents.** Floats lose money.
Integer-cents break on 4-decimal unit prices, FX rates and percentage commission.
Values come back from the driver as strings and are never implicitly coerced.

**One polymorphic `documents` table**, not eight near-identical ones. Quotation →
sales order → invoice → credit note → PO → bill share 90% of their columns and
100% of their line shape. Conversion becomes `INSERT … SELECT`; AR and AP ageing
become the same query with a different sign; a new document type is an enum value
plus a posting rule. *Cost:* a few nullable columns and `docType` checks in
application code — much cheaper than eight tables drifting apart.

**Double-entry is real, and the database enforces it.** A deferred constraint
trigger rejects any unbalanced journal at commit, and a check constraint stops a
line being both debit and credit. This is deliberately *not* left to the service
layer: a bug in one code path must not be able to produce a ledger that does not
add up.

**Business unit is a dimension on the journal *line*, not the header.** That is
precisely what makes inter-company postings expressible as one balanced entry, and
a consolidated P&L a `GROUP BY` rather than a merge exercise.

**Posting rules are data** (`posting_rules`), not a switch statement — so a new
country's VAT treatment is configuration, and an accountant can inspect why a
journal looks the way it does.

---

## 3. Derived data: caches with an audit trail behind them

Three tables are deliberately denormalised, each with an immutable source of truth:

| Cache | Source of truth | Why |
|---|---|---|
| `stock_levels` | `stock_moves` (immutable) | A POS barcode scan must not sum a million-row ledger |
| `documents.amount_due` | `payment_allocations` | The most-read number in the product |
| `kpi_snapshots` | `documents` / `journal_lines` | Historical dashboard reads must not scan the ledger |

The rule: caches are written **in the same transaction** as their source, and can
always be rebuilt from it. You must be able to explain how you arrived at
today's stock quantity — the same discipline as the general ledger.

---

## 4. Application architecture — and the honest downside

Next.js Server Components read the database directly through the metric layer.
No REST/GraphQL hop for page data.

**What this buys:** no duplicated types, no serialisation boundary, no N+1 over
HTTP, and a full 21-metric dashboard in ~106 ms.

**The real downside:** the mobile app (Phase 4) cannot consume Server Components.
It needs an API. Mitigation, already structured for: all business logic lives in
`packages/core`, not in components. The Phase 4 API is a thin route-handler layer
over the *same* functions — so there is exactly one implementation of "what is
revenue", consumed by web, mobile and AI alike. Had the logic been written inside
components, that would be a rewrite.

```
apps/web  ─┐
apps/mobile┼─→ packages/core  (metrics, RBAC, posting rules, formatting)
worker    ─┘        │
                    └─→ packages/db  (schema, RLS, tenant-scoped client)
```

`packages/core` has **no** React and **no** Next imports. That is enforced by
review and is the boundary that keeps the mobile option open.

---

## 5. Performance

Measured on the seeded dataset (3,366 documents, 22,781 journal lines, MacBook,
local Postgres):

| Operation | Time |
|---|---|
| Full 21-metric sweep | **106 ms** |
| Dashboard page (SSR, cold) | ~290 ms |
| Dashboard page (warm) | ~90 ms |
| Receivables with drill-down | ~160 ms |
| Full seed (30k+ rows) | 3.9 s |

**A finding worth generalising:** the first run after seeding took **19 seconds**
for the ledger metrics — a 900× regression. Cause: a freshly `TRUNCATE`d table has
no statistics, so the planner assumed tiny tables and chose nested loops over a
22k-row join. `ANALYZE` fixed it completely. The same trap exists in production
after any bulk import or restore, so `ANALYZE` now runs as a post-load step. This
is the kind of thing that only shows up if you actually run the code.

**Scaling path, in the order it should be applied:**
1. `kpi_snapshots` already removes historical aggregation from the read path.
2. Redis cache on metric results keyed by `(tenant, metric, params, day)`.
3. Partition `journal_lines`, `stock_moves`, `audit_log` by month.
4. Read replica for reporting; primary for transactions.
5. Only then: shard by tenant.

Do not do 3–5 before measuring. The dashboard is 106 ms.

---

## 6. Frontend

- **Server Components by default.** The dashboard ships essentially zero
  application JavaScript — sparklines and bars are server-rendered SVG. This is
  not purism; it is the right call for mid-range Android hardware.
- **Suspense per band**, so headline numbers paint without waiting for the
  slowest widget.
- **`params`/`searchParams` are Promises** in Next 16 and are awaited.
- **Widget failure is isolated**: `runMetrics` catches per metric, so one broken
  query renders one degraded tile rather than a blank page.
- **Design system** in [`globals.css`](../apps/web/src/app/globals.css): OKLCH
  tokens, dark mode re-tuned rather than inverted, tabular figures everywhere,
  `prefers-reduced-motion` honoured, 44px touch targets.

Semantic-colour rule, worth calling out: a rise in overdue debt must never render
green. `Delta` takes a `polarity`, so "up" and "good" are separate concepts.

---

## 7. What is deliberately not built yet

Named so nobody mistakes absence for oversight:

- **Password hashing is a placeholder.** `verifyPassword()` accepts a known dev
  password. It is one isolated function; production swaps in argon2id
  (`m=64MB, t=3, p=4`). Isolating it was the point.
- **MFA** — columns exist (`mfa_secret_enc`, `recovery_codes_enc`), flow does not.
- **Automation execution** — rules are modelled and seeded; the runner is Phase 3.
- **Field-level encryption** for national IDs — Phase 3.
- **Rate limiting, CSP, security headers** — Phase 1 hardening, before any deploy.
