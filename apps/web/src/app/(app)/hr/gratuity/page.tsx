import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { calculateGratuity, formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader } from "@/components/ui";
import { DataTable, PageHeader, StatStrip, TableEmpty } from "@/components/page";

export const dynamic = "force-dynamic";

/**
 * End-of-service gratuity register.
 *
 * Shows the liability per employee AND the working behind it, because the
 * number is large, unfamiliar to most owners, and will be challenged the first
 * time they see it. Every row can be reconciled by hand against Article 51 of
 * Federal Decree-Law 33/2021 — which is the only way it earns trust.
 */
export default async function GratuityPage() {
  const session = await requireSession();
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  const { staff, provision } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const staff = await tx.execute<{
        id: string; full_name: string; designation: string; nationality: string | null;
        joined_on: string; basic: string; housing: string; transport: string; other: string;
        accrued: string; bu: string; color_token: string; iban_enc: string | null;
        wps_person_id: string | null; wps_routing_code: string | null;
      }>(sql`
        SELECT e.id, e.full_name, e.designation, e.nationality, e.joined_on::text,
               e.base_salary AS basic, e.housing_allowance AS housing,
               e.transport_allowance AS transport, e.other_allowance AS other,
               e.gratuity_accrued AS accrued, b.name AS bu, b.color_token,
               e.iban_enc, e.wps_person_id, e.wps_routing_code
          FROM employees e
          JOIN business_units b ON b.id = e.primary_business_unit_id
         WHERE e.status IN ('active','probation','on_leave')
         ORDER BY e.gratuity_accrued DESC
      `);
      const provision = await tx.execute<{ amount: string }>(sql`
        SELECT COALESCE(SUM(jl.base_credit - jl.base_debit), 0) AS amount
          FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE a.system_key = 'GRATUITY_PROVISION'
      `);
      return { staff, provision };
    },
  );

  // Recompute live rather than trusting the stored figure — this page is where
  // the owner comes to check the number, so it must show the calculation, not
  // a cached copy of it.
  const rows = staff.map((e) => {
    const total = Number(e.basic) + Number(e.housing) + Number(e.transport) + Number(e.other);
    const g = calculateGratuity({
      basicSalary: Number(e.basic),
      totalSalary: total,
      joinedOn: e.joined_on,
      asOf: today,
    });
    return { ...e, total, g };
  });

  const liability = rows.reduce((t, r) => t + r.g.amount, 0);
  const provisioned = Number(provision[0]?.amount ?? 0);
  const notYetEntitled = rows.filter((r) => !r.g.entitled).length;
  const monthlyRun = rows.reduce((t, r) => t + r.g.dailyBasicWage * (21 / 12) * 1, 0);
  const wpsReady = rows.filter(
    (r) => r.iban_enc && r.wps_person_id && r.wps_routing_code,
  ).length;
  const payMonth = today.slice(0, 7);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      <PageHeader
        title="End-of-service gratuity"
        subtitle="Federal Decree-Law 33 of 2021, Article 51 · calculated on basic salary only"
        back={{ href: "/compliance", label: "Compliance" }}
        actions={
          <a href={`/api/wps/${payMonth}`} className="btn btn-primary text-xs" download>
            ↓ WPS file for {payMonth}
          </a>
        }
      />

      <StatStrip
        stats={[
          { label: "Total liability", value: formatMoney(liability, ccy, 0), tone: "caution" },
          {
            label: "Posted to provision",
            value: formatMoney(provisioned, ccy, 0),
            tone: Math.abs(liability - provisioned) < 1 ? "positive" : "negative",
            hint: Math.abs(liability - provisioned) < 1 ? "reconciled" : "does not tie",
          },
          { label: "Employees covered", value: String(rows.length - notYetEntitled) },
          {
            label: "Under 1 year",
            value: String(notYetEntitled),
            hint: "No entitlement yet",
          },
          {
            label: "WPS-ready",
            value: `${wpsReady}/${rows.length}`,
            tone: wpsReady === rows.length ? "positive" : "negative",
            hint: "IBAN + Person ID + routing",
          },
        ]}
      />

      <Card>
        <CardHeader
          title="Per employee"
          subtitle="21 days' basic wage per year for the first five years, 30 days thereafter, capped at two years' total wage"
        />
        <DataTable
          rows={rows}
          rowKey={(r) => r.id}
          empty={<TableEmpty title="No active employees" detail="Nothing accruing." />}
          columns={[
            {
              key: "name", header: "Employee",
              render: (r) => (
                <div className="min-w-0">
                  <p className="font-medium truncate">{r.full_name}</p>
                  <p className="text-2xs text-subtle truncate">
                    {r.designation} · {r.bu}
                  </p>
                </div>
              ),
            },
            { key: "joined", header: "Joined", render: (r) => r.joined_on },
            {
              key: "service", header: "Service", numeric: true,
              render: (r) => (
                <span className={r.g.entitled ? "" : "text-subtle"}>
                  {r.g.serviceYears.toFixed(1)} yr
                </span>
              ),
            },
            {
              key: "basic", header: "Basic / month", numeric: true,
              render: (r) => (
                <div>
                  <div>{formatMoney(Number(r.basic), ccy, 0)}</div>
                  <div className="text-2xs text-subtle">of {formatMoney(r.total, ccy, 0)} package</div>
                </div>
              ),
            },
            {
              key: "days", header: "Days earned", numeric: true,
              render: (r) =>
                r.g.entitled ? (
                  <div>
                    <div>{r.g.totalDays.toFixed(1)}</div>
                    {r.g.beyondFiveYearDays > 0 && (
                      <div className="text-2xs text-subtle">
                        {r.g.firstFiveYearDays.toFixed(0)} + {r.g.beyondFiveYearDays.toFixed(1)}
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "accrued", header: "Liability", numeric: true,
              render: (r) =>
                r.g.entitled ? (
                  <span className="font-semibold" style={{ color: "var(--caution)" }}>
                    {formatMoney(r.g.amount, ccy, 0)}
                  </span>
                ) : (
                  <span className="text-subtle text-2xs">under 1 year</span>
                ),
            },
            {
              key: "wps", header: "WPS", numeric: true,
              render: (r) =>
                r.iban_enc && r.wps_person_id && r.wps_routing_code ? (
                  <span className="chip" style={{ background: "var(--positive-soft)", color: "var(--positive)" }}>
                    ready
                  </span>
                ) : (
                  <span className="chip" style={{ background: "var(--negative-soft)", color: "var(--negative)" }}>
                    incomplete
                  </span>
                ),
            },
          ]}
        />
      </Card>

      <Card className="p-4" as="div">
        <p className="label mb-1.5">Why the salary split matters</p>
        <p className="text-xs leading-relaxed text-muted">
          Gratuity is calculated on <strong>basic salary only</strong> — housing, transport and
          other allowances are excluded. A system that stores one lumped &ldquo;salary&rdquo;
          figure cannot compute this at all. UAE employers commonly set basic at 50–60% of the
          package precisely to contain the liability; this group is at{" "}
          <strong>
            {rows.length
              ? Math.round(
                  (rows.reduce((t, r) => t + Number(r.basic), 0) /
                    rows.reduce((t, r) => t + r.total, 0)) *
                    100,
                )
              : 0}
            %
          </strong>
          .
        </p>
        <p className="text-2xs text-subtle mt-2 leading-relaxed">
          Under the 2021 law the old reductions for resignation were removed: an employee who
          resigns after a year receives the same entitlement as one who is terminated. Forfeiture
          survives only for dismissal under Article 44 (gross misconduct). Daily wage is monthly
          basic × 12 ÷ 365 — the convention MOHRE and the courts use.
        </p>
      </Card>
    </div>
  );
}
