import { Suspense } from "react";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { can, formatMoneyCompact } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadActionItems, loadMetrics, metric, resolveToday } from "@/lib/data";
import { dismissExceptionAction, restoreExceptionAction } from "@/lib/actions/exceptions";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import {
  BU_COLOR,
  BarRow,
  Card,
  CardHeader,
  Chip,
  Delta,
  EmptyState,
  GridSkeleton,
  KpiTile,
  Sparkline,
} from "@/components/ui";
import {
  CalendarHeatmap,
  ChartEmpty,
  ChartSkeleton,
  Waterfall,
  concludeCalendar,
  concludeWaterfall,
  type WaterfallStep,
} from "@/components/charts";

export const dynamic = "force-dynamic";

/**
 * THE 30-SECOND DASHBOARD.
 *
 * The brief asked for ~30 widgets. Showing 30 widgets is the fastest way to
 * ensure none of them is read. This screen answers four questions in a fixed
 * order, because that is the order a business owner actually needs them:
 *
 *   1. What needs me TODAY?        → the action list
 *   2. Am I making money?          → headline tiles
 *   3. Will I run out of cash?     → cash, receivables, forecast
 *   4. Which business is winning?  → portfolio comparison
 *
 * The action list is first by deliberate inversion. The tiles used to lead,
 * and a wall of tiles is where the eye lands first — so the one thing on the
 * page that is actually actionable today was being read last, after the owner
 * had already spent his attention on numbers he can do nothing about right
 * now. Exceptions before summaries; the summaries are still one scroll away.
 *
 * Everything else from the brief exists — it lives one click away in the
 * relevant module, reachable from the tile it belongs to. Depth is preserved;
 * only the front page is disciplined.
 *
 * Rendering: each band is its own <Suspense> boundary, so the headline numbers
 * paint as soon as their query returns instead of waiting for the slowest
 * widget on the page.
 *
 * ── THE TWO CHARTS FROM WF-05 §2 ────────────────────────────────────────────
 * The wireframe names two explanatory figures on this screen by form, and both
 * now exist: WHY PROFIT MOVED is a waterfall (`ProfitBridgeBand`) and CASH THIS
 * MONTH is a calendar heatmap (`CashCalendarBand`). Neither needs `"use
 * client"`. Nothing in `components/charts/` carries state, an effect, a
 * measurement or an event handler — hover is `:hover`, the readout is a native
 * `title`, and the table twin is a native `<details>` — so they render inside
 * these async server bands with no hydration cost, which is the whole reason
 * that directory is hand-rolled rather than a charting library.
 */
export default async function DashboardPage() {
  const session = await requireSession();
  const today = resolveToday(session.timezone);
  const greeting = new Date(`${today}T09:00:00Z`).getUTCHours() < 12 ? "Good morning" : "Good afternoon";

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {greeting}, {session.fullName.split(" ")[0]}
          </h1>
          <p className="text-xs text-muted mt-0.5">
            {new Date(`${today}T00:00:00Z`).toLocaleDateString("en-GB", {
              weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
            })}
          </p>
        </div>
        {/*
          The "✦ Ask about your business" CTA used to sit here, styled as the
          primary action and pointing at /assistant. That route has been a
          redirect("/") for as long as no ANTHROPIC_API_KEY is provisioned, so
          the largest button on the owner's home screen returned him to the
          page he had just clicked from. An affordance that cannot do what it
          promises is worse than none at all: it teaches the owner that the
          controls on this screen do nothing.

          Restore it in the same commit that re-enables the assistant — the
          checklist is in (app)/assistant/page.tsx, alongside the commented-out
          NAV entry in (app)/layout.tsx that this CTA was quietly bypassing.
        */}
      </header>

      <Suspense fallback={<div className="skeleton h-40 rounded-[var(--radius-lg)]" />}>
        <ActionBand />
      </Suspense>

      <Suspense fallback={<GridSkeleton count={4} />}>
        <HeadlineBand />
      </Suspense>

      <Suspense fallback={<ChartSkeleton height={180} />}>
        <ProfitBridgeBand />
      </Suspense>

      <Suspense fallback={<div className="skeleton h-64 rounded-[var(--radius-lg)]" />}>
        <PortfolioBand />
      </Suspense>

      <Suspense fallback={<ChartSkeleton height={120} />}>
        <CashCalendarBand />
      </Suspense>

      <Suspense fallback={<div className="skeleton h-56 rounded-[var(--radius-lg)]" />}>
        <ComplianceBand />
      </Suspense>

      <Suspense fallback={<GridSkeleton count={4} />}>
        <OperationsBand />
      </Suspense>
    </div>
  );
}

// ── UAE compliance: VAT, gratuity, cheques, expiries ────────────────────────

/**
 * The band that makes this a *UAE* system rather than a generic one.
 *
 * Each of these can cost the owner real money if nobody looks: an over-claimed
 * VAT return invites an FTA assessment, an unrecorded gratuity liability makes
 * the balance sheet fiction, an unbanked cheque is cash sitting in a drawer, and
 * an expired trade licence freezes the company bank account.
 */
async function ComplianceBand() {
  const session = await requireSession();
  const m = await loadMetrics(session, [
    { metricId: "vat_return_position" },
    { metricId: "gratuity_liability", params: { limit: 4 } },
    { metricId: "cheque_pipeline" },
    { metricId: "compliance_watchlist" },
    { metricId: "corporate_tax_estimate" },
  ]);
  const ccy = session.baseCurrency;
  const vat = metric(m, "vat_return_position");
  const gratuity = metric(m, "gratuity_liability");
  const cheques = metric(m, "cheque_pipeline");
  const watch = metric(m, "compliance_watchlist");
  const ctax = metric(m, "corporate_tax_estimate");

  // Nothing here is visible to roles without the underlying permissions.
  if (!vat && !gratuity && !cheques && !watch) return null;

  const dueNow = cheques?.breakdown?.find((b) => b.key === "due_now");
  const bounced = cheques?.breakdown?.find((b) => b.key === "bounced");
  const exemptShare = vat?.breakdown?.find((b) => b.key === "ratio");
  const irrecoverable = vat?.breakdown?.find((b) => b.key === "irrecoverable");

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      {/* VAT + corporate tax */}
      {vat && (
        <Card>
          <CardHeader
            title="VAT this quarter"
            subtitle="FTA position, after input apportionment"
            href="/accounting/vat"
          />
          <div className="px-4 pb-4">
            <div className="flex items-baseline gap-2">
              <span className="kpi-value" style={{ color: vat.value > 0 ? "var(--caution)" : "var(--positive)" }}>
                {formatMoneyCompact(Math.abs(vat.value), ccy)}
              </span>
              <span className="text-2xs text-subtle">
                {vat.value > 0 ? "payable to FTA" : "refundable"}
              </span>
            </div>
            <div className="mt-3 space-y-1">
              {vat.breakdown
                ?.filter((b) => ["box1", "box5", "output", "input"].includes(b.key))
                .map((b) => (
                  <div key={b.key} className="flex items-baseline justify-between gap-2 text-2xs">
                    <span className="text-muted truncate">{b.label}</span>
                    <span className="tnum font-medium shrink-0">
                      {formatMoneyCompact(b.value, ccy)}
                    </span>
                  </div>
                ))}
            </div>
            {irrecoverable && irrecoverable.value > 0 && (
              <p
                className="text-2xs mt-2.5 px-2 py-1.5 rounded-[var(--radius-sm)] leading-snug"
                style={{ background: "var(--caution-soft)", color: "var(--caution)" }}
              >
                {formatMoneyCompact(irrecoverable.value, ccy)} of input VAT is not recoverable —
                residential rent is exempt, so only {exemptShare?.value ?? 0}% of overhead VAT can
                be reclaimed.
              </p>
            )}
            {ctax && (
              <p className="text-2xs text-subtle mt-2 leading-snug">
                Corporate tax estimate for the year: {formatMoneyCompact(ctax.value, ccy)}
                {ctax.breakdown?.find((b) => b.key === "sbr")?.value === 1
                  ? " — Small Business Relief applied."
                  : " — above the AED 3M Small Business Relief cap."}
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Cheques */}
      {cheques && (
        <Card>
          <CardHeader title="Cheques" subtitle="Post-dated cheques held" href="/rentals/cheques" />
          <div className="px-4 pb-4">
            <div className="flex items-baseline gap-2">
              <span className="kpi-value">{formatMoneyCompact(cheques.value, ccy)}</span>
              <span className="text-2xs text-subtle">not yet banked</span>
            </div>
            <div className="mt-3 space-y-1.5">
              {cheques.breakdown?.map((b) => (
                <div key={b.key} className="flex items-baseline justify-between gap-2 text-2xs">
                  <span
                    className="truncate"
                    style={{
                      color: b.key === "bounced" ? "var(--negative)"
                        : b.key === "due_now" ? "var(--caution)" : "var(--text-muted)",
                    }}
                  >
                    {b.label}
                  </span>
                  <span className="tnum font-medium shrink-0">
                    {formatMoneyCompact(b.value, ccy)}
                    <span className="text-subtle font-normal"> ({String(b.meta?.count ?? 0)})</span>
                  </span>
                </div>
              ))}
            </div>
            {dueNow && dueNow.value > 0 && (
              <p
                className="text-2xs mt-2.5 px-2 py-1.5 rounded-[var(--radius-sm)] leading-snug"
                style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
              >
                {String(dueNow.meta?.count ?? 0)} cheques worth{" "}
                {formatMoneyCompact(dueNow.value, ccy)} are ready to deposit this week.
              </p>
            )}
            {bounced && bounced.value > 0 && (
              <p
                className="text-2xs mt-1.5 px-2 py-1.5 rounded-[var(--radius-sm)] leading-snug"
                style={{ background: "var(--negative-soft)", color: "var(--negative)" }}
              >
                {String(bounced.meta?.count ?? 0)} bounced — chase replacements.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Gratuity + expiries */}
      <div className="space-y-3">
        {gratuity && (
          <Card className="p-4">
            <p className="label">End-of-service liability</p>
            <p className="kpi-value mt-1">{formatMoneyCompact(gratuity.value, ccy)}</p>
            <p className="text-2xs text-subtle mt-1.5 leading-snug">
              Accrued gratuity across{" "}
              {String(gratuity.breakdown?.find((b) => b.key === "headcount")?.value ?? 0)} staff
              under Federal Decree-Law 33/2021. Owed today, whether or not anyone resigns.
            </p>
          </Card>
        )}

        {watch && (
          <Card>
            <CardHeader
              title="Compliance deadlines"
              subtitle="Next 90 days"
              action={
                <Chip tone={watch.value > 0 ? "caution" : "positive"}>{watch.value} open</Chip>
              }
            />
            <div className="px-4 pb-3">
              {watch.breakdown?.length ? (
                watch.breakdown.slice(0, 5).map((b) => (
                  <div
                    key={b.key}
                    className="flex items-baseline justify-between gap-2 py-1 border-b last:border-0"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <span className="text-2xs truncate">{b.label}</span>
                    <span
                      className="text-2xs font-semibold tnum shrink-0"
                      style={{
                        color: b.value <= 30 ? "var(--negative)"
                          : b.value <= 60 ? "var(--caution)" : "var(--text-muted)",
                      }}
                    >
                      {b.meta?.kind === "ejari" ? "action" : `${b.value}d`}
                    </span>
                  </div>
                ))
              ) : (
                <EmptyState title="Nothing expiring" detail="No licences or visas due in 90 days." />
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── Band 1: am I making money, and will I have cash? ────────────────────────

async function HeadlineBand() {
  const session = await requireSession();
  const m = await loadMetrics(session, [
    { metricId: "revenue_today" },
    { metricId: "revenue_mtd" },
    { metricId: "net_profit_mtd" },
    { metricId: "cash_balance" },
    { metricId: "revenue_trend" },
    { metricId: "business_health_score" },
    { metricId: "cash_flow_forecast" },
    { metricId: "accounts_receivable" },
    { metricId: "overdue_debt" },
  ]);
  const ccy = session.baseCurrency;
  const trend = metric(m, "revenue_trend");
  const health = metric(m, "business_health_score");
  const forecast = metric(m, "cash_flow_forecast");

  return (
    <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Today's revenue" result={metric(m, "revenue_today")} currency={ccy}
          compareLabel="vs same day last week" accent />
        <KpiTile label="Revenue this month" result={metric(m, "revenue_mtd")} currency={ccy}
          compareLabel="vs same days last month" />
        <KpiTile
          label="Net profit this month"
          result={metric(m, "net_profit_mtd")}
          currency={ccy}
          compareLabel="vs same days last month"
          /**
           * Rent and payroll post on the 1st–3rd; revenue accrues daily. Early
           * in a month this tile is *expected* to be negative, and showing the
           * bare number without saying so teaches the owner to distrust it.
           * The like-for-like comparison is the signal; the level is not.
           */
          hint={(() => {
            const np = metric(m, "net_profit_mtd");
            const elapsed = np?.breakdown?.find((b) => b.key === "elapsed");
            if (!elapsed) return "From the ledger — after rent, wages and every posted cost.";
            const of = Number(elapsed.meta?.of ?? 30);
            return np!.value < 0 && elapsed.value < of * 0.5
              ? `Day ${elapsed.value} of ${of}. Rent and payroll are already booked for the whole month — compare the change, not the level.`
              : `Day ${elapsed.value} of ${of}, from the ledger after every posted cost.`;
          })()}
        />
        <KpiTile label="Cash & bank" result={metric(m, "cash_balance")} currency={ccy}
          compareLabel="" />
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
        {/* Revenue trend */}
        <Card>
          <CardHeader
            title="Revenue, last 30 days"
            subtitle={trend ? `${formatMoneyCompact(trend.value, ccy)} total across all businesses` : undefined}
            href="/businesses"
          />
          <div className="px-4 pb-4">
            {trend?.series && <Sparkline points={trend.series} height={80} />}
            <div className="flex justify-between text-2xs text-subtle mt-1.5">
              <span>{trend?.series?.[0]?.x}</span>
              <span>{trend?.series?.at(-1)?.x}</span>
            </div>
          </div>
        </Card>

        {/* Health score — always decomposed, never a bare number */}
        <Card>
          <CardHeader title="Business health" subtitle="Weighted across five signals" />
          {health && (
            <div className="px-4 pb-4">
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-semibold tnum tracking-tight"
                  style={{ color: health.value >= 70 ? "var(--positive)" : health.value >= 45 ? "var(--caution)" : "var(--negative)" }}>
                  {Math.round(health.value)}
                </span>
                <span className="text-xs text-subtle">/ 100</span>
              </div>
              <div className="mt-3 space-y-2">
                {health.breakdown?.map((b) => {
                  const outOf = Number(b.meta?.outOf ?? 20);
                  const ratio = outOf ? b.value / outOf : 0;
                  return (
                    <div key={b.key}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-2xs font-medium">{b.label}</span>
                        <span className="text-2xs tnum text-muted">{b.value}/{outOf}</span>
                      </div>
                      <div className="h-1 rounded-full mt-1 overflow-hidden" style={{ background: "var(--surface-3)" }}>
                        <div className="h-full rounded-full"
                          style={{
                            width: `${Math.max(2, ratio * 100)}%`,
                            background: ratio >= 0.7 ? "var(--positive)" : ratio >= 0.4 ? "var(--caution)" : "var(--negative)",
                          }} />
                      </div>
                      <p className="text-2xs text-subtle mt-0.5">{String(b.meta?.detail ?? "")}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* Cash runway strip */}
      <Card className="p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="label">Projected cash in 30 days</p>
            <p className="kpi-value mt-1">
              {forecast ? formatMoneyCompact(forecast.value, ccy) : "—"}
            </p>
            <div className="mt-1 flex items-center gap-1.5">
              <Delta ratio={forecast?.changeRatio} />
              <span className="text-2xs text-subtle">vs cash today</span>
            </div>
          </div>
          <div className="flex-1 min-w-[260px] grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5">
            {forecast?.breakdown?.map((b) => (
              <div key={b.key} className="flex items-baseline justify-between gap-2 border-b pb-1"
                style={{ borderColor: "var(--border)" }}>
                <span className="text-2xs text-muted truncate">{b.label}</span>
                <span className="text-2xs font-semibold tnum shrink-0"
                  style={{ color: b.value < 0 ? "var(--negative)" : "var(--text)" }}>
                  {formatMoneyCompact(b.value, ccy)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Owed to you" result={metric(m, "accounts_receivable")} currency={ccy}
          polarity="lower_is_better" hint="Total unpaid customer and tenant invoices." />
        <KpiTile label="Already overdue" result={metric(m, "overdue_debt")} currency={ccy}
          polarity="lower_is_better" hint="Past due date. Chase this first." />
        <Suspense fallback={<div className="skeleton h-28 rounded-[var(--radius-lg)]" />}>
          <SecondaryTiles />
        </Suspense>
      </div>
    </>
  );
}

async function SecondaryTiles() {
  const session = await requireSession();
  const m = await loadMetrics(session, [
    { metricId: "upcoming_installments" },
    { metricId: "customers_total" },
  ]);
  return (
    <>
      <KpiTile label="Installments due" result={metric(m, "upcoming_installments")}
        currency={session.baseCurrency} polarity="neutral"
        hint="Next 30 days, plus anything already missed." />
      <KpiTile label="Customers" result={metric(m, "customers_total")}
        currency={session.baseCurrency} />
    </>
  );
}

// ── Band 1b: why profit moved, and when cash leaves ─────────────────────────

/**
 * Date arithmetic on ISO strings, local to this file.
 *
 * The metric registry has the same three helpers and does not export them; the
 * interco screen redeclares its own `monthStart` for the same reason. Copying
 * four lines is cheaper than widening `@nexus/core`'s public surface from a
 * screen, and these are pure string/UTC operations with no timezone opinion of
 * their own — "today" has already been resolved to the tenant's date by
 * `resolveToday` before it reaches them.
 */
const monthStartOf = (iso: string) => `${iso.slice(0, 7)}-01`;

function shiftDaysBy(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prevMonthStartOf(iso: string): string {
  const d = new Date(`${monthStartOf(iso)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

const monthNameOf = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });

/**
 * WHY PROFIT MOVED — the waterfall WF-05 §2 puts under the tiles.
 *
 * The tiles say profit is down 8%. That is the question, not the answer, and
 * §2.1's mock is explicit about the shape of the answer: last period's profit
 * anchored on the left, one floating bar per business showing what it added or
 * took away, this period's profit anchored on the right. A bridge is the only
 * form that says "these seven things, in these sizes, are the whole of the
 * difference" — a table of before-and-after columns makes the reader do that
 * subtraction themselves, and they will not.
 *
 * ── WHY THE DRIVERS ARE BUSINESSES AND NOT ACCOUNTS ─────────────────────────
 * A bridge decomposed by expense account ("salaries +4k, rent +0k") tells the
 * owner what kind of cost moved. This owner's actual question is *which shop*,
 * because that is the unit he can walk into on a Tuesday. The account-level
 * cascade exists too and is the right decomposition for an accountant — it is
 * the waterfall on /accounting/profit-loss, one click away through the
 * footnote below.
 *
 * ── WHY THE COMPARISON IS ELAPSED-DAY MATCHED ───────────────────────────────
 * Rent and payroll post on the 1st–3rd while revenue accrues daily, so a full
 * prior month against six days of this one is not a comparison, it is a
 * guarantee that profit "fell". The prior window is truncated to the same day
 * of the month, exactly as `net_profit_mtd` does for the tile above — and the
 * two must agree, because they are the same number on the same screen.
 *
 * Group-level lines (payroll, gratuity, visa fees) carry no business unit and
 * come back under their own label rather than being dropped or spread across
 * the businesses: an incomplete bridge that looks complete is the failure mode
 * that makes this chart untrustworthy, and `concludeWaterfall` would report the
 * residual out loud anyway.
 */
async function ProfitBridgeBand() {
  const session = await requireSession();
  // Same gate as the portfolio band below: this decomposes group profit across
  // the businesses, so it is consolidated data and a branch manager does not
  // see the region at all (WF-05 §2.3 — absent, not greyed).
  if (!can(session.principal, "dashboard:consolidated")) return null;

  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;
  const fmt = (v: number) => formatMoneyCompact(v, ccy);

  const dayOfMonth = Number(today.slice(8, 10));
  const mStart = monthStartOf(today);
  const pStart = prevMonthStartOf(today);
  const pEnd = shiftDaysBy(pStart, dayOfMonth - 1);

  const rows = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) =>
      tx.execute<{ label: string; cur: string; prior: string }>(sql`
        WITH pl AS (
          SELECT COALESCE(b.name, 'Group-level costs') AS label,
                 b.sort_order AS sort_order,
                 CASE WHEN j.posting_date >= ${mStart}::date THEN 'cur' ELSE 'prior' END AS bucket,
                 CASE WHEN a.type = 'income' THEN jl.base_credit - jl.base_debit
                      ELSE -(jl.base_debit - jl.base_credit) END AS profit
            FROM journal_lines jl
            JOIN journals j ON j.id = jl.journal_id
            JOIN accounts a ON a.id = jl.account_id
            LEFT JOIN business_units b ON b.id = jl.business_unit_id
           WHERE a.type IN ('income', 'expense')
             AND j.posting_date BETWEEN ${pStart}::date AND ${today}::date
             AND NOT (j.posting_date > ${pEnd}::date AND j.posting_date < ${mStart}::date)
        )
        SELECT label,
               COALESCE(SUM(profit) FILTER (WHERE bucket = 'cur'), 0)::text AS cur,
               COALESCE(SUM(profit) FILTER (WHERE bucket = 'prior'), 0)::text AS prior
          FROM pl
         GROUP BY label, sort_order
         ORDER BY sort_order NULLS LAST, label
      `),
  );

  const period =
    dayOfMonth === 1
      ? `the first day of ${monthNameOf(today)}`
      : `the first ${dayOfMonth} days of ${monthNameOf(today)}`;

  if (rows.length === 0) {
    return (
      <ChartEmpty
        title="Why profit moved"
        conclusion={`Nothing has been posted to income or expenses in ${period} or in the same days of ${monthNameOf(pStart)}, so there is no movement to explain.`}
        note={`${pStart} to ${pEnd} against ${mStart} to ${today}`}
      />
    );
  }

  const priorTotal = rows.reduce((t, r) => t + Number(r.prior), 0);
  const curTotal = rows.reduce((t, r) => t + Number(r.cur), 0);

  const steps: WaterfallStep[] = [
    { label: `${monthNameOf(pStart)} 1–${dayOfMonth}`, value: priorTotal, kind: "total" },
    ...rows
      .map((r) => ({ label: r.label, value: Number(r.cur) - Number(r.prior), kind: "delta" as const }))
      // A driver that moved by less than half a fils is a zero-height bar with
      // a name on it — noise in a form whose whole claim is that bar length
      // means something.
      .filter((s) => Math.abs(s.value) >= 0.005),
    { label: `${monthNameOf(today)} 1–${dayOfMonth}`, value: curTotal, kind: "total" },
  ];

  return (
    <Waterfall
      title="Why profit moved"
      steps={steps}
      format={fmt}
      conclusion={concludeWaterfall(steps, fmt, { subject: "Net profit", period })}
      note={`Each business's contribution to the change, ${monthNameOf(pStart)} 1–${dayOfMonth} against ${monthNameOf(today)} 1–${dayOfMonth} — the same elapsed days, so the comparison is like for like.`}
      footnote={
        <Link href="/accounting/profit-loss" className="text-accent hover:underline">
          The same period decomposed by account, on the profit &amp; loss →
        </Link>
      }
    />
  );
}

/**
 * CASH THIS MONTH — the calendar heatmap from WF-05 §2.
 *
 * §2.1's worked conclusion is "cash goes out on the 3rd and the 17th, every
 * month", and that sentence is the argument for the form: it is a claim about
 * *which day of the cycle*, and a 90-point line chart cannot make it because
 * the day-of-month axis it needs does not exist on a line. A calendar puts
 * every day of the week on a row and every week in a column, so a payroll run
 * that always lands early in the month shows up as a vertical stripe.
 *
 * ── WHY NINETY DAYS AND NOT THE CALENDAR MONTH ──────────────────────────────
 * A deliberate, reported deviation from the wireframe's "CASH THIS MONTH"
 * label. The pattern the chart exists to expose repeats monthly, so a single
 * month shows it exactly once and cannot distinguish "the rent went out on the
 * 3rd" from "the rent goes out on the 3rd". Worse, the window is month-TO-DATE:
 * on the 6th it is a six-cell strip, and `concludeCalendar` will not claim a
 * weekday pattern from six days — correctly, since it would be a coincidence.
 * A quarter shows the cycle three times, which is the smallest window in which
 * the sentence can be earned rather than asserted. `cell = 13` is the
 * component's own documented size for fitting 90 days in a phone card.
 *
 * Diverging mode, not sequential: the reader needs the sign. A day cash left is
 * a different event from a day cash arrived, and one colour ramp says only "a
 * lot happened".
 */
async function CashCalendarBand() {
  const session = await requireSession();
  if (!can(session.principal, "report:read")) return null;

  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;
  const fmt = (v: number) => formatMoneyCompact(v, ccy);
  const from = shiftDaysBy(today, -89);

  const rows = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) =>
      tx.execute<{ d: string; v: string }>(sql`
        SELECT j.posting_date::text AS d,
               SUM(jl.base_debit - jl.base_credit)::text AS v
          FROM journal_lines jl
          JOIN journals j ON j.id = jl.journal_id
          JOIN accounts a ON a.id = jl.account_id
         WHERE a.system_key IN ('CASH', 'BANK', 'WALLET')
           AND j.posting_date BETWEEN ${from}::date AND ${today}::date
         GROUP BY 1
         ORDER BY 1
      `),
  );

  if (rows.length === 0) {
    return (
      <ChartEmpty
        title="Cash in and out"
        conclusion="No money has moved through any cash, bank or wallet account in the last 90 days."
        note={`${from} to ${today}`}
      />
    );
  }

  /**
   * A full day spine, zero-filled.
   *
   * `concludeCalendar` counts the bad days against `days.length`, so handing it
   * only the days that carry a posting would make it say "negative on 6 of 74
   * days" for a 90-day window — a denominator that quietly flatters a quiet
   * period. A zero day is also a fact worth stating. It costs nothing visually:
   * the heatmap bins zero to the same empty cell as a day with no row at all.
   */
  const posted = new Map(rows.map((r) => [r.d, Number(r.v)]));
  const days: { date: string; value: number }[] = [];
  for (let d = from; d <= today; d = shiftDaysBy(d, 1)) {
    days.push({ date: d, value: posted.get(d) ?? 0 });
  }

  return (
    <CalendarHeatmap
      title="Cash in and out"
      from={from}
      to={today}
      values={days}
      format={fmt}
      mode="diverging"
      conclusion={concludeCalendar(days, fmt, { subject: "Cash", mode: "diverging" })}
      note="Net movement across every cash, bank and wallet account, one cell per day for the last 90 days."
      footnote="Ninety days rather than the current month: the outflow cycle repeats monthly, and one month shows it once."
    />
  );
}

// ── Band 2: what needs me today ─────────────────────────────────────────────

/**
 * The exception list. FR-V01, WF-05 §2.
 *
 * Three states, and the distinction between the last two is the part that is
 * easy to get wrong:
 *
 *   ITEMS        the ranked list, each row a link to the rows behind it plus a
 *                "set aside" control.
 *   EMPTY        the caller may see exceptions and has none. A positive state,
 *                not a blank region — WF-05 §2.3.
 *   NO REGION    the caller may see no detector at all, so the band is ABSENT
 *                rather than an empty card reading "0 open". A barber being
 *                shown a permanently empty "Needs you today" card teaches them
 *                the screen is broken; showing them a card that says nothing is
 *                overdue also quietly confirms the shape of financial data they
 *                have no right to. Absence is both kinder and tighter.
 */
async function ActionBand() {
  const session = await requireSession();
  const feed = await loadActionItems(session);
  if (feed.visibleDetectors === 0) return null;

  const { items, dismissed } = feed;
  const ccy = session.baseCurrency;
  const tone = { critical: "negative", warning: "caution", opportunity: "accent" } as const;

  return (
    <Card>
      <CardHeader
        title="Needs you today"
        subtitle="Ranked by money at stake, not by recency"
        action={<Chip tone={items.length ? "negative" : "positive"}>{items.length} open</Chip>}
      />
      {items.length === 0 ? (
        <EmptyState
          title="Nothing needs your attention"
          detail={
            dismissed.length > 0
              ? `Everything firing right now is something you have already set aside. ${dismissed.length} of them, below.`
              : "No overdue invoices, no missed SLAs, no empty units. Enjoy it while it lasts."
          }
        />
      ) : (
        <ul className="divide-y" style={{ borderColor: "var(--border)" }}>
          {items.map((item) => (
            <li key={item.id}>
              <Link href={item.href} className="flex items-start gap-3 px-4 py-3 hover:bg-surface-2 transition-colors">
                <span
                  className="w-1 self-stretch rounded-full shrink-0"
                  style={{
                    background:
                      item.severity === "critical" ? "var(--negative)"
                      : item.severity === "warning" ? "var(--caution)" : "var(--accent)",
                  }}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-xs font-semibold truncate">{item.title}</p>
                    {item.amount !== null && (
                      <span className="text-xs font-semibold tnum shrink-0"
                        style={{ color: item.severity === "critical" ? "var(--negative)" : "var(--text)" }}>
                        {formatMoneyCompact(item.amount, ccy)}
                      </span>
                    )}
                  </div>
                  <p className="text-2xs text-subtle mt-0.5 leading-snug">{item.detail}</p>
                </div>
                <Chip tone={tone[item.severity]}>{item.severity}</Chip>
              </Link>
              {/*
                Outside the <Link>, not inside it: a form nested in an anchor is
                invalid HTML and the browser's recovery is to submit-and-navigate,
                which would lose the dismissal.
              */}
              <Disclosure summary="Set this aside">
                <p className="text-2xs text-muted leading-relaxed mb-3">
                  It disappears from this list until it gets worse than it is right now —
                  more of them, more money, or older. Your reason is kept on the audit log.
                </p>
                <ActionForm
                  action={dismissExceptionAction}
                  submitLabel="Set aside"
                  pendingLabel="Saving…"
                  variant="ghost"
                  hidden={{ key: item.id }}
                >
                  <div className="grid sm:grid-cols-2 gap-3 mb-3">
                    <Field
                      label="Why (kept on the audit log)"
                      name="reason"
                      placeholder="Rajesh is chasing these, review Sunday…"
                      required
                    />
                    <Field
                      label="Bring it back"
                      name="retention"
                      options={[
                        { value: "worse", label: "Only if it gets worse" },
                        { value: "7", label: "In 7 days" },
                        { value: "30", label: "In 30 days" },
                      ]}
                    />
                  </div>
                </ActionForm>
              </Disclosure>
            </li>
          ))}
        </ul>
      )}

      {dismissed.length > 0 && (
        <div className="border-t" style={{ borderColor: "var(--border)" }}>
          <Disclosure summary={`${dismissed.length} set aside`}>
            <ul className="space-y-3">
              {dismissed.map((d) => (
                <li key={d.key} className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold">{d.label}</p>
                    <p className="text-2xs text-subtle mt-0.5 leading-snug">
                      “{d.reason}”
                      {d.expiresAt ? " · returns on a date you set" : " · returns if it worsens"}
                    </p>
                  </div>
                  <ActionForm
                    action={restoreExceptionAction}
                    submitLabel="Put back"
                    pendingLabel="…"
                    variant="ghost"
                    hidden={{ key: d.key }}
                  />
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}
    </Card>
  );
}

// ── Band 3: which business is winning ───────────────────────────────────────

async function PortfolioBand() {
  const session = await requireSession();
  if (!session.principal.permissions.has("dashboard:consolidated")) return null;

  const m = await loadMetrics(session, [
    { metricId: "business_performance" },
    { metricId: "staff_performance", params: { limit: 5 } },
  ]);
  const perf = metric(m, "business_performance");
  const staff = metric(m, "staff_performance");
  const ccy = session.baseCurrency;
  const rows = perf?.breakdown ?? [];
  // Magnitudes, not signed values. BarRow renders |value| / max, so a month in
  // which every business lost money would collapse this denominator to the 1
  // floor, blow every ratio past 100%, and let Math.min clamp all of them to
  // full width — every business looking identically bad on the one screen whose
  // job is telling them apart.
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);

  const best = [...rows].sort((a, b) => Number(b.meta?.grossMargin ?? 0) - Number(a.meta?.grossMargin ?? 0))[0];
  const worst = [...rows]
    .filter((r) => r.value > 0)
    .sort((a, b) => Number(a.meta?.growth ?? 0) - Number(b.meta?.growth ?? 0))[0];

  return (
    <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr]">
      <Card>
        <CardHeader title="This month by business" subtitle="Revenue, with gross margin and growth" href="/businesses" />
        <div className="px-4 pb-4">
          {rows.map((r) => (
            <BarRow
              key={r.key}
              label={r.label}
              value={r.value}
              max={max}
              display={formatMoneyCompact(r.value, ccy)}
              color={BU_COLOR[String(r.meta?.color ?? "slate")] ?? "var(--accent)"}
              href={`/businesses`}
              meta={
                <span className="flex items-center gap-2">
                  <span>
                    margin {((Number(r.meta?.marginRate ?? 0)) * 100).toFixed(0)}%
                  </span>
                  <span aria-hidden>·</span>
                  <Delta ratio={Number(r.meta?.growth ?? 0) || null} />
                  <span aria-hidden>·</span>
                  <span>{String(r.meta?.invoices ?? 0)} invoices</span>
                </span>
              }
            />
          ))}
        </div>
      </Card>

      <div className="space-y-3">
        <Card className="p-4">
          <p className="label">Strongest this month</p>
          {best ? (
            <>
              <p className="text-lg font-semibold tracking-tight mt-1">{best.label}</p>
              <p className="text-2xs text-muted mt-1 leading-relaxed">
                {formatMoneyCompact(Number(best.meta?.grossMargin ?? 0), ccy)} gross margin on{" "}
                {formatMoneyCompact(best.value, ccy)} revenue —{" "}
                {((Number(best.meta?.marginRate ?? 0)) * 100).toFixed(0)}% of every dirham kept.
              </p>
            </>
          ) : <p className="text-xs text-subtle mt-1">No data yet</p>}
        </Card>

        <Card className="p-4">
          <p className="label">Losing ground</p>
          {worst ? (
            <>
              <p className="text-lg font-semibold tracking-tight mt-1">{worst.label}</p>
              <p className="text-2xs text-muted mt-1 leading-relaxed">
                Revenue is{" "}
                <span style={{ color: "var(--negative)" }}>
                  {((Number(worst.meta?.growth ?? 0)) * 100).toFixed(1)}%
                </span>{" "}
                against the same days last month. Worth an hour of your time this week.
              </p>
            </>
          ) : <p className="text-xs text-subtle mt-1">No data yet</p>}
        </Card>

        <Card>
          {/*
            This pointed at /hr/performance, which has never existed — the
            request fell through (app)/[...slug] to a real 404. Until an HR
            performance screen is built, the drill-down goes where the
            staff_performance metric itself already declares its drilldownHref
            (packages/core/src/metrics/registry.ts): the gratuity register,
            the one screen in the product that lists employees individually.
            Keep the two in step if either moves.
          */}
          <CardHeader title="Top staff" subtitle="Revenue attributed this month" href="/hr/gratuity" />
          <div className="px-4 pb-3">
            {staff?.breakdown?.slice(0, 5).map((sRow) => (
              <div key={sRow.key} className="flex items-baseline justify-between gap-2 py-1">
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{sRow.label}</p>
                  <p className="text-2xs text-subtle truncate">{String(sRow.meta?.role ?? "")}</p>
                </div>
                <span className="text-xs font-semibold tnum shrink-0">
                  {formatMoneyCompact(sRow.value, ccy)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Band 4: operations ──────────────────────────────────────────────────────

async function OperationsBand() {
  const session = await requireSession();
  const m = await loadMetrics(session, [
    { metricId: "appointments_today" },
    { metricId: "open_service_requests" },
    { metricId: "occupancy_rate" },
    { metricId: "inventory_value" },
    { metricId: "low_stock_items", params: { limit: 6 } },
    { metricId: "churn_risk_customers", params: { limit: 6 } },
    { metricId: "channel_performance" },
  ]);
  const ccy = session.baseCurrency;
  const occ = metric(m, "occupancy_rate");
  const lowStock = metric(m, "low_stock_items");
  const churn = metric(m, "churn_risk_customers");
  const channels = metric(m, "channel_performance");
  const appts = metric(m, "appointments_today");
  const jobs = metric(m, "open_service_requests");

  return (
    <>
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <KpiTile label="Appointments today" result={appts} currency={ccy}
          hint={`Chair utilisation ${appts?.breakdown?.find((b) => b.key === "utilisation")?.value ?? 0}%`} />
        <KpiTile label="Open service jobs" result={jobs} currency={ccy} polarity="lower_is_better"
          hint={`${jobs?.breakdown?.find((b) => b.key === "sla_breached")?.value ?? 0} past SLA`} />
        <KpiTile label="Occupancy" result={occ} currency={ccy}
          hint={occ ? `${formatMoneyCompact(Number(occ.breakdown?.find((b) => b.key === "vacancy_cost")?.value ?? 0), ccy)}/mo lost to vacancy` : undefined} />
        <KpiTile label="Stock value" result={metric(m, "inventory_value")} currency={ccy} polarity="neutral"
          hint={`${metric(m, "inventory_value")?.breakdown?.[0]?.value ?? 0} items need reordering`} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <Card>
          <CardHeader title="Reorder now" subtitle="Ranked by days of cover, not quantity" href="/inventory" />
          <div className="px-4 pb-4">
            {lowStock?.breakdown?.length ? (
              lowStock.breakdown.map((b) => (
                <div key={b.key} className="flex items-baseline justify-between gap-3 py-1.5 border-b last:border-0"
                  style={{ borderColor: "var(--border)" }}>
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{b.label}</p>
                    <p className="text-2xs text-subtle">
                      {b.meta?.daysOfCover !== null && b.meta?.daysOfCover !== undefined
                        ? `${b.meta.daysOfCover} days of cover`
                        : "no recent sales"}
                      {" · order "}{String(b.meta?.suggestedQty ?? 0)}
                    </p>
                  </div>
                  <span className="text-xs font-semibold tnum shrink-0"
                    style={{ color: Number(b.value) <= 0 ? "var(--negative)" : "var(--caution)" }}>
                    {b.value} left
                  </span>
                </div>
              ))
            ) : (
              <EmptyState title="Stock levels are healthy" detail="Nothing has fallen to its reorder point." />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Customers slipping away" subtitle="Proven buyers, gone quiet" href="/crm" />
          <div className="px-4 pb-4">
            {churn?.breakdown?.length ? (
              churn.breakdown.map((b) => (
                <div key={b.key} className="flex items-baseline justify-between gap-3 py-1.5 border-b last:border-0"
                  style={{ borderColor: "var(--border)" }}>
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{b.label}</p>
                    <p className="text-2xs text-subtle">
                      last seen {String(b.meta?.daysSinceLastVisit ?? "?")} days ago
                    </p>
                  </div>
                  <span className="text-xs font-semibold tnum shrink-0">
                    {formatMoneyCompact(b.value, ccy)}
                  </span>
                </div>
              ))
            ) : (
              <EmptyState title="No one is drifting" detail="Every repeat customer has been in recently." />
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Online by channel" subtitle="This month, net of commission" href="/ecommerce" />
          <div className="px-4 pb-4">
            {channels?.breakdown?.length ? (
              channels.breakdown.map((b) => (
                <BarRow key={b.key} label={b.label} value={b.value}
                  max={Math.max(...channels.breakdown!.map((x) => Math.abs(x.value)), 1)}
                  display={formatMoneyCompact(b.value, ccy)}
                  meta={`${String(b.meta?.orders ?? 0)} orders`} />
              ))
            ) : (
              <EmptyState title="No online sales yet" detail="Connect a channel to start tracking." icon="○" />
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
