import Link from "next/link";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { daysUntil, formatMoney, formatMoneyCompact } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import {
  BuTag, DataTable, DaysPill, FilterTabs, PageHeader, StatStrip, StatusPill, TableEmpty,
} from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * Rentals — apartments and parking bays in one screen.
 *
 * They are the same domain object (a space, let for a term, at a recurring
 * charge) so they share a module. The differences that matter are surfaced
 * rather than hidden: residential rent is VAT-exempt while parking is standard
 * rated, and the collection method differs — cheque bundles dominate flats,
 * transfers are common for bays.
 */
export default async function RentalsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const session = await requireSession();
  const { filter = "all" } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const m = await loadMetrics(session, [{ metricId: "occupancy_rate" }]);
  const occ = metric(m, "occupancy_rate");

  const { units, leases, counts } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const units = await tx.execute<{
        id: string; code: string; name: string | null; kind: string; status: string;
        list_rent: string; bedrooms: number | null; area: string | null;
        bu: string; color_token: string; site: string; tenant_name: string | null;
        lease_ends: string | null;
      }>(sql`
        SELECT u.id, u.code, u.name, u.kind::text, u.status::text, u.list_rent,
               u.bedrooms, u.area_sqft AS area, b.name AS bu, b.color_token,
               st.name AS site, p.display_name AS tenant_name, l.ends_on::text AS lease_ends
          FROM units u
          JOIN business_units b ON b.id = u.business_unit_id
          JOIN sites st ON st.id = u.site_id
          LEFT JOIN leases l ON l.unit_id = u.id AND l.status = 'active'
          LEFT JOIN parties p ON p.id = l.party_id
         ORDER BY b.sort_order, u.code
      `);

      const leases = await tx.execute<{
        id: string; lease_number: string; unit: string; kind: string; party: string;
        phone: string | null; annual_rent: string; rent_amount: string; status: string;
        starts_on: string; ends_on: string | null; collection: string;
        cheque_count: number | null; ejari: string | null; balance_due: string;
        bu: string; color_token: string;
      }>(sql`
        SELECT l.id, l.lease_number, u.code AS unit, u.kind::text AS kind,
               p.display_name AS party, p.primary_phone AS phone,
               l.annual_rent, l.rent_amount, l.status::text, l.starts_on::text,
               l.ends_on::text, l.collection_method::text AS collection,
               l.cheque_count, l.ejari_number AS ejari, l.balance_due,
               b.name AS bu, b.color_token
          FROM leases l
          JOIN units u ON u.id = l.unit_id
          JOIN parties p ON p.id = l.party_id
          JOIN business_units b ON b.id = l.business_unit_id
         WHERE l.status = 'active'
         ORDER BY l.ends_on NULLS LAST
      `);

      const counts = await tx.execute<{ vacant: number; expiring: number; arrears: number }>(sql`
        SELECT
          (SELECT COUNT(*)::int FROM units WHERE status <> 'occupied') AS vacant,
          (SELECT COUNT(*)::int FROM leases
            WHERE status = 'active' AND ends_on BETWEEN ${today}::date AND ${today}::date + 60) AS expiring,
          (SELECT COUNT(*)::int FROM leases WHERE status = 'active' AND balance_due > 0) AS arrears
      `);

      return { units, leases, counts };
    },
  );

  const filtered =
    filter === "vacant" ? units.filter((u) => u.status !== "occupied")
    : filter === "apartments" ? units.filter((u) => u.kind === "apartment")
    : filter === "parking" ? units.filter((u) => u.kind === "parking_bay")
    : units;

  const expiringLeases =
    filter === "expiring"
      ? leases.filter((l) => l.ends_on && daysUntil(l.ends_on, today) <= 60)
      : leases;

  const vacancyCost = Number(
    occ?.breakdown?.find((b) => b.key === "vacancy_cost")?.value ?? 0,
  );
  const annualRoll = leases.reduce((t, l) => t + Number(l.annual_rent), 0);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader
        title="Rentals"
        subtitle="Al Waseem Residence, JVC · Bay Square Parking, Business Bay"
        actions={
          <Link href="/rentals/cheques" className="btn btn-primary text-xs">
            Cheque register →
          </Link>
        }
      />

      <StatStrip
        stats={[
          { label: "Occupancy", value: `${occ?.value ?? 0}%`, tone: (occ?.value ?? 0) >= 85 ? "positive" : "caution" },
          { label: "Annual rent roll", value: formatMoney(annualRoll, ccy, 0), hint: `${leases.length} active leases` },
          {
            label: "Vacant units",
            value: String(counts[0]?.vacant ?? 0),
            tone: (counts[0]?.vacant ?? 0) > 0 ? "negative" : "positive",
            hint: `${formatMoneyCompact(vacancyCost, ccy)}/mo lost`,
          },
          {
            label: "Expiring ≤60 days",
            value: String(counts[0]?.expiring ?? 0),
            tone: (counts[0]?.expiring ?? 0) > 0 ? "caution" : "positive",
          },
          {
            label: "In arrears",
            value: String(counts[0]?.arrears ?? 0),
            tone: (counts[0]?.arrears ?? 0) > 0 ? "negative" : "positive",
          },
        ]}
      />

      <Card>
        <CardHeader
          title="Leases"
          subtitle="Annual contracts, billed monthly for accrual accuracy"
          action={
            <FilterTabs
              basePath="/rentals"
              active={filter === "expiring" ? "expiring" : "all"}
              options={[
                { key: "all", label: "All", count: leases.length },
                { key: "expiring", label: "Expiring", count: counts[0]?.expiring ?? 0 },
              ]}
            />
          }
        />
        <DataTable
          rows={expiringLeases}
          rowKey={(l) => l.id}
          empty={<TableEmpty title="No leases match" detail="Try a different filter." />}
          columns={[
            {
              key: "unit", header: "Unit",
              render: (l) => (
                <div>
                  <p className="font-medium">{l.unit}</p>
                  <BuTag name={l.bu} color={l.color_token} />
                </div>
              ),
            },
            {
              key: "party", header: "Tenant",
              render: (l) => (
                <div className="min-w-0">
                  <p className="truncate">{l.party}</p>
                  <p className="text-2xs text-subtle truncate">{l.phone}</p>
                </div>
              ),
            },
            {
              key: "rent", header: "Annual rent", numeric: true,
              render: (l) => (
                <div>
                  <div>{formatMoney(Number(l.annual_rent), ccy, 0)}</div>
                  <div className="text-2xs text-subtle">
                    {formatMoney(Number(l.rent_amount), ccy, 0)}/mo
                  </div>
                </div>
              ),
            },
            {
              key: "collection", header: "Collection",
              render: (l) =>
                l.collection === "post_dated_cheques" ? (
                  <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                    {l.cheque_count} cheques
                  </span>
                ) : (
                  <span className="chip" style={{ background: "var(--surface-3)", color: "var(--text-muted)" }}>
                    transfer
                  </span>
                ),
            },
            {
              key: "vat", header: "VAT",
              render: (l) =>
                l.kind === "apartment" ? (
                  <span className="text-2xs text-muted">exempt</span>
                ) : (
                  <span className="text-2xs text-muted">5%</span>
                ),
            },
            {
              key: "ejari", header: "Ejari",
              render: (l) =>
                l.ejari ? (
                  <span className="tnum text-2xs text-muted">{l.ejari}</span>
                ) : (
                  <span className="chip" style={{ background: "var(--negative-soft)", color: "var(--negative)" }}>
                    missing
                  </span>
                ),
            },
            {
              key: "ends", header: "Expires", numeric: true,
              render: (l) => (l.ends_on ? <DaysPill days={daysUntil(l.ends_on, today)} /> : "—"),
            },
            {
              key: "due", header: "Arrears", numeric: true,
              render: (l) =>
                Number(l.balance_due) > 0 ? (
                  <span style={{ color: "var(--negative)" }} className="font-semibold">
                    {formatMoney(Number(l.balance_due), ccy, 0)}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
          ]}
        />
      </Card>

      <Card>
        <CardHeader
          title="Units"
          subtitle="Apartments and parking bays share one model — a space, let for a term"
          action={
            <FilterTabs
              basePath="/rentals"
              active={["vacant", "apartments", "parking"].includes(filter) ? filter : "all"}
              options={[
                { key: "all", label: "All", count: units.length },
                { key: "apartments", label: "Flats", count: units.filter((u) => u.kind === "apartment").length },
                { key: "parking", label: "Bays", count: units.filter((u) => u.kind === "parking_bay").length },
                { key: "vacant", label: "Vacant", count: counts[0]?.vacant ?? 0 },
              ]}
            />
          }
        />
        <DataTable
          rows={filtered}
          rowKey={(u) => u.id}
          empty={<TableEmpty title="No units match" detail="Try a different filter." />}
          columns={[
            {
              key: "code", header: "Unit",
              render: (u) => (
                <div>
                  <p className="font-medium">{u.name ?? u.code}</p>
                  <p className="text-2xs text-subtle">{u.site}</p>
                </div>
              ),
            },
            {
              key: "kind", header: "Type",
              render: (u) => (
                <span className="text-muted">
                  {u.kind === "parking_bay"
                    ? "Parking bay"
                    : `${u.bedrooms ?? "?"} bed · ${Math.round(Number(u.area ?? 0))} sqft`}
                </span>
              ),
            },
            { key: "status", header: "Status", render: (u) => <StatusPill status={u.status} /> },
            {
              key: "tenant", header: "Tenant",
              render: (u) =>
                u.tenant_name ?? <span className="text-subtle">vacant</span>,
            },
            {
              key: "rent", header: "Rent / month", numeric: true,
              render: (u) => formatMoney(Number(u.list_rent), ccy, 0),
            },
            {
              key: "annual", header: "Annual", numeric: true,
              render: (u) => (
                <span className="text-muted">{formatMoney(Number(u.list_rent) * 12, ccy, 0)}</span>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
