# 00 — Product strategy, and where the brief is wrong

This document exists because the brief asked to be challenged. Everything here is
a recommendation with reasoning, not a decision already taken on your behalf.

---

## 1. The brief lists eleven businesses. There are five domains.

This is the single highest-leverage decision in the whole project.

| Brief says | Actually is | Why |
|---|---|---|
| Plumbing, Electrical, Handyman, AC Maintenance, Cleaning, Construction-maintenance | **One field-service domain** | Identical lifecycle: customer → site → scheduled visit → technician + materials → invoice. They differ in service catalogue, required skill and default duration — all data, not code. |
| Apartment rental + Parking | **One space-rental domain** | A parking bay is a unit with a lease, a recurring charge, an occupancy rate and an overdue balance. Same table, different `unit_kind`. |
| Salon | **Appointment scheduling** | Generalises to clinics, studios, workshops. The bookable thing is a `resource`, not a "chair". |
| Mobile shop | **Retail with serialised stock** | The only genuinely distinctive requirement is IMEI/warranty tracking and installment sales. |
| E-commerce | **Retail with channels + fulfilment** | Shares the entire catalogue, stock and invoicing spine with the shop. |
| Construction (projects) | **Field service + budget/phase/retention** | A project is a budgeted container of jobs. |

**Impact:** roughly a 60% reduction in build surface, and — more importantly — every
improvement to scheduling, invoicing or dispatch benefits six businesses at once
instead of one. Building eleven modules would produce eleven mediocre ones.

This is implemented: `business_kind` has 7 values, and the six trades are one
`field_service` business with a `service_kind` column.

**Trade-off, stated honestly:** a unified model needs per-business configuration
(`business_unit_modules.settings`) and occasional conditional UI. That is a real
cost. It is far smaller than the cost of six divergent codebases.

---

## 2. Twenty-one AI features is a roadmap for shipping none of them

The brief lists 21 AI capabilities. Most are separate products. Built together
they will all be mediocre, and a mediocre "AI receptionist" answering your
customers is worse than no AI receptionist.

**Ranked by (value to this owner ÷ effort):**

| Rank | Capability | Why it wins |
|---|---|---|
| 1 | **Document/receipt ingestion** (photo → draft bill) | The owner runs on paper today. This is the difference between the system being accurate and being abandoned. It attacks the actual bottleneck: data entry. |
| 2 | **Daily executive briefing** | Zero user effort, arrives before the day starts, creates the habit that makes everything else valuable. |
| 3 | **Anomaly & threshold alerts** | Mostly deterministic (see below). Catches cash variance, margin collapse, SLA breach. |
| 4 | **Conversational analyst over the semantic layer** | High value, but only *after* 1–3 make the data trustworthy. |
| 5 | Everything else | Genuinely useful later. Not now. |

**The features I recommend you drop or defer indefinitely:**

- *AI receptionist / chatbot answering customers.* Customer-facing autonomous AI in
  a business where a mistake means a missed appointment or a wrong quote. The
  liability is real and the WhatsApp/telephony integration is a project of its own.
  Defer to Phase 5, behind human review.
- *AI fraud detection.* At your transaction volume this is statistically
  meaningless. What actually catches fraud here is the **cash drawer variance
  report** — deterministic, already in the schema (`cash_register_sessions`), and
  it works on day one.
- *AI social media planner / content generator.* A separate product. Buy it.

**Critical architectural point:** anomaly detection, reorder proposals, churn
scoring and lead scoring are **not** LLM problems. They are thresholds and simple
statistics. Using a language model for them makes them slower, more expensive,
non-deterministic and unexplainable. The LLM's job is to *explain and prioritise*
what deterministic code has already found.

### Why the AI has no SQL access

Anthropic's own data team published that their internal analytics agent went from
**21% to ~95% accuracy** — and the fix was not a better model or better SQL
generation. It was a curated semantic layer, because *accuracy is a context and
verification problem, not a code-generation problem*.

So this system has [`packages/core/src/metrics/`](../packages/core/src/metrics/):
21 typed, permission-checked, individually tested metric functions. The dashboard
calls them. The AI calls the same ones as tools. Consequences:

- The AI and the dashboard **cannot** disagree about what "revenue" means.
- Every AI claim carries the metric id and value that produced it → clickable evidence.
- The AI cannot invent a join, scan a huge table, or reach another tenant.
- Every metric is snapshot-testable against the deterministic seed → a real eval suite.

The cost: a question nobody anticipated cannot be answered. For a business owner
making decisions with money, "I don't have a metric for that" is strictly better
than a confident wrong number.

---

## 3. Requirements the brief is missing

These came out of modelling the actual portfolio. Several are more valuable than
things that *were* on the list.

### 3.1 Inter-company transactions — the killer feature nobody asked for
Your AC company services your own rental flat. Today that is invisible: the
property looks more profitable than it is, and the service company looks less
busy. **Implemented**: a job on an owned `unit` generates a real invoice from
Tech Services to Properties, one balanced journal with both sides, netting to zero
at group level. No off-the-shelf SMB ERP does this. ~18% of seeded jobs are internal.

### 3.2 Owner drawings vs. business expense
The #1 accounting mess in owner-operated groups: personal spending booked as
business cost, so every profit number is wrong. **Implemented**: account `3200
Owner Drawings` (equity, not expense), seeded with monthly withdrawals, excluded
from net profit.

### 3.3 Cash drawer control
Salon and parking are cash-first. If you cannot answer *"what should be in the
till, and what actually is"*, shrinkage is invisible. **Implemented**:
`cash_register_sessions` with expected vs counted vs variance, plus a variance
alert automation. Highest-ROI control in the accounting module; cost almost nothing.

### 3.4 Localisation is not cosmetic — and in the UAE it changes the data model
Configured for **Dubai mainland: AED, 5% VAT, calendar fiscal year, DED trade
licensing, Ejari registration**. Four rules are not formatting concerns at all:

- **Residential rent is VAT-exempt**, commercial rent and standalone parking are
  standard-rated. Exempt ≠ zero-rated: input VAT on the flats is *not*
  recoverable, so overheads must be apportioned. Over-claiming it is a routine
  FTA assessment finding.
- **Post-dated cheques** are how tenancies are actually settled. A year of
  cheques in the safe is neither cash nor a receivable, and there is no way to
  express that without a dedicated register.
- **End-of-service gratuity** accrues daily on *basic* salary only — which forces
  the salary to be stored as components, not one figure. AED 160,353 for this
  group today.
- **Compliance expiries** (trade licence, visa, Ejari) are operational: a lapsed
  licence freezes the company bank account.

Full detail and the code map: [05-uae-localisation.md](05-uae-localisation.md).

### 3.5 Migration from the current manual system
Not mentioned in the brief, and the single most common reason ERP rollouts fail.
Opening balances, current tenant leases, outstanding debts and stock counts must
come across on day one or the numbers are wrong and trust never forms. **This is
Phase 1 work, not an afterthought.** See [03-roadmap](03-roadmap.md).

### 3.6 Adoption is the real risk, not features
If the barber does not record the walk-in, revenue is wrong and every AI insight
built on it is garbage. Design consequences already applied:
- Walk-in appointments do **not** require creating a customer record first.
- Staff never need a login to be paid (`employees.user_id` is nullable).
- The mobile bottom nav has five items, not twenty.

### 3.7 Things also missing, worth flagging
- **Multi-currency**: modelled (`exchange_rates`, base amounts on every ledger line), not yet exercised.
- **Deferred revenue** on prepaid salon memberships and parking season tickets — modelled.
- **Retention** on construction contracts — modelled; commonly forgotten and it is real money.
- **Approval limits** — who may discount, void, or refund, and above what amount. Modelled as sensitive permissions; workflow is Phase 3.

---

## 4. "Production-ready" — an honest position

A complete ERP for eleven businesses is a multi-team, multi-quarter programme. Any
claim to have delivered that in one pass is false. What has actually been built is
a **production-grade foundation with real depth in the parts that are hardest to
retrofit**:

| Built and verified | Specified, not built |
|---|---|
| 86-table schema, all tenant-isolated | Most module UIs (Phase 2) |
| RLS proven to block cross-tenant read *and* write | AI chat interface (Phase 3) |
| Double-entry ledger, DB-enforced balance | Mobile app (Phase 4) |
| 26-metric semantic layer, ~150 ms full sweep | Automation execution engine (Phase 3) |
| RBAC with 16 roles + business scoping, verified per role | Payment gateway / WhatsApp integrations (Phase 3) |
| UAE VAT with input apportionment, gratuity, WPS, corporate tax | FTA filing / e-invoicing (Phase 3) |
| PDC cheque register with full lifecycle | Ejari and DEWA integrations (Phase 3) |
| Dashboard, portfolio and receivables screens | Bank feed import (Phase 3) |
| 40-check E2E suite, all passing | |

The things left are largely *additive*. The things done are the ones that are
ruinous to change later: tenancy, the ledger, the permission model, and the metric
definitions.

---

## 5. Recommended sequencing (and why this order)

1. **Migrate the real data first.** Before any new module. A system with fake
   numbers trains the owner to distrust it.
2. **One business end-to-end, not all seven half-way.** Start with the **salon**:
   highest transaction count, simplest domain, and daily use builds the habit.
3. **Then rentals**, because it is almost pure automation (rent runs and reminders)
   and delivers the clearest cash win for the least behaviour change.
4. **Then field service**, which needs the mobile app and is the biggest lift.
5. **AI last** — it is only as good as the data the first four produce.

See [03-roadmap.md](03-roadmap.md) for phases, acceptance criteria and risks.
