import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney, formatMoneyCompact, formatPercent } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { BU_COLOR, Card, CardHeader, Chip, Delta, Sparkline } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Portfolio comparison — the screen that only exists because this owner runs
 * seven businesses rather than one.
 *
 * Deliberately ranks on GROSS MARGIN, not revenue. The mobile shop turns over
 * far more than the salon and keeps far less of it; a revenue league table
 * would tell this owner to invest in exactly the wrong place.
 */
export default async function BusinessesPage() {
  const session = await requireSession();
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const m = await loadMetrics(session, [
    { metricId: "business_performance" },
    { metricId: "revenue_trend" },
  ]);
  const perf = metric(m, "business_performance");
  const rows = [...(perf?.breakdown ?? [])].sort(
    (a, b) => Number(b.meta?.grossMargin ?? 0) - Number(a.meta?.grossMargin ?? 0),
  );

  // Per-business 30-day sparkline in one query rather than N metric calls.
  const trends = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) =>
      tx.execute<{ business_unit_id: string; d: string; v: string }>(sql`
        SELECT business_unit_id, issue_date::text AS d, SUM(subtotal)::text AS v
          FROM documents
         WHERE doc_type='invoice' AND status NOT IN ('cancelled','void','draft')
           AND issue_date > ${today}::date - 30
         GROUP BY 1, 2 ORDER BY 2
      `),
  );
  const byBu = new Map<string, { x: string; y: number }[]>();
  for (const t of trends) {
    const list = byBu.get(t.business_unit_id) ?? [];
    list.push({ x: t.d, y: Number(t.v) });
    byBu.set(t.business_unit_id, list);
  }

  const totalRevenue = rows.reduce((t, r) => t + r.value, 0);
  const totalMargin = rows.reduce((t, r) => t + Number(r.meta?.grossMargin ?? 0), 0);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Businesses</h1>
        <p className="text-xs text-muted mt-0.5">
          {formatMoney(totalRevenue, ccy)} revenue this month ·{" "}
          {formatMoney(totalMargin, ccy)} gross margin ·{" "}
          {totalRevenue ? ((totalMargin / totalRevenue) * 100).toFixed(1) : "0"}% blended
        </p>
      </header>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((r, i) => {
          const margin = Number(r.meta?.grossMargin ?? 0);
          const marginRate = Number(r.meta?.marginRate ?? 0);
          const growth = Number(r.meta?.growth ?? 0) || null;
          const color = BU_COLOR[String(r.meta?.color ?? "slate")] ?? "var(--accent)";
          const series = byBu.get(r.key) ?? [];
          return (
            <Card key={r.key} className="overflow-hidden">
              <div className="h-1" style={{ background: color }} aria-hidden />
              <div className="px-4 pt-3 pb-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-sm font-semibold tracking-tight truncate">{r.label}</h2>
                    <p className="text-2xs text-subtle capitalize">
                      {String(r.meta?.kind ?? "").replace(/_/g, " ")}
                    </p>
                  </div>
                  <Chip tone={i === 0 ? "positive" : i === rows.length - 1 ? "caution" : "neutral"}>
                    #{i + 1} by margin
                  </Chip>
                </div>

                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div>
                    <p className="label">Revenue</p>
                    <p className="text-lg font-semibold tnum tracking-tight">
                      {formatMoneyCompact(r.value, ccy)}
                    </p>
                    <Delta ratio={growth} />
                  </div>
                  <div>
                    <p className="label">Gross margin</p>
                    <p className="text-lg font-semibold tnum tracking-tight"
                      style={{ color: margin > 0 ? "var(--positive)" : "var(--negative)" }}>
                      {formatMoneyCompact(margin, ccy)}
                    </p>
                    <p className="text-2xs text-subtle tnum">
                      {(marginRate * 100).toFixed(0)}% kept
                    </p>
                  </div>
                </div>

                {series.length > 1 && (
                  <div className="mt-3">
                    <Sparkline points={series} height={32} stroke={color} id={r.key} />
                  </div>
                )}

                <p className="text-2xs text-subtle mt-2">
                  {String(r.meta?.invoices ?? 0)} invoices ·{" "}
                  {formatMoneyCompact(Number(r.meta?.priorRevenue ?? 0), ccy)} same days last month
                </p>
              </div>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title="Side by side" subtitle="Ranked by gross margin contribution" />
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b" style={{ borderColor: "var(--border)" }}>
                {["Business", "Revenue", "Margin", "Margin %", "Growth", "Share of margin"].map((h, i) => (
                  <th key={h} className={`px-4 py-2 label font-medium ${i >= 1 ? "text-right" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const margin = Number(r.meta?.grossMargin ?? 0);
                return (
                  <tr key={r.key} className="border-b last:border-0" style={{ borderColor: "var(--border)" }}>
                    <td className="px-4 py-2">
                      <span className="inline-flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full"
                          style={{ background: BU_COLOR[String(r.meta?.color ?? "slate")] }} aria-hidden />
                        <span className="font-medium">{r.label}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right tnum">{formatMoney(r.value, ccy)}</td>
                    <td className="px-4 py-2 text-right tnum font-semibold">{formatMoney(margin, ccy)}</td>
                    <td className="px-4 py-2 text-right tnum text-muted">
                      {((Number(r.meta?.marginRate ?? 0)) * 100).toFixed(1)}%
                    </td>
                    <td className="px-4 py-2 text-right tnum">
                      {formatPercent(Number(r.meta?.growth ?? 0) || null)}
                    </td>
                    <td className="px-4 py-2 text-right tnum text-muted">
                      {totalMargin ? ((margin / totalMargin) * 100).toFixed(1) : "0.0"}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
