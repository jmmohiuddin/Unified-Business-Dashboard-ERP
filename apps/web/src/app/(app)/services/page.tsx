import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { completeJobAction } from "@/lib/actions";
import {
  DataTable, FilterTabs, PageHeader, StatStrip, StatusPill, TableEmpty,
} from "@/components/page";

export const dynamic = "force-dynamic";

const TRADE_LABEL: Record<string, string> = {
  ac_service: "AC", plumbing: "Plumbing", electrical: "Electrical",
  handyman: "Handyman", cleaning: "Cleaning",
};

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
 */
export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; trade?: string }>;
}) {
  const session = await requireSession();
  const { filter = "open", trade } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const m = await loadMetrics(session, [{ metricId: "open_service_requests" }]);
  const open = metric(m, "open_service_requests");

  const { jobs, byTrade, techs } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
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
         ORDER BY
           (j.complete_by < now() AND j.status NOT IN ('completed','invoiced','cancelled')) DESC,
           j.reported_at DESC
         LIMIT 400
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

      return { jobs, byTrade, techs };
    },
  );

  const OPEN = ["request", "quoted", "scheduled", "dispatched", "in_progress", "on_hold"];
  let filtered =
    filter === "open" ? jobs.filter((j) => OPEN.includes(j.status))
    : filter === "breached" ? jobs.filter((j) => j.breached)
    : filter === "invoiced" ? jobs.filter((j) => j.status === "invoiced")
    : filter === "internal" ? jobs.filter((j) => j.unit_code !== null)
    : jobs;
  if (trade) filtered = filtered.filter((j) => j.service_kind === trade);

  const breachedCount = jobs.filter((j) => j.breached).length;
  const internalCount = jobs.filter((j) => j.unit_code !== null).length;
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
              active={filter}
              options={[
                { key: "open", label: "Open", count: jobs.filter((j) => OPEN.includes(j.status)).length },
                { key: "breached", label: "Past SLA", count: breachedCount },
                { key: "internal", label: "Own units", count: internalCount },
                { key: "invoiced", label: "Invoiced", count: jobs.filter((j) => j.status === "invoiced").length },
                { key: "all", label: "All", count: jobs.length },
              ]}
            />
          }
        />
        <DataTable
          rows={filtered.slice(0, 80)}
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
                OPEN.includes(j.status) ? (
                  <ActionForm action={completeJobAction} submitLabel="Complete"
                    pendingLabel="…" variant="ghost" hidden={{ jobId: j.id }} />
                ) : null,
            },
          ]}
        />
        {filtered.length > 80 && (
          <p className="text-2xs text-subtle px-4 pb-3">
            Showing 80 of {filtered.length}. Pagination lands with the dispatch board in Phase 2.
          </p>
        )}
      </Card>
    </div>
  );
}
