import { sql, type SQL } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { completeJobAction } from "@/lib/actions";
import {
  DataTable, FilterTabs, PageHeader, Pagination, StatStrip, StatusPill, TableEmpty, pageSlice,
} from "@/components/page";

export const dynamic = "force-dynamic";

const TRADE_LABEL: Record<string, string> = {
  ac_service: "AC", plumbing: "Plumbing", electrical: "Electrical",
  handyman: "Handyman", cleaning: "Cleaning",
};

const TABS = ["open", "breached", "internal", "invoiced", "all"] as const;
type Tab = (typeof TABS)[number];

/** Statuses that mean a job is still live. Shared by the tab, the badge and the
 *  row-level Complete button so they can never drift apart. */
const OPEN_STATUSES = ["request", "quoted", "scheduled", "dispatched", "in_progress", "on_hold"];

/**
 * Field service job board.
 *
 * One screen for all five trades, because they share a lifecycle — the brief
 * described them as five separate businesses. `service_kind` is the only thing
 * that differs, and it is a filter rather than a fork in the code.
 *
 * Two things are deliberately prominent: SLA breach, which predicts complaints
 * better than any other signal, and per-job margin, which is the number that
 * tells the owner which trade is actually worth doing.
 *
 * THIS SCREEN TRUNCATED TWICE. It fetched 400 jobs, filtered that array in
 * JavaScript, then rendered `.slice(0, 80)` of the result and printed "Showing
 * 80 of N" where N was itself a count of the 400 — a number about a sample,
 * labelled as a number about the business. Both cuts are gone: the filter and
 * the count are SQL, and the 80 is a real page of a real total.
 *
 * `open_service_requests` also declares its drill-down as `/services?status=open`
 * while the tab chips write `?filter=…`, so the tile the owner clicked landed
 * them on the default board rather than on the open jobs it promised. Both
 * spellings are read.
 */
export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{
    filter?: string; status?: string; trade?: string; page?: string; per?: string;
  }>;
}) {
  const session = await requireSession();
  const {
    filter, status: rawStatus, trade, page: rawPage, per: rawPer,
  } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  // The tabs write `filter`; `status` is the metric registry's spelling and
  // only arrives on a fresh drill-down.
  const wanted = filter ?? rawStatus ?? "open";
  const tab: Tab = (TABS as readonly string[]).includes(wanted) ? (wanted as Tab) : "open";

  const m = await loadMetrics(session, [{ metricId: "open_service_requests" }]);
  const open = metric(m, "open_service_requests");

  const breachedSql = sql`(j.complete_by < now() AND j.status NOT IN ('completed','invoiced','cancelled'))`;
  const openSql = sql`j.status IN ('request','quoted','scheduled','dispatched','in_progress','on_hold')`;
  const internalSql = sql`j.unit_id IS NOT NULL`;

  const tabClause: SQL =
    tab === "open" ? sql` AND ${openSql}`
    : tab === "breached" ? sql` AND ${breachedSql}`
    : tab === "invoiced" ? sql` AND j.status = 'invoiced'`
    : tab === "internal" ? sql` AND ${internalSql}`
    : sql``;
  const tradeClause: SQL = trade ? sql` AND j.service_kind = ${trade}` : sql``;

  const { jobs, byTrade, techs, facets, slice } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      /* One aggregate pass: every tab badge, the two stat-strip counts that used
         to be measured off the fetched array, and the pager total. The trade
         filter is included because a badge that ignores the active trade would
         promise rows the list cannot show. */
      const [f] = await tx.execute<{
        every: number; open: number; breached: number; invoiced: number;
        internal: number; active: number;
      }>(sql`
        SELECT COUNT(*)::int AS every,
               COUNT(*) FILTER (WHERE ${openSql})::int AS open,
               COUNT(*) FILTER (WHERE ${breachedSql})::int AS breached,
               COUNT(*) FILTER (WHERE j.status = 'invoiced')::int AS invoiced,
               COUNT(*) FILTER (WHERE ${internalSql})::int AS internal,
               COUNT(*) FILTER (WHERE TRUE ${tabClause})::int AS active
          FROM jobs j
         WHERE TRUE ${tradeClause}
      `);
      const facets = f ?? { every: 0, open: 0, breached: 0, invoiced: 0, internal: 0, active: 0 };

      const slice = pageSlice({ page: rawPage, per: rawPer }, facets.active);

      const jobs = await tx.execute<{
        id: string; job_number: string; service_kind: string; title: string;
        status: string; priority: string; party: string | null; site: string | null;
        unit_code: string | null; reported_at: string; complete_by: string | null;
        breached: boolean; quoted: string; labor_cost: string; material_cost: string;
        technician: string | null; rating: number | null;
      }>(sql`
        SELECT j.id, j.job_number, j.service_kind, j.title, j.status::text, j.priority::text,
               p.display_name AS party, st.name AS site, u.code AS unit_code,
               j.reported_at::text, j.complete_by::text,
               (j.complete_by < now() AND j.status NOT IN ('completed','invoiced','cancelled')) AS breached,
               j.quoted_value AS quoted, j.labor_cost, j.material_cost,
               e.full_name AS technician, j.customer_rating AS rating
          FROM jobs j
          LEFT JOIN parties p ON p.id = j.party_id
          LEFT JOIN sites st ON st.id = j.site_id
          LEFT JOIN units u ON u.id = j.unit_id
          LEFT JOIN LATERAL (
            SELECT employee_id FROM job_visits WHERE job_id = j.id ORDER BY seq LIMIT 1
          ) v ON true
          LEFT JOIN employees e ON e.id = v.employee_id
         WHERE TRUE ${tabClause} ${tradeClause}
         -- Trailing j.id makes the sort total. Jobs are reported in bursts and
         -- tie on reported_at; without it a page boundary can repeat or drop one.
         ORDER BY ${breachedSql} DESC, j.reported_at DESC, j.id
         LIMIT ${slice.perPage} OFFSET ${slice.offset}
      `);

      const byTrade = await tx.execute<{ service_kind: string; n: number; revenue: string; cost: string }>(sql`
        SELECT service_kind, COUNT(*)::int AS n,
               COALESCE(SUM(invoiced_value), 0) AS revenue,
               COALESCE(SUM(labor_cost + material_cost), 0) AS cost
          FROM jobs
         WHERE reported_at >= ${today}::date - 90
         GROUP BY 1 ORDER BY 3 DESC
      `);

      const techs = await tx.execute<{ name: string; done: number; avg_rating: string | null }>(sql`
        SELECT e.full_name AS name, COUNT(*) FILTER (WHERE jv.status = 'done')::int AS done,
               ROUND(AVG(j.customer_rating), 1)::text AS avg_rating
          FROM job_visits jv
          JOIN employees e ON e.id = jv.employee_id
          JOIN jobs j ON j.id = jv.job_id
         WHERE jv.scheduled_start >= ${today}::date - 30
         GROUP BY e.full_name ORDER BY 2 DESC
      `);

      return { jobs, byTrade, techs, facets, slice };
    },
  );

  const breachedCount = facets.breached;
  const internalCount = facets.internal;
  const revenue90 = byTrade.reduce((t, r) => t + Number(r.revenue), 0);
  const cost90 = byTrade.reduce((t, r) => t + Number(r.cost), 0);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader
        title="Service jobs"
        subtitle="AC, plumbing, electrical, handyman and cleaning — one board, five trades"
      />

      <StatStrip
        stats={[
          { label: "Open jobs", value: String(open?.value ?? 0) },
          {
            label: "Past SLA",
            value: String(breachedCount),
            tone: breachedCount > 0 ? "negative" : "positive",
            hint: "Best predictor of complaints",
          },
          { label: "Revenue, 90 days", value: formatMoney(revenue90, ccy, 0) },
          {
            label: "Gross margin",
            value: revenue90 ? `${(((revenue90 - cost90) / revenue90) * 100).toFixed(0)}%` : "—",
            tone: "positive",
            hint: formatMoney(revenue90 - cost90, ccy, 0),
          },
          {
            label: "On own properties",
            value: String(internalCount),
            tone: "accent",
            hint: "Inter-company billed",
          },
        ]}
      />

      <div className="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader title="By trade" subtitle="Last 90 days, ranked by revenue" />
          <DataTable
            rows={byTrade}
            rowKey={(r) => r.service_kind}
            empty={<TableEmpty title="No jobs yet" detail="Nothing recorded." />}
            columns={[
              {
                key: "trade", header: "Trade",
                render: (r) => (
                  <span className="font-medium">
                    {TRADE_LABEL[r.service_kind] ?? r.service_kind}
                  </span>
                ),
              },
              { key: "n", header: "Jobs", numeric: true, render: (r) => r.n },
              { key: "rev", header: "Revenue", numeric: true, render: (r) => formatMoney(Number(r.revenue), ccy, 0) },
              { key: "cost", header: "Cost", numeric: true, render: (r) => <span className="text-muted">{formatMoney(Number(r.cost), ccy, 0)}</span> },
              {
                key: "margin", header: "Margin", numeric: true,
                render: (r) => {
                  const rev = Number(r.revenue);
                  const marg = rev - Number(r.cost);
                  return rev > 0 ? (
                    <span
                      className="font-semibold"
                      style={{ color: marg / rev > 0.4 ? "var(--positive)" : "var(--caution)" }}
                    >
                      {((marg / rev) * 100).toFixed(0)}%
                    </span>
                  ) : (
                    <span className="text-subtle">—</span>
                  );
                },
              },
            ]}
          />
        </Card>

        <Card>
          <CardHeader title="Technicians" subtitle="Visits completed, last 30 days" />
          <div className="px-4 pb-4">
            {techs.length === 0 ? (
              <TableEmpty title="No visits" detail="Nothing this month." />
            ) : (
              techs.map((t) => (
                <div
                  key={t.name}
                  className="flex items-baseline justify-between gap-2 py-1.5 border-b last:border-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <span className="text-xs truncate">{t.name}</span>
                  <span className="text-xs tnum shrink-0">
                    {t.done}
                    {t.avg_rating && (
                      <span className="text-2xs text-subtle ml-1.5">★ {t.avg_rating}</span>
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Jobs"
          subtitle="SLA breaches first"
          action={
            <FilterTabs
              basePath="/services"
              active={tab}
              defaultKey="open"
              // The trade travels with the tab, otherwise narrowing an AC board
              // to "Past SLA" silently widens it back to all five trades.
              params={{ trade }}
              options={[
                { key: "open", label: "Open", count: facets.open },
                { key: "breached", label: "Past SLA", count: facets.breached },
                { key: "internal", label: "Own units", count: facets.internal },
                { key: "invoiced", label: "Invoiced", count: facets.invoiced },
                { key: "all", label: "All", count: facets.every },
              ]}
            />
          }
        />
        <DataTable
          rows={jobs}
          rowKey={(j) => j.id}
          empty={<TableEmpty title="No jobs match" detail="Try a different filter." />}
          columns={[
            {
              key: "job", header: "Job",
              render: (j) => (
                <div className="min-w-0">
                  <p className="font-medium truncate">{j.title}</p>
                  <p className="text-2xs text-subtle tnum">{j.job_number}</p>
                </div>
              ),
            },
            {
              key: "trade", header: "Trade",
              render: (j) => (
                <span className="chip" style={{ background: "var(--surface-3)", color: "var(--text-muted)" }}>
                  {TRADE_LABEL[j.service_kind] ?? j.service_kind}
                </span>
              ),
            },
            {
              key: "where", header: "Customer / site",
              render: (j) => (
                <div className="min-w-0">
                  {j.unit_code ? (
                    <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                      own unit {j.unit_code}
                    </span>
                  ) : (
                    <p className="truncate">{j.party ?? "—"}</p>
                  )}
                  <p className="text-2xs text-subtle truncate">{j.site}</p>
                </div>
              ),
            },
            { key: "tech", header: "Technician", render: (j) => j.technician ?? <span className="text-subtle">unassigned</span> },
            {
              key: "priority", header: "Priority",
              render: (j) =>
                j.priority === "emergency" ? (
                  <span className="chip" style={{ background: "var(--negative-soft)", color: "var(--negative)" }}>
                    emergency
                  </span>
                ) : (
                  <span className="text-muted text-2xs">{j.priority}</span>
                ),
            },
            {
              key: "status", header: "Status",
              render: (j) => (
                <div className="flex items-center gap-1.5">
                  <StatusPill status={j.status} />
                  {j.breached && (
                    <span className="chip" style={{ background: "var(--negative-soft)", color: "var(--negative)" }}>
                      SLA
                    </span>
                  )}
                </div>
              ),
            },
            {
              key: "value", header: "Value", numeric: true,
              render: (j) => formatMoney(Number(j.quoted), ccy, 0),
            },
            {
              key: "do", header: "", numeric: true,
              render: (j) =>
                OPEN_STATUSES.includes(j.status) ? (
                  <ActionForm action={completeJobAction} submitLabel="Complete"
                    pendingLabel="…" variant="ghost" hidden={{ jobId: j.id }} />
                ) : null,
            },
          ]}
        />
        <Pagination
          slice={slice}
          basePath="/services"
          params={{ filter: tab === "open" ? undefined : tab, trade }}
          noun="jobs"
        />
      </Card>
    </div>
  );
}
