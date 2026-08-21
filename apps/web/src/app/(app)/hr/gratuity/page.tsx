import Link from "next/link";
import { sql } from "drizzle-orm";
import { withTenant } from "@nexus/db";
import { can, formatMoney } from "@nexus/core";
import {
  GRATUITY_SETTLE_PERMISSION,
  loadGratuityRegister,
  type GratuityRegisterRow,
} from "@nexus/core/services";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { ActionForm, Disclosure, Field } from "@/components/action-form";
import { BuTag, DataTable, PageHeader, StatStrip, TableEmpty } from "@/components/page";
import { rehireEmployeeAction, settleGratuityAction } from "@/lib/actions/gratuity";

export const dynamic = "force-dynamic";

/**
 * END-OF-SERVICE GRATUITY — the register, and the payout that settles it.
 *
 * Shows the liability per employee AND the working behind it, because the
 * number is large, unfamiliar to most owners, and will be challenged the first
 * time they see it. Every row can be reconciled by hand against Article 51 of
 * Federal Decree-Law 33/2021 — which is the only way it earns trust.
 *
 * The recipe, so "by hand" means something: count whole years from the SERVICE
 * START to today's date, 21 days each for the first five and 30 for each one
 * after, pro-rate the year in progress over its own length, and multiply by
 * monthly basic × 12 ÷ 365. `calculateGratuity` counts service in calendar
 * anniversaries for exactly this reason — the elapsed-days ÷ 365 it used to do
 * moved the five-year boundary earlier on every leap day, which put the register
 * a couple of days out on round anniversaries and made the promise above false.
 *
 * WHAT IS NEW ON THIS SCREEN, and why it changes what the register is for:
 *
 *  • THE PAYOUT. Until now nothing in the product could settle the number this
 *    page displays. The liability accrued forever and the leaving employee was
 *    paid outside the system, so the register was a statement of a debt nobody
 *    could discharge. "Settle" posts the journal that discharges it, and it is
 *    the only screen in the product that pays a five-figure sum to a person, so
 *    it is behind an `ActionForm confirm` that states the effect in words.
 *
 *  • SERVICE START, NOT JOINING DATE. The `Joined` column now shows both when
 *    they differ. An employee who was settled and rehired accrues from their
 *    rehire date; their joining date stays on the row because it is on their
 *    contract and in their visa file. That is edge case EC-05, and before this
 *    change the register showed a rehired employee the full service they had
 *    already been paid for — AED 60,515.67 where AED 10,176.47 was owed, on the
 *    fixture in `gratuity-payout.test.ts`.
 *
 *  • THE PROVISION SPLIT, BEFORE THE BUTTON. Each settlement row shows what
 *    comes out of the provision and what will land in this month's profit. An
 *    owner only ever discovers their monthly accrual is running light at the
 *    moment somebody leaves, so this is the moment to say it.
 *
 * The five states of WF-05 §0: default below, `loading.tsx` alongside, the
 * group-level `error.tsx`, the "nobody is accruing" empty state, and the
 * permission-denied card immediately after the session lookup.
 */
export default async function GratuityPage({
  searchParams,
}: {
  searchParams: Promise<{ settle?: string; rehire?: string }>;
}) {
  const session = await requireSession();
  const { settle: settleFor, rehire: rehireFor } = await searchParams;
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;

  // Mirrors the nav, which gates this route on `payroll:read`, and the
  // `gratuity_liability` metric, which is gated on the same key. Paying one is
  // a separate, sensitive permission: the accountant may read the liability and
  // may not settle it.
  const mayRead = can(session.principal, "payroll:read");
  const maySettle = can(session.principal, GRATUITY_SETTLE_PERMISSION);

  /* ── STATE: permission denied ───────────────────────────────────────────── */
  // A real answer rather than a 404, per the convention on the cash screen:
  // anyone who lands here followed a link or a bookmark, and naming the
  // permission they would need is more use than a dead end.
  if (!mayRead) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="End-of-service gratuity" back={{ href: "/compliance", label: "Compliance" }} />
        <Card className="p-5" as="div">
          <p className="text-xs font-semibold">You do not have access to the gratuity register.</p>
          <p className="text-2xs text-subtle mt-1.5 leading-relaxed max-w-[52ch]">
            The accrued end-of-service liability is salary data, so it needs{" "}
            <code className="text-2xs">payroll:read</code>. Settling one and paying it needs{" "}
            <code className="text-2xs">payroll:pay</code> on top. Ask whoever manages access on
            the People and access screen.
          </p>
        </Card>
      </div>
    );
  }

  const { rows, provision, settlements } = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => ({
      // The entitlement is recomputed here rather than read from
      // `employees.gratuity_accrued`: this is where the owner comes to check
      // the number, so it has to show the calculation and not a cached copy.
      rows: await loadGratuityRegister(tx, { asOf: today }),
      provision: await tx.execute<{ amount: string }>(sql`
        SELECT COALESCE(SUM(jl.base_credit - jl.base_debit), 0) AS amount
          FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE a.system_key = 'GRATUITY_PROVISION'
      `),
      settlements: await tx.execute<{
        id: string; settlement_number: string; reason: string; last_working_day: string;
        gratuity_amount: string; net_payable: string; provision_applied: string;
        expense_shortfall: string; provision_released: string; forfeiture_assumed: boolean;
        settled_via: string; explanation: string; employee_id: string; full_name: string;
        status: string; joined_on: string; service_restarted_on: string | null;
        bu_name: string; color_token: string;
      }>(sql`
        SELECT g.id, g.settlement_number, g.reason, g.last_working_day::text,
               g.gratuity_amount, g.net_payable, g.provision_applied,
               g.expense_shortfall, g.provision_released, g.forfeiture_assumed,
               g.settled_via, g.explanation,
               e.id AS employee_id, e.full_name, e.status::text AS status,
               e.joined_on::text, e.service_restarted_on::text,
               b.name AS bu_name, b.color_token
          FROM gratuity_settlements g
          JOIN employees e ON e.id = g.employee_id
          JOIN business_units b ON b.id = g.business_unit_id
         ORDER BY g.last_working_day DESC, g.created_at DESC
         LIMIT 25
      `),
    }),
  );

  const liability = rows.reduce((t, r) => t + r.gratuity.amount, 0);
  const provisioned = Number(provision[0]?.amount ?? 0);
  const notYetEntitled = rows.filter((r) => !r.gratuity.entitled).length;
  const rehired = rows.filter((r) => r.settledThrough !== null);
  // No monthly run-rate tile here on purpose. One used to be computed at
  // `dailyBasicWage x 21/12` for every employee and never rendered — 1.75
  // days/month applied to staff past five years who accrue 2.5, and to staff
  // under a year who accrue nothing. A wrong number sitting one line away from
  // a tile gets wired to the tile eventually. If the run-rate is wanted, take
  // it from `monthlyGratuityAccrual` — the movement between two valuation
  // dates — which is band-aware and is what actually gets posted.
  const wpsReady = rows.filter((r) => r.wpsReady).length;
  const payMonth = today.slice(0, 7);

  const focusedSettle = settleFor ? rows.find((r) => r.employeeId === settleFor) : undefined;
  const focusedRehire = rehireFor
    ? settlements.find((s) => s.employee_id === rehireFor)
    : undefined;

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

      {focusedSettle && (
        <SettlementPanel row={focusedSettle} today={today} ccy={ccy} maySettle={maySettle} />
      )}

      {focusedRehire && (
        <RehirePanel
          employeeId={focusedRehire.employee_id}
          name={focusedRehire.full_name}
          joinedOn={focusedRehire.joined_on}
          settledThrough={focusedRehire.last_working_day}
          settlementNumber={focusedRehire.settlement_number}
          status={focusedRehire.status}
          today={today}
          maySettle={maySettle}
        />
      )}

      <Card>
        <CardHeader
          title="Per employee"
          subtitle="21 days' basic wage per year for the first five years, 30 days thereafter, capped at two years' total wage"
        />
        <DataTable
          rows={rows}
          rowKey={(r) => r.employeeId}
          empty={
            <TableEmpty
              title="No active employees"
              detail="Nothing is accruing. Gratuity starts building from an employee's first day, so this fills up as soon as anyone is on the payroll."
            />
          }
          columns={[
            {
              key: "name", header: "Employee",
              render: (r) => (
                <div className="min-w-0">
                  <p className="font-medium truncate">{r.fullName}</p>
                  <p className="text-2xs text-subtle truncate">
                    {r.designation ?? "—"} · <BuTag name={r.businessUnitName} color={r.colorToken ?? "slate"} />
                  </p>
                </div>
              ),
            },
            {
              key: "joined", header: "Service from",
              render: (r) => (
                <div>
                  <div>{r.serviceStart}</div>
                  {/* Both dates, whenever they differ. The joining date is on
                      the contract and in the MOHRE file; the service start is
                      what the arithmetic uses. Showing only one of them is how
                      a rehired employee's row becomes unexplainable. */}
                  {r.serviceStart !== r.joinedOn && (
                    <div className="text-2xs text-subtle">
                      joined {r.joinedOn} · settled to {r.settledThrough}
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: "service", header: "Service", numeric: true,
              render: (r) => (
                <span className={r.gratuity.entitled ? "" : "text-subtle"}>
                  {r.gratuity.serviceYears.toFixed(1)} yr
                </span>
              ),
            },
            {
              key: "basic", header: "Basic / month", numeric: true,
              render: (r) => (
                <div>
                  <div>{formatMoney(r.basicSalary, ccy, 0)}</div>
                  <div className="text-2xs text-subtle">
                    of {formatMoney(r.totalSalary, ccy, 0)} package
                  </div>
                </div>
              ),
            },
            {
              key: "days", header: "Days earned", numeric: true,
              render: (r) =>
                r.gratuity.entitled ? (
                  <div>
                    <div>{r.gratuity.totalDays.toFixed(1)}</div>
                    {r.gratuity.beyondFiveYearDays > 0 && (
                      <div className="text-2xs text-subtle">
                        {r.gratuity.firstFiveYearDays.toFixed(0)} +{" "}
                        {r.gratuity.beyondFiveYearDays.toFixed(1)}
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
                r.gratuity.entitled ? (
                  <span className="font-semibold" style={{ color: "var(--caution)" }}>
                    {formatMoney(r.gratuity.amount, ccy, 0)}
                  </span>
                ) : (
                  <span className="text-subtle text-2xs">under 1 year</span>
                ),
            },
            {
              key: "wps", header: "WPS", numeric: true,
              render: (r) =>
                r.wpsReady ? (
                  <span className="chip" style={{ background: "var(--positive-soft)", color: "var(--positive)" }}>
                    ready
                  </span>
                ) : (
                  <span className="chip" style={{ background: "var(--negative-soft)", color: "var(--negative)" }}>
                    incomplete
                  </span>
                ),
            },
            {
              key: "settle", header: "", numeric: true,
              render: (r) =>
                maySettle ? (
                  <Link
                    href={`/hr/gratuity?settle=${r.employeeId}`}
                    className="btn text-2xs"
                    style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
                    scroll
                  >
                    Settle…
                  </Link>
                ) : null,
            },
          ]}
        />
        {!maySettle && rows.length > 0 && (
          <p className="px-4 pb-4 text-2xs text-subtle leading-relaxed">
            Settling an employee&rsquo;s end of service pays them and posts the journal that
            discharges this liability. It needs <code className="text-2xs">payroll:pay</code>,
            which this role does not hold.
          </p>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Settled"
          subtitle="Payouts that discharged the liability. A settled period is never counted again — a rehired employee accrues from their rehire date."
        />
        {settlements.length === 0 ? (
          <EmptyState
            icon="▨"
            title="Nobody has been settled yet"
            detail="When an employee leaves, settling them here pays the gratuity and takes it off the balance sheet. Until then the liability above keeps accruing."
          />
        ) : (
          <DataTable
            rows={settlements}
            rowKey={(s) => s.id}
            // Unreachable — the branch above renders the richer `EmptyState`
            // when there are none. `DataTable` requires the prop, and a table
            // that silently renders nothing is the "no data" / "nothing set up"
            // confusion WF-05 §0 separates.
            empty={<TableEmpty title="No settlements yet" detail="Nobody has been paid out." />}
            columns={[
              {
                key: "ref", header: "Settlement",
                render: (s) => (
                  <div className="min-w-0">
                    <p className="font-medium truncate">{s.full_name}</p>
                    <p className="text-2xs text-subtle truncate">
                      {s.settlement_number} · {s.reason.replace(/_/g, " ")}
                    </p>
                  </div>
                ),
              },
              { key: "lwd", header: "Last day", render: (s) => s.last_working_day },
              {
                key: "gratuity", header: "Gratuity", numeric: true,
                render: (s) => formatMoney(Number(s.gratuity_amount), ccy, 0),
              },
              {
                key: "split", header: "Provision / P&L", numeric: true,
                render: (s) => (
                  <div>
                    <div>{formatMoney(Number(s.provision_applied), ccy, 0)}</div>
                    {Number(s.expense_shortfall) > 0 && (
                      <div className="text-2xs" style={{ color: "var(--negative)" }}>
                        + {formatMoney(Number(s.expense_shortfall), ccy, 0)} charged
                      </div>
                    )}
                    {Number(s.provision_released) > 0 && (
                      <div className="text-2xs" style={{ color: "var(--positive)" }}>
                        − {formatMoney(Number(s.provision_released), ccy, 0)} released
                      </div>
                    )}
                  </div>
                ),
              },
              {
                key: "net", header: "Net paid", numeric: true,
                render: (s) => (
                  <div>
                    <div className="font-semibold">{formatMoney(Number(s.net_payable), ccy, 0)}</div>
                    <div className="text-2xs text-subtle">{s.settled_via.replace(/_/g, " ")}</div>
                  </div>
                ),
              },
              {
                key: "flag", header: "", numeric: true,
                render: (s) =>
                  s.forfeiture_assumed ? (
                    <span
                      className="chip"
                      style={{ background: "var(--caution-soft)", color: "var(--caution)" }}
                      title="Settled at zero on the Article 44 forfeiture assumption — open question Q-2b."
                    >
                      Q-2b
                    </span>
                  ) : null,
              },
              {
                key: "rehire", header: "", numeric: true,
                render: (s) =>
                  maySettle && ["resigned", "terminated"].includes(s.status) ? (
                    <Link
                      href={`/hr/gratuity?rehire=${s.employee_id}`}
                      className="btn text-2xs"
                      style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
                      scroll
                    >
                      Rehire…
                    </Link>
                  ) : null,
              },
            ]}
          />
        )}
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
                  (rows.reduce((t, r) => t + r.basicSalary, 0) /
                    rows.reduce((t, r) => t + r.totalSalary, 0)) *
                    100,
                )
              : 0}
            %
          </strong>
          .
        </p>
        <p className="text-2xs text-subtle mt-2 leading-relaxed">
          Under the 2021 law the old reductions for resignation were removed: an employee who
          resigns after a year receives the same entitlement as one who is terminated. Service is
          counted to the <strong>anniversary of the service start</strong>, so the 21-day rate runs
          to the fifth anniversary and 30 days a year applies only after it — a part-completed
          year is pro-rated over its own length. Daily wage is monthly basic × 12 ÷ 365, the
          convention MOHRE and the courts use.
        </p>
        <p className="text-2xs text-subtle mt-2 leading-relaxed">
          <strong>Settling and rehiring.</strong> A payout discharges the liability rather than
          charging it again: it debits the provision that has been building month by month, and
          only the difference — the amount the accrual under- or over-provided — reaches this
          month&rsquo;s profit. If a settled employee comes back, their service clock restarts on
          their rehire date. Their joining date is not moved; it is on their labour contract and
          in their MOHRE file, and it is the evidence that the first period was paid for.
          {rehired.length > 0 && (
            <>
              {" "}
              <strong>
                {rehired.length} current employee{rehired.length === 1 ? " has" : "s have"}
              </strong>{" "}
              a restarted clock.
            </>
          )}
        </p>
        <p className="text-2xs text-subtle mt-2 leading-relaxed">
          <strong>Assumption, not confirmed law:</strong> the calculation behind these figures
          forfeits the whole entitlement when an employee is dismissed for gross misconduct — so a
          settlement run that way pays nothing. That was the rule under Articles 120 and 139 of
          Federal Law 8 of 1980, which has been superseded. Article 44 of Federal Decree-Law 33 of
          2021 permits dismissal without notice but may not extinguish the Article 51
          end-of-service benefit. Open question Q-2b, with MOHRE or an employment lawyer — the
          settlement form refuses a misconduct payout until someone ticks an acknowledgement, and
          every settlement made that way is tagged, so they can all be found again if the answer
          comes back the other way.
        </p>
      </Card>
    </div>
  );
}

/* ── The payout ────────────────────────────────────────────────────────────── */

/**
 * The settlement form for one employee.
 *
 * Every figure the owner needs to judge the payout is on the panel before the
 * button: the entitlement, the provision that will be released, and the
 * difference that will hit profit. The `confirm` then states the effect in
 * words rather than asking "are you sure?" — a confirmation the user cannot
 * read is a click-through, which is worse than none because it looks like a
 * control.
 *
 * The amount shown is the ordinary-termination figure. A gross-misconduct
 * settlement pays nothing under an assumption nobody has confirmed, which is
 * why the amount cannot simply be restated for it and why the service refuses
 * that path without an explicit acknowledgement. See open question Q-2b.
 */
function SettlementPanel({
  row,
  today,
  ccy,
  maySettle,
}: {
  row: GratuityRegisterRow;
  today: string;
  ccy: string;
  maySettle: boolean;
}) {
  const entitlement = row.gratuity.amount;
  const shortfall = Math.max(0, entitlement - row.accruedOnRecord);
  const release = Math.max(0, row.accruedOnRecord - entitlement);

  return (
    <Card>
      <CardHeader
        title={`Settle ${row.fullName}`}
        subtitle={row.gratuity.explanation}
        action={
          <Link href="/hr/gratuity" className="text-2xs text-subtle hover:underline">
            Cancel
          </Link>
        }
      />
      <div className="px-4 pb-4 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Figure label="Entitlement at today" value={formatMoney(entitlement, ccy)} tone="caution" />
          <Figure label="Provision carried" value={formatMoney(row.accruedOnRecord, ccy)} />
          <Figure
            label={shortfall > 0 ? "Charged to this month" : "Released to profit"}
            value={formatMoney(shortfall > 0 ? shortfall : release, ccy)}
            tone={shortfall > 0 ? "negative" : release > 0 ? "positive" : undefined}
          />
          <Figure
            label="Advances outstanding"
            value={formatMoney(row.advanceOutstanding, ccy)}
            tone={row.advanceOutstanding > 0 ? "caution" : undefined}
          />
        </div>

        {row.accruedOnRecord === 0 && entitlement > 0 && (
          <p
            className="text-2xs leading-relaxed px-3 py-2 rounded-[var(--radius-md)]"
            style={{ background: "var(--caution-soft)", color: "var(--caution)" }}
          >
            Nothing has been accrued for {row.fullName} on record, so the whole{" "}
            {formatMoney(entitlement, ccy)} will be charged to this month&rsquo;s profit rather
            than released from the provision. That is the honest posting, but it means the
            monthly accrual has not been running for them — worth checking before you settle.
          </p>
        )}

        {!maySettle ? (
          <p className="text-2xs text-subtle leading-relaxed">
            Settling needs <code className="text-2xs">payroll:pay</code>.
          </p>
        ) : (
          <ActionForm
            action={settleGratuityAction}
            submitLabel="Settle and pay"
            pendingLabel="Posting…"
            variant="primary"
            hidden={{ employeeId: row.employeeId }}
            confirm={
              `This pays ${row.fullName} their end-of-service settlement, posts the journal ` +
              `that discharges ${formatMoney(row.accruedOnRecord, ccy)} of provision, and closes ` +
              `their employment record. On an ordinary termination the gratuity is ` +
              `${formatMoney(entitlement, ccy)}. It cannot be undone by a click — reversing it ` +
              `needs a manual journal and a corrected employment record.`
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <Field
                label="Reason"
                name="reason"
                options={[
                  { value: "resignation", label: "Resignation" },
                  { value: "termination", label: "Termination" },
                  { value: "gross_misconduct", label: "Gross misconduct (Art. 44)" },
                ]}
              />
              <Field
                label="Last working day"
                name="lastWorkingDay"
                type="date"
                defaultValue={today}
                required
              />
              <Field
                label="Unpaid leave days"
                name="unpaidLeaveDays"
                type="number"
                min="0"
                step="1"
                defaultValue={0}
              />
            </div>

            <Disclosure summary="Everything else owed on the last day">
              <p className="text-2xs text-subtle leading-relaxed mb-3 max-w-[64ch]">
                Nothing in the product accrues leave salary or notice pay yet, so these are
                entered rather than derived. They post to staff cost in the month of settlement.
                Deductions other than salary advances are deliberately not offered — a fine or an
                unreturned laptop has no account mapping here that would not be invented, and
                those belong in a manual journal.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Field label="Unpaid salary" name="unpaidSalary" type="number" step="0.01" min="0" defaultValue={0} />
                <Field label="Leave encashment" name="leaveEncashment" type="number" step="0.01" min="0" defaultValue={0} />
                <Field label="Notice pay" name="noticePay" type="number" step="0.01" min="0" defaultValue={0} />
                <Field label="Other" name="otherEarnings" type="number" step="0.01" min="0" defaultValue={0} />
              </div>
              {row.advanceOutstanding > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
                  <Field
                    label={`Salary advance recovered (up to ${formatMoney(row.advanceOutstanding, ccy)})`}
                    name="advanceRecovery"
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={row.advanceOutstanding}
                  />
                </div>
              )}
            </Disclosure>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 mb-3">
              <Field
                label="Paid by"
                name="settledVia"
                options={[
                  { value: "bank_transfer", label: "Bank transfer" },
                  { value: "wps", label: "WPS run" },
                  { value: "cash", label: "Cash" },
                  { value: "payable", label: "Owed — pay in the next bank run" },
                ]}
              />
              <Field label="Note (kept on the audit log)" name="note" placeholder="Optional" />
            </div>

            {/* Not defaulted, not hidden, and not `required` — a misconduct
                settlement must be refused by the server when this is unticked,
                and the refusal is the point. The service returns the four
                sentences explaining why. */}
            <label className="flex items-start gap-2 mb-3 text-2xs leading-relaxed cursor-pointer">
              <input
                type="checkbox"
                name="acknowledgeForfeitureAssumption"
                className="mt-0.5 shrink-0"
              />
              <span className="text-muted">
                <strong>Gross misconduct only.</strong> I understand that settling for gross
                misconduct pays <strong>nothing at all</strong>, and that the forfeiture is an{" "}
                <strong>assumption</strong> under Article 44 of Federal Decree-Law 33 of 2021
                rather than confirmed law — open question Q-2b. On this employee it is the
                difference between {formatMoney(entitlement, ccy)} and nil.
              </span>
            </label>
          </ActionForm>
        )}
      </div>
    </Card>
  );
}

/* ── EC-05 ─────────────────────────────────────────────────────────────────── */

/**
 * Bring a settled employee back, restarting the service clock.
 *
 * The screen's whole job here is to make the two dates visible at once, because
 * the mistake this prevents is invisible: without a restarted clock the rehired
 * employee's register row immediately shows all the service that was already
 * bought, and the arithmetic is internally consistent while being applied to
 * years that have been paid for.
 */
function RehirePanel({
  employeeId,
  name,
  joinedOn,
  settledThrough,
  settlementNumber,
  status,
  today,
  maySettle,
}: {
  employeeId: string;
  name: string;
  joinedOn: string;
  settledThrough: string;
  settlementNumber: string;
  status: string;
  today: string;
  maySettle: boolean;
}) {
  const alreadyBack = !["resigned", "terminated"].includes(status);
  return (
    <Card>
      <CardHeader
        title={`Rehire ${name}`}
        subtitle={`Joined ${joinedOn} · settled to ${settledThrough} under ${settlementNumber}`}
        action={
          <Link href="/hr/gratuity" className="text-2xs text-subtle hover:underline">
            Cancel
          </Link>
        }
      />
      <div className="px-4 pb-4 space-y-3">
        <p className="text-2xs text-subtle leading-relaxed max-w-[68ch]">
          Gratuity will accrue from the date they start again, not from {joinedOn}. Service to{" "}
          {settledThrough} was settled and paid, so counting it a second time would pay for the
          same years twice. Their joining date is not changed — it is on the labour contract and
          in the MOHRE file, and it is the evidence that the first period existed.
        </p>
        {alreadyBack ? (
          <p className="text-2xs text-subtle">
            {name} is already {status.replace(/_/g, " ")}.
          </p>
        ) : !maySettle ? (
          <p className="text-2xs text-subtle">
            Restarting a service clock decides what the next settlement pays, so it needs{" "}
            <code className="text-2xs">payroll:pay</code>.
          </p>
        ) : (
          <ActionForm
            action={rehireEmployeeAction}
            submitLabel="Rehire"
            pendingLabel="Saving…"
            hidden={{ employeeId }}
            confirm={
              `${name} goes back to active and starts accruing gratuity again from the date ` +
              `below. The service already settled to ${settledThrough} is not counted again.`
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <Field
                label="First day back"
                name="rehiredOn"
                type="date"
                defaultValue={today}
                required
              />
              <Field label="New basic salary" name="basicSalary" type="number" step="0.01" min="0" placeholder="unchanged" />
              <Field label="New housing allowance" name="housingAllowance" type="number" step="0.01" min="0" placeholder="unchanged" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              <Field label="New transport allowance" name="transportAllowance" type="number" step="0.01" min="0" placeholder="unchanged" />
              <Field label="New other allowance" name="otherAllowance" type="number" step="0.01" min="0" placeholder="unchanged" />
              <Field label="Note (kept on the audit log)" name="note" placeholder="Optional" />
            </div>
          </ActionForm>
        )}
      </div>
    </Card>
  );
}

/** One labelled figure in the settlement summary strip. */
function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "caution" | "negative" | "positive";
}) {
  const color =
    tone === "caution" ? "var(--caution)"
    : tone === "negative" ? "var(--negative)"
    : tone === "positive" ? "var(--positive)"
    : "var(--text)";
  return (
    <div className="px-3 py-2 rounded-[var(--radius-md)]" style={{ background: "var(--surface-2)" }}>
      <p className="label mb-0.5">{label}</p>
      <p className="text-sm font-semibold tnum" style={{ color }}>
        {value}
      </p>
    </div>
  );
}
