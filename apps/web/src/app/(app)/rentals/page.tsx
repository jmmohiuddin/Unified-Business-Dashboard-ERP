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
import { BulletChart, ChartEmpty, concludeBullet, type BulletRow } from "@/components/charts";

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
 *    the whole reason the form exists. It is now `BulletChart` from
 *    `components/charts` rather than the SVG this file used to hand-roll —
 *    same form, but it arrives with the required conclusion line and the
 *    keyboard-reachable table twin that PDD §7.7 and §7.8 ask of every figure,
 *    neither of which the local copy had.
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
 * The measure's polarity, as a mark tone.
 *
 * Ten points is one qualitative band on the scale below (`bandAt`), so "within
 * a band of target" is caution and further than that is a problem. Naming the
 * JOB rather than passing a colour is what stops a status hue and a business
 * identity hue being spelled the same way — see the note on `MarkTone`.
 */
function occupancyTone(actual: number, target: number): BulletRow["tone"] {
  if (actual >= target) return "positive";
  return actual >= target - 10 ? "caution" : "negative";
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

  /**
   * The occupancy bullet graph (WF-05 §9.1, FR-R04).
   *
   * Three rows on one shared 0–100 scale rather than one, because "73% let" is
   * an average over two things that are not alike: sixteen flats that turn over
   * once a year and forty parking bays that turn over constantly. The blended
   * figure can sit on target while every empty unit is a flat, which is the
   * expensive kind. The per-kind rows come straight from the metric's own
   * breakdown so the split cannot disagree with the headline above it.
   *
   * All three carry the same target. Nothing in the product stores a target per
   * unit kind — see the note on `OCCUPANCY_TARGET` — and inventing a second
   * constant here would be a made-up number wearing the same clothes as a
   * measured one.
   */
  const percent = (v: number) => `${v.toFixed(1)}%`;
  const occupancyRows: BulletRow[] = [
    {
      label: "All units",
      actual: occupancy,
      target: OCCUPANCY_TARGET,
      tone: occupancyTone(occupancy, OCCUPANCY_TARGET),
      meta: `${letCount} of ${units.length} let`,
    },
    ...(occ?.breakdown ?? [])
      .filter((b) => b.key === "apartment" || b.key === "parking_bay")
      .map((b) => ({
        label: b.label,
        actual: b.value,
        target: OCCUPANCY_TARGET,
        tone: occupancyTone(b.value, OCCUPANCY_TARGET),
        meta: `${String(b.meta?.occupied ?? 0)} of ${String(b.meta?.total ?? 0)} let`,
      })),
  ];

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
        /**
         * Occupancy is deliberately NOT a stat here any more.
         *
         * WF-05 §9.1 asks for it as a bullet graph, and it was appearing twice:
         * once as a bare "73.2%" in this strip and again, correctly, in the
         * chart below. A bare percentage is the thing the bullet graph exists to
         * replace — it is only a decision once you can see the target beside it —
         * and printing both teaches the reader that the strip is the real number
         * and the chart is decoration.
         */
        stats={[
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
        {units.length === 0 ? (
          <ChartEmpty
            title="Occupancy"
            conclusion="There are no units on the books yet, so there is no occupancy to measure."
            note={`Target ${percent(OCCUPANCY_TARGET)}`}
          />
        ) : (
          <BulletChart
            title="Occupancy"
            rows={occupancyRows}
            format={percent}
            max={100}
            /* One qualitative band, ending ten points under target: "below here
               is a problem". Greyscale by design — the band is context, and a
               coloured band would compete with the measure bar it sits behind. */
            bandAt={OCCUPANCY_TARGET - 10}
            conclusion={concludeBullet({
              subject: "Occupancy",
              actual: occupancy,
              target: OCCUPANCY_TARGET,
              format: percent,
              count: { done: letCount, of: units.length, unit: "unit" },
            })}
            note={
              (counts[0]?.expiring ?? 0) > 0
                ? `${counts[0]!.expiring} lease${counts[0]!.expiring === 1 ? "" : "s"} end within 60 days.`
                : "Nothing ends within 60 days."
            }
            footnote={
              vacancyCost > 0
                ? `Vacancy is costing ${formatMoneyCompact(vacancyCost, ccy)} a month in list rent.`
                : undefined
            }
          />
        )}

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
