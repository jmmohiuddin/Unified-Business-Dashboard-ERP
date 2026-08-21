import { sql, type SQL } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { adjustStockAction } from "@/lib/actions";
import {
  BuTag, DataTable, FilterTabs, PageHeader, Pagination, StatStrip, TableEmpty, pageSlice,
  type PageKeys,
} from "@/components/page";

export const dynamic = "force-dynamic";

const TABS = ["all", "low", "serialised"] as const;
type Tab = (typeof TABS)[number];

/**
 * Two paginated lists share this route, so they cannot share pager parameters:
 * one `?page=` would move both, and turning to page 3 of the IMEI register
 * would silently turn the stock table too.
 */
const STOCK_KEYS: PageKeys = { page: "page", per: "per" };
const IMEI_KEYS: PageKeys = { page: "ipage", per: "iper" };

/**
 * Inventory: stock, reorder proposals and the IMEI register.
 *
 * The reorder list is ranked by DAYS OF COVER rather than absolute quantity —
 * four units of a fast-moving charger is more urgent than two of something that
 * sells twice a year, and quantity-ranked reorder lists get this backwards every
 * time.
 *
 * The stock table used to be fetched whole and then filtered in JavaScript, and
 * the IMEI register stopped dead at 60 rows with nothing on screen saying so.
 * Both are paged in SQL now. The stock filters are the interesting case: "low"
 * is a predicate on an AGGREGATE (`SUM(on_hand) - SUM(reserved)` against the
 * item's reorder point), so it lives in `HAVING`, not `WHERE` — which is also
 * why its count has to be taken over the grouped set rather than over rows.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{
    filter?: string; page?: string; per?: string; ipage?: string; iper?: string;
  }>;
}) {
  const session = await requireSession();
  const {
    filter, page: rawPage, per: rawPer, ipage: rawIPage, iper: rawIPer,
  } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const tab: Tab = (TABS as readonly string[]).includes(filter ?? "") ? (filter as Tab) : "all";
  const available = sql`SUM(sl.on_hand) - SUM(sl.reserved)`;
  const isLow = sql`i.reorder_point IS NOT NULL AND ${available} <= i.reorder_point`;

  const stockWhere: SQL = tab === "serialised" ? sql` AND i.tracking_mode = 'serial'` : sql``;
  const stockHaving: SQL = tab === "low" ? sql` HAVING ${isLow}` : sql``;

  const m = await loadMetrics(session, [
    { metricId: "inventory_value" },
    { metricId: "low_stock_items", params: { limit: 25 } },
  ]);
  const value = metric(m, "inventory_value");
  const lowStock = metric(m, "low_stock_items");

  const {
    stock, stockFacets, stockSlice, serials, imeiSlice, warehouses,
    countableWarehouses, countableItems, inStockImei, soldImei,
  } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      /* Counted over the grouped set, because an item held in three warehouses
         is one row on this screen and three rows in `stock_levels`. Counting
         the base table would overstate every badge and hand the pager a total
         it could never reach. */
      const [sf] = await tx.execute<{ every: number; low: number; serialised: number }>(sql`
        SELECT COUNT(*)::int AS every,
               COUNT(*) FILTER (WHERE z.low)::int AS low,
               COUNT(*) FILTER (WHERE z.tracking = 'serial')::int AS serialised
          FROM (
            SELECT i.tracking_mode::text AS tracking, (${isLow}) AS low
              FROM stock_levels sl
              JOIN items i ON i.id = sl.item_id
             GROUP BY i.id, i.tracking_mode, i.reorder_point
          ) z
      `);
      const stockFacets = sf ?? { every: 0, low: 0, serialised: 0 };
      const stockTotal =
        tab === "low" ? stockFacets.low
        : tab === "serialised" ? stockFacets.serialised
        : stockFacets.every;
      const stockSlice = pageSlice({ page: rawPage, per: rawPer }, stockTotal, { keys: STOCK_KEYS });

      const stock = await tx.execute<{
        id: string; name: string; sku: string | null; tracking: string;
        on_hand: string; reserved: string; avg_cost: string; sale_price: string;
        reorder_point: string | null; bu: string | null; color_token: string | null;
        warehouses: string;
      }>(sql`
        SELECT i.id, i.name, i.sku, i.tracking_mode::text AS tracking,
               SUM(sl.on_hand) AS on_hand, SUM(sl.reserved) AS reserved,
               MAX(sl.avg_cost) AS avg_cost, i.sale_price, i.reorder_point,
               b.name AS bu, b.color_token,
               STRING_AGG(DISTINCT w.code, ', ') AS warehouses
          FROM stock_levels sl
          JOIN items i ON i.id = sl.item_id
          JOIN warehouses w ON w.id = sl.warehouse_id
          LEFT JOIN business_units b ON b.id = i.business_unit_id
         WHERE TRUE ${stockWhere}
         GROUP BY i.id, i.name, i.sku, i.tracking_mode, i.sale_price, i.reorder_point,
                  b.name, b.color_token
         ${stockHaving}
         -- Trailing i.id makes the sort total: items with no stock all value at
         -- zero and would otherwise reshuffle between page requests.
         ORDER BY SUM(sl.on_hand * sl.avg_cost) DESC, i.id
         LIMIT ${stockSlice.perPage} OFFSET ${stockSlice.offset}
      `);

      const [ic] = await tx.execute<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM serial_units`);
      const imeiSlice = pageSlice(
        { ipage: rawIPage, iper: rawIPer }, ic?.n ?? 0, { keys: IMEI_KEYS },
      );

      const serials = await tx.execute<{
        id: string; serial_no: string; item: string; status: string;
        sold_on: string | null; sold_price: string | null; warranty: string | null;
        buyer: string | null;
      }>(sql`
        SELECT su.id, su.serial_no, i.name AS item, su.status,
               su.sold_on::text, su.sold_price, su.warranty_ends_on::text AS warranty,
               p.display_name AS buyer
          FROM serial_units su
          JOIN items i ON i.id = su.item_id
          LEFT JOIN parties p ON p.id = su.sold_to_party_id
         ORDER BY su.status, su.sold_on DESC NULLS LAST, su.id
         LIMIT ${imeiSlice.perPage} OFFSET ${imeiSlice.offset}
      `);

      const warehouses = await tx.execute<{
        code: string; name: string; is_van: boolean; value: string; lines: number;
      }>(sql`
        SELECT w.code, w.name, w.is_mobile_van AS is_van,
               COALESCE(SUM(sl.on_hand * sl.avg_cost), 0) AS value,
               COUNT(sl.id)::int AS lines
          FROM warehouses w
          LEFT JOIN stock_levels sl ON sl.warehouse_id = w.id
         GROUP BY w.code, w.name, w.is_mobile_van
         ORDER BY 3 DESC
      `);

      // Ids for the stock-count form (the display query above joins for codes).
      // Bounded on purpose: these fill <select> elements, not lists the user
      // browses, so a pager would be the wrong affordance for them.
      const countableWarehouses = await tx.execute<{ id: string; name: string; bu: string }>(sql`
        SELECT w.id, w.name, w.business_unit_id AS bu FROM warehouses w
         WHERE w.is_active = true ORDER BY w.name
      `);
      const countableItems = await tx.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM items
         WHERE tracking_mode IN ('quantity','serial') AND is_active = true
         ORDER BY name LIMIT 200
      `);

      /* Handset counts for the stat strip. They used to be measured off the
         60-row page of the register below, so both figures were really "…of the
         60 most recent", labelled as totals. */
      const [imei] = await tx.execute<{ in_stock: number; sold: number }>(sql`
        SELECT COUNT(*) FILTER (WHERE status = 'in_stock')::int AS in_stock,
               COUNT(*) FILTER (WHERE status = 'sold')::int AS sold
          FROM serial_units
      `);

      return {
        stock, stockFacets, stockSlice, serials, imeiSlice, warehouses,
        countableWarehouses, countableItems,
        inStockImei: imei?.in_stock ?? 0, soldImei: imei?.sold ?? 0,
      };
    },
  );

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader title="Inventory" subtitle="Shop floor, warehouse and technician vans" />

      <StatStrip
        stats={[
          { label: "Stock value", value: formatMoney(value?.value ?? 0, ccy, 0), hint: "At moving-average cost" },
          {
            label: "Need reorder",
            value: String(lowStock?.value ?? 0),
            tone: (lowStock?.value ?? 0) > 0 ? "caution" : "positive",
          },
          {
            label: "Out of stock",
            value: String(value?.breakdown?.find((b) => b.key === "out")?.value ?? 0),
            tone: "negative",
          },
          { label: "Handsets in stock", value: String(inStockImei), hint: "IMEI tracked" },
          { label: "Handsets sold", value: String(soldImei), hint: "Warranty on file" },
        ]}
      />

      {/* ── Reorder ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Reorder now"
          subtitle="Ranked by days of cover at the trailing 30-day sales rate — not by quantity"
        />
        <DataTable
          rows={lowStock?.breakdown ?? []}
          rowKey={(r) => r.key}
          empty={
            <TableEmpty
              title="Stock levels are healthy"
              detail="Nothing has fallen to its reorder point."
            />
          }
          columns={[
            { key: "item", header: "Item", render: (r) => <span className="font-medium">{r.label}</span> },
            { key: "avail", header: "Available", numeric: true, render: (r) => r.value },
            {
              key: "cover", header: "Days of cover", numeric: true,
              render: (r) =>
                r.meta?.daysOfCover !== null && r.meta?.daysOfCover !== undefined ? (
                  <span
                    className="font-semibold"
                    style={{
                      color:
                        Number(r.meta.daysOfCover) < 7 ? "var(--negative)"
                        : Number(r.meta.daysOfCover) < 21 ? "var(--caution)" : undefined,
                    }}
                  >
                    {String(r.meta.daysOfCover)}
                  </span>
                ) : (
                  <span className="text-subtle text-2xs">no recent sales</span>
                ),
            },
            { key: "rop", header: "Reorder point", numeric: true, render: (r) => String(r.meta?.reorderPoint ?? "—") },
            { key: "qty", header: "Suggested order", numeric: true, render: (r) => String(r.meta?.suggestedQty ?? "—") },
            {
              key: "cost", header: "Est. cost", numeric: true,
              render: (r) => formatMoney(Number(r.meta?.estimatedCost ?? 0), ccy, 0),
            },
          ]}
        />
      </Card>

      {/* ── Stock count ────────────────────────────────────────────────── */}
      <Card>
        <Disclosure summary="+ Record a stock count">
          <ActionForm
            action={adjustStockAction}
            submitLabel="Post count"
            pendingLabel="Posting…"
            className="space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {/* Warehouse value carries its business unit as "id::bu" so the
                  action knows which business to post the variance against,
                  whichever warehouse is chosen. */}
              <Field label="Warehouse" name="warehouseRef" required
                options={countableWarehouses.map((w) => ({ value: `${w.id}::${w.bu}`, label: w.name }))} />
              <Field label="Item" name="itemId" required
                options={countableItems.map((i) => ({ value: i.id, label: i.name }))} />
              <Field label="Counted quantity" name="countedQuantity" type="number" step="0.01" min="0" required />
              <Field label="Reason" name="reason"
                options={[
                  { value: "count", label: "Physical count" },
                  { value: "damage", label: "Damaged" },
                  { value: "theft", label: "Missing / theft" },
                  { value: "correction", label: "Correction" },
                ]} />
            </div>
            <p className="text-2xs text-subtle leading-relaxed">
              The variance against the system quantity is posted as an adjustment move AND to the
              P&amp;L — shrinkage is a real cost, not a silent write-off. A count that matches the
              system does nothing.
            </p>
          </ActionForm>
        </Disclosure>
      </Card>

      {/* ── Warehouses ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="By location"
          subtitle="A technician's van is a warehouse — that is how you know what parts are on the road"
        />
        <DataTable
          rows={warehouses}
          rowKey={(w) => w.code}
          empty={<TableEmpty title="No warehouses" detail="Nothing configured." />}
          columns={[
            {
              key: "name", header: "Location",
              render: (w) => (
                <span className="inline-flex items-center gap-2">
                  <span className="font-medium">{w.name}</span>
                  {w.is_van && (
                    <span className="chip" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                      van
                    </span>
                  )}
                </span>
              ),
            },
            { key: "lines", header: "Item lines", numeric: true, render: (w) => w.lines },
            { key: "value", header: "Stock value", numeric: true, render: (w) => formatMoney(Number(w.value), ccy, 0) },
          ]}
        />
      </Card>

      {/* ── Stock ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Stock"
          action={
            <FilterTabs
              basePath="/inventory"
              active={tab}
              // The IMEI register's position rides along, so filtering the
              // stock table does not reset the other list on the page.
              params={{ ipage: rawIPage, iper: rawIPer }}
              options={[
                { key: "all", label: "All", count: stockFacets.every },
                { key: "low", label: "Low", count: stockFacets.low },
                { key: "serialised", label: "Serialised", count: stockFacets.serialised },
              ]}
            />
          }
        />
        <DataTable
          rows={stock}
          rowKey={(s) => s.id}
          empty={<TableEmpty title="No items match" detail="Try a different filter." />}
          columns={[
            {
              key: "item", header: "Item",
              render: (s) => (
                <div className="min-w-0">
                  <p className="font-medium truncate">{s.name}</p>
                  <p className="text-2xs text-subtle tnum">{s.sku ?? "—"}</p>
                </div>
              ),
            },
            {
              key: "bu", header: "Business",
              render: (s) =>
                s.bu ? <BuTag name={s.bu} color={s.color_token ?? "slate"} /> : <span className="text-subtle text-2xs">shared</span>,
            },
            {
              key: "where", header: "Held at",
              render: (s) => <span className="text-2xs text-muted">{s.warehouses}</span>,
            },
            {
              key: "onhand", header: "On hand", numeric: true,
              render: (s) => Math.round(Number(s.on_hand)),
            },
            {
              key: "avail", header: "Available", numeric: true,
              render: (s) => {
                const avail = Number(s.on_hand) - Number(s.reserved);
                const low = s.reorder_point !== null && avail <= Number(s.reorder_point);
                return (
                  <span
                    className="font-semibold"
                    style={{ color: avail <= 0 ? "var(--negative)" : low ? "var(--caution)" : undefined }}
                  >
                    {Math.round(avail)}
                  </span>
                );
              },
            },
            { key: "cost", header: "Avg cost", numeric: true, render: (s) => formatMoney(Number(s.avg_cost), ccy, 0) },
            {
              key: "value", header: "Value", numeric: true,
              render: (s) => formatMoney(Number(s.on_hand) * Number(s.avg_cost), ccy, 0),
            },
          ]}
        />
        <Pagination
          slice={stockSlice}
          basePath="/inventory"
          params={{
            filter: tab === "all" ? undefined : tab,
            // Carry the sibling pager, or paging stock would rewind the IMEI
            // register under the reader.
            ipage: rawIPage,
            iper: rawIPer,
          }}
          noun="items"
        />
      </Card>

      {/* ── IMEI register ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="IMEI register"
          subtitle="Scan a handset and you have the sale, the price, the buyer and the warranty end date"
        />
        <DataTable
          rows={serials}
          rowKey={(s) => s.id}
          empty={<TableEmpty title="No serialised units" detail="Nothing tracked by IMEI yet." />}
          columns={[
            { key: "imei", header: "IMEI", render: (s) => <span className="tnum font-medium">{s.serial_no}</span> },
            { key: "item", header: "Handset", render: (s) => s.item },
            {
              key: "status", header: "Status",
              render: (s) => (
                <span
                  className="chip"
                  style={
                    s.status === "sold"
                      ? { background: "var(--surface-3)", color: "var(--text-muted)" }
                      : { background: "var(--positive-soft)", color: "var(--positive)" }
                  }
                >
                  {s.status.replace(/_/g, " ")}
                </span>
              ),
            },
            { key: "buyer", header: "Sold to", render: (s) => s.buyer ?? <span className="text-subtle">—</span> },
            { key: "sold", header: "Sold on", render: (s) => s.sold_on ?? <span className="text-subtle">—</span> },
            {
              key: "price", header: "Price", numeric: true,
              render: (s) => (s.sold_price ? formatMoney(Number(s.sold_price), ccy, 0) : <span className="text-subtle">—</span>),
            },
            {
              key: "warranty", header: "Warranty until",
              render: (s) =>
                s.warranty ? (
                  <span style={{ color: s.warranty < today ? "var(--text-subtle)" : "var(--positive)" }}>
                    {s.warranty}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
          ]}
        />
        <Pagination
          slice={imeiSlice}
          basePath="/inventory"
          params={{
            filter: tab === "all" ? undefined : tab,
            page: rawPage,
            per: rawPer,
          }}
          noun="handsets"
        />
      </Card>
    </div>
  );
}
