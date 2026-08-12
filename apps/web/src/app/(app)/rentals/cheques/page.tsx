import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { daysUntil, formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import { chequeAction } from "@/lib/actions";
import {
  BuTag, DataTable, DaysPill, FilterTabs, PageHeader, StatStrip, StatusPill, TableEmpty,
} from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * Post-dated cheque register.
 *
 * The screen a Dubai landlord actually opens on a Sunday morning: what do I
 * bank this week, and who has bounced. Cheques in the safe are neither cash nor
 * receivables, so they get their own register with a real lifecycle rather than
 * being force-fitted into payments.
 */
export default async function ChequesPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const session = await requireSession();
  // A register defaults to showing the register. "Bank now" is legitimately
  // empty much of the time — cheque dates cluster on lease anniversaries — and
  // an empty screen on arrival reads as broken rather than as good news.
  const { filter = "all" } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const { cheques, totals } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const cheques = await tx.execute<{
        id: string; cheque_number: string; bank_name: string | null; drawer: string | null;
        cheque_date: string; amount: string; status: string;
        period_start: string | null; period_end: string | null;
        bounce_reason: string | null; custody: string | null;
        unit: string | null; lease_number: string | null; bu: string; color_token: string;
      }>(sql`
        SELECT c.id, c.cheque_number, c.bank_name, c.drawer_name AS drawer,
               c.cheque_date::text, c.amount, c.status::text,
               c.period_start::text, c.period_end::text, c.bounce_reason,
               c.custody_location AS custody,
               u.code AS unit, l.lease_number, b.name AS bu, b.color_token
          FROM cheques c
          JOIN business_units b ON b.id = c.business_unit_id
          LEFT JOIN leases l ON l.id = c.lease_id
          LEFT JOIN units u ON u.id = l.unit_id
         WHERE c.direction = 'in'
         ORDER BY c.cheque_date
      `);

      const totals = await tx.execute<{
        status: string; total: string; n: number;
      }>(sql`
        SELECT status::text, SUM(amount) AS total, COUNT(*)::int AS n
          FROM cheques WHERE direction = 'in' GROUP BY status
      `);

      return { cheques, totals };
    },
  );

  const stat = (s: string) => totals.find((t) => t.status === s);
  const dueSoon = cheques.filter(
    (c) => c.status === "held" && daysUntil(c.cheque_date, today) <= 30,
  );

  const filtered =
    filter === "due" ? dueSoon
    : filter === "held" ? cheques.filter((c) => c.status === "held")
    : filter === "bounced" ? cheques.filter((c) => c.status === "bounced")
    : filter === "cleared" ? cheques.filter((c) => c.status === "cleared")
    : cheques;

  const heldTotal = Number(stat("held")?.total ?? 0);
  const bouncedTotal = Number(stat("bounced")?.total ?? 0);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader
        title="Cheque register"
        subtitle="Post-dated cheques held against tenancy contracts"
        back={{ href: "/rentals", label: "Rentals" }}
      />

      <StatStrip
        stats={[
          {
            label: "Due to bank ≤30 days",
            value: String(dueSoon.length),
            tone: dueSoon.length > 0 ? "accent" : "default",
            hint: formatMoney(dueSoon.reduce((t, c) => t + Number(c.amount), 0), ccy, 0),
          },
          {
            label: "Held in safe",
            value: formatMoney(heldTotal, ccy, 0),
            hint: `${stat("held")?.n ?? 0} cheques`,
          },
          {
            label: "Clearing",
            value: formatMoney(Number(stat("deposited")?.total ?? 0), ccy, 0),
            hint: `${stat("deposited")?.n ?? 0} deposited`,
          },
          {
            label: "Bounced",
            value: formatMoney(bouncedTotal, ccy, 0),
            tone: bouncedTotal > 0 ? "negative" : "positive",
            hint: `${stat("bounced")?.n ?? 0} to chase`,
          },
          {
            label: "Cleared to date",
            value: formatMoney(Number(stat("cleared")?.total ?? 0), ccy, 0),
            tone: "positive",
            hint: `${stat("cleared")?.n ?? 0} cheques`,
          },
        ]}
      />

      <Card>
        <CardHeader
          title="Cheques"
          subtitle="Each instrument is tied to the rental period it covers"
          action={
            <FilterTabs
              basePath="/rentals/cheques"
              active={filter}
              options={[
                { key: "all", label: "All", count: cheques.length },
                { key: "due", label: "Bank now", count: dueSoon.length },
                { key: "held", label: "Held", count: stat("held")?.n ?? 0 },
                { key: "bounced", label: "Bounced", count: stat("bounced")?.n ?? 0 },
                { key: "cleared", label: "Cleared", count: stat("cleared")?.n ?? 0 },
              ]}
            />
          }
        />
        <DataTable
          rows={filtered}
          rowKey={(c) => c.id}
          empty={
            <TableEmpty
              title={filter === "due" ? "Nothing to bank this month" : "No cheques match"}
              detail={
                filter === "due"
                  ? "No post-dated cheques fall due in the next 30 days."
                  : "Try a different filter."
              }
            />
          }
          columns={[
            {
              key: "no", header: "Cheque",
              render: (c) => (
                <div>
                  <p className="font-medium tnum">{c.cheque_number}</p>
                  <p className="text-2xs text-subtle truncate">{c.bank_name}</p>
                </div>
              ),
            },
            {
              key: "drawer", header: "Tenant",
              render: (c) => (
                <div className="min-w-0">
                  <p className="truncate">{c.drawer}</p>
                  <p className="text-2xs text-subtle truncate">
                    {c.unit ? `Unit ${c.unit}` : ""} {c.lease_number ? `· ${c.lease_number}` : ""}
                  </p>
                </div>
              ),
            },
            { key: "bu", header: "Business", render: (c) => <BuTag name={c.bu} color={c.color_token} /> },
            {
              key: "period", header: "Covers",
              render: (c) =>
                c.period_start ? (
                  <span className="text-2xs text-muted">
                    {c.period_start} → {c.period_end}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            { key: "date", header: "Cheque date", render: (c) => c.cheque_date },
            {
              key: "due", header: "", numeric: true,
              render: (c) =>
                c.status === "held" ? <DaysPill days={daysUntil(c.cheque_date, today)} /> : null,
            },
            { key: "amount", header: "Amount", numeric: true, render: (c) => formatMoney(Number(c.amount), ccy, 0) },
            {
              key: "do", header: "",
              render: (c) => (
                <div className="flex gap-1">
                  {c.status === "held" && (
                    <>
                      <ActionForm action={chequeAction} submitLabel="Deposit" pendingLabel="…"
                        variant="ghost"
                        hidden={{ chequeId: c.id, action: "deposit", onDate: today }} />
                      <ActionForm action={chequeAction} submitLabel="Cleared" pendingLabel="…"
                        confirm={`Records ${formatMoney(Number(c.amount), ccy, 0)} as received and settles the invoices this cheque covers. There is no undo on this screen.`}
                        hidden={{ chequeId: c.id, action: "clear", onDate: today }} />
                    </>
                  )}
                  {c.status === "deposited" && (
                    <>
                      <ActionForm action={chequeAction} submitLabel="Cleared" pendingLabel="…"
                        confirm={`Records ${formatMoney(Number(c.amount), ccy, 0)} as received and settles the invoices this cheque covers. There is no undo on this screen.`}
                        hidden={{ chequeId: c.id, action: "clear", onDate: today }} />
                      <ActionForm action={chequeAction} submitLabel="Bounced" pendingLabel="…"
                        variant="danger"
                        confirm={`Marks ${formatMoney(Number(c.amount), ccy, 0)} as returned unpaid, posts a AED 100 bank charge, and leaves the debt outstanding.`}
                        hidden={{ chequeId: c.id, action: "bounce", onDate: today,
                          bounceReason: "Insufficient funds", bankCharge: "100" }} />
                    </>
                  )}
                </div>
              ),
            },
            {
              key: "status", header: "Status",
              render: (c) => (
                <div>
                  <StatusPill status={c.status} />
                  {c.bounce_reason && (
                    <p className="text-2xs mt-0.5" style={{ color: "var(--negative)" }}>
                      {c.bounce_reason}
                    </p>
                  )}
                  {c.status === "held" && c.custody && (
                    <p className="text-2xs text-subtle mt-0.5">{c.custody}</p>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Card className="p-4" as="div">
        <p className="label mb-1.5">Why cheques are not payments</p>
        <p className="text-xs leading-relaxed text-muted">
          A cheque sitting in the safe is a promise, not money. Booking a year of rent cheques as
          cash would overstate the bank balance by the full annual rent; booking them as
          receivables would be wrong too, because the invoice for month nine does not exist yet.
          They live here until they clear, at which point a payment is created and allocated
          across the invoices for the months that cheque covers.
        </p>
        <p className="text-2xs text-subtle mt-2 leading-relaxed">
          Rent is still invoiced monthly regardless of collection method, so the profit and loss
          account is correct whether the tenant pays by cheque bundle or bank transfer.
        </p>
      </Card>
    </div>
  );
}
