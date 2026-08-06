import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import { FilterTabs, PageHeader, StatStrip, TableEmpty } from "@/components/page";

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

  const { lines, byBusiness } = await withTenant(
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

      return { lines, byBusiness };
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
    </div>
  );
}
