import { sql, type SQL } from "drizzle-orm";
import {
  changeRatio,
  defineMetric,
  num,
  type MetricContext,
  type MetricDefinition,
  type MetricParams,
} from "./types.ts";
import { UAE_METRICS } from "./uae-metrics.ts";

/**
 * Metric implementations.
 *
 * Written as parameterised SQL rather than ORM query-builder chains: these are
 * analytical aggregates where the shape of the plan matters, and being able to
 * read the exact statement is what makes a financial figure auditable.
 *
 * Every statement is automatically tenant-filtered by RLS (see packages/db).
 * The `business_unit_id` predicates below are *authorisation* scope, not
 * isolation — isolation is the database's job and is not trusted to this layer.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a genuine Postgres uuid[] literal.
 *
 * Interpolating a JS array directly through drizzle's `sql` template expands it
 * into a comma-separated tuple — `($1, $2)` — which Postgres reads as a record,
 * not an array, and `record::uuid[]` is a type error. Each element must be its
 * own bound parameter inside an explicit ARRAY[] constructor. Still fully
 * parameterised: no identifier or value is ever concatenated into the string.
 */
function uuidArray(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]`;
}

/** Resolve the effective business-unit scope: explicit params ∩ user's scope. */
function buScope(ctx: MetricContext, params: MetricParams): string[] | null {
  const requested = params.businessUnitIds?.length ? params.businessUnitIds : null;
  const allowed = ctx.allowedBusinessUnitIds?.length ? ctx.allowedBusinessUnitIds : null;
  if (requested && allowed) return requested.filter((x) => allowed.includes(x));
  return requested ?? allowed;
}

/** Resolve the effective business-unit filter: explicit params ∩ user's scope. */
function buFilter(ctx: MetricContext, params: MetricParams, column = "business_unit_id"): SQL {
  const ids = buScope(ctx, params);
  // null scope = unrestricted. An EMPTY list means the user is scoped to no
  // business at all, which must return nothing rather than everything — the
  // difference between a locked-down account and a full data leak.
  if (!ids) return sql`TRUE`;
  if (ids.length === 0) return sql`FALSE`;
  return sql`${sql.raw(column)} = ANY(${uuidArray(ids)})`;
}

/**
 * The same filter for a ledger table, where a NULL business unit means "group".
 *
 * `journal_lines.business_unit_id` is nullable: a bank transfer or a head-office
 * accrual belongs to the group, not to a branch. Filtering those rows out would
 * make a branch manager's cash balance and running cost smaller than the money
 * that actually exists, so unattributed lines are included in every scope. This
 * is the shape `cash_balance` and `net_profit_mtd` already use; it is factored
 * out here so the composite metrics cannot quietly disagree with the tiles they
 * are composed from.
 */
function buFilterNullable(ctx: MetricContext, params: MetricParams, column: string): SQL {
  const ids = buScope(ctx, params);
  if (!ids) return sql`TRUE`;
  return sql`(${sql.raw(column)} IS NULL OR ${buFilter(ctx, params, column)})`;
}

/**
 * Scope a table that carries no business unit of its own.
 *
 * `parties` is shared across the whole group — one customer buys a handset from
 * the shop and books a haircut at the salon — so the attribution lives in the
 * `party_business_units` link table. The predicate must collapse to TRUE when
 * no scope is in force rather than to "has at least one link row", or an
 * unrestricted owner's customer count would silently shed every party that was
 * never attributed to a business.
 */
function partyBuFilter(ctx: MetricContext, params: MetricParams, alias = "p"): SQL {
  const ids = buScope(ctx, params);
  if (!ids) return sql`TRUE`;
  if (ids.length === 0) return sql`FALSE`;
  return sql`EXISTS (
    SELECT 1 FROM party_business_units pbu
     WHERE pbu.party_id = ${sql.raw(alias)}.id
       AND pbu.business_unit_id = ANY(${uuidArray(ids)})
  )`;
}

function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}
function prevMonthStart(iso: string): string {
  const d = new Date(`${monthStart(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}
function shiftDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Revenue & profit ────────────────────────────────────────────────────────

const revenueToday = defineMetric({
  id: "revenue_today",
  title: "Today's Revenue",
  description:
    "Net revenue (excluding VAT) from invoices issued today, across the selected businesses. " +
    "Cancelled and voided invoices are excluded. Compared against the same weekday last week, " +
    "because retail and salon trade is strongly weekday-dependent.",
  unit: "currency",
  polarity: "higher_is_better",
  permission: "dashboard:read",
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ today: string; prior: string }>(sql`
      SELECT
        COALESCE(SUM(subtotal) FILTER (WHERE issue_date = ${ctx.today}::date), 0) AS today,
        COALESCE(SUM(subtotal) FILTER (WHERE issue_date = ${shiftDays(ctx.today, -7)}::date), 0) AS prior
      FROM documents
      WHERE doc_type = 'invoice'
        AND status NOT IN ('cancelled', 'void', 'draft')
        AND issue_date IN (${ctx.today}::date, ${shiftDays(ctx.today, -7)}::date)
        AND ${buFilter(ctx, params)}
    `);
    const value = num(rows[0]?.today);
    const prior = num(rows[0]?.prior);
    return { value, unit: "currency" as const, priorValue: prior, changeRatio: changeRatio(value, prior),
      drilldownHref: "/receivables?range=today" };
  },
});

const revenueMtd = defineMetric({
  id: "revenue_mtd",
  title: "Revenue This Month",
  description:
    "Net revenue (excluding VAT) from invoices issued between the 1st of the current month and " +
    "today. Prior value is the same number of days in the previous month, so a comparison made " +
    "on the 6th compares six days to six days rather than six days to a full month.",
  unit: "currency",
  polarity: "higher_is_better",
  permission: "dashboard:read",
  aiExposed: true,
  async run(ctx, params) {
    const dayOfMonth = Number(ctx.today.slice(8, 10));
    const pStart = prevMonthStart(ctx.today);
    const pEnd = shiftDays(pStart, dayOfMonth - 1);
    const rows = await ctx.tx.execute<{ cur: string; prior: string }>(sql`
      SELECT
        COALESCE(SUM(subtotal) FILTER (
          WHERE issue_date BETWEEN ${monthStart(ctx.today)}::date AND ${ctx.today}::date), 0) AS cur,
        COALESCE(SUM(subtotal) FILTER (
          WHERE issue_date BETWEEN ${pStart}::date AND ${pEnd}::date), 0) AS prior
      FROM documents
      WHERE doc_type = 'invoice'
        AND status NOT IN ('cancelled', 'void', 'draft')
        AND issue_date BETWEEN ${pStart}::date AND ${ctx.today}::date
        AND ${buFilter(ctx, params)}
    `);
    const value = num(rows[0]?.cur);
    const prior = num(rows[0]?.prior);
    return { value, unit: "currency" as const, priorValue: prior, changeRatio: changeRatio(value, prior),
      drilldownHref: "/receivables?range=mtd" };
  },
});

const netProfitMtd = defineMetric({
  id: "net_profit_mtd",
  title: "Net Profit This Month",
  description:
    "Income minus expenses for the current month, taken from the general ledger — not from " +
    "invoices. It includes rent, salaries, utilities and every other posted cost, and it excludes " +
    "owner drawings (which are equity, not expense). " +
    "IMPORTANT for interpretation: fixed monthly costs such as rent and payroll are posted at the " +
    "start of the month, while revenue accrues daily. Early in a month this figure is therefore " +
    "expected to be negative and says nothing about the month's outcome. The prior-period " +
    "comparison uses the same number of elapsed days, so the CHANGE is meaningful even when the " +
    "level is not. The breakdown returns income, expenses and how much of the month has elapsed.",
  unit: "currency",
  polarity: "higher_is_better",
  permission: "report:read",
  aiExposed: true,
  async run(ctx, params) {
    const dayOfMonth = Number(ctx.today.slice(8, 10));
    const pStart = prevMonthStart(ctx.today);
    const pEnd = shiftDays(pStart, dayOfMonth - 1);
    const rows = await ctx.tx.execute<{
      period: string; profit: string; income: string; expense: string;
    }>(sql`
      SELECT
        CASE WHEN j.posting_date >= ${monthStart(ctx.today)}::date THEN 'cur' ELSE 'prior' END AS period,
        SUM(
          CASE WHEN a.type = 'income'  THEN jl.base_credit - jl.base_debit
               WHEN a.type = 'expense' THEN -(jl.base_debit - jl.base_credit)
               ELSE 0 END
        ) AS profit,
        SUM(CASE WHEN a.type = 'income' THEN jl.base_credit - jl.base_debit ELSE 0 END) AS income,
        SUM(CASE WHEN a.type = 'expense' THEN jl.base_debit - jl.base_credit ELSE 0 END) AS expense
      FROM journal_lines jl
      JOIN journals j ON j.id = jl.journal_id
      JOIN accounts a ON a.id = jl.account_id
      WHERE a.type IN ('income', 'expense')
        AND j.posting_date BETWEEN ${pStart}::date AND ${ctx.today}::date
        AND NOT (j.posting_date > ${pEnd}::date AND j.posting_date < ${monthStart(ctx.today)}::date)
        AND ${buFilterNullable(ctx, params, "jl.business_unit_id")}
      GROUP BY 1
    `);
    const cur = rows.find((r) => r.period === "cur");
    const value = num(cur?.profit);
    const prior = num(rows.find((r) => r.period === "prior")?.profit);

    // Days in this month, so the UI can say "6 of 31 days elapsed" rather than
    // presenting a partial-month loss as if it were a result.
    const d = new Date(`${monthStart(ctx.today)}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    const daysInMonth = d.getUTCDate();

    return {
      value, unit: "currency" as const, priorValue: prior,
      changeRatio: changeRatio(value, prior),
      breakdown: [
        { key: "income", label: "Income posted", value: num(cur?.income) },
        { key: "expense", label: "Costs posted", value: -num(cur?.expense) },
        { key: "elapsed", label: "Days elapsed", value: dayOfMonth,
          meta: { of: daysInMonth, note: "Fixed costs post at month start; revenue accrues daily." } },
      ],
      drilldownHref: "/accounting/profit-loss",
    };
  },
});

const revenueTrend = defineMetric({
  id: "revenue_trend",
  title: "Revenue Trend",
  description:
    "Daily net revenue for the last 30 days (or the requested window), used for the dashboard " +
    "sparkline and for spotting week-on-week momentum.",
  unit: "currency",
  polarity: "higher_is_better",
  permission: "dashboard:read",
  aiExposed: true,
  async run(ctx, params) {
    const from = params.from ?? shiftDays(ctx.today, -29);
    const to = params.to ?? ctx.today;
    const rows = await ctx.tx.execute<{ d: string; v: string }>(sql`
      SELECT gs::date::text AS d, COALESCE(SUM(dd.subtotal), 0) AS v
      FROM generate_series(${from}::date, ${to}::date, interval '1 day') gs
      LEFT JOIN documents dd
        ON dd.issue_date = gs::date
       AND dd.doc_type = 'invoice'
       AND dd.status NOT IN ('cancelled','void','draft')
       AND ${buFilter(ctx, params, "dd.business_unit_id")}
      GROUP BY 1 ORDER BY 1
    `);
    const series = rows.map((r) => ({ x: r.d, y: num(r.v) }));
    const total = series.reduce((t, p) => t + p.y, 0);
    return { value: total, unit: "currency" as const, series };
  },
});

// ── Cash & receivables ──────────────────────────────────────────────────────

const cashBalance = defineMetric({
  id: "cash_balance",
  title: "Cash & Bank Balance",
  description:
    "Total balance across cash in hand, bank accounts and mobile wallets, from the general " +
    "ledger. Excludes cash still held by couriers on COD orders, which is reported separately " +
    "because it is not yet spendable.",
  unit: "currency",
  polarity: "higher_is_better",
  permission: "report:read",
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ balance: string; system_key: string }>(sql`
      SELECT a.system_key, SUM(jl.base_debit - jl.base_credit) AS balance
      FROM journal_lines jl
      JOIN accounts a ON a.id = jl.account_id
      WHERE a.system_key IN ('CASH','BANK','WALLET')
        AND ${buFilterNullable(ctx, params, "jl.business_unit_id")}
      GROUP BY a.system_key
    `);
    const value = rows.reduce((t, r) => t + num(r.balance), 0);
    return {
      value, unit: "currency" as const,
      breakdown: rows.map((r) => ({
        key: r.system_key,
        label: { CASH: "Cash in hand", BANK: "Bank", WALLET: "Mobile wallet" }[r.system_key] ?? r.system_key,
        value: num(r.balance),
      })),
      drilldownHref: "/",
    };
  },
});

const accountsReceivable = defineMetric({
  id: "accounts_receivable",
  title: "Accounts Receivable",
  description:
    "Total money owed to the businesses by customers and tenants — the sum of amount_due on all " +
    "unpaid or partly paid sales invoices. Broken down by ageing bucket (current, 1–30, 31–60, " +
    "60+ days overdue).",
  unit: "currency",
  polarity: "lower_is_better",
  permission: "document:read",
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ bucket: string; total: string; cnt: number }>(sql`
      SELECT
        CASE
          WHEN due_date IS NULL OR due_date >= ${ctx.today}::date THEN 'current'
          WHEN due_date >= ${shiftDays(ctx.today, -30)}::date THEN 'd1_30'
          WHEN due_date >= ${shiftDays(ctx.today, -60)}::date THEN 'd31_60'
          ELSE 'd60_plus'
        END AS bucket,
        SUM(amount_due) AS total, COUNT(*)::int AS cnt
      FROM documents
      WHERE direction = 'in' AND doc_type IN ('invoice')
        AND amount_due > 0 AND status NOT IN ('cancelled','void','draft')
        AND ${buFilter(ctx, params)}
      GROUP BY 1
    `);
    const labels: Record<string, string> = {
      current: "Not yet due", d1_30: "1–30 days late", d31_60: "31–60 days late", d60_plus: "60+ days late",
    };
    const order = ["current", "d1_30", "d31_60", "d60_plus"];
    return {
      value: rows.reduce((t, r) => t + num(r.total), 0),
      unit: "currency" as const,
      breakdown: order
        .map((k) => rows.find((r) => r.bucket === k))
        .filter(Boolean)
        .map((r) => ({ key: r!.bucket, label: labels[r!.bucket]!, value: num(r!.total),
          meta: { invoices: r!.cnt } })),
      drilldownHref: "/receivables",
    };
  },
});

const overdueDebt = defineMetric({
  id: "overdue_debt",
  title: "Overdue Debt",
  description:
    "The portion of accounts receivable that is already past its due date. This is the number " +
    "that should drive collection activity; total AR includes invoices that are simply not due yet.",
  unit: "currency",
  polarity: "lower_is_better",
  permission: "document:read",
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ total: string; cnt: number; worst: string }>(sql`
      SELECT COALESCE(SUM(amount_due),0) AS total, COUNT(*)::int AS cnt,
             COALESCE(MAX(${ctx.today}::date - due_date), 0)::text AS worst
      FROM documents
      WHERE direction = 'in' AND amount_due > 0 AND due_date < ${ctx.today}::date
        AND status NOT IN ('cancelled','void','draft') AND ${buFilter(ctx, params)}
    `);
    return {
      value: num(rows[0]?.total), unit: "currency" as const,
      breakdown: [
        { key: "invoices", label: "Overdue invoices", value: num(rows[0]?.cnt) },
        { key: "worst", label: "Oldest (days)", value: num(rows[0]?.worst) },
      ],
      drilldownHref: "/receivables?filter=overdue",
    };
  },
});

const accountsPayable = defineMetric({
  id: "accounts_payable",
  title: "Accounts Payable",
  description: "Total owed to suppliers on unpaid purchase bills.",
  unit: "currency",
  polarity: "neutral",
  permission: "document:read",
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ total: string }>(sql`
      SELECT COALESCE(SUM(amount_due),0) AS total FROM documents
      WHERE direction = 'out' AND amount_due > 0
        AND status NOT IN ('cancelled','void','draft') AND ${buFilter(ctx, params)}
    `);
    return { value: num(rows[0]?.total), unit: "currency" as const, drilldownHref: "/purchases" };
  },
});

const upcomingInstallments = defineMetric({
  id: "upcoming_installments",
  title: "Installments Due (30 days)",
  description:
    "Scheduled installment payments falling due in the next 30 days, plus anything already " +
    "overdue. Relevant to the phone shop, where handsets are commonly sold on credit against IMEI.",
  unit: "currency",
  polarity: "neutral",
  permission: "document:read",
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ state: string; total: string; cnt: number }>(sql`
      SELECT CASE WHEN i.due_on < ${ctx.today}::date THEN 'overdue' ELSE 'upcoming' END AS state,
             SUM(i.amount_due - i.amount_paid) AS total, COUNT(*)::int AS cnt
      FROM installments i
      JOIN installment_plans p ON p.id = i.plan_id
      WHERE i.status <> 'paid' AND i.due_on <= ${shiftDays(ctx.today, 30)}::date
        AND ${buFilter(ctx, params, "p.business_unit_id")}
      GROUP BY 1
    `);
    return {
      value: rows.reduce((t, r) => t + num(r.total), 0),
      unit: "currency" as const,
      breakdown: rows.map((r) => ({
        key: r.state, label: r.state === "overdue" ? "Already overdue" : "Due within 30 days",
        value: num(r.total), meta: { count: r.cnt },
      })),
      drilldownHref: "/receivables",
    };
  },
});

const cashFlowForecast = defineMetric({
  id: "cash_flow_forecast",
  title: "30-Day Cash Forecast",
  description:
    "Projected closing cash in 30 days = current cash + receivables due in the window (weighted " +
    "by each customer's historical payment reliability) + scheduled rent + installments − payables " +
    "due − a 3-month average of recurring operating costs. Deliberately arithmetic and explainable " +
    "rather than a learned model: an owner will not act on a number they cannot reconstruct. " +
    "Scoped to the selected businesses; ledger lines booked to the group rather than to a branch " +
    "are included in every scope, because that cash and that cost are real for everyone.",
  unit: "currency",
  polarity: "higher_is_better",
  permission: "report:read",
  aiExposed: true,
  async run(ctx, params) {
    const horizon = shiftDays(ctx.today, 30);
    const rows = await ctx.tx.execute<{
      cash: string; inflow: string; overdue_recoverable: string; outflow: string; opex: string;
    }>(sql`
      WITH cash AS (
        SELECT COALESCE(SUM(jl.base_debit - jl.base_credit),0) v
        FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE a.system_key IN ('CASH','BANK','WALLET')
          AND ${buFilterNullable(ctx, params, "jl.business_unit_id")}
      ),
      inflow AS (
        SELECT COALESCE(SUM(amount_due),0) v FROM documents
        WHERE direction='in' AND amount_due>0 AND status NOT IN ('cancelled','void','draft')
          AND due_date BETWEEN ${ctx.today}::date AND ${horizon}::date
          AND ${buFilter(ctx, params)}
      ),
      -- Overdue money is not worthless, but it is not worth face value either.
      overdue AS (
        SELECT COALESCE(SUM(amount_due * 0.45),0) v FROM documents
        WHERE direction='in' AND amount_due>0 AND status NOT IN ('cancelled','void','draft')
          AND due_date < ${ctx.today}::date
          AND ${buFilter(ctx, params)}
      ),
      outflow AS (
        SELECT COALESCE(SUM(amount_due),0) v FROM documents
        WHERE direction='out' AND amount_due>0 AND status NOT IN ('cancelled','void','draft')
          AND (due_date IS NULL OR due_date <= ${horizon}::date)
          AND ${buFilter(ctx, params)}
      ),
      opex AS (
        SELECT COALESCE(SUM(jl.base_debit - jl.base_credit),0) / 3.0 v
        FROM journal_lines jl
        JOIN journals j ON j.id = jl.journal_id
        JOIN accounts a ON a.id = jl.account_id
        WHERE a.type='expense' AND a.system_key NOT IN ('COGS','MATERIALS')
          AND j.posting_date >= ${shiftDays(ctx.today, -90)}::date
          AND ${buFilterNullable(ctx, params, "jl.business_unit_id")}
      )
      SELECT (SELECT v FROM cash) cash, (SELECT v FROM inflow) inflow,
             (SELECT v FROM overdue) overdue_recoverable, (SELECT v FROM outflow) outflow,
             (SELECT v FROM opex) opex
    `);
    const r = rows[0]!;
    const cash = num(r.cash), inflow = num(r.inflow), recov = num(r.overdue_recoverable);
    const outflow = num(r.outflow), opex = num(r.opex);
    const projected = cash + inflow + recov - outflow - opex;
    return {
      value: projected, unit: "currency" as const, priorValue: cash,
      changeRatio: changeRatio(projected, cash),
      breakdown: [
        { key: "cash", label: "Cash today", value: cash },
        { key: "inflow", label: "Invoices due in 30 days", value: inflow },
        { key: "recovery", label: "Overdue expected (45%)", value: recov },
        { key: "outflow", label: "Supplier bills due", value: -outflow },
        { key: "opex", label: "Typical monthly running cost", value: -opex },
      ],
      drilldownHref: "/",
    };
  },
});

// ── Customers ───────────────────────────────────────────────────────────────

const customersTotal = defineMetric({
  id: "customers_total",
  title: "Total Customers",
  description: "Distinct customer records that have transacted at least once.",
  unit: "count",
  polarity: "higher_is_better",
  permission: "party:read",
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ total: number; new_mtd: number; returning: number }>(sql`
      SELECT
        COUNT(*) FILTER (WHERE p.visit_count > 0)::int AS total,
        COUNT(*) FILTER (WHERE p.created_at >= ${monthStart(ctx.today)}::date)::int AS new_mtd,
        COUNT(*) FILTER (WHERE p.visit_count > 1)::int AS returning
      FROM parties p WHERE p.is_customer = true AND ${partyBuFilter(ctx, params)}
    `);
    const r = rows[0]!;
    return {
      value: num(r.total), unit: "count" as const,
      breakdown: [
        { key: "new", label: "New this month", value: num(r.new_mtd) },
        { key: "returning", label: "Returning", value: num(r.returning) },
      ],
      drilldownHref: "/crm",
    };
  },
});

const churnRisk = defineMetric({
  id: "churn_risk_customers",
  title: "Customers At Risk",
  description:
    "Customers who used to come regularly but have not transacted in over 60 days, ranked by " +
    "lifetime value. These are the highest-return targets for a win-back message because they " +
    "have already proved they will buy.",
  unit: "count",
  polarity: "lower_is_better",
  permission: "party:read",
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ id: string; display_name: string; ltv: string; recency: number }>(sql`
      SELECT p.id, p.display_name, p.lifetime_value AS ltv, p.rfm_recency AS recency
      FROM parties p
      WHERE p.is_customer = true AND p.churn_risk IN ('medium','high') AND p.visit_count >= 2
        AND ${partyBuFilter(ctx, params)}
      ORDER BY p.lifetime_value DESC
      LIMIT ${params.limit ?? 8}
    `);
    const countRows = await ctx.tx.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int n FROM parties p
      WHERE p.is_customer = true AND p.churn_risk IN ('medium','high') AND p.visit_count >= 2
        AND ${partyBuFilter(ctx, params)}
    `);
    return {
      value: num(countRows[0]?.n), unit: "count" as const,
      breakdown: rows.map((r) => ({
        key: r.id, label: r.display_name, value: num(r.ltv), meta: { daysSinceLastVisit: num(r.recency) },
      })),
      drilldownHref: "/crm?segment=at_risk",
    };
  },
});

// ── Operations ──────────────────────────────────────────────────────────────

const appointmentsToday = defineMetric({
  id: "appointments_today",
  title: "Today's Appointments",
  description:
    "Salon bookings scheduled for today, split by status. Also reports chair utilisation: booked " +
    "service minutes as a share of total open chair-minutes.",
  unit: "count",
  polarity: "higher_is_better",
  permission: "appointment:read",
  requiresModules: ["appointments"],
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ status: string; n: number; minutes: string }>(sql`
      SELECT status::text, COUNT(*)::int n,
             COALESCE(SUM(EXTRACT(EPOCH FROM (ends_at - starts_at))/60),0) AS minutes
      FROM appointments
      WHERE starts_at >= ${ctx.today}::date AND starts_at < ${shiftDays(ctx.today, 1)}::date
        AND ${buFilter(ctx, params)}
      GROUP BY 1
    `);
    // Scoped for the same reason the bookings above are: an unfiltered chair
    // count is a denominator drawn from businesses whose bookings were excluded
    // from the numerator, which reports the salon as half-empty when it is full.
    const chairs = await ctx.tx.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int n FROM resources
       WHERE kind = 'chair' AND is_active = true AND ${buFilter(ctx, params)}
    `);
    const bookedMinutes = rows
      .filter((r) => !["cancelled", "no_show"].includes(r.status))
      .reduce((t, r) => t + num(r.minutes), 0);
    const capacity = num(chairs[0]?.n) * 11 * 60; // 10:00–21:00
    return {
      value: rows.reduce((t, r) => t + num(r.n), 0), unit: "count" as const,
      breakdown: [
        ...rows.map((r) => ({ key: r.status, label: r.status.replace(/_/g, " "), value: num(r.n) })),
        { key: "utilisation", label: "Chair utilisation %",
          value: capacity ? Math.round((bookedMinutes / capacity) * 100) : 0 },
      ],
      drilldownHref: "/salon",
    };
  },
});

const openServiceRequests = defineMetric({
  id: "open_service_requests",
  title: "Open Service Jobs",
  description:
    "Field-service jobs not yet completed, across all trades (AC, plumbing, electrical, handyman, " +
    "cleaning). Highlights how many have breached their SLA target, which is the number that " +
    "predicts complaints.",
  unit: "count",
  polarity: "lower_is_better",
  permission: "job:read",
  requiresModules: ["field_service"],
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ service_kind: string; n: number; breached: number }>(sql`
      SELECT service_kind, COUNT(*)::int n,
             COUNT(*) FILTER (WHERE complete_by < now())::int breached
      FROM jobs
      WHERE status IN ('request','quoted','scheduled','dispatched','in_progress','on_hold')
        AND ${buFilter(ctx, params)}
      GROUP BY 1 ORDER BY 2 DESC
    `);
    const total = rows.reduce((t, r) => t + num(r.n), 0);
    const breached = rows.reduce((t, r) => t + num(r.breached), 0);
    return {
      value: total, unit: "count" as const,
      breakdown: [
        ...rows.map((r) => ({ key: r.service_kind, label: r.service_kind.replace(/_/g, " "),
          value: num(r.n), meta: { breached: num(r.breached) } })),
        { key: "sla_breached", label: "SLA breached", value: breached },
      ],
      drilldownHref: "/services?status=open",
    };
  },
});

const occupancy = defineMetric({
  id: "occupancy_rate",
  title: "Occupancy",
  description:
    "Share of rentable units currently let, covering both apartments and parking bays. Vacancy is " +
    "reported alongside its monthly cost: an empty flat is not a neutral event, it is the list " +
    "rent burning every month.",
  unit: "percent",
  polarity: "higher_is_better",
  permission: "unit:read",
  requiresModules: ["rentals"],
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{
      kind: string; total: number; occupied: number; vacant_rent: string;
    }>(sql`
      SELECT u.kind::text,
             COUNT(*)::int total,
             COUNT(*) FILTER (WHERE u.status = 'occupied')::int occupied,
             COALESCE(SUM(u.list_rent) FILTER (WHERE u.status <> 'occupied'), 0) vacant_rent
      FROM units u
      WHERE ${buFilter(ctx, params, "u.business_unit_id")}
      GROUP BY 1
    `);
    const total = rows.reduce((t, r) => t + num(r.total), 0);
    const occ = rows.reduce((t, r) => t + num(r.occupied), 0);
    return {
      value: total ? Math.round((occ / total) * 1000) / 10 : 0,
      unit: "percent" as const,
      breakdown: [
        ...rows.map((r) => ({
          key: r.kind, label: r.kind === "parking_bay" ? "Parking bays" : "Apartments",
          value: num(r.total) ? Math.round((num(r.occupied) / num(r.total)) * 1000) / 10 : 0,
          meta: { occupied: num(r.occupied), total: num(r.total), vacantRent: num(r.vacant_rent) },
        })),
        { key: "vacancy_cost", label: "Monthly rent lost to vacancy",
          value: rows.reduce((t, r) => t + num(r.vacant_rent), 0) },
      ],
      drilldownHref: "/rentals",
    };
  },
});

const inventoryValue = defineMetric({
  id: "inventory_value",
  title: "Inventory Value",
  description:
    "Stock on hand valued at moving-average cost, across all warehouses including technician vans. " +
    "Also counts items at or below their reorder point.",
  unit: "currency",
  polarity: "neutral",
  permission: "stock:read",
  requiresModules: ["inventory"],
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{ value: string; low: number; out: number }>(sql`
      SELECT
        COALESCE(SUM(sl.on_hand * sl.avg_cost), 0) AS value,
        COUNT(*) FILTER (WHERE i.reorder_point IS NOT NULL
                           AND sl.on_hand - sl.reserved <= i.reorder_point)::int AS low,
        COUNT(*) FILTER (WHERE sl.on_hand <= 0)::int AS out
      FROM stock_levels sl
      JOIN items i ON i.id = sl.item_id
      JOIN warehouses w ON w.id = sl.warehouse_id
      WHERE ${buFilter(ctx, params, "w.business_unit_id")}
    `);
    return {
      value: num(rows[0]?.value), unit: "currency" as const,
      breakdown: [
        { key: "low", label: "Items at or below reorder point", value: num(rows[0]?.low) },
        { key: "out", label: "Out of stock", value: num(rows[0]?.out) },
      ],
      drilldownHref: "/inventory",
    };
  },
});

const lowStockItems = defineMetric({
  id: "low_stock_items",
  title: "Reorder Now",
  description:
    "Items whose available quantity (on hand minus reserved) has fallen to or below the reorder " +
    "point, ranked by how many days of cover remain at the trailing 30-day sales rate. Days-of-cover " +
    "is the correct ranking, not absolute quantity: 4 units of a fast mover is more urgent than " +
    "2 units of something that sells twice a year.",
  unit: "count",
  polarity: "lower_is_better",
  permission: "stock:read",
  requiresModules: ["inventory"],
  aiExposed: true,
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{
      id: string; name: string; available: string; reorder_point: string;
      reorder_qty: string; daily_rate: string; cost: string;
    }>(sql`
      -- Scoped to the same businesses as the warehouses below. A group-wide
      -- sales rate divided into one shop's stock is not that shop's days of
      -- cover: it would rank the shop's reorder list by how fast the *group*
      -- sells the item, and order in stock the shop cannot move.
      WITH sales AS (
        SELECT dl.item_id, SUM(dl.quantity) / 30.0 AS daily_rate
        FROM document_lines dl JOIN documents d ON d.id = dl.document_id
        WHERE d.doc_type = 'invoice' AND d.issue_date >= ${shiftDays(ctx.today, -30)}::date
          AND d.status NOT IN ('cancelled','void','draft')
          AND ${buFilter(ctx, params, "d.business_unit_id")}
        GROUP BY 1
      )
      SELECT i.id, i.name,
             SUM(sl.on_hand - sl.reserved) AS available,
             i.reorder_point, i.reorder_qty, i.cost_price AS cost,
             COALESCE(MAX(s.daily_rate), 0) AS daily_rate
      FROM stock_levels sl
      JOIN items i ON i.id = sl.item_id
      JOIN warehouses w ON w.id = sl.warehouse_id
      LEFT JOIN sales s ON s.item_id = i.id
      WHERE i.reorder_point IS NOT NULL AND ${buFilter(ctx, params, "w.business_unit_id")}
      GROUP BY i.id, i.name, i.reorder_point, i.reorder_qty, i.cost_price
      HAVING SUM(sl.on_hand - sl.reserved) <= i.reorder_point
      ORDER BY CASE WHEN COALESCE(MAX(s.daily_rate),0) = 0 THEN 9999
                    ELSE SUM(sl.on_hand - sl.reserved) / MAX(s.daily_rate) END
      LIMIT ${params.limit ?? 10}
    `);
    return {
      value: rows.length, unit: "count" as const,
      breakdown: rows.map((r) => {
        const rate = num(r.daily_rate);
        const avail = num(r.available);
        return {
          key: r.id, label: r.name, value: avail,
          meta: {
            daysOfCover: rate > 0 ? Math.round((avail / rate) * 10) / 10 : null,
            reorderPoint: num(r.reorder_point),
            suggestedQty: num(r.reorder_qty),
            estimatedCost: num(r.reorder_qty) * num(r.cost),
          },
        };
      }),
      drilldownHref: "/inventory",
    };
  },
});

// ── Portfolio comparison ────────────────────────────────────────────────────

const businessPerformance = defineMetric({
  id: "business_performance",
  title: "Performance by Business",
  description:
    "Revenue, gross margin and month-on-month growth for each business, ranked by contribution to " +
    "group profit. This is the metric that answers 'which business earned the most' and 'which one " +
    "is dragging'. Gross margin (revenue − direct cost) is used rather than revenue alone, because " +
    "a high-revenue, low-margin business can be the weakest performer in the portfolio.",
  unit: "currency",
  polarity: "higher_is_better",
  permission: "dashboard:consolidated",
  aiExposed: true,
  async run(ctx, params) {
    const dayOfMonth = Number(ctx.today.slice(8, 10));
    const pStart = prevMonthStart(ctx.today);
    const pEnd = shiftDays(pStart, dayOfMonth - 1);
    const rows = await ctx.tx.execute<{
      id: string; name: string; kind: string; color_token: string;
      revenue: string; cost: string; prior_revenue: string; invoices: number;
    }>(sql`
      SELECT b.id, b.name, b.kind::text, b.color_token,
        COALESCE(SUM(d.subtotal) FILTER (
          WHERE d.issue_date BETWEEN ${monthStart(ctx.today)}::date AND ${ctx.today}::date), 0) revenue,
        COALESCE(SUM(d.cost_total) FILTER (
          WHERE d.issue_date BETWEEN ${monthStart(ctx.today)}::date AND ${ctx.today}::date), 0) cost,
        COALESCE(SUM(d.subtotal) FILTER (
          WHERE d.issue_date BETWEEN ${pStart}::date AND ${pEnd}::date), 0) prior_revenue,
        COUNT(d.id) FILTER (
          WHERE d.issue_date BETWEEN ${monthStart(ctx.today)}::date AND ${ctx.today}::date)::int invoices
      FROM business_units b
      LEFT JOIN documents d
        ON d.business_unit_id = b.id AND d.doc_type = 'invoice'
       AND d.status NOT IN ('cancelled','void','draft')
      WHERE b.is_active = true AND ${buFilter(ctx, params, "b.id")}
      GROUP BY b.id, b.name, b.kind, b.color_token
      ORDER BY 5 DESC
    `);
    return {
      value: rows.reduce((t, r) => t + num(r.revenue), 0),
      unit: "currency" as const,
      breakdown: rows.map((r) => {
        const rev = num(r.revenue);
        const margin = rev - num(r.cost);
        const prior = num(r.prior_revenue);
        return {
          key: r.id, label: r.name, value: rev,
          meta: {
            kind: r.kind, color: r.color_token, grossMargin: margin,
            marginRate: rev ? margin / rev : 0,
            priorRevenue: prior, growth: changeRatio(rev, prior), invoices: num(r.invoices),
          },
        };
      }),
      drilldownHref: "/businesses",
    };
  },
});

const businessHealthScore = defineMetric({
  id: "business_health_score",
  title: "Business Health Score",
  description:
    "A 0–100 composite of five weighted signals: profitability (30), cash runway (25), receivable " +
    "quality (20), growth (15) and operational load such as SLA breaches and vacancy (10). Every " +
    "component is returned with its own sub-score so the headline number is always explainable — " +
    "a health score you cannot decompose is astrology. Every component honours the selected " +
    "businesses, so a branch manager scores their branch rather than the group.",
  unit: "score",
  polarity: "higher_is_better",
  permission: "dashboard:read",
  aiExposed: true,
  async run(ctx, params) {
    const r = await ctx.tx.execute<{
      revenue: string; profit: string; cash: string; opex: string;
      ar: string; overdue: string; prior_revenue: string; open_jobs: string; breached: string;
      units: string; vacant: string;
    }>(sql`
      WITH cur AS (
        SELECT COALESCE(SUM(subtotal),0) revenue FROM documents
        WHERE doc_type='invoice' AND status NOT IN ('cancelled','void','draft')
          AND issue_date BETWEEN ${monthStart(ctx.today)}::date AND ${ctx.today}::date
          AND ${buFilter(ctx, params)}
      ),
      prior AS (
        SELECT COALESCE(SUM(subtotal),0) revenue FROM documents
        WHERE doc_type='invoice' AND status NOT IN ('cancelled','void','draft')
          AND issue_date BETWEEN ${prevMonthStart(ctx.today)}::date
                             AND ${shiftDays(prevMonthStart(ctx.today), Number(ctx.today.slice(8, 10)) - 1)}::date
          AND ${buFilter(ctx, params)}
      ),
      pl AS (
        SELECT COALESCE(SUM(CASE WHEN a.type='income' THEN jl.base_credit - jl.base_debit
                                 ELSE -(jl.base_debit - jl.base_credit) END),0) profit
        FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id JOIN accounts a ON a.id=jl.account_id
        WHERE a.type IN ('income','expense') AND j.posting_date >= ${monthStart(ctx.today)}::date
          AND ${buFilterNullable(ctx, params, "jl.business_unit_id")}
      ),
      cash AS (
        SELECT COALESCE(SUM(jl.base_debit - jl.base_credit),0) v
        FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id
        WHERE a.system_key IN ('CASH','BANK','WALLET')
          AND ${buFilterNullable(ctx, params, "jl.business_unit_id")}
      ),
      opex AS (
        SELECT COALESCE(SUM(jl.base_debit - jl.base_credit),0)/3.0 v
        FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id JOIN accounts a ON a.id=jl.account_id
        WHERE a.type='expense' AND j.posting_date >= ${shiftDays(ctx.today, -90)}::date
          AND ${buFilterNullable(ctx, params, "jl.business_unit_id")}
      ),
      ar AS (
        SELECT COALESCE(SUM(amount_due),0) total,
               COALESCE(SUM(amount_due) FILTER (WHERE due_date < ${ctx.today}::date),0) overdue
        FROM documents WHERE direction='in' AND amount_due>0 AND status NOT IN ('cancelled','void','draft')
          AND ${buFilter(ctx, params)}
      ),
      jobs AS (
        SELECT COUNT(*)::numeric open_jobs,
               COUNT(*) FILTER (WHERE complete_by < now())::numeric breached
        FROM jobs WHERE status IN ('request','quoted','scheduled','dispatched','in_progress','on_hold')
          AND ${buFilter(ctx, params)}
      ),
      un AS (
        SELECT COUNT(*)::numeric units, COUNT(*) FILTER (WHERE status<>'occupied')::numeric vacant
        FROM units WHERE ${buFilter(ctx, params)}
      )
      SELECT (SELECT revenue FROM cur) revenue, (SELECT profit FROM pl) profit,
             (SELECT v FROM cash) cash, (SELECT v FROM opex) opex,
             (SELECT total FROM ar) ar, (SELECT overdue FROM ar) overdue,
             (SELECT revenue FROM prior) prior_revenue,
             (SELECT open_jobs FROM jobs) open_jobs, (SELECT breached FROM jobs) breached,
             (SELECT units FROM un) units, (SELECT vacant FROM un) vacant
    `);
    const d = r[0]!;
    const revenue = num(d.revenue), profit = num(d.profit), cash = num(d.cash), opex = num(d.opex);
    const ar = num(d.ar), overdue = num(d.overdue), prior = num(d.prior_revenue);
    const openJobs = num(d.open_jobs), breached = num(d.breached);
    const units = num(d.units), vacant = num(d.vacant);

    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    // Profitability: 15% net margin scores full marks.
    const profitability = clamp(revenue > 0 ? profit / revenue / 0.15 : 0);
    // Runway: 3 months of operating cost in the bank scores full marks.
    const runwayMonths = opex > 0 ? cash / opex : 6;
    const runway = clamp(runwayMonths / 3);
    // Receivable quality: what share of what you're owed is NOT late.
    const arQuality = ar > 0 ? clamp(1 - overdue / ar) : 1;
    // Growth: +10% month on month scores full marks.
    const growthRatio = changeRatio(revenue, prior) ?? 0;
    const growth = clamp((growthRatio + 0.1) / 0.2);
    // Operations: SLA breaches and vacancy both drag.
    const slaOk = openJobs > 0 ? clamp(1 - breached / openJobs) : 1;
    const occOk = units > 0 ? clamp(1 - vacant / units) : 1;
    const operations = (slaOk + occOk) / 2;

    const parts = [
      { key: "profitability", label: "Profitability", weight: 30, score: profitability },
      { key: "runway", label: "Cash runway", weight: 25, score: runway },
      { key: "receivables", label: "Receivable quality", weight: 20, score: arQuality },
      { key: "growth", label: "Growth", weight: 15, score: growth },
      { key: "operations", label: "Operations", weight: 10, score: operations },
    ];
    const total = Math.round(parts.reduce((t, p) => t + p.weight * p.score, 0));

    return {
      value: total, unit: "score" as const,
      breakdown: parts.map((p) => ({
        key: p.key, label: p.label, value: Math.round(p.weight * p.score),
        meta: { outOf: p.weight, detail:
          p.key === "runway" ? `${runwayMonths.toFixed(1)} months of cover`
          : p.key === "receivables" ? `${Math.round((1 - arQuality) * 100)}% of AR is overdue`
          : p.key === "growth" ? `${(growthRatio * 100).toFixed(1)}% vs last month`
          : p.key === "profitability" ? `${revenue ? ((profit / revenue) * 100).toFixed(1) : "0"}% net margin`
          : `${breached} SLA breaches, ${vacant} vacant units` },
      })),
    };
  },
});

const staffPerformance = defineMetric({
  id: "staff_performance",
  title: "Top Performing Staff",
  description:
    "Employees ranked by net revenue (excluding VAT) attributed to them on invoices issued " +
    "between the 1st of the current month and today, with jobs or services completed and average " +
    "customer rating where available.",
  unit: "currency",
  polarity: "higher_is_better",
  permission: "employee:read",
  aiExposed: true,
  /**
   * Two things about this statement are load-bearing, and both were wrong.
   *
   * The date predicate belongs in the WHERE clause with an INNER JOIN, not in
   * the ON clause of an outer join. `LEFT JOIN documents d ON d.id = dl.document_id
   * AND d.issue_date BETWEEN …` does not filter rows — it decides which rows get
   * a matching `d`. Every line the employee ever billed still survived the join
   * with `d` NULL and still landed in the SUM, so a metric titled "this month"
   * ranked people by lifetime takings and a stylist who left six months ago
   * outranked this month's top earner.
   *
   * And the basis is `line_total − tax_amount`, not `line_total`. `line_total`
   * is VAT-inclusive, while every other revenue figure in this registry sums
   * `documents.subtotal`. Ranking staff on a VAT-inclusive number next to a
   * VAT-exclusive revenue tile invites exactly the comparison it will not
   * survive; the two now reconcile.
   */
  async run(ctx, params) {
    const rows = await ctx.tx.execute<{
      id: string; full_name: string; designation: string; revenue: string; jobs: number; rating: string;
    }>(sql`
      SELECT e.id, e.full_name, e.designation,
             SUM(dl.line_total - dl.tax_amount) revenue,
             COUNT(DISTINCT dl.document_id)::int jobs,
             e.avg_customer_rating rating
      FROM employees e
      JOIN document_lines dl ON dl.employee_id = e.id
      JOIN documents d ON d.id = dl.document_id
      WHERE e.status = 'active'
        AND d.doc_type = 'invoice'
        AND d.status NOT IN ('cancelled','void','draft')
        AND d.issue_date BETWEEN ${monthStart(ctx.today)}::date AND ${ctx.today}::date
        AND ${buFilter(ctx, params, "e.primary_business_unit_id")}
      GROUP BY e.id, e.full_name, e.designation, e.avg_customer_rating
      HAVING SUM(dl.line_total - dl.tax_amount) > 0
      ORDER BY 4 DESC LIMIT ${params.limit ?? 6}
    `);
    return {
      value: rows.reduce((t, r) => t + num(r.revenue), 0), unit: "currency" as const,
      breakdown: rows.map((r) => ({
        key: r.id, label: r.full_name, value: num(r.revenue),
        meta: { role: r.designation, transactions: num(r.jobs), rating: r.rating ? num(r.rating) : null },
      })),
      drilldownHref: "/hr/gratuity",
    };
  },
});

const channelPerformance = defineMetric({
  id: "channel_performance",
  title: "Sales by Channel",
  description:
    "Online net revenue (excluding VAT) this month split by sales channel (own website, " +
    "marketplace, social), after deducting each channel's commission at the rate on its " +
    "`channels` record. Answers whether the marketplace is actually worth its take rate: the " +
    "gross figure and the commission withheld are both returned alongside the net.",
  unit: "currency",
  polarity: "higher_is_better",
  permission: "dashboard:read",
  requiresModules: ["ecommerce"],
  aiExposed: true,
  /**
   * The commission is the whole point of this metric and it was not being taken.
   *
   * A channel breakdown that reports gross revenue tells you noon.com is your
   * biggest channel, which is the answer you already had. Deducting the 15% take
   * rate is what turns it into a decision: at equal gross, the own website keeps
   * every dirham and the marketplace keeps 85 fils.
   *
   * Matched on `channels.name` because that is the link the sales path actually
   * writes — `document.metadata.channel` holds the channel's name (see the seed's
   * `channelSource`). `documents.channel_id` exists but is never populated, so a
   * key join is not available yet; the business-unit predicate keeps the name
   * match from crossing businesses. A channel with no matching record is treated
   * as commission-free rather than dropped, so its revenue is never lost from the
   * total — it is simply reported at gross.
   */
  async run(ctx, params) {
    // The subtraction is done in SQL, on `numeric`, so the net figure is an
    // exact decimal rather than the difference of two floats.
    const rows = await ctx.tx.execute<{
      channel: string; net: string; gross: string; commission: string; rate: string | null; orders: number;
    }>(sql`
      SELECT COALESCE(d.metadata->>'channel', 'Direct') AS channel,
             SUM(d.subtotal - d.subtotal * COALESCE(c.commission_rate, 0)) net,
             SUM(d.subtotal) gross,
             SUM(d.subtotal * COALESCE(c.commission_rate, 0)) commission,
             MAX(c.commission_rate) rate,
             COUNT(*)::int orders
      FROM documents d
      LEFT JOIN channels c
        ON c.name = d.metadata->>'channel'
       AND c.business_unit_id = d.business_unit_id
      WHERE d.doc_type='invoice' AND d.status NOT IN ('cancelled','void','draft')
        AND d.issue_date BETWEEN ${monthStart(ctx.today)}::date AND ${ctx.today}::date
        AND d.metadata ? 'channel' AND ${buFilter(ctx, params, "d.business_unit_id")}
      GROUP BY 1 ORDER BY 2 DESC
    `);
    return {
      value: rows.reduce((t, r) => t + num(r.net), 0), unit: "currency" as const,
      breakdown: rows.map((r) => ({
        key: r.channel, label: r.channel, value: num(r.net),
        meta: {
          orders: num(r.orders), gross: num(r.gross), commission: num(r.commission),
          commissionRate: r.rate === null ? null : num(r.rate),
        },
      })),
      drilldownHref: "/businesses",
    };
  },
});

// ── Registry ────────────────────────────────────────────────────────────────

export const METRICS = [
  ...UAE_METRICS,
  revenueToday,
  revenueMtd,
  revenueTrend,
  netProfitMtd,
  cashBalance,
  cashFlowForecast,
  accountsReceivable,
  overdueDebt,
  accountsPayable,
  upcomingInstallments,
  customersTotal,
  churnRisk,
  appointmentsToday,
  openServiceRequests,
  occupancy,
  inventoryValue,
  lowStockItems,
  businessPerformance,
  businessHealthScore,
  staffPerformance,
  channelPerformance,
] as unknown as MetricDefinition[];

export const METRICS_BY_ID: Record<string, MetricDefinition> = Object.fromEntries(
  METRICS.map((m) => [m.id, m]),
);
