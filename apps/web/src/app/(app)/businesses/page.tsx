import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { daysUntil, formatMoney, formatMoneyCompact, formatPercent } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { BU_COLOR, Card, CardHeader, Chip, Delta, Sparkline } from "@/components/ui";
import {
  ChartEmpty,
  SmallMultiples,
  concludeSmallMultiples,
  type BuColor,
  type Panel,
} from "@/components/charts";

export const dynamic = "force-dynamic";

/**
 * Portfolio comparison — the screen that only exists because this owner runs
 * seven businesses rather than one.
 *
 * Deliberately ranks on GROSS MARGIN, not revenue. The mobile shop turns over
 * far more than the salon and keeps far less of it; a revenue league table
 * would tell this owner to invest in exactly the wrong place.
 *
 * The cards answer "how big is each one this month". The small multiples below
 * them answer the other half of a portfolio question — "which way is each one
 * going" — and that comparison only works on a shared scale, which is what the
 * per-card sparklines cannot give: each of those is auto-scaled to its own
 * series, so the salon's good month and the parking's good month draw the same
 * shape. See the docblock on the block itself.
 */

/**
 * The eight identity hues the chart system will accept.
 *
 * `color_token` arrives from the database as a bare string. Narrowing it here
 * rather than casting means a token that is added to `business_units` without
 * a matching chart hue degrades to the neutral accent instead of painting
 * `var(--color-bu-teal)`, which resolves to nothing and draws an invisible line.
 */
const BU_HUES = new Set<string>([
  "violet", "blue", "cyan", "amber", "lime", "orange", "rose", "slate",
]);
const buHue = (token: string | undefined): BuColor | undefined =>
  token && BU_HUES.has(token) ? (token as BuColor) : undefined;

/** Number of complete calendar months shown in the small multiples. */
const TREND_MONTHS = 6;

/** "2026-02-01" → "February 2026", for prose about a month bucket. */
const monthLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
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

  /**
   * The month spine for the small multiples.
   *
   * COMPLETE calendar months only — the current month is excluded on purpose.
   * Today is the 6th of the month more often than it is the 31st, so a trailing
   * bucket that holds six days of trading next to five full months does not
   * mean "revenue collapsed", it means the month is not over. That is exactly
   * the kind of false finding `concludeSmallMultiples` would then state as
   * fact: it reports the movement from the first bucket to the last one.
   */
  const currentMonthStart = `${today.slice(0, 7)}-01`;
  const months: string[] = [];
  for (let i = TREND_MONTHS; i >= 1; i--) {
    const d = new Date(`${currentMonthStart}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - i);
    months.push(d.toISOString().slice(0, 10));
  }

  // Two shapes of the same source in one round trip: the 30-day daily series
  // behind each card's sparkline, and the monthly series behind the shared-scale
  // panels. Both read `documents.subtotal`, which is what `business_performance`
  // measures, so no figure on this screen is derived differently from another.
  const { trends, monthly } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const trends = await tx.execute<{ business_unit_id: string; d: string; v: string }>(sql`
        SELECT business_unit_id, issue_date::text AS d, SUM(subtotal)::text AS v
          FROM documents
         WHERE doc_type='invoice' AND status NOT IN ('cancelled','void','draft')
           AND issue_date > ${today}::date - 30
         GROUP BY 1, 2 ORDER BY 2
      `);

      const monthly = await tx.execute<{ business_unit_id: string; m: string; v: string }>(sql`
        SELECT business_unit_id,
               to_char(date_trunc('month', issue_date), 'YYYY-MM-DD') AS m,
               SUM(subtotal)::text AS v
          FROM documents
         WHERE doc_type='invoice' AND status NOT IN ('cancelled','void','draft')
           AND issue_date >= ${months[0]}::date
           AND issue_date < ${currentMonthStart}::date
         GROUP BY 1, 2 ORDER BY 2
      `);

      return { trends, monthly };
    },
  );
  const byBu = new Map<string, { x: string; y: number }[]>();
  for (const t of trends) {
    const list = byBu.get(t.business_unit_id) ?? [];
    list.push({ x: t.d, y: Number(t.v) });
    byBu.set(t.business_unit_id, list);
  }

  // Zero-filled against the shared spine. A month a business raised no invoice
  // is a month it billed nothing — a real zero, not a gap — and leaving it out
  // would draw a straight line across the hole and hide the quiet month.
  const monthlyByBu = new Map<string, Map<string, number>>();
  for (const r of monthly) {
    const m = monthlyByBu.get(r.business_unit_id) ?? new Map<string, number>();
    m.set(r.m, Number(r.v));
    monthlyByBu.set(r.business_unit_id, m);
  }
  const panels: Panel[] = rows.map((r) => ({
    label: r.label,
    bu: buHue(String(r.meta?.color ?? "")),
    points: months.map((m) => ({ x: m, y: monthlyByBu.get(r.key)?.get(m) ?? 0 })),
  }));

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

      {/*
        SMALL MULTIPLES — PDD §7.4's answer to "six unlike businesses".

        The alternative is six lines on one set of axes, and it fails twice
        here. First on scale: Properties bills an order of magnitude more than
        the salon, so on shared axes the salon is a flat line at the bottom and
        its trend — the thing this screen exists to show — is invisible.
        Second on identity: six overlaid series can only be told apart by hue,
        and the measured caveat on the `--color-bu-*` tokens says two of those
        pairs are not separable under deuteranopia. One titled panel per
        business carries identity in the heading, where colour vision is not
        required, and the shared vertical scale keeps the sizes honest.

        These are panels, not sparklines: the card sparklines above are
        individually auto-scaled, which is right for "is this one up or down"
        and wrong for "which one moved most".
      */}
      {panels.some((p) => p.points.some((pt) => pt.y !== 0)) ? (
        <SmallMultiples
          title="Which way each business is going"
          panels={panels}
          format={(v) => formatMoneyCompact(v, ccy)}
          columns={3}
          conclusion={concludeSmallMultiples(panels, (v) => formatMoneyCompact(v, ccy), {
            subject: "Revenue",
          })}
          note={`Invoiced revenue by month, ${monthLabel(months[0])} to ${monthLabel(months.at(-1)!)} — complete months only, on one shared scale.`}
          footnote={`The current month is not shown: ${monthLabel(currentMonthStart)} is ${daysUntil(today, currentMonthStart) + 1} days old, and a part-month bucket beside five whole ones reads as a collapse.`}
        />
      ) : (
        <ChartEmpty
          title="Which way each business is going"
          conclusion={`No invoices were raised by any business between ${monthLabel(months[0])} and ${monthLabel(months.at(-1)!)}, so there is no trend to compare.`}
          note="Complete months only, on one shared scale."
        />
      )}

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
