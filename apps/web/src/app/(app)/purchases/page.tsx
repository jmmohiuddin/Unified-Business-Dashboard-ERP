import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import {
  BuTag, DataTable, DaysPill, FilterTabs, PageHeader, StatStrip, StatusPill, TableEmpty,
} from "@/components/page";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { payBillAction, receiveBillAction } from "@/lib/actions";

export const dynamic = "force-dynamic";

/**
 * Payables and purchasing.
 *
 * The mirror of receivables, and it exists because a money model with only the
 * receivable side is half a ledger — the owner cannot see what they owe, cannot
 * measure creditor days, and cannot track input VAT. The polymorphic documents
 * table means this is the same machinery with `direction = 'out'`.
 */
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const session = await requireSession();
  const { filter = "unpaid" } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const m = await loadMetrics(session, [{ metricId: "accounts_payable" }]);
  const ap = metric(m, "accounts_payable");

  const { bills, bySupplier, businessUnits, suppliers, items } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
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
         WHERE d.direction = 'out' AND d.doc_type IN ('bill','purchase_order')
         ORDER BY d.issue_date DESC
         LIMIT 80
      `);

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

      return { bills, bySupplier, businessUnits, suppliers, items };
    },
  );

  const filtered =
    filter === "unpaid" ? bills.filter((b) => b.doc_type === "bill" && Number(b.amount_due) > 0)
    : filter === "overdue" ? bills.filter((b) => b.doc_type === "bill" && Number(b.days_late) > 0)
    : filter === "po" ? bills.filter((b) => b.doc_type === "purchase_order")
    : bills;

  const overdueTotal = bills
    .filter((b) => b.doc_type === "bill" && Number(b.days_late) > 0)
    .reduce((t, b) => t + Number(b.amount_due), 0);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader title="Bills & purchase orders" subtitle="What you owe suppliers" />

      <StatStrip
        stats={[
          { label: "Owed to suppliers", value: formatMoney(ap?.value ?? 0, ccy, 0), tone: "caution" },
          { label: "Overdue", value: formatMoney(overdueTotal, ccy, 0), tone: overdueTotal > 0 ? "negative" : "positive" },
          { label: "Open bills", value: String(bills.filter((b) => b.doc_type === "bill" && Number(b.amount_due) > 0).length) },
          { label: "Open POs", value: String(bills.filter((b) => b.doc_type === "purchase_order" && b.status === "draft").length) },
          { label: "Suppliers with a balance", value: String(bySupplier.length) },
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
              active={filter}
              options={[
                { key: "unpaid", label: "Unpaid" },
                { key: "overdue", label: "Overdue" },
                { key: "po", label: "POs" },
                { key: "all", label: "All", count: bills.length },
              ]}
            />
          }
        />
        <DataTable
          rows={filtered}
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
