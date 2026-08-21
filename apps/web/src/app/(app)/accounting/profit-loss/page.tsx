import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { can, formatMoney, formatMoneyCompact, type ServiceContext } from "@nexus/core";
import {
  interBusinessEliminations,
  type InterBusinessEliminations,
} from "@nexus/core/services";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import { FilterTabs, PageHeader, StatStrip, TableEmpty } from "@/components/page";
import {
  ChartEmpty,
  SmallMultiples,
  Waterfall,
  concludeSmallMultiples,
  type BuColor,
  type Panel,
  type WaterfallStep,
} from "@/components/charts";

export const dynamic = "force-dynamic";

/** Postgres returns a RowList, but every filtered subset below is a plain
 *  array — so the helpers are typed against the row shape, not the query result. */
type PlLine = {
  code: string;
  name: string;
  type: string;
  system_key: string | null;
  amount: string;
};

/** Complete calendar months behind the small multiples. */
const TREND_MONTHS = 6;

/** "2026-02-01" → "February 2026", for prose about a month bucket. */
const monthLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/**
 * The eight identity hues the chart system will accept.
 *
 * Narrowed rather than cast: a `color_token` added to `business_units` without
 * a matching chart hue degrades to the neutral accent instead of painting
 * `var(--color-bu-teal)`, which resolves to nothing and draws an invisible line.
 */
const BU_HUES = new Set<string>([
  "violet", "blue", "cyan", "amber", "lime", "orange", "rose", "slate",
]);
const buHue = (token: string | null | undefined): BuColor | undefined =>
  token && BU_HUES.has(token) ? (token as BuColor) : undefined;

/**
 * Profit & loss, straight from the general ledger.
 *
 * Two things this does that a naive P&L does not:
 *
 *  1. Owner drawings are EXCLUDED. They are equity, not expense. Including them
 *     is the single most common reason an owner-operated group's profit figure
 *     is wrong, and it always understates profitability.
 *  2. It reports per business AND consolidated from the same query, because
 *     business unit is a dimension on the journal line rather than a separate
 *     chart of accounts.
 *
 * ── THE THREE FIGURES WF-05 §11 ASKS FOR ────────────────────────────────────
 * The statement is the record; the figures are the argument, and §11 is
 * specific about which argument each one makes.
 *
 *   REVENUE TO PROFIT   a cascade. Shows proportion, which a column of totals
 *                       cannot: the salary bar is visibly more than half the
 *                       income bar.
 *   THE PARTS AND WHOLE a bridge from the businesses' own profits to the
 *                       group's. §11's whole point — "the owner needs to see
 *                       that the group figure is smaller than the sum of the
 *                       parts and why, or he will not trust it."
 *   BY BUSINESS         small multiples on one shared scale. The only thing on
 *                       the screen that says which way each business is going.
 *
 * All three are server components. Nothing in `components/charts/` holds state
 * or measures the DOM — hover is `:hover`, the readout is a native `title`, the
 * table twin is a native `<details>` — so none of this needs `"use client"` and
 * the page's JavaScript cost is unchanged at approximately zero.
 */
export default async function ProfitLossPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await requireSession();
  const { period = "mtd" } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const monthStart = `${today.slice(0, 7)}-01`;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1;
  const quarterStart = `${today.slice(0, 4)}-${String(q).padStart(2, "0")}-01`;
  const from = period === "ytd" ? yearStart : period === "qtd" ? quarterStart : monthStart;
  const label = period === "ytd" ? "Year to date" : period === "qtd" ? "Quarter to date" : "Month to date";

  /**
   * The month spine behind the small multiples (WF-05 §11's six panels).
   *
   * COMPLETE calendar months, and deliberately NOT the period the tabs above
   * select. Two reasons, both about not stating a false finding:
   *
   *  1. A part-month bucket next to whole ones reads as a collapse.
   *     `concludeSmallMultiples` reports the movement from the first bucket to
   *     the last, so on the 6th of the month it would announce that every
   *     business is down when nothing has happened except a calendar.
   *  2. "Month to date" is one bucket. A trend needs at least two, and the
   *     panels are the only thing on this screen that answers "which way",
   *     which the statement above — a single column of totals — cannot.
   *
   * The note under the chart says so out loud rather than letting the reader
   * assume the panels follow the tab they just clicked.
   */
  const currentMonthStart = `${today.slice(0, 7)}-01`;
  const months: string[] = [];
  for (let i = TREND_MONTHS; i >= 1; i--) {
    const d = new Date(`${currentMonthStart}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 10));
  }

  // The consolidation figures need `report:read`, which is also what gates this
  // route. A caller who reached the page without it gets the region ABSENT
  // rather than an error card (WF-05 §0's permission-denied state), and the
  // service is not called at all rather than called and allowed to throw.
  const mayConsolidate = can(session.principal, "report:read");

  const { lines, byBusiness, monthly, eliminations } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const lines = await tx.execute<PlLine>(sql`
        SELECT a.code, a.name, a.type::text, a.system_key,
               SUM(CASE WHEN a.type = 'income' THEN jl.base_credit - jl.base_debit
                        ELSE jl.base_debit - jl.base_credit END) AS amount
          FROM journal_lines jl
          JOIN journals j ON j.id = jl.journal_id
          JOIN accounts a ON a.id = jl.account_id
         WHERE a.type IN ('income','expense')
           AND j.posting_date BETWEEN ${from}::date AND ${today}::date
         GROUP BY a.code, a.name, a.type, a.system_key
        HAVING SUM(CASE WHEN a.type = 'income' THEN jl.base_credit - jl.base_debit
                        ELSE jl.base_debit - jl.base_credit END) <> 0
         ORDER BY a.code
      `);

      const byBusiness = await tx.execute<{
        name: string | null; color_token: string | null; income: string; expense: string;
      }>(sql`
        SELECT b.name, b.color_token,
               COALESCE(SUM(jl.base_credit - jl.base_debit) FILTER (WHERE a.type = 'income'), 0) AS income,
               COALESCE(SUM(jl.base_debit - jl.base_credit) FILTER (WHERE a.type = 'expense'), 0) AS expense
          FROM journal_lines jl
          JOIN journals j ON j.id = jl.journal_id
          JOIN accounts a ON a.id = jl.account_id
          LEFT JOIN business_units b ON b.id = jl.business_unit_id
         WHERE a.type IN ('income','expense')
           AND j.posting_date BETWEEN ${from}::date AND ${today}::date
         GROUP BY b.name, b.color_token
         ORDER BY 3 DESC
      `);

      // Per-business monthly profit for the panels. Same expression as the
      // statement above — income credit-side, expense debit-side — so a panel
      // and a table row for the same window cannot disagree.
      const monthly = await tx.execute<{
        name: string; color_token: string; sort_order: number; m: string; profit: string;
      }>(sql`
        SELECT b.name, b.color_token, b.sort_order,
               to_char(date_trunc('month', j.posting_date), 'YYYY-MM-DD') AS m,
               SUM(CASE WHEN a.type = 'income' THEN jl.base_credit - jl.base_debit
                        ELSE -(jl.base_debit - jl.base_credit) END)::text AS profit
          FROM journal_lines jl
          JOIN journals j ON j.id = jl.journal_id
          JOIN accounts a ON a.id = jl.account_id
          JOIN business_units b ON b.id = jl.business_unit_id
         WHERE a.type IN ('income', 'expense')
           AND j.posting_date >= ${months[0]}::date
           AND j.posting_date < ${currentMonthStart}::date
         GROUP BY b.name, b.color_token, b.sort_order, 4
         ORDER BY b.sort_order, 4
      `);

      const eliminations: InterBusinessEliminations | null = mayConsolidate
        ? await interBusinessEliminations(
            {
              tx,
              tenantId: session.tenantId,
              principal: session.principal,
              today,
              baseCurrency: ccy,
            } satisfies ServiceContext,
            { from, to: today },
          )
        : null;

      return { lines, byBusiness, monthly, eliminations };
    },
  );

  const income = lines.filter((l) => l.type === "income");
  const cogs = lines.filter(
    (l) => l.type === "expense" && ["COGS", "MATERIALS", "SUBCONTRACTOR"].includes(l.system_key ?? ""),
  );
  const opex = lines.filter(
    (l) => l.type === "expense" && !["COGS", "MATERIALS", "SUBCONTRACTOR"].includes(l.system_key ?? ""),
  );

  const sum = (rows: PlLine[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
  const totalIncome = sum(income);
  const totalCogs = sum(cogs);
  const grossProfit = totalIncome - totalCogs;
  const totalOpex = sum(opex);
  const netProfit = grossProfit - totalOpex;

  const fmt = (v: number) => formatMoney(v, ccy, 0);
  const fmtCompact = (v: number) => formatMoneyCompact(v, ccy);

  /**
   * THE REVENUE-TO-PROFIT CASCADE (WF-05 §11's first figure).
   *
   * Income anchored at the top, every cost floating down from it, profit
   * anchored at the bottom. The statement below says the same thing in figures
   * and says it better for an accountant checking a number; what it cannot do
   * is show PROPORTION. "Salaries 79,200" against "income 132,615" is a
   * subtraction the reader has to perform, and a cascade performs it for them:
   * the bar for salaries is visibly more than half the income bar, which is the
   * finding.
   *
   * Every cost line is passed individually and `rollUpSteps` inside the
   * component folds the tail into one signed "Other" — PDD §7.3 caps a bridge
   * at eight steps, and that rule lives in the component precisely so a caller
   * mapping a general ledger straight into the props cannot break it.
   *
   * Zero-valued lines are dropped: the query already excludes accounts that net
   * to zero over the period, but a line that nets to zero across two postings
   * would draw a labelled bar of no height.
   */
  const bridgeSteps: WaterfallStep[] = [
    { label: "Income", value: totalIncome, kind: "total" },
    ...(totalCogs !== 0
      ? [{ label: "Direct costs", value: -totalCogs, kind: "delta" as const }]
      : []),
    ...opex
      .filter((l) => Number(l.amount) !== 0)
      .map((l) => ({ label: l.name, value: -Number(l.amount), kind: "delta" as const })),
    { label: "Net profit", value: netProfit, kind: "total" },
  ];

  /**
   * Why this conclusion is hand-composed rather than `concludeWaterfall`.
   *
   * `conclude.ts` has one waterfall generator and it is written for the OTHER
   * kind of bridge — a period-over-period one, where the opening and closing
   * anchors are the same quantity at two different times, so "profit fell X"
   * is true. A revenue-to-profit cascade is not that. Its anchors are two
   * DIFFERENT quantities, and the generator would render "Income fell AED
   * 185,411, from AED 132,615 to −AED 52,796" — which asserts that income fell
   * when income did no such thing; costs consumed it. A conclusion that is
   * wrong is worse than none, so this one is written here.
   *
   * It is still generated from the data at render time, which is the rule that
   * actually matters: every figure and the named line come out of the query
   * above, so when the ledger moves the sentence moves with it. PDD §7.7 allows
   * exactly this — "a page with real domain knowledge is free to write a better
   * sentence by hand". A `concludeCascade` generator belongs beside the other
   * seven in `conclude.ts`; that directory is not this screen's to change.
   */
  const totalCost = totalCogs + totalOpex;
  const biggestCost = lines
    .filter((l) => l.type === "expense")
    .reduce<PlLine | null>((m, l) => (m === null || Number(l.amount) > Number(m.amount) ? l : m), null);
  const outcome =
    netProfit >= 0 ? `${fmt(netProfit)} of net profit` : `a net loss of ${fmt(-netProfit)}`;
  const bridgeConclusion =
    lines.length === 0
      ? `Nothing has been posted to income or expenses between ${from} and ${today}.`
      : `${fmt(totalIncome)} of income became ${outcome} after ${fmt(totalCost)} of cost.` +
        (biggestCost
          ? ` The largest single line is ${biggestCost.name} at ${fmt(Number(biggestCost.amount))}` +
            (totalIncome > 0
              ? ` — ${((Number(biggestCost.amount) / totalIncome) * 100).toFixed(1)}% of income.`
              : ".")
          : "");

  /**
   * PARTS AND WHOLE — WF-05 §11's core argument.
   *
   * "The elimination is shown, not just its effect. The owner needs to see that
   * the group figure is smaller than the sum of the parts and why, or he will
   * not trust it."
   *
   * On this screen the gap is NOT the inter-company elimination, and saying so
   * precisely is the point. `interBusinessEliminations` documents which figure
   * a screen must subtract: `profitElimination` is what a sum of DOCUMENT-
   * derived business results overstates the group by. This page is built from
   * the ledger, where the internal legs have already netted against each other,
   * so subtracting it here would be double-counting — the service's own
   * docblock says "a P&L built from the ledger must not".
   *
   * What does separate the parts from the whole here is `unattributedProfit`:
   * payroll, gratuity accrual and visa fees are posted with no business
   * dimension, so they are in the group's profit and in none of the businesses'.
   * That is a real and large number, it is the reason the businesses look
   * collectively profitable while the group does not, and it was previously
   * only visible as an unexplained "Group-level" row at the bottom of a table.
   *
   * The internal trade is still stated — it inflates the revenue and the cost
   * lines above even where it cancels in profit — but in the footnote, because
   * it is not what makes these two totals differ.
   */
  const parts = eliminations
    ? eliminations.byBusiness.reduce((t, b) => t + Number(b.profit), 0)
    : 0;
  const unattributed = Number(eliminations?.unattributedProfit ?? 0);
  const groupProfit = Number(eliminations?.groupProfit ?? 0);
  const revenueElimination = Number(eliminations?.revenueElimination ?? 0);
  const profitElimination = Number(eliminations?.profitElimination ?? 0);
  const irrecoverableVat = Number(eliminations?.irrecoverableVat ?? 0);

  const partsSteps: WaterfallStep[] = [
    {
      label: `The ${eliminations?.byBusiness.length ?? 0} businesses together`,
      value: parts,
      kind: "total",
    },
    ...(Math.abs(unattributed) >= 0.005
      ? [
          {
            label: "Group-level costs, on no business",
            value: unattributed,
            kind: "delta" as const,
          },
        ]
      : []),
    { label: "Group net profit", value: groupProfit, kind: "total" },
  ];

  const partsConclusion =
    unattributed < 0
      ? `Your ${eliminations?.byBusiness.length ?? 0} businesses made ${fmt(parts)} between them, but the group made ${fmt(groupProfit)} — ${fmt(-unattributed)} of payroll, gratuity and visa cost is carried by the group and by none of them.`
      : unattributed > 0
        ? `Your ${eliminations?.byBusiness.length ?? 0} businesses made ${fmt(parts)} between them and the group made ${fmt(groupProfit)}: ${fmt(unattributed)} of income sits outside every business, which is a posting to chase rather than a result.`
        : `Every dirham of the group's ${fmt(groupProfit)} is attributed to a business — the parts and the whole agree exactly.`;

  /**
   * The consolidated figure and this page's own net profit are the same
   * quantity computed twice, by this file's SQL and by the service's. They must
   * agree. If they ever do not, say so on the screen rather than showing two
   * numbers and letting the reader find the contradiction — a reconciliation
   * that silently fails is the failure mode that makes a consolidated figure
   * untrustworthy in the first place.
   */
  const consolidationDrift = eliminations ? groupProfit - netProfit : 0;

  // Per-business monthly profit, zero-filled against the shared spine. A month
  // a business posted nothing is a real zero; dropping it would draw a straight
  // line across the hole and hide the quiet month.
  const byBu = new Map<string, { name: string; color: string | null; at: Map<string, number> }>();
  for (const r of monthly) {
    const entry = byBu.get(r.name) ?? { name: r.name, color: r.color_token, at: new Map() };
    entry.at.set(r.m, Number(r.profit));
    byBu.set(r.name, entry);
  }
  const panels: Panel[] = [...byBu.values()].map((b) => ({
    label: b.name,
    bu: buHue(b.color),
    points: months.map((m) => ({ x: m, y: b.at.get(m) ?? 0 })),
  }));

  const Section = ({
    title,
    rows,
    total,
    tone,
  }: {
    title: string;
    rows: PlLine[];
    total: number;
    tone?: "positive" | "negative";
  }) => (
    <>
      <tr style={{ background: "var(--surface-2)" }}>
        <td colSpan={3} className="px-4 py-1.5 label font-semibold">
          {title}
        </td>
      </tr>
      {rows.map((l) => (
        <tr key={l.code} className="border-b last:border-0" style={{ borderColor: "var(--border)" }}>
          <td className="px-4 py-1.5 tnum text-subtle w-16">{l.code}</td>
          <td className="px-4 py-1.5">{l.name}</td>
          <td className="px-4 py-1.5 text-right tnum">{formatMoney(Number(l.amount), ccy, 2)}</td>
        </tr>
      ))}
      <tr className="border-b" style={{ borderColor: "var(--border-strong)" }}>
        <td />
        <td className="px-4 py-1.5 text-xs font-semibold">Total {title.toLowerCase()}</td>
        <td
          className="px-4 py-1.5 text-right tnum font-semibold"
          style={{ color: tone === "positive" ? "var(--positive)" : tone === "negative" ? "var(--negative)" : undefined }}
        >
          {formatMoney(total, ccy, 2)}
        </td>
      </tr>
    </>
  );

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1200px] mx-auto space-y-5">
      <PageHeader
        title="Profit & loss"
        subtitle={`${label} · ${from} to ${today} · from the general ledger`}
        actions={
          <FilterTabs
            basePath="/accounting/profit-loss"
            param="period"
            active={period}
            options={[
              { key: "mtd", label: "Month" },
              { key: "qtd", label: "Quarter" },
              { key: "ytd", label: "Year" },
            ]}
          />
        }
      />

      <StatStrip
        stats={[
          { label: "Income", value: formatMoney(totalIncome, ccy, 0), tone: "positive" },
          { label: "Direct costs", value: formatMoney(totalCogs, ccy, 0) },
          {
            label: "Gross profit",
            value: formatMoney(grossProfit, ccy, 0),
            hint: totalIncome ? `${((grossProfit / totalIncome) * 100).toFixed(1)}% margin` : undefined,
          },
          { label: "Operating costs", value: formatMoney(totalOpex, ccy, 0) },
          {
            label: "Net profit",
            value: formatMoney(netProfit, ccy, 0),
            tone: netProfit >= 0 ? "positive" : "negative",
            hint: totalIncome ? `${((netProfit / totalIncome) * 100).toFixed(1)}% net margin` : undefined,
          },
        ]}
      />

      {lines.length === 0 ? (
        <ChartEmpty
          title="Revenue to profit"
          conclusion={bridgeConclusion}
          note={`${label} · ${from} to ${today}`}
        />
      ) : (
        <Waterfall
          title="Revenue to profit"
          steps={bridgeSteps}
          format={fmt}
          conclusion={bridgeConclusion}
          note={`${label} · ${from} to ${today} · every cost line, largest first, with the tail rolled up`}
          footnote={
            revenueElimination > 0
              ? `Income and cost above each include ${fmt(revenueElimination)} of trade between your own businesses. It cancels in profit, so the closing figure is right, but both the top line and the cost line are that much larger than the group's dealings with the outside world.`
              : undefined
          }
        />
      )}

      <Card>
        <CardHeader
          title="Statement"
          subtitle="Owner drawings are excluded — they are equity, not expense"
        />
        {lines.length === 0 ? (
          <TableEmpty title="No postings in this period" detail="Nothing has been posted yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <tbody>
                <Section title="Income" rows={income} total={totalIncome} tone="positive" />
                {cogs.length > 0 && <Section title="Direct costs" rows={cogs} total={totalCogs} />}
                <tr style={{ background: "var(--surface-2)" }}>
                  <td />
                  <td className="px-4 py-2 text-xs font-semibold">Gross profit</td>
                  <td className="px-4 py-2 text-right tnum font-semibold">
                    {formatMoney(grossProfit, ccy, 2)}
                  </td>
                </tr>
                <Section title="Operating costs" rows={opex} total={totalOpex} />
                <tr style={{ background: "var(--accent-soft)" }}>
                  <td />
                  <td className="px-4 py-2.5 text-sm font-semibold">Net profit</td>
                  <td
                    className="px-4 py-2.5 text-right tnum text-sm font-semibold"
                    style={{ color: netProfit >= 0 ? "var(--positive)" : "var(--negative)" }}
                  >
                    {formatMoney(netProfit, ccy, 2)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {eliminations && (
        <Waterfall
          title="The parts and the whole"
          steps={partsSteps}
          format={fmt}
          maxSteps={4}
          conclusion={partsConclusion}
          note={`${label} · ${from} to ${today} · every business's ledger profit, and what sits outside all of them`}
          footnote={
            <>
              {revenueElimination > 0 && (
                <p>
                  {fmt(revenueElimination)} of revenue and {fmt(revenueElimination)} of cost in the
                  period is trade between your own businesses, across{" "}
                  {eliminations.rows.length === 1
                    ? `${eliminations.rows[0].creditorName} → ${eliminations.rows[0].debtorName}`
                    : `${eliminations.rows.length} pairs`}
                  .{" "}
                  {profitElimination === 0
                    ? "All of it moved at cost, so it removes nothing from group profit — the ledger has already netted the two legs against each other."
                    : `${fmt(profitElimination)} of it carried a margin, so a sum of the businesses' own reported results overstates the group by that much.`}
                </p>
              )}
              {irrecoverableVat > 0 && (
                <p className="mt-1">
                  {fmt(irrecoverableVat)} of input VAT on that trade could not be reclaimed — the
                  receiving side's activity is exempt — and it is not eliminated. Trading between
                  your own businesses costs the group that much in real money.
                </p>
              )}
              {Math.abs(consolidationDrift) > 0.5 && (
                <p className="mt-1">
                  This consolidation is {fmt(Math.abs(consolidationDrift))}{" "}
                  {consolidationDrift > 0 ? "above" : "below"} the {fmt(netProfit)} net profit on the
                  statement above. The two are the same figure computed twice and they should
                  agree; the difference is a defect, not a reconciling item.
                </p>
              )}
            </>
          }
        />
      )}

      <Card>
        <CardHeader title="By business" subtitle="Consolidated and per entity from the same ledger" />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b" style={{ borderColor: "var(--border)" }}>
                <th className="px-4 py-2 label font-medium">Business</th>
                <th className="px-4 py-2 label font-medium text-right">Income</th>
                <th className="px-4 py-2 label font-medium text-right">Costs</th>
                <th className="px-4 py-2 label font-medium text-right">Net</th>
                <th className="px-4 py-2 label font-medium text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {byBusiness.map((r) => {
                const inc = Number(r.income);
                const exp = Number(r.expense);
                const net = inc - exp;
                return (
                  <tr
                    key={r.name ?? "group"}
                    className="border-b last:border-0"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <td className="px-4 py-2">
                      {r.name ? (
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="w-1.5 h-1.5 rounded-full"
                            style={{ background: `var(--color-bu-${r.color_token})` }}
                            aria-hidden
                          />
                          <span className="font-medium">{r.name}</span>
                        </span>
                      ) : (
                        <span className="text-muted italic">
                          Group-level (payroll, gratuity, visas)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tnum">{formatMoney(inc, ccy, 0)}</td>
                    <td className="px-4 py-2 text-right tnum text-muted">{formatMoney(exp, ccy, 0)}</td>
                    <td
                      className="px-4 py-2 text-right tnum font-semibold"
                      style={{ color: net >= 0 ? "var(--positive)" : "var(--negative)" }}
                    >
                      {formatMoney(net, ccy, 0)}
                    </td>
                    <td className="px-4 py-2 text-right tnum text-muted">
                      {inc > 0 ? `${((net / inc) * 100).toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-2xs text-subtle px-4 pb-3 pt-2 leading-relaxed">
          Costs that serve the whole group — payroll, gratuity accrual, visa fees — are posted
          without a business dimension and appear on the group-level row rather than being
          arbitrarily allocated.
        </p>
      </Card>

      {/*
        BY BUSINESS — WF-05 §11's six panels.

        "Small multiples with a shared scale rather than six lines on one chart.
        This is the correct form for six unlike businesses and it is what a
        single combined chart cannot do."

        The table above this is a single column of totals: it says how each
        business did in the selected period and nothing at all about direction.
        The panels are the only thing on the screen that answers "which way",
        and the shared scale is what makes the answer comparable — Contracting's
        swing and the salon's swing are drawn at the same dirham-per-pixel, so a
        panel that looks flat is flat rather than merely small.
      */}
      {panels.some((p) => p.points.some((pt) => pt.y !== 0)) ? (
        <SmallMultiples
          title="Which way each business is going"
          panels={panels}
          format={fmtCompact}
          columns={3}
          conclusion={concludeSmallMultiples(panels, fmtCompact, { subject: "Profit" })}
          note={`Ledger profit by month, ${monthLabel(months[0])} to ${monthLabel(months.at(-1)!)} — complete months only, on one shared scale.`}
          footnote={`These panels do not follow the period tabs above. ${monthLabel(currentMonthStart)} is excluded because a part-month bucket beside whole ones reads as a collapse, and "month to date" is one bucket, which is not a trend.`}
        />
      ) : (
        <ChartEmpty
          title="Which way each business is going"
          conclusion={`No business posted income or expenses between ${monthLabel(months[0])} and ${monthLabel(months.at(-1)!)}, so there is no trend to compare.`}
          note="Complete months only, on one shared scale."
        />
      )}
    </div>
  );
}
