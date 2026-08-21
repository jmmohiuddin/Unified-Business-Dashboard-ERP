import Link from "next/link";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { can, daysUntil, formatMoney, formatMoneyCompact } from "@nexus/core";
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
 *
 * FR-R04 turned this from a board into a place work starts. Three additions,
 * each replacing a number the owner could read but not act on:
 *
 *  • OCCUPANCY AS A BULLET GRAPH. "83%" is a fact; "83% against a 90% target,
 *    with three leases ending inside 60 days" is a decision. The bar carries
 *    the measure, the target and the qualitative bands in one glance, which is
 *    the whole reason the form exists.
 *  • ENDING SOON, WITH A RENEWAL LINK. A lease expiring in 22 days is the
 *    highest-value thing on this page and it used to be a chip in a column.
 *  • [LET] ON A VACANT UNIT. A vacant flat is rent burning every month; the
 *    action that stops it is now one click from the row that reports it.
 */

/**
 * The occupancy target.
 *
 * Hard-coded, and flagged as such. WF-05 §9.1 draws the bullet graph against
 * "target 90%", and nothing in the product stores a target for any metric yet —
 * there is no targets table and `MetricResult` has no field for one. A constant
 * here is honest about that; a target invented per screen and scattered across
 * the app would not be. When targets become configurable this becomes a lookup
 * and the component below does not change.
 */
const OCCUPANCY_TARGET = 90;

/**
 * Bullet graph.
 *
 * Stephen Few's form, and it is the right one here for the reason it was
 * invented: a single measure that only means something against a target and a
 * qualitative scale. Server-rendered inline SVG, like every other chart in this
 * app — a charting library would cost more bytes than the whole page.
 */
function OccupancyBullet({ value, target }: { value: number; target: number }) {
  const pct = Math.max(0, Math.min(100, value));
  const tgt = Math.max(0, Math.min(100, target));
  const tone =
    value >= target ? "var(--positive)" : value >= target - 10 ? "var(--caution)" : "var(--negative)";
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-2xl font-semibold tnum tracking-tight" style={{ color: tone }}>
          {value.toFixed(1)}%
        </span>
        <span className="text-2xs text-subtle">let</span>
      </div>
      <svg
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        className="w-full h-4"
        role="img"
        aria-label={`Occupancy ${value.toFixed(1)} percent against a target of ${target} percent`}
      >
        {/* Qualitative bands: poor, satisfactory, good. Lightest is best. */}
        <rect x="0" y="0" width="100" height="10" fill="var(--surface-3)" />
        <rect x="0" y="0" width={String(tgt - 10)} height="10" fill="var(--surface-2)" opacity="0.6" />
        {/* The measure. */}
        <rect x="0" y="3" width={String(pct)} height="4" fill={tone} />
        {/* The target marker. */}
        <rect x={String(tgt - 0.4)} y="0.5" width="0.8" height="9" fill="var(--text)" />
      </svg>
      <div className="flex justify-between text-2xs text-subtle mt-1">
        <span>0%</span>
        <span className="tnum">target {target}%</span>
      </div>
    </div>
  );
}

export default async function RentalsPage({
  searchParams,
}: {
  searchParams: Promise<{ leases?: string; units?: string; filter?: string }>;
}) {
  const session = await requireSession();
  /**
   * Two filters, two search params.
   *
   * They shared one `filter` param, so choosing "Vacant" under Units silently
   * reset the Leases tabs to "All" and vice versa — two controls fighting over
   * one piece of state, on a screen whose whole job is comparing the two
   * tables. They are now independent.
   *
   * The "show everything" option is keyed `any` rather than `all` because
   * `FilterTabs` renders the key `all` as the bare base path with no query
   * string at all, which would drop the sibling filter on the way past. That
   * component is shared and not this feature's to change; the right fix is a
   * `preserve` prop on `FilterTabs` so a tab strip carries the params it does
   * not own, and it is raised with the coordinator. Until then, no key here is
   * called `all` and both params survive every click.
   */
  const params = await searchParams;
  /**
   * `?filter=expiring` is the old single param, still linked from the Today
   * screen's lease-expiry action item (`lib/data.ts`). It is honoured as an
   * alias for the leases filter so that link keeps working — a route guard
   * warning about a parameter the page ignores is the mild version of the
   * failure; the real one is an owner clicking "3 leases expiring" and landing
   * on an unfiltered list. The alias goes when that href becomes
   * `?leases=expiring`, which is a change in a coordinator-owned file.
   */
  const leaseFilter = params.leases ?? params.filter ?? "any";
  const unitFilter = params.units ?? "any";
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const m = await loadMetrics(session, [{ metricId: "occupancy_rate" }]);
  const occ = metric(m, "occupancy_rate");

  const mayWrite = can(session.principal, "lease:create");

  const { units, leases, counts, endingSoon } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const units = await tx.execute<{
        id: string; code: string; name: string | null; kind: string; status: string;
        list_rent: string; bedrooms: number | null; area: string | null;
        bu: string; color_token: string; site: string; tenant_name: string | null;
        lease_id: string | null; lease_ends: string | null;
      }>(sql`
        SELECT u.id, u.code, u.name, u.kind::text, u.status::text, u.list_rent,
               u.bedrooms, u.area_sqft AS area, b.name AS bu, b.color_token,
               st.name AS site, p.display_name AS tenant_name,
               l.id AS lease_id, l.ends_on::text AS lease_ends
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
        bu: string; color_token: string; treatment: string | null; tax_code: string | null;
      }>(sql`
        SELECT l.id, l.lease_number, u.code AS unit, u.kind::text AS kind,
               p.display_name AS party, p.primary_phone AS phone,
               l.annual_rent, l.rent_amount, l.status::text, l.starts_on::text,
               l.ends_on::text, l.collection_method::text AS collection,
               l.cheque_count, l.ejari_number AS ejari, l.balance_due,
               b.name AS bu, b.color_token,
               tc.treatment::text AS treatment, tc.code AS tax_code
          FROM leases l
          JOIN units u ON u.id = l.unit_id
          JOIN parties p ON p.id = l.party_id
          JOIN business_units b ON b.id = l.business_unit_id
          LEFT JOIN LATERAL (
            SELECT c.item_id FROM lease_charges c
             WHERE c.lease_id = l.id AND c.is_active = true
             ORDER BY c.created_at LIMIT 1
          ) lc ON TRUE
          LEFT JOIN items i ON i.id = lc.item_id
          LEFT JOIN tax_codes tc ON tc.id = i.tax_code_id
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

      /**
       * The vacancy forecast FR-R04 asks for.
       *
       * Auto-renewing tenancies are excluded: they are not a forthcoming
       * vacancy, and listing them turns a queue of things to do into a list to
       * scroll past. Ordered by urgency, not by unit.
       */
      const endingSoon = await tx.execute<{
        id: string; lease_number: string; unit: string; unit_name: string | null;
        party: string; ends_on: string; rent_amount: string; bu: string; color_token: string;
      }>(sql`
        SELECT l.id, l.lease_number, u.code AS unit, u.name AS unit_name,
               p.display_name AS party, l.ends_on::text, l.rent_amount,
               b.name AS bu, b.color_token
          FROM leases l
          JOIN units u ON u.id = l.unit_id
          JOIN parties p ON p.id = l.party_id
          JOIN business_units b ON b.id = l.business_unit_id
         WHERE l.status IN ('active', 'expiring')
           AND l.auto_renew = false
           AND l.ends_on IS NOT NULL
           AND l.ends_on <= ${today}::date + 60
         ORDER BY l.ends_on
         LIMIT 10
      `);

      return { units, leases, counts, endingSoon };
    },
  );

  const filteredUnits =
    unitFilter === "vacant" ? units.filter((u) => u.status !== "occupied")
    : unitFilter === "apartments" ? units.filter((u) => u.kind === "apartment")
    : unitFilter === "parking" ? units.filter((u) => u.kind === "parking_bay")
    : units;

  const filteredLeases =
    leaseFilter === "expiring"
      ? leases.filter((l) => l.ends_on && daysUntil(l.ends_on, today) <= 60)
      : leaseFilter === "arrears"
        ? leases.filter((l) => Number(l.balance_due) > 0)
        : leases;

  const vacancyCost = Number(
    occ?.breakdown?.find((b) => b.key === "vacancy_cost")?.value ?? 0,
  );
  const annualRoll = leases.reduce((t, l) => t + Number(l.annual_rent), 0);
  const occupancy = occ?.value ?? 0;
  const letCount = units.filter((u) => u.status === "occupied").length;

  // Preserve the sibling filter across a click. See the note above.
  const unitsParam = leaseFilter === "any" ? "units" : `leases=${leaseFilter}&units`;
  const leasesParam = unitFilter === "any" ? "leases" : `units=${unitFilter}&leases`;

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader
        title="Rentals"
        subtitle="Al Waseem Residence, JVC · Bay Square Parking, Business Bay"
        actions={
          <>
            {mayWrite && (
              <Link href="/rentals/lease/new" className="btn btn-primary text-xs">
                New lease
              </Link>
            )}
            <Link href="/rentals/cheques" className="btn text-xs" style={{ background: "var(--surface-2)" }}>
              Cheques →
            </Link>
          </>
        }
      />

      <StatStrip
        stats={[
          { label: "Occupancy", value: `${occupancy}%`, tone: occupancy >= OCCUPANCY_TARGET ? "positive" : "caution" },
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

      {/* ── The board: occupancy against target, what is ending, what to run ── */}
      <div className="grid lg:grid-cols-3 gap-5">
        <Card className="p-4" as="div">
          <p className="label mb-2">Occupancy</p>
          <OccupancyBullet value={occupancy} target={OCCUPANCY_TARGET} />
          <p className="text-2xs text-muted mt-3 leading-relaxed">
            {letCount} of {units.length} let.{" "}
            {(counts[0]?.expiring ?? 0) > 0
              ? `${counts[0]!.expiring} lease${counts[0]!.expiring === 1 ? "" : "s"} end within 60 days.`
              : "Nothing ends within 60 days."}{" "}
            {vacancyCost > 0 && (
              <>Vacancy is costing {formatMoneyCompact(vacancyCost, ccy)} a month.</>
            )}
          </p>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="Ending soon"
            subtitle="Within 60 days, excluding tenancies that renew themselves"
            action={
              <span className="chip" style={{ background: "var(--caution-soft)", color: "var(--caution)" }}>
                {endingSoon.length}
              </span>
            }
          />
          {endingSoon.length === 0 ? (
            <TableEmpty
              title="Nothing ends in the next 60 days"
              detail="The forecast looks at lease end dates, so this is a real all-clear rather than an empty query."
            />
          ) : (
            <ul className="px-4 pb-4 space-y-1.5">
              {endingSoon.map((l) => (
                <li
                  key={l.id}
                  className="flex items-center justify-between gap-3 py-1.5 border-b last:border-0"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">
                      {l.unit_name ?? l.unit} · {l.party}
                    </p>
                    <p className="text-2xs text-subtle truncate">
                      <BuTag name={l.bu} color={l.color_token} />
                      <span className="ml-1.5 tnum">
                        {formatMoney(Number(l.rent_amount), ccy, 0)}/mo · ends {l.ends_on}
                      </span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <DaysPill days={daysUntil(l.ends_on, today)} />
                    <Link href={`/rentals/lease/${l.id}`} className="btn text-2xs" style={{ background: "var(--surface-2)" }}>
                      Renew
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Link
        href="/rentals/rent-run"
        className="card block px-4 py-3 transition-colors hover:bg-surface-2"
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs font-semibold" style={{ color: "var(--accent)" }}>
              ▸ Rent run
            </p>
            <p className="text-2xs text-subtle mt-0.5 leading-relaxed">
              Raise a month of rent invoices in one action. Preview the exempt-versus-standard
              split before anything posts; running the same month twice creates nothing.
            </p>
          </div>
          <span className="text-2xs font-semibold" style={{ color: "var(--accent)" }}>
            Preview →
          </span>
        </div>
      </Link>

      <Card>
        <CardHeader
          title="Leases"
          subtitle="Annual contracts, billed monthly for accrual accuracy"
          action={
            <FilterTabs
              basePath="/rentals"
              param={leasesParam}
              active={["expiring", "arrears"].includes(leaseFilter) ? leaseFilter : "any"}
              options={[
                { key: "any", label: "All", count: leases.length },
                { key: "expiring", label: "Expiring", count: counts[0]?.expiring ?? 0 },
                { key: "arrears", label: "In arrears", count: counts[0]?.arrears ?? 0 },
              ]}
            />
          }
        />
        <DataTable
          rows={filteredLeases}
          rowKey={(l) => l.id}
          empty={<TableEmpty title="No leases match" detail="Try a different filter." />}
          columns={[
            {
              key: "unit", header: "Unit",
              render: (l) => (
                <div>
                  <Link href={`/rentals/lease/${l.id}`} className="font-medium hover:underline">
                    {l.unit}
                  </Link>
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
              /**
               * Read from the lease's own tax code, not inferred from the unit
               * kind. The column used to say "exempt" for anything that was an
               * apartment and "5%" for everything else — a display that agreed
               * with the invoice only by coincidence and would have gone on
               * agreeing right through a misconfigured lease. This is now the
               * same source the rent run bills from, so a mismatch is visible
               * here rather than on the VAT return.
               */
              render: (l) =>
                l.treatment === "exempt" ? (
                  <span className="text-2xs text-muted">exempt</span>
                ) : l.treatment ? (
                  <span className="text-2xs" style={{ color: "var(--caution)" }}>
                    {l.tax_code}
                  </span>
                ) : (
                  <span className="chip" style={{ background: "var(--negative-soft)", color: "var(--negative)" }}>
                    not set
                  </span>
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
              param={unitsParam}
              active={["vacant", "apartments", "parking"].includes(unitFilter) ? unitFilter : "any"}
              options={[
                { key: "any", label: "All", count: units.length },
                { key: "apartments", label: "Flats", count: units.filter((u) => u.kind === "apartment").length },
                { key: "parking", label: "Bays", count: units.filter((u) => u.kind === "parking_bay").length },
                { key: "vacant", label: "Vacant", count: counts[0]?.vacant ?? 0 },
              ]}
            />
          }
        />
        <DataTable
          rows={filteredUnits}
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
                u.tenant_name ? (
                  u.lease_id ? (
                    <Link href={`/rentals/lease/${u.lease_id}`} className="hover:underline">
                      {u.tenant_name}
                    </Link>
                  ) : (
                    u.tenant_name
                  )
                ) : (
                  <span className="text-subtle">vacant</span>
                ),
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
            {
              key: "do", header: "",
              // The action that stops the meter running, on the row that
              // reports it running. A vacant unit is the only row on this table
              // with something to do about it.
              render: (u) =>
                u.status !== "occupied" && mayWrite ? (
                  <Link href={`/rentals/lease/new?unit=${u.id}`} className="btn text-2xs" style={{ background: "var(--surface-2)" }}>
                    Let
                  </Link>
                ) : null,
            },
          ]}
        />
      </Card>
    </div>
  );
}
