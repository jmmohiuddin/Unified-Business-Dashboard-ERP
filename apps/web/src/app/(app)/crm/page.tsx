import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import {
  DataTable, FilterTabs, PageHeader, Pagination, StatStrip, TableEmpty, pageSlice,
} from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * Customers.
 *
 * One record per human, whatever role they play. In this portfolio the same
 * person is routinely a salon customer, the tenant in flat 402 and an occasional
 * service caller — the "Also a" column exists to make that visible, because it
 * is the cross-sell insight that separate customer tables destroy.
 *
 * Search is a plain GET form so results are shareable and there is no client
 * JavaScript; it hits a pg_trgm index on name + phone.
 *
 * TWO NAMES FOR ONE SEGMENT. `customer_churn_risk` declares its drill-down as
 * `/crm?segment=at_risk`, while this screen's own tab chips write `?filter=…`.
 * The route guard flagged it: the path resolved, so the owner got a real page —
 * the complete 447-record customer list rather than the 26 people the tile said
 * were at risk. Both spellings are read here rather than renaming one end,
 * because the metric registry is shared and its declared parameter is part of
 * its published contract.
 */
export default async function CrmPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string; filter?: string; segment?: string; page?: string; per?: string;
  }>;
}) {
  const session = await requireSession();
  const {
    q = "", filter, segment: rawSegment, page: rawPage, per: rawPer,
  } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;
  const term = q.trim();
  // The tabs write `filter`, so it wins when both are present; `segment` is the
  // metric registry's spelling and only ever arrives on a fresh drill-down.
  const active = filter ?? rawSegment ?? "all";

  const { rows, stats, slice } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const search = term
        ? sql`AND (p.display_name ILIKE ${"%" + term + "%"} OR p.primary_phone ILIKE ${"%" + term + "%"})`
        : sql``;
      // `is_customer` is part of the at-risk definition in the metric that links
      // here. Repeating it keeps the drill-down reconciling to the tile by
      // construction rather than by the coincidence that every at-risk party in
      // today's data happens to be a customer.
      const segment =
        active === "at_risk"
          ? sql`AND p.is_customer = true AND p.churn_risk IN ('medium','high') AND p.visit_count >= 2`
        : active === "tenants" ? sql`AND p.is_tenant_renter = true`
        : active === "suppliers" ? sql`AND p.is_supplier = true`
        : active === "owing" ? sql`AND p.open_balance > 0`
        : sql``;

      // Counted over exactly the search + segment the rows use, so "1–50 of 26"
      // can never disagree with the tab badge beside it.
      const [c] = await tx.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM parties p WHERE TRUE ${search} ${segment}
      `);
      const total = c?.n ?? 0;
      const slice = pageSlice({ page: rawPage, per: rawPer }, total);

      const rows = await tx.execute<{
        id: string; display_name: string; type: string; phone: string | null;
        email: string | null; is_customer: boolean; is_supplier: boolean;
        is_tenant: boolean; ltv: string; open_balance: string; visits: number;
        recency: number | null; churn: string | null; businesses: string | null;
      }>(sql`
        SELECT p.id, p.display_name, p.type::text, p.primary_phone AS phone, p.email,
               p.is_customer, p.is_supplier, p.is_tenant_renter AS is_tenant,
               p.lifetime_value AS ltv, p.open_balance, p.visit_count AS visits,
               p.rfm_recency AS recency, p.churn_risk AS churn,
               (SELECT STRING_AGG(DISTINCT b.name, ', ')
                  FROM party_business_units pbu
                  JOIN business_units b ON b.id = pbu.business_unit_id
                 WHERE pbu.party_id = p.id) AS businesses
          FROM parties p
         WHERE TRUE ${search} ${segment}
         -- Trailing p.id makes the sort total: 218 of the 447 records share a
         -- lifetime value of zero, and OFFSET paging over a tie like that
         -- reshuffles between requests, showing some people twice and others
         -- never.
         ORDER BY p.lifetime_value DESC, p.id
         LIMIT ${slice.perPage} OFFSET ${slice.offset}
      `);

      const stats = await tx.execute<{
        total: number; customers: number; tenants: number; at_risk: number;
        owing: number; owed: string; multi: number;
      }>(sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE is_customer)::int AS customers,
               COUNT(*) FILTER (WHERE is_tenant_renter)::int AS tenants,
               COUNT(*) FILTER (WHERE is_customer AND churn_risk IN ('medium','high') AND visit_count >= 2)::int AS at_risk,
               COUNT(*) FILTER (WHERE open_balance > 0)::int AS owing,
               COALESCE(SUM(open_balance), 0) AS owed,
               (SELECT COUNT(*)::int FROM (
                  SELECT party_id FROM party_business_units
                   GROUP BY party_id HAVING COUNT(DISTINCT business_unit_id) > 1
                ) z) AS multi
          FROM parties
      `);

      return { rows, stats, total, slice };
    },
  );

  const s = stats[0];

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader
        title="Customers"
        subtitle="One record per person — customer, tenant, supplier or all three"
        actions={
          <form action="/crm" method="get" className="flex gap-1.5">
            <input
              name="q"
              defaultValue={term}
              placeholder="Name or phone…"
              aria-label="Search customers"
              className="px-3 py-1.5 rounded-[var(--radius-md)] text-xs w-48"
              style={{ background: "var(--surface)", border: "1px solid var(--border-strong)" }}
            />
            <button type="submit" className="btn btn-primary text-xs">
              Search
            </button>
          </form>
        }
      />

      <StatStrip
        stats={[
          { label: "Total records", value: String(s?.total ?? 0) },
          { label: "Customers", value: String(s?.customers ?? 0) },
          {
            label: "Across 2+ businesses",
            value: String(s?.multi ?? 0),
            tone: "accent",
            hint: "Cross-sell base",
          },
          {
            label: "At risk",
            value: String(s?.at_risk ?? 0),
            tone: (s?.at_risk ?? 0) > 0 ? "caution" : "positive",
            hint: "Repeat buyers gone quiet",
          },
          {
            label: "Owing you",
            value: formatMoney(Number(s?.owed ?? 0), ccy, 0),
            tone: Number(s?.owed ?? 0) > 0 ? "negative" : "positive",
            hint: `${s?.owing ?? 0} people`,
          },
        ]}
      />

      <Card>
        <CardHeader
          title={term ? `Results for “${term}”` : "All records"}
          subtitle="Ranked by lifetime value"
          action={
            <FilterTabs
              basePath="/crm"
              active={active}
              // The search term travels with the tab: narrowing a search to a
              // segment must not throw the search away.
              params={{ q: term || undefined }}
              options={[
                { key: "all", label: "All" },
                { key: "at_risk", label: "At risk", count: s?.at_risk ?? 0 },
                { key: "tenants", label: "Tenants", count: s?.tenants ?? 0 },
                { key: "owing", label: "Owing", count: s?.owing ?? 0 },
                { key: "suppliers", label: "Suppliers" },
              ]}
            />
          }
        />
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          empty={
            <TableEmpty
              title={term ? "Nobody matches that search" : "No records"}
              detail={term ? "Try part of a name or phone number." : "Nothing to show."}
            />
          }
          columns={[
            {
              key: "name", header: "Name",
              render: (r) => (
                <div className="min-w-0">
                  <p className="font-medium truncate">{r.display_name}</p>
                  <p className="text-2xs text-subtle truncate">
                    {r.phone}
                    {r.email ? ` · ${r.email}` : ""}
                  </p>
                </div>
              ),
            },
            {
              key: "roles", header: "Also a",
              render: (r) => {
                const roles = [
                  r.is_customer && "customer",
                  r.is_tenant && "tenant",
                  r.is_supplier && "supplier",
                ].filter(Boolean) as string[];
                return (
                  <div className="flex gap-1 flex-wrap">
                    {roles.map((role) => (
                      <span
                        key={role}
                        className="chip"
                        style={
                          role === "tenant"
                            ? { background: "var(--caution-soft)", color: "var(--caution)" }
                            : { background: "var(--surface-3)", color: "var(--text-muted)" }
                        }
                      >
                        {role}
                      </span>
                    ))}
                  </div>
                );
              },
            },
            {
              key: "businesses", header: "Businesses",
              render: (r) => (
                <span className="text-2xs text-muted">{r.businesses ?? "—"}</span>
              ),
            },
            { key: "visits", header: "Transactions", numeric: true, render: (r) => r.visits },
            {
              key: "recency", header: "Last seen", numeric: true,
              render: (r) =>
                r.recency === null ? (
                  <span className="text-subtle">never</span>
                ) : (
                  <span
                    style={{
                      color:
                        r.churn === "high" ? "var(--negative)"
                        : r.churn === "medium" ? "var(--caution)" : undefined,
                    }}
                  >
                    {r.recency}d ago
                  </span>
                ),
            },
            {
              key: "ltv", header: "Lifetime value", numeric: true,
              render: (r) => formatMoney(Number(r.ltv), ccy, 0),
            },
            {
              key: "owed", header: "Owes", numeric: true,
              render: (r) =>
                Number(r.open_balance) > 0 ? (
                  <span style={{ color: "var(--negative)" }} className="font-semibold">
                    {formatMoney(Number(r.open_balance), ccy, 0)}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
          ]}
        />
        <Pagination
          slice={slice}
          basePath="/crm"
          params={{ q: term || undefined, filter: active === "all" ? undefined : active }}
          noun="records"
        />
      </Card>
    </div>
  );
}
