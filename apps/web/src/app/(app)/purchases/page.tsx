import { sql, type SQL } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import {
  BuTag, DataTable, DaysPill, FilterTabs, PageHeader, Pagination, StatStrip, StatusPill,
  TableEmpty, pageSlice,
} from "@/components/page";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { payBillAction, receiveBillAction } from "@/lib/actions";

export const dynamic = "force-dynamic";

const TABS = ["unpaid", "overdue", "po", "all"] as const;
type Tab = (typeof TABS)[number];

/**
 * Payables and purchasing.
 *
 * The mirror of receivables, and it exists because a money model with only the
 * receivable side is half a ledger — the owner cannot see what they owe, cannot
 * measure creditor days, and cannot track input VAT. The polymorphic documents
 * table means this is the same machinery with `direction = 'out'`.
 *
 * THE FILTERS AND THE FIGURES BOTH MOVED INTO SQL. This screen used to fetch
 * the 80 most recent documents and then filter, count and total that array in
 * JavaScript. Every number on it was therefore a number about the last 80 rows
 * wearing the label of a number about the ledger: "Overdue" summed only the
 * overdue bills that happened to be recent enough to survive the LIMIT, and the
 * "All" tab badge read 80 no matter how many documents existed. Aggregates and
 * filters belong on the same side of the wire as the rows they describe.
 */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; page?: string; per?: string }>;
}) {
  const session = await requireSession();
  const { filter, page: rawPage, per: rawPer } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const tab: Tab = (TABS as readonly string[]).includes(filter ?? "") ? (filter as Tab) : "unpaid";

  const m = await loadMetrics(session, [{ metricId: "accounts_payable" }]);
  const ap = metric(m, "accounts_payable");

  const base = sql`d.direction = 'out' AND d.doc_type IN ('bill','purchase_order')`;
  const unpaidBill = sql`d.doc_type = 'bill' AND d.amount_due > 0`;
  // A paid bill is not overdue, however late it was settled. The array filter
  // this replaces tested only the due date, so settled bills sat in the overdue
  // tab forever.
  const overdueBill = sql`${unpaidBill} AND d.due_date < ${today}::date`;

  const tabClause: SQL =
    tab === "unpaid" ? sql` AND ${unpaidBill}`
    : tab === "overdue" ? sql` AND ${overdueBill}`
    : tab === "po" ? sql` AND d.doc_type = 'purchase_order'`
    : sql``;

  const { bills, facets, supplierCount, bySupplier, businessUnits, suppliers, items, slice } =
    await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      /* One aggregate pass over the whole payables ledger: every tab badge, the
         stat strip, and the exact total the pager needs. */
      const [f] = await tx.execute<{
        every: number; unpaid: number; overdue: number; po: number; open_po: number;
        active: number; overdue_total: string;
      }>(sql`
        SELECT COUNT(*)::int AS every,
               COUNT(*) FILTER (WHERE ${unpaidBill})::int AS unpaid,
               COUNT(*) FILTER (WHERE ${overdueBill})::int AS overdue,
               COUNT(*) FILTER (WHERE d.doc_type = 'purchase_order')::int AS po,
               COUNT(*) FILTER (WHERE d.doc_type = 'purchase_order' AND d.status = 'draft')::int AS open_po,
               COUNT(*) FILTER (WHERE TRUE ${tabClause})::int AS active,
               COALESCE(SUM(d.amount_due) FILTER (WHERE ${overdueBill}), 0)::text AS overdue_total
          FROM documents d
         WHERE ${base}
      `);
      const facets = f ?? {
        every: 0, unpaid: 0, overdue: 0, po: 0, open_po: 0, active: 0, overdue_total: "0",
      };

      const slice = pageSlice({ page: rawPage, per: rawPer }, facets.active);

      const bills = await tx.execute<{
        id: string; doc_number: string; doc_type: string; supplier: string; bu: string;
        color: string; issue_date: string; due_date: string | null; total: string;
        amount_due: string; status: string; business_unit_id: string; party_id: string | null;
        days_late: string;
      }>(sql`
        SELECT d.id, d.doc_number, d.doc_type::text, d.business_unit_id, d.party_id,
               COALESCE(p.display_name, d.party_name_snapshot, '—') AS supplier,
               b.name AS bu, b.color_token AS color,
               d.issue_date::text, d.due_date::text, d.total, d.amount_due, d.status::text,
               GREATEST(0, ${today}::date - d.due_date)::text AS days_late
          FROM documents d
          JOIN business_units b ON b.id = d.business_unit_id
          LEFT JOIN parties p ON p.id = d.party_id
         WHERE ${base} ${tabClause}
         -- Trailing d.id makes the sort total. Bills are issued in batches and
         -- tie on issue_date constantly; without it an OFFSET page boundary can
         -- repeat a bill or skip one.
         ORDER BY d.issue_date DESC, d.id
         LIMIT ${slice.perPage} OFFSET ${slice.offset}
      `);

      /* The panel below shows the top ten, which is the point of it — but the
         stat strip needs how many suppliers carry a balance, not how many of
         them fit in the panel. */
      const [sc] = await tx.execute<{ n: number }>(sql`
        SELECT COUNT(DISTINCT d.party_id)::int AS n FROM documents d
         WHERE d.direction = 'out' AND d.doc_type = 'bill' AND d.amount_due > 0
           AND d.party_id IS NOT NULL
      `);
      const supplierCount = sc?.n ?? 0;

      const bySupplier = await tx.execute<{
        id: string; name: string; owed: string; n: string;
      }>(sql`
        SELECT p.id, p.display_name AS name, SUM(d.amount_due)::text AS owed, COUNT(*)::text AS n
          FROM documents d JOIN parties p ON p.id = d.party_id
         WHERE d.direction = 'out' AND d.doc_type = 'bill' AND d.amount_due > 0
         GROUP BY p.id, p.display_name ORDER BY SUM(d.amount_due) DESC LIMIT 10
      `);

      const businessUnits = await tx.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM business_units WHERE is_active = true ORDER BY sort_order
      `);
      const suppliers = await tx.execute<{ id: string; name: string }>(sql`
        SELECT id, display_name AS name FROM parties WHERE is_supplier = true ORDER BY display_name
      `);
      const items = await tx.execute<{ id: string; name: string; cost: string }>(sql`
        SELECT id, name, cost_price AS cost FROM items
         WHERE is_purchasable = true AND is_active = true ORDER BY name LIMIT 100
      `);

      return { bills, facets, supplierCount, bySupplier, businessUnits, suppliers, items, slice };
    },
  );

  const overdueTotal = Number(facets.overdue_total);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader title="Bills & purchase orders" subtitle="What you owe suppliers" />

      <StatStrip
        stats={[
          { label: "Owed to suppliers", value: formatMoney(ap?.value ?? 0, ccy, 0), tone: "caution" },
          { label: "Overdue", value: formatMoney(overdueTotal, ccy, 0), tone: overdueTotal > 0 ? "negative" : "positive" },
          { label: "Open bills", value: String(facets.unpaid) },
          { label: "Open POs", value: String(facets.open_po) },
          { label: "Suppliers with a balance", value: String(supplierCount) },
        ]}
      />

      <Card>
        {/* Recording a supplier bill is the AP mirror of taking a payment, so it
            lives on the screen where the owner is already looking at what they
            owe — receiving stock and reclaiming input VAT happen atomically. */}
        <Disclosure summary="+ Record a supplier bill">
          <ActionForm
            action={receiveBillAction}
            submitLabel="Record bill"
            pendingLabel="Recording…"
            className="space-y-3"
            /* FR-P12. Three irreversible things happen at once here and only
               one of them is visible on this screen, which is why the
               confirmation lists them: the debt, the stock, and the VAT. The
               VAT line is the one that matters most — an input-VAT claim on a
               bill recorded in error is a wrong figure on a filed return, and
               the return is not corrected from this page. */
            confirm="Records a debt to this supplier that stays on the payables list until it is paid, receives the stock and recomputes the item's average cost, and claims the VAT back on the next return. There is no undo on this screen — a bill recorded in error has to be reversed by the accountant, and both entries stay visible."
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Business" name="businessUnitId" required
                options={businessUnits.map((b) => ({ value: b.id, label: b.name }))} />
              <Field label="Supplier" name="supplierId" required
                options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
              <Field label="Item received" name="itemId" required
                options={items.map((i) => ({ value: i.id, label: i.name }))} />
              <Field label="Quantity" name="quantity" type="number" step="0.01" min="0.01" defaultValue={1} required />
              <Field label="Unit cost (AED)" name="unitCost" type="number" step="0.01" min="0" required />
              <Field label="VAT rate" name="vatRate"
                options={[{ value: "0.05", label: "5% standard" }, { value: "0", label: "0% / exempt" }]} />
              <Field label="Bill date" name="billDate" type="date" defaultValue={today} required />
              <Field label="Supplier ref" name="supplierReference" placeholder="Their invoice no." />
            </div>
            <p className="text-2xs text-subtle leading-relaxed">
              Stock is received and the moving-average cost recomputed automatically. Input VAT is
              reclaimed here — unless this business makes exempt residential supplies, in which case
              it is expensed, which the ledger handles for you.
            </p>
          </ActionForm>
        </Disclosure>

        <CardHeader
          title="Documents"
          action={
            <FilterTabs
              basePath="/purchases"
              active={tab}
              defaultKey="unpaid"
              options={[
                { key: "unpaid", label: "Unpaid", count: facets.unpaid },
                { key: "overdue", label: "Overdue", count: facets.overdue },
                { key: "po", label: "POs", count: facets.po },
                { key: "all", label: "All", count: facets.every },
              ]}
            />
          }
        />
        <DataTable
          rows={bills}
          rowKey={(b) => b.id}
          empty={<TableEmpty title="Nothing here" detail="No bills or purchase orders match." />}
          columns={[
            {
              key: "doc", header: "Document",
              render: (b) => (
                <div>
                  <p className="font-medium tnum">{b.doc_number}</p>
                  <p className="text-2xs text-subtle">
                    {b.doc_type === "purchase_order" ? "Purchase order" : "Bill"}
                  </p>
                </div>
              ),
            },
            { key: "supplier", header: "Supplier", render: (b) => b.supplier },
            { key: "bu", header: "Business", render: (b) => <BuTag name={b.bu} color={b.color} /> },
            {
              key: "due", header: "Due",
              render: (b) => (
                <span>
                  {b.due_date ?? "—"}
                  {Number(b.days_late) > 0 && (
                    <span className="ml-1.5"><DaysPill days={-Number(b.days_late)} /></span>
                  )}
                </span>
              ),
            },
            { key: "total", header: "Total", numeric: true, render: (b) => formatMoney(Number(b.total), ccy, 0) },
            {
              key: "due_amt", header: "Outstanding", numeric: true,
              render: (b) => (
                <span className="font-semibold">{formatMoney(Number(b.amount_due), ccy, 0)}</span>
              ),
            },
            { key: "status", header: "Status", render: (b) => <StatusPill status={b.status} /> },
            {
              key: "do", header: "", numeric: true,
              render: (b) =>
                b.doc_type === "bill" && Number(b.amount_due) > 0 ? (
                  <ActionForm
                    action={payBillAction}
                    submitLabel="Pay"
                    pendingLabel="…"
                    variant="ghost"
                    confirm={`Pays ${b.doc_number} in full. Money leaves the account and the entry cannot be undone from this screen.`}
                    hidden={{
                      businessUnitId: b.business_unit_id,
                      supplierId: b.party_id ?? undefined,
                      billId: b.id,
                      amount: String(Number(b.amount_due)),
                      method: "bank_transfer",
                      paidOn: today,
                      reference: `Payment for ${b.doc_number}`,
                    }}
                  />
                ) : null,
            },
          ]}
        />
        <Pagination
          slice={slice}
          basePath="/purchases"
          params={{ filter: tab === "unpaid" ? undefined : tab }}
          noun="documents"
        />
      </Card>

      <Card>
        <CardHeader title="By supplier" subtitle="Who you owe the most" />
        <div className="px-4 pb-4">
          {bySupplier.length === 0 ? (
            <TableEmpty title="Nothing owed" detail="No open supplier balances." />
          ) : (
            bySupplier.map((s) => (
              <div
                key={s.id}
                className="flex items-baseline justify-between gap-3 py-1.5 border-b last:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{s.name}</p>
                  <p className="text-2xs text-subtle">{s.n} open bill{Number(s.n) === 1 ? "" : "s"}</p>
                </div>
                <span className="text-xs font-semibold tnum shrink-0">
                  {formatMoney(Number(s.owed), ccy, 0)}
                </span>
              </div>
            ))
          )}
        </div>
      </Card>
    </div>
  );
}
