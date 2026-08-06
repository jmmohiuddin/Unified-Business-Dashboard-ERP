import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { adjustStockAction } from "@/lib/actions";
import {
  BuTag, DataTable, FilterTabs, PageHeader, StatStrip, TableEmpty,
} from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * Inventory: stock, reorder proposals and the IMEI register.
 *
 * The reorder list is ranked by DAYS OF COVER rather than absolute quantity —
 * four units of a fast-moving charger is more urgent than two of something that
 * sells twice a year, and quantity-ranked reorder lists get this backwards every
 * time.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const session = await requireSession();
  const { filter = "all" } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const m = await loadMetrics(session, [
    { metricId: "inventory_value" },
    { metricId: "low_stock_items", params: { limit: 25 } },
  ]);
  const value = metric(m, "inventory_value");
  const lowStock = metric(m, "low_stock_items");

  const { stock, serials, warehouses, countableWarehouses, countableItems } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
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
         GROUP BY i.id, i.name, i.sku, i.tracking_mode, i.sale_price, i.reorder_point,
                  b.name, b.color_token
         ORDER BY SUM(sl.on_hand * sl.avg_cost) DESC
      `);

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
         ORDER BY su.status, su.sold_on DESC NULLS LAST
         LIMIT 60
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
      const countableWarehouses = await tx.execute<{ id: string; name: string; bu: string }>(sql`
        SELECT w.id, w.name, w.business_unit_id AS bu FROM warehouses w
         WHERE w.is_active = true ORDER BY w.name
      `);
      const countableItems = await tx.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM items
         WHERE tracking_mode IN ('quantity','serial') AND is_active = true
         ORDER BY name LIMIT 200
      `);

      return { stock, serials, warehouses, countableWarehouses, countableItems };
    },
  );

  const filtered =
    filter === "low"
      ? stock.filter(
          (s) =>
            s.reorder_point !== null &&
            Number(s.on_hand) - Number(s.reserved) <= Number(s.reorder_point),
        )
      : filter === "serialised"
        ? stock.filter((s) => s.tracking === "serial")
        : stock;

  const inStockImei = serials.filter((s) => s.status === "in_stock").length;
  const soldImei = serials.filter((s) => s.status === "sold").length;

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
              active={filter}
              options={[
                { key: "all", label: "All", count: stock.length },
                { key: "low", label: "Low", count: lowStock?.value ?? 0 },
                { key: "serialised", label: "Serialised", count: stock.filter((s) => s.tracking === "serial").length },
              ]}
            />
          }
        />
        <DataTable
          rows={filtered}
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
      </Card>
    </div>
  );
}
