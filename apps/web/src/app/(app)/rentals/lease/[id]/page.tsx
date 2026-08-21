import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { can, daysUntil, formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { renewLeaseAction, terminateLeaseAction } from "@/lib/actions/rentals";
import {
  BuTag, DataTable, DaysPill, PageHeader, StatStrip, StatusPill, TableEmpty,
} from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * ONE TENANCY, END TO END.
 *
 * The screen the property manager opens when a tenant calls. It carries the two
 * writes that FR-R01 asks for beyond creation — renew and terminate — and it
 * puts the evidence for each of them on the same page as the button, because
 * both decisions turn on numbers the operator would otherwise have to hold in
 * their head: what has been invoiced, what is outstanding, which cheques are
 * still in the safe, and how much deposit is actually held.
 *
 * Renewal and termination are both irreversible in the sense that matters —
 * they post to the ledger and there is no undo screen — so both sit behind a
 * `Disclosure` and both carry a `confirm` that states the effect in money
 * rather than asking "are you sure?".
 */

/** The forward pointer a renewal leaves behind, when there is one. */
function renewalNote(reason: string | null): string | null {
  if (!reason) return null;
  const line = reason.split("\n").find((l) => l.startsWith("Renewed —"));
  return line ?? null;
}

export default async function LeasePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  if (!can(session.principal, "lease:read")) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1000px] mx-auto space-y-5">
        <PageHeader title="Lease" back={{ href: "/rentals", label: "Rentals" }} />
        <Card>
          <EmptyState
            icon="—"
            title="Not available for your role"
            detail="Tenancy records are visible to the property manager, the accountant and the owner."
          />
        </Card>
      </div>
    );
  }

  const data = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const leases = await tx.execute<{
        id: string; lease_number: string; status: string; starts_on: string;
        ends_on: string | null; terminated_on: string | null; termination_reason: string | null;
        annual_rent: string; rent_amount: string; billing_day: number; grace_days: number;
        notice_period_days: number; escalation_rate: string; auto_renew: boolean;
        collection_method: string; cheque_count: number | null;
        ejari_number: string | null; ejari_registered_on: string | null;
        dewa_premise_number: string | null;
        deposit_amount: string; deposit_held: string; balance_due: string;
        unit_id: string; unit_code: string; unit_name: string | null; unit_kind: string;
        site: string; party_id: string; party_name: string; party_phone: string | null;
        bu: string; bu_id: string; color_token: string;
        item_name: string | null; tax_code: string | null; treatment: string | null;
        charge_amount: string | null;
      }>(sql`
        SELECT l.id, l.lease_number, l.status::text, l.starts_on::text, l.ends_on::text,
               l.terminated_on::text, l.termination_reason,
               l.annual_rent, l.rent_amount, l.billing_day, l.grace_days,
               l.notice_period_days, l.escalation_rate, l.auto_renew,
               l.collection_method::text, l.cheque_count,
               l.ejari_number, l.ejari_registered_on::text, l.dewa_premise_number,
               l.deposit_amount, l.deposit_held, l.balance_due,
               u.id AS unit_id, u.code AS unit_code, u.name AS unit_name, u.kind::text AS unit_kind,
               st.name AS site, p.id AS party_id, p.display_name AS party_name,
               p.primary_phone AS party_phone,
               b.name AS bu, b.id AS bu_id, b.color_token,
               i.name AS item_name, tc.code AS tax_code, tc.treatment::text AS treatment,
               lc.amount AS charge_amount
          FROM leases l
          JOIN units u ON u.id = l.unit_id
          JOIN sites st ON st.id = u.site_id
          JOIN parties p ON p.id = l.party_id
          JOIN business_units b ON b.id = l.business_unit_id
          LEFT JOIN LATERAL (
            SELECT c.amount, c.item_id FROM lease_charges c
             WHERE c.lease_id = l.id AND c.is_active = true
             ORDER BY c.created_at LIMIT 1
          ) lc ON TRUE
          LEFT JOIN items i ON i.id = lc.item_id
          LEFT JOIN tax_codes tc ON tc.id = i.tax_code_id
         WHERE l.id = ${id}::uuid AND l.deleted_at IS NULL
      `);
      const lease = leases[0];
      if (!lease) return null;

      const invoices = await tx.execute<{
        id: string; doc_number: string; issue_date: string; due_date: string | null;
        status: string; subtotal: string; tax_total: string; total: string; amount_due: string;
        period_start: string | null; period_end: string | null;
      }>(sql`
        SELECT d.id, d.doc_number, d.issue_date::text, d.due_date::text, d.status::text,
               d.subtotal, d.tax_total, d.total, d.amount_due,
               MIN(dl.period_start)::text AS period_start, MAX(dl.period_end)::text AS period_end
          FROM documents d
          JOIN document_lines dl ON dl.document_id = d.id
         WHERE dl.lease_id = ${id}::uuid
         GROUP BY d.id
         ORDER BY d.issue_date DESC
         LIMIT 40
      `);

      const cheques = await tx.execute<{
        id: string; cheque_number: string; bank_name: string | null; cheque_date: string;
        amount: string; status: string; period_start: string | null; period_end: string | null;
      }>(sql`
        SELECT id, cheque_number, bank_name, cheque_date::text, amount, status::text,
               period_start::text, period_end::text
          FROM cheques WHERE lease_id = ${id}::uuid ORDER BY cheque_date
      `);

      return { lease, invoices, cheques };
    },
  );

  if (!data) notFound();
  const { lease, invoices, cheques } = data;

  const live = ["active", "expiring", "defaulted"].includes(lease.status);
  const mayRenew = live && can(session.principal, "lease:update");
  const mayTerminate = live && can(session.principal, "lease:terminate");
  const superseded = renewalNote(lease.termination_reason);
  const monthly = Number(lease.charge_amount ?? lease.rent_amount);
  const held = Number(lease.deposit_held);
  const outstanding = invoices.reduce((t, i) => t + Number(i.amount_due), 0);
  const heldCheques = cheques.filter((c) => c.status === "held");

  const nextTermStart = lease.ends_on
    ? new Date(new Date(`${lease.ends_on}T00:00:00Z`).getTime() + 86_400_000)
        .toISOString()
        .slice(0, 10)
    : today;
  const nextTermEnd = (() => {
    const d = new Date(`${nextTermStart}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();
  const escalated = Math.round(monthly * (1 + Number(lease.escalation_rate)) * 100) / 100;

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1100px] mx-auto space-y-5">
      <PageHeader
        title={`${lease.unit_name ?? lease.unit_code} · ${lease.party_name}`}
        subtitle={
          <span className="flex items-center gap-2 flex-wrap">
            <span className="tnum">{lease.lease_number}</span>
            <StatusPill status={lease.status} />
            <BuTag name={lease.bu} color={lease.color_token} />
            <span>{lease.site}</span>
          </span>
        }
        back={{ href: "/rentals", label: "Rentals" }}
        actions={
          <Link href="/rentals/rent-run" className="btn text-xs" style={{ background: "var(--surface-2)" }}>
            Rent run →
          </Link>
        }
      />

      {superseded && (
        <Card className="p-4" as="div">
          <p className="text-xs" style={{ color: "var(--accent)" }}>
            {superseded} The earlier term is kept intact so the invoices raised under it still
            explain themselves.
          </p>
        </Card>
      )}

      <StatStrip
        stats={[
          {
            label: "Rent",
            value: formatMoney(monthly, ccy, 0),
            hint: `${formatMoney(Number(lease.annual_rent), ccy, 0)} a year`,
          },
          {
            label: "VAT treatment",
            value: lease.treatment ? lease.treatment.replace(/_/g, " ") : "not set",
            tone: lease.treatment === "exempt" ? "default" : lease.treatment ? "caution" : "negative",
            hint: lease.tax_code ?? "no rent item",
          },
          {
            label: "Deposit held",
            value: formatMoney(held, ccy, 0),
            hint: held < Number(lease.deposit_amount) ? "short of the agreed deposit" : "a liability, not income",
          },
          {
            label: "Outstanding",
            value: formatMoney(outstanding, ccy, 0),
            tone: outstanding > 0 ? "negative" : "positive",
            hint: `${invoices.length} invoices raised`,
          },
          {
            label: lease.status === "terminated" ? "Terminated" : "Expires",
            value: lease.ends_on ?? "open ended",
            tone: lease.ends_on && daysUntil(lease.ends_on, today) <= 60 ? "caution" : "default",
            hint: lease.ends_on ? `${daysUntil(lease.ends_on, today)} days` : undefined,
          },
        ]}
      />

      <div className="grid lg:grid-cols-2 gap-5">
        <Card>
          <CardHeader title="Terms" subtitle="What the tenancy contract says" />
          <div className="px-4 pb-4 grid grid-cols-2 gap-y-2.5 gap-x-4 text-xs">
            {[
              ["Term", `${lease.starts_on} → ${lease.ends_on ?? "open"}`],
              ["Rent falls due on", `day ${lease.billing_day} of each month`],
              ["Grace before late", `${lease.grace_days} days`],
              ["Notice period", `${lease.notice_period_days} days`],
              ["Annual increase", `${(Number(lease.escalation_rate) * 100).toFixed(1)}%`],
              ["Auto renew", lease.auto_renew ? "yes" : "no"],
              ["Collection", lease.collection_method.replace(/_/g, " ")],
              ["Instalments", lease.cheque_count ? `${lease.cheque_count} cheques` : "—"],
              ["Bills through", lease.item_name ?? "no charge row"],
              ["Tenant", `${lease.party_name}${lease.party_phone ? ` · ${lease.party_phone}` : ""}`],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="label">{label}</p>
                <p className="mt-0.5">{value}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Registration"
            subtitle="An unregistered tenancy cannot be enforced at the Rental Dispute Centre"
          />
          <div className="px-4 pb-4 grid grid-cols-2 gap-y-2.5 gap-x-4 text-xs">
            <div>
              <p className="label">Ejari number</p>
              <p className="mt-0.5 tnum">
                {lease.ejari_number ?? (
                  <span className="chip" style={{ background: "var(--negative-soft)", color: "var(--negative)" }}>
                    missing
                  </span>
                )}
              </p>
            </div>
            <div>
              <p className="label">Registered on</p>
              <p className="mt-0.5">{lease.ejari_registered_on ?? "—"}</p>
            </div>
            <div>
              <p className="label">DEWA premise</p>
              <p className="mt-0.5 tnum">{lease.dewa_premise_number ?? "—"}</p>
            </div>
            <div>
              <p className="label">Deposit agreed</p>
              <p className="mt-0.5">{formatMoney(Number(lease.deposit_amount), ccy, 0)}</p>
            </div>
          </div>
          {lease.status === "terminated" && lease.termination_reason && (
            <div className="px-4 pb-4">
              <p className="label">Terminated {lease.terminated_on}</p>
              <p className="text-2xs text-muted mt-0.5 leading-relaxed whitespace-pre-line">
                {lease.termination_reason}
              </p>
            </div>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Cheques"
          subtitle="Which physical instrument covers which rental period"
          action={
            <Link href="/rentals/cheques" className="text-2xs font-semibold" style={{ color: "var(--accent)" }}>
              Register →
            </Link>
          }
        />
        <DataTable
          rows={cheques}
          rowKey={(c) => c.id}
          empty={
            <TableEmpty
              title="No cheques on file"
              detail={
                lease.collection_method === "post_dated_cheques"
                  ? "This lease is settled by post-dated cheque but none has been filed. The rent run will flag every month until one is."
                  : "This tenancy is not collected by cheque."
              }
            />
          }
          columns={[
            {
              key: "no",
              header: "Cheque",
              render: (c) => (
                <div>
                  <p className="font-medium tnum">{c.cheque_number}</p>
                  <p className="text-2xs text-subtle">{c.bank_name}</p>
                </div>
              ),
            },
            {
              key: "covers",
              header: "Covers",
              render: (c) =>
                c.period_start ? (
                  <span className="text-2xs text-muted tnum">
                    {c.period_start} → {c.period_end}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            { key: "date", header: "Dated", render: (c) => <span className="tnum">{c.cheque_date}</span> },
            {
              key: "due",
              header: "",
              numeric: true,
              render: (c) =>
                c.status === "held" ? <DaysPill days={daysUntil(c.cheque_date, today)} /> : null,
            },
            {
              key: "amount",
              header: "Amount",
              numeric: true,
              render: (c) => formatMoney(Number(c.amount), ccy, 2),
            },
            { key: "status", header: "Status", render: (c) => <StatusPill status={c.status} /> },
          ]}
        />
      </Card>

      <Card>
        <CardHeader title="Invoices" subtitle="Rent raised against this tenancy, newest first" />
        <DataTable
          rows={invoices}
          rowKey={(i) => i.id}
          empty={
            <TableEmpty
              title="Nothing invoiced yet"
              detail="Rent is raised by the rent run, monthly, whatever the collection method."
            />
          }
          columns={[
            {
              key: "no",
              header: "Invoice",
              render: (i) => (
                <div>
                  <p className="font-medium tnum">{i.doc_number}</p>
                  <p className="text-2xs text-subtle tnum">{i.issue_date}</p>
                </div>
              ),
            },
            {
              key: "covers",
              header: "Covers",
              render: (i) => (
                <span className="text-2xs text-muted tnum">
                  {i.period_start} → {i.period_end}
                </span>
              ),
            },
            { key: "net", header: "Net", numeric: true, render: (i) => formatMoney(Number(i.subtotal), ccy, 2) },
            {
              key: "vat",
              header: "VAT",
              numeric: true,
              render: (i) =>
                Number(i.tax_total) > 0 ? (
                  formatMoney(Number(i.tax_total), ccy, 2)
                ) : (
                  <span className="text-subtle">exempt</span>
                ),
            },
            { key: "total", header: "Total", numeric: true, render: (i) => formatMoney(Number(i.total), ccy, 2) },
            {
              key: "due",
              header: "Outstanding",
              numeric: true,
              render: (i) =>
                Number(i.amount_due) > 0 ? (
                  <span style={{ color: "var(--negative)" }} className="font-semibold">
                    {formatMoney(Number(i.amount_due), ccy, 2)}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            { key: "status", header: "Status", render: (i) => <StatusPill status={i.status} /> },
          ]}
        />
      </Card>

      {/* ── Renew ───────────────────────────────────────────────────────── */}
      {mayRenew && (
        <Card>
          <Disclosure summary="Renew this tenancy" defaultOpen={false}>
            <p className="text-2xs text-subtle mb-3 leading-relaxed">
              A renewal is a new term, not an edit of this one. This lease is closed on the day
              before the new one starts and kept exactly as it is, so every invoice already raised
              still agrees with the lease that produced it. The deposit moves across without a
              journal — it is already the tenant&rsquo;s money on your balance sheet and it is not
              being taken again. Rent for any days of the current term that are still unbilled is
              raised at the OLD rate.
            </p>
            <ActionForm
              action={renewLeaseAction}
              submitLabel="Renew"
              pendingLabel="Renewing…"
              hidden={{ leaseId: lease.id }}
              confirm={`Closes ${lease.lease_number} and opens a new term on the same unit. Invoices already raised are untouched. There is no undo.`}
            >
              <div className="grid sm:grid-cols-2 gap-3 mb-3">
                <Field label="New term from" name="startsOn" type="date" defaultValue={nextTermStart} />
                <Field label="New term to" name="endsOn" type="date" defaultValue={nextTermEnd} />
                <Field
                  label={`Rent per month (${ccy})`}
                  name="rentAmount"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue={escalated}
                />
                <Field label="Rent falls due on day" name="billingDay" type="number" min="1" defaultValue={lease.billing_day} />
                <Field label="Instalments" name="chequeCount" type="number" min="1" defaultValue={lease.cheque_count ?? 4} />
                <Field label="New Ejari number" name="ejariNumber" placeholder="the old registration expires with the term" />
                <Field label="Deposit top-up" name="additionalDeposit" type="number" step="0.01" min="0" defaultValue={0} />
                <Field
                  label="Top-up received by"
                  name="additionalDepositVia"
                  options={[
                    { value: "", label: "No top-up" },
                    { value: "bank_transfer", label: "Bank transfer" },
                    { value: "cash", label: "Cash" },
                    { value: "cheque", label: "Cheque" },
                  ]}
                />
              </div>
              <p className="label mb-1.5">New cheque bundle, in date order</p>
              <p className="text-2xs text-subtle mb-2 leading-relaxed">
                Entering a new bundle hands the tenant back any unbanked cheque of the old bundle
                that covers a period the closing term no longer runs to. Leave blank and the old
                cheques stay where they are.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                <Field label="Bank" name="chequeBank" className="col-span-2 sm:col-span-1" />
                {[1, 2, 3, 4].map((i) => (
                  <Field key={i} label={`Cheque ${i}`} name={`chequeNumber${i}`} />
                ))}
              </div>
            </ActionForm>
          </Disclosure>
        </Card>
      )}

      {/* ── Terminate ───────────────────────────────────────────────────── */}
      {mayTerminate && (
        <Card>
          <Disclosure summary="End this tenancy and settle the deposit" defaultOpen={false}>
            <p className="text-2xs text-subtle mb-3 leading-relaxed">
              In order: rent is raised for the days occupied but not yet billed; rent already
              invoiced for days after the end date is credited back; then the{" "}
              {formatMoney(held, ccy, 2)} deposit is settled — deductions first, then whatever is
              needed against arrears, then the balance refunded. Deductions and the refund can
              never together exceed the deposit held, and an attempt to exceed it is refused rather
              than quietly capped.
              {heldCheques.length > 0 && (
                <>
                  {" "}
                  {heldCheques.length} unbanked cheque{heldCheques.length === 1 ? "" : "s"} covering
                  periods after the end date will be handed back to the tenant.
                </>
              )}
            </p>
            <ActionForm
              action={terminateLeaseAction}
              submitLabel="End tenancy"
              pendingLabel="Settling…"
              variant="danger"
              hidden={{ leaseId: lease.id }}
              confirm={`Ends ${lease.lease_number}, raises the final rent, settles the ${formatMoney(held, ccy, 2)} deposit and posts the refund. There is no undo — reversing it means credit notes and manual journals.`}
            >
              <div className="grid sm:grid-cols-2 gap-3 mb-3">
                <Field label="Last day of occupation" name="terminatedOn" type="date" required defaultValue={today} />
                <Field label="Reason" name="reason" required placeholder="Tenant relocating; 90 days notice given" />
                <Field label="Withhold from deposit for" name="deductionLabel" placeholder="Wall repair and repaint" />
                <Field label={`Amount (${ccy})`} name="deductionAmount" type="number" step="0.01" min="0" defaultValue={0} />
                <Field
                  label="Set against arrears"
                  name="applyToArrears"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder={`blank = as much as fits (${formatMoney(outstanding, ccy, 2)} owed)`}
                />
                <Field
                  label="Refund the balance by"
                  name="refundVia"
                  options={[
                    { value: "bank_transfer", label: "Bank transfer" },
                    { value: "cash", label: "Cash" },
                    { value: "none", label: "Do not refund yet" },
                  ]}
                />
                <Field
                  label="Raise the final rent"
                  name="billFinalRent"
                  options={[
                    { value: "true", label: "Yes — bill the days occupied but unbilled" },
                    { value: "false", label: "No — already invoiced by hand" },
                  ]}
                />
                <Field
                  label="Credit rent past the end date"
                  name="creditUnusedRent"
                  options={[
                    { value: "true", label: "Yes — issue a credit note" },
                    { value: "false", label: "No — report it and leave it" },
                  ]}
                />
              </div>
            </ActionForm>
          </Disclosure>
        </Card>
      )}

      {!live && (
        <Card className="p-4" as="div">
          <p className="text-2xs text-subtle leading-relaxed">
            This term is {lease.status}. It is kept rather than deleted because the invoices raised
            under it have to remain explicable to an auditor years later — a lease that has been
            edited out of existence leaves a gap where the evidence should be.
          </p>
        </Card>
      )}
    </div>
  );
}
