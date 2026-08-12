import Link from "next/link";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { formatMoney, formatMoneyCompact } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { loadMetrics, metric, resolveToday } from "@/lib/data";
import { BarRow, Card, CardHeader, Chip, EmptyState } from "@/components/ui";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { createCreditNoteAction, recordPaymentAction } from "@/lib/actions";

export const dynamic = "force-dynamic";

/**
 * Drill-down reference implementation.
 *
 * Every dashboard tile links to a screen like this one. The contract: the
 * headline figure here must reconcile EXACTLY to the tile that linked to it,
 * because the moment a drill-down disagrees with its summary, the owner stops
 * trusting both. Both read the same metric definition — that is how the
 * guarantee is kept rather than hoped for.
 */
export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const session = await requireSession();
  const { filter } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;
  const overdueOnly = filter === "overdue";

  const m = await loadMetrics(session, [
    { metricId: "accounts_receivable" },
    { metricId: "overdue_debt" },
  ]);
  const ar = metric(m, "accounts_receivable");
  const overdue = metric(m, "overdue_debt");

  const { invoices, byParty, businessUnits, recentInvoices } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const invoices = await tx.execute<{
        id: string; doc_number: string; party: string; bu: string; color: string;
        issue_date: string; due_date: string | null; total: string; amount_due: string;
        days_late: string; business_unit_id: string; party_id: string | null;
      }>(sql`
        SELECT d.id, d.doc_number, d.business_unit_id, d.party_id,
               COALESCE(p.display_name, d.party_name_snapshot, '—') AS party,
               b.name AS bu, b.color_token AS color,
               d.issue_date::text, d.due_date::text, d.total, d.amount_due,
               GREATEST(0, ${today}::date - d.due_date)::text AS days_late
          FROM documents d
          JOIN business_units b ON b.id = d.business_unit_id
          LEFT JOIN parties p ON p.id = d.party_id
         WHERE d.direction = 'in' AND d.amount_due > 0
           AND d.status NOT IN ('cancelled','void','draft')
           ${overdueOnly ? sql`AND d.due_date < ${today}::date` : sql``}
         ORDER BY d.due_date ASC NULLS LAST
         LIMIT 60
      `);

      const businessUnits = await tx.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM business_units WHERE is_active = true ORDER BY sort_order
      `);

      // Recent invoices a return could be raised against — including paid ones,
      // because returns usually come after the customer has already paid.
      const recentInvoices = await tx.execute<{ id: string; doc_number: string; party: string; total: string }>(sql`
        SELECT d.id, d.doc_number, COALESCE(p.display_name, d.party_name_snapshot, '—') AS party, d.total
          FROM documents d LEFT JOIN parties p ON p.id = d.party_id
         WHERE d.direction = 'in' AND d.doc_type = 'invoice'
           AND d.status NOT IN ('cancelled','void','draft')
           AND NOT EXISTS (
             SELECT 1 FROM documents cn WHERE cn.source_document_id = d.id AND cn.doc_type = 'credit_note'
           )
         ORDER BY d.issue_date DESC LIMIT 40
      `);

      const byParty = await tx.execute<{
        id: string; name: string; phone: string | null; owed: string; n: string; worst: string;
      }>(sql`
        SELECT p.id, p.display_name AS name, p.primary_phone AS phone,
               SUM(d.amount_due)::text AS owed, COUNT(*)::text AS n,
               MAX(GREATEST(0, ${today}::date - d.due_date))::text AS worst
          FROM documents d JOIN parties p ON p.id = d.party_id
         WHERE d.direction='in' AND d.amount_due > 0
           AND d.status NOT IN ('cancelled','void','draft')
         GROUP BY p.id, p.display_name, p.primary_phone
         ORDER BY SUM(d.amount_due) DESC
         LIMIT 10
      `);

      return { invoices, byParty, businessUnits, recentInvoices };
    },
  );

  const bucketMax = Math.max(...(ar?.breakdown?.map((b) => b.value) ?? [1]), 1);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Money owed to you</h1>
          <p className="text-xs text-muted mt-0.5">
            {formatMoney(ar?.value ?? 0, ccy)} outstanding ·{" "}
            <span style={{ color: "var(--negative)" }}>
              {formatMoney(overdue?.value ?? 0, ccy)} already overdue
            </span>
          </p>
        </div>
        <div className="flex gap-1.5">
          <Link href="/receivables" className={`btn text-xs ${overdueOnly ? "btn-ghost" : "btn-primary"}`}>
            All
          </Link>
          <Link href="/receivables?filter=overdue" className={`btn text-xs ${overdueOnly ? "btn-primary" : "btn-ghost"}`}>
            Overdue only
          </Link>
        </div>
      </header>

      <div className="grid gap-3 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader title="Ageing" subtitle="How late is the money" />
          <div className="px-4 pb-4">
            {ar?.breakdown?.map((b) => (
              <BarRow
                key={b.key}
                label={b.label}
                value={b.value}
                max={bucketMax}
                display={formatMoneyCompact(b.value, ccy)}
                color={b.key === "current" ? "var(--positive)" : b.key === "d60_plus" ? "var(--negative)" : "var(--caution)"}
                meta={`${String(b.meta?.invoices ?? 0)} invoices`}
              />
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Who owes the most" subtitle="Start your calls at the top" href="/crm" />
          <div className="px-4 pb-4">
            {byParty.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 py-1.5 border-b last:border-0"
                style={{ borderColor: "var(--border)" }}>
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">{p.name}</p>
                  <p className="text-2xs text-subtle truncate">
                    {p.n} invoice{Number(p.n) === 1 ? "" : "s"}
                    {Number(p.worst) > 0 && ` · ${p.worst} days late`}
                    {p.phone && ` · ${p.phone}`}
                  </p>
                </div>
                <span className="text-xs font-semibold tnum shrink-0"
                  style={{ color: Number(p.worst) > 30 ? "var(--negative)" : "var(--text)" }}>
                  {formatMoneyCompact(Number(p.owed), ccy)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        {/* Receiving money is the most-used write in the product, so it lives
            on the screen where the owner is already looking at who owes what,
            not behind a separate "new payment" page. */}
        <Disclosure summary="+ Record a payment">
          <ActionForm
            action={recordPaymentAction}
            submitLabel="Record payment"
            pendingLabel="Recording…"
            className="space-y-3"
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Field
                label="Business"
                name="businessUnitId"
                required
                options={businessUnits.map((b) => ({ value: b.id, label: b.name }))}
              />
              <Field
                label="Customer"
                name="partyId"
                options={[
                  { value: "", label: "— unallocated —" },
                  ...byParty.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
              <Field label="Amount (AED)" name="amount" type="number" step="0.01" min="0.01" required />
              <Field
                label="Method"
                name="method"
                options={[
                  { value: "card", label: "Card" },
                  { value: "cash", label: "Cash" },
                  { value: "bank_transfer", label: "Bank transfer" },
                  { value: "cheque", label: "Cheque" },
                  { value: "digital_wallet", label: "Apple / Google Pay" },
                ]}
              />
              <Field label="Received on" name="receivedOn" type="date" defaultValue={today} required />
              <Field label="Reference" name="reference" placeholder="Optional" className="sm:col-span-2" />
            </div>
            <p className="text-2xs text-subtle leading-relaxed">
              Leave the customer blank to hold the money on account. Otherwise it is applied to
              their oldest unpaid invoices first — which is what keeps the ageing report honest.
            </p>
          </ActionForm>
        </Disclosure>

        {/* Returns. A credit note reverses the sale rather than editing the
            original invoice, so a filed VAT return stays intact and the auditor
            sees both the sale and its reversal. */}
        <Disclosure summary="+ Credit note / return">
          <ActionForm
            action={createCreditNoteAction}
            submitLabel="Raise credit note"
            pendingLabel="Raising…"
            className="space-y-3"
            confirm="Reverses the revenue, the VAT and the cost of sale, restocks any returned goods, and — if the invoice was already paid — issues a refund. Credit notes are not deleted afterwards; correcting one means raising another."
            hidden={{ full: "true" }}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Invoice to credit" name="invoiceId" required
                options={recentInvoices.map((i) => ({
                  value: i.id,
                  label: `${i.doc_number} — ${i.party} (${formatMoney(Number(i.total), ccy, 0)})`,
                }))} />
              <Field label="Reason" name="reason" placeholder="Faulty / returned / goodwill" required />
              <Field label="Settlement" name="refundMethod"
                options={[
                  { value: "credit_on_account", label: "Credit on account" },
                  { value: "cash", label: "Refund cash" },
                  { value: "bank_transfer", label: "Refund bank transfer" },
                  { value: "card", label: "Refund to card" },
                ]} />
            </div>
            <p className="text-2xs text-subtle leading-relaxed">
              Credits the full invoice: reverses revenue, output VAT and — if goods come back —
              cost of sales. If the customer had already paid, the balance is refunded or held as
              credit, whichever you choose.
            </p>
          </ActionForm>
        </Disclosure>

        <CardHeader
          title={overdueOnly ? "Overdue invoices" : "Open invoices"}
          subtitle="Oldest due date first"
          action={<Chip tone="neutral">{invoices.length} shown</Chip>}
        />
        {invoices.length === 0 ? (
          <EmptyState title="Everything is paid" detail="No open invoices match this filter." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left border-b" style={{ borderColor: "var(--border)" }}>
                  {["Invoice", "Customer", "Business", "Due", "Total", "Outstanding", ""].map((h, i) => (
                    <th key={h || "action"} className={`px-4 py-2 label font-medium ${i >= 4 ? "text-right" : ""}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const late = Number(inv.days_late);
                  return (
                    <tr key={inv.id} className="border-b last:border-0 hover:bg-surface-2 transition-colors"
                      style={{ borderColor: "var(--border)" }}>
                      <td className="px-4 py-2 font-medium whitespace-nowrap">{inv.doc_number}</td>
                      <td className="px-4 py-2 max-w-[16rem] truncate">{inv.party}</td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full"
                            style={{ background: `var(--color-bu-${inv.color})` }} aria-hidden />
                          <span className="text-muted">{inv.bu}</span>
                        </span>
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {inv.due_date}
                        {late > 0 && (
                          <span className="ml-1.5 text-2xs font-semibold" style={{ color: "var(--negative)" }}>
                            +{late}d
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tnum text-muted">
                        {formatMoney(Number(inv.total), ccy)}
                      </td>
                      <td className="px-4 py-2 text-right tnum font-semibold">
                        {formatMoney(Number(inv.amount_due), ccy)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <ActionForm
                          action={recordPaymentAction}
                          submitLabel="Settle"
                          pendingLabel="…"
                          variant="ghost"
                          hidden={{
                            businessUnitId: inv.business_unit_id,
                            partyId: inv.party_id ?? undefined,
                            documentId: inv.id,
                            amount: String(Number(inv.amount_due)),
                            method: "bank_transfer",
                            receivedOn: today,
                            reference: `Settled from receivables`,
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
