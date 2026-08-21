import Link from "next/link";
import { withTenant } from "@nexus/db";
import { can, formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { resolveToday } from "@/lib/data";
import { Card, CardHeader, EmptyState } from "@/components/ui";
import { ActionForm } from "@/components/action-form";
import {
  BuTag,
  DataTable,
  FilterTabs,
  PageHeader,
  StatStrip,
  StatusPill,
  TableEmpty,
} from "@/components/page";
import { payrollRunAction } from "@/lib/actions/payroll";
/**
 * See the note in `lib/actions/payroll.ts`: this reaches into the service
 * module directly only until the coordinator adds the payroll line to the
 * `@nexus/core` services barrel.
 */
import {
  loadPayrollRuns,
  previewPayrollRun,
  PAYROLL_APPROVE_PERMISSION,
  PAYROLL_READ_PERMISSION,
  type PayrollPreview,
  type PayrollWarning,
} from "../../../../../../../packages/core/src/services/payroll.ts";

export const dynamic = "force-dynamic";

/**
 * THE PAYROLL RUN — FR-C06.
 *
 * Two steps, and the first one is the product. Everything above the button
 * exists so that somebody can refuse to press it.
 *
 * `payroll_runs` and `payslips` have been in the schema since the first
 * migration with nothing writing them, and the WPS file the bank receives was
 * being built straight from the `employees` table — a parallel computation that
 * no human had ever approved. This screen is the thing that was missing: the
 * month, computed once, shown in full, approved, posted, and then serialised
 * into the file. The download moved here from the gratuity register for the
 * same reason; a payroll export belongs next to the payroll.
 *
 * The organising decision is that the DEDUCTIONS AND THE PART-MONTHS are not a
 * detail shown after the fact. A joiner, a leaver, unpaid leave and a salary
 * advance are exactly the four things a fixed-package assumption gets wrong,
 * and they are the four things the table below states per person, per day,
 * before anything posts. Roadmap criterion 2.5 asks that the run match a
 * hand-calculated control sample exactly — so every row shows the days it was
 * prorated over, and each salary component is prorated separately, because that
 * is the arithmetic the person doing the check will actually perform.
 *
 * The five states of WF-05 §0: default below, `loading.tsx` alongside, the
 * group-level `error.tsx` plus an in-page failure card for a preview that
 * throws, the "nobody is payable" empty state, and the permission-denied card
 * immediately after the session lookup.
 */

/** Months the operator can run, newest first: the current one and the three before. */
function selectableMonths(today: string): { key: string; label: string }[] {
  const [y, m] = today.split("-").map((p) => parseInt(p, 10));
  const names = ["January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November", "December"];
  const out: { key: string; label: string }[] = [];
  for (let back = 0; back < 4; back++) {
    const d = new Date(Date.UTC(y!, m! - 1 - back, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    out.push({ key, label: `${names[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCFullYear()}` });
  }
  return out;
}

const SEVERITY_STYLE: Record<PayrollWarning["severity"], { bg: string; fg: string; label: string }> = {
  critical: { bg: "var(--negative-soft)", fg: "var(--negative)", label: "Fix before approving" },
  warning: { bg: "var(--caution-soft)", fg: "var(--caution)", label: "Worth knowing" },
  info: { bg: "var(--surface-3)", fg: "var(--text-muted)", label: "Already handled" },
};

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const session = await requireSession();
  const today = resolveToday(session.timezone);
  const ccy = session.baseCurrency;
  const months = selectableMonths(today);
  const { period = months[0]!.key } = await searchParams;

  const mayRead = can(session.principal, PAYROLL_READ_PERMISSION);
  const mayApprove = can(session.principal, PAYROLL_APPROVE_PERMISSION);

  /* ── STATE: permission denied ───────────────────────────────────────────── */
  // A real answer rather than a 404, per the convention on the gratuity and
  // cash screens: anyone who lands here followed a link or a bookmark, and
  // naming the permission they would need is more use than a dead end.
  if (!mayRead) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="Payroll" back={{ href: "/compliance", label: "Compliance" }} />
        <Card className="p-5" as="div">
          <p className="text-xs font-semibold">You do not have access to payroll.</p>
          <p className="text-2xs text-subtle mt-1.5 leading-relaxed max-w-[56ch]">
            What everyone is paid is the most sensitive read in the product, so it needs{" "}
            <code className="text-2xs">payroll:read</code>. Approving a run and posting the wage
            journal needs <code className="text-2xs">payroll:approve</code>; releasing the money
            needs <code className="text-2xs">payroll:pay</code> on top. Ask whoever manages access
            on the People and access screen.
          </p>
        </Card>
      </div>
    );
  }

  let preview: PayrollPreview | null = null;
  let failure: string | null = null;
  const runs = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => loadPayrollRuns(tx, { limit: 12 }),
  );

  try {
    preview = await withTenant(
      { tenantId: session.tenantId, userId: session.userId },
      async (tx) =>
        previewPayrollRun(
          {
            tx,
            tenantId: session.tenantId,
            principal: session.principal,
            today,
            baseCurrency: session.baseCurrency,
          },
          { period },
        ),
    );
  } catch (err) {
    // ERROR STATE, per WF-05 §17. Said out loud, because the anxiety a failed
    // payroll produces is entirely about whether it half-ran.
    failure = err instanceof Error ? err.message : "The preview could not be built.";
  }

  const header = (
    <PageHeader
      title="Payroll"
      subtitle={
        preview
          ? `${preview.label} · wages due ${preview.dueOn}, no grace period since 1 June 2026`
          : "Compute a month, approve it, then file the WPS salary file"
      }
      back={{ href: "/compliance", label: "Compliance" }}
      actions={
        <FilterTabs
          basePath="/hr/payroll"
          param="period"
          active={period}
          options={months.map((m) => ({ key: m.key, label: m.label }))}
        />
      }
    />
  );

  if (failure || !preview) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1100px] mx-auto space-y-5">
        {header}
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold" style={{ color: "var(--negative)" }}>
            The preview could not be built
          </p>
          <p className="text-xs text-muted mt-1.5 leading-relaxed">{failure}</p>
          <p className="text-2xs text-subtle mt-2">
            Nothing has been posted. No payslip is created until the preview is approved.
          </p>
        </Card>
      </div>
    );
  }

  const critical = preview.warnings.filter((w) => w.severity === "critical");
  const advisory = preview.warnings.filter((w) => w.severity === "warning");
  const handled = preview.warnings.filter((w) => w.severity === "info");
  const blocked = preview.blockers.length > 0;
  const nothingToDo = preview.lines.length === 0;
  const existingRun = runs.find((r) => r.period === period);

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1400px] mx-auto space-y-5">
      {header}

      <StatStrip
        stats={[
          {
            label: "Payslips to create",
            value: String(preview.totals.employees),
            tone: preview.totals.employees > 0 ? "accent" : "default",
            hint: preview.alreadyPaid.length
              ? `${preview.alreadyPaid.length} already paid`
              : undefined,
          },
          { label: "Gross", value: formatMoney(preview.totals.gross, ccy, 0) },
          {
            label: "Commission",
            value: formatMoney(preview.totals.commission, ccy, 0),
            tone: preview.totals.commission > 0 ? "accent" : "default",
            hint: preview.totals.commission > 0 ? "from earned entries" : "none earned",
          },
          {
            label: "Deductions",
            value: formatMoney(preview.totals.deductions, ccy, 0),
            tone: preview.totals.deductions > 0 ? "caution" : "default",
            hint: preview.totals.deductions > 0 ? "salary advances" : undefined,
          },
          {
            label: "Net payable",
            value: formatMoney(preview.totals.net, ccy, 0),
            tone: "positive",
          },
          {
            label: "Already run?",
            value: existingRun ? existingRun.status : "No",
            tone: existingRun ? "positive" : "default",
            hint: existingRun ? `${preview.alreadyPaid.length} on payslips` : undefined,
          },
        ]}
      />

      {/* ── Blockers. The run will refuse while any of these stand. ──────── */}
      {blocked && (
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold" style={{ color: "var(--negative)" }}>
            This run will not post
          </p>
          <ul className="mt-2 space-y-1">
            {preview.blockers.map((b) => (
              <li
                key={`${b.employeeId}-${b.code}`}
                className="text-2xs leading-relaxed px-2.5 py-1.5 rounded-[var(--radius-md)]"
                style={{ background: "var(--negative-soft)", color: "var(--negative)" }}
              >
                <span className="font-semibold">{b.fullName}</span> {b.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── The split by business. Where the wage expense lands. ─────────── */}
      {preview.byBusinessUnit.length > 0 && (
        <Card>
          <CardHeader
            title="Where the cost lands"
            subtitle="One journal, with legs per business — wage expense, advances recovered, net payable"
          />
          <div className="px-4 pb-4 space-y-2">
            {preview.byBusinessUnit.map((g) => (
              <div
                key={g.businessUnitId}
                className="rounded-[var(--radius-md)] px-3 py-2.5"
                style={{ background: "var(--surface-2)" }}
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <p className="text-xs font-semibold">
                    {g.businessUnitName}
                    <span className="ml-1.5 text-2xs font-normal text-muted tnum">
                      {g.businessUnitCode}
                    </span>
                  </p>
                  <p className="text-xs tnum">
                    <span className="text-muted">{g.employees} staff · gross </span>
                    <span className="font-semibold">{formatMoney(g.gross, ccy, 2)}</span>
                    {g.deductions > 0 && (
                      <>
                        <span className="text-muted"> · less </span>
                        <span className="font-semibold">{formatMoney(g.deductions, ccy, 2)}</span>
                      </>
                    )}
                    <span className="text-muted"> · net </span>
                    <span className="font-semibold">{formatMoney(g.net, ccy, 2)}</span>
                  </p>
                </div>
              </div>
            ))}
            <p className="text-2xs text-subtle leading-relaxed pt-1">
              Wages and overtime are debited to Salaries &amp; Wages, commission to Staff
              Commission, advances recovered are credited back to Staff Advances, and the balance
              is credited to Salaries Payable (WPS). Approving does not move money — the bank
              transfer discharges the payable separately, so the bank balance is not misstated
              for the days between approval and payday.
            </p>
          </div>
        </Card>
      )}

      {/* ── Warnings ────────────────────────────────────────────────────── */}
      {preview.warnings.length > 0 && (
        <Card>
          <CardHeader
            title="Before you approve"
            subtitle={`${critical.length} to fix · ${advisory.length} worth knowing · ${handled.length} already handled`}
          />
          <div className="px-4 pb-4 space-y-3">
            {([critical, advisory, handled] as PayrollWarning[][]).map((group) =>
              group.length === 0 ? null : (
                <div key={group[0]!.severity}>
                  <p
                    className="label mb-1.5"
                    style={{ color: SEVERITY_STYLE[group[0]!.severity].fg }}
                  >
                    {SEVERITY_STYLE[group[0]!.severity].label}
                  </p>
                  <ul className="space-y-1">
                    {group.map((w, i) => (
                      <li
                        key={`${w.employeeId}-${w.code}-${i}`}
                        className="text-2xs leading-relaxed px-2.5 py-1.5 rounded-[var(--radius-md)]"
                        style={{
                          background: SEVERITY_STYLE[w.severity].bg,
                          color: SEVERITY_STYLE[w.severity].fg,
                        }}
                      >
                        <span className="font-semibold">
                          {w.employeeCode} · {w.fullName}
                        </span>{" "}
                        {w.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        </Card>
      )}

      {/* ── What will be paid ───────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Payslips to be created"
          subtitle="Each component prorated separately over the real length of the month, so every row can be checked by hand"
        />
        <DataTable
          rows={preview.lines}
          rowKey={(l) => l.employeeId}
          empty={
            preview.alreadyRun ? (
              <EmptyState
                title={`${preview.label} has already been paid`}
                detail={`Every payable employee has a payslip — ${preview.alreadyPaid.length} of them. Running it again creates nothing.`}
              />
            ) : (
              <TableEmpty
                title="Nobody is payable in this month"
                detail="No employee was on the payroll for any part of this period. Pick a different month."
              />
            )
          }
          columns={[
            {
              key: "who",
              header: "Employee",
              render: (l) => (
                <div className="min-w-0">
                  <p className="font-medium truncate">{l.fullName}</p>
                  <p className="text-2xs text-subtle">
                    {l.employeeCode}
                    {l.designation ? ` · ${l.designation}` : ""}
                  </p>
                </div>
              ),
            },
            {
              key: "bu",
              header: "Business",
              render: (l) => <BuTag name={l.businessUnitName} color={l.colorToken ?? "default"} />,
            },
            {
              key: "days",
              header: "Covers",
              render: (l) => (
                <div>
                  <p className="text-2xs text-muted tnum">
                    {l.periodStart} → {l.periodEnd}
                  </p>
                  {l.prorated ? (
                    <p className="text-2xs" style={{ color: "var(--caution)" }}>
                      {l.daysPaid}/{l.daysInMonth} days
                      {l.unpaidLeaveDays > 0 ? ` · ${l.unpaidLeaveDays}d unpaid leave` : ""}
                    </p>
                  ) : (
                    <p className="text-2xs text-subtle">full month · {l.daysInMonth} days</p>
                  )}
                </div>
              ),
            },
            {
              key: "fixed",
              header: "Fixed pay",
              numeric: true,
              render: (l) => formatMoney(l.fixedPay, ccy, 2),
            },
            {
              key: "overtime",
              header: "Overtime",
              numeric: true,
              render: (l) =>
                l.overtimeAmount > 0 ? (
                  formatMoney(l.overtimeAmount, ccy, 2)
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "commission",
              header: "Commission",
              numeric: true,
              render: (l) =>
                l.commissionAmount > 0 ? (
                  <span>
                    {formatMoney(l.commissionAmount, ccy, 2)}
                    <span className="block text-2xs text-subtle">{l.commissionEntries} entries</span>
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "gross",
              header: "Gross",
              numeric: true,
              render: (l) => formatMoney(l.grossAmount, ccy, 2),
            },
            {
              key: "deduction",
              header: "Advance",
              numeric: true,
              render: (l) =>
                l.deductionTotal > 0 ? (
                  <span style={{ color: "var(--caution)" }}>
                    −{formatMoney(l.deductionTotal, ccy, 2)}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "net",
              header: "Net",
              numeric: true,
              render: (l) => (
                <span className="font-semibold">{formatMoney(l.netAmount, ccy, 2)}</span>
              ),
            },
            {
              key: "wps",
              header: "WPS",
              render: (l) =>
                l.wpsReady ? (
                  <span className="chip" style={{ background: "var(--surface-3)", color: "var(--text-muted)" }}>
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

      {/* ── Deliberately not paid ───────────────────────────────────────── */}
      {preview.notPaid.length > 0 && (
        <Card className="p-4" as="div">
          <p className="label mb-1.5">Not included in this run</p>
          <ul className="space-y-1">
            {preview.notPaid.map((n) => (
              <li key={n.employeeCode} className="text-2xs text-muted leading-relaxed">
                <span className="font-semibold">
                  {n.employeeCode} · {n.fullName}
                </span>{" "}
                — {n.reason}
              </li>
            ))}
          </ul>
          <p className="text-2xs text-subtle mt-2 leading-relaxed">
            These people are named rather than silently dropped. Each needs a decision and, where
            one is owed, a manual journal.
          </p>
        </Card>
      )}

      {/* ── Step two ────────────────────────────────────────────────────── */}
      {mayApprove && !nothingToDo && (
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold mb-1">
            Approve {preview.totals.employees} payslips for {preview.label}
          </p>
          <p className="text-2xs text-subtle mb-3 leading-relaxed">
            {formatMoney(preview.totals.gross, ccy, 2)} gross,{" "}
            {formatMoney(preview.totals.deductions, ccy, 2)} recovered against salary advances,{" "}
            {formatMoney(preview.totals.net, ccy, 2)} net payable and due {preview.dueOn}. Running
            this month again afterwards creates nothing.
          </p>
          <ActionForm
            action={payrollRunAction}
            submitLabel={`Approve ${preview.totals.employees} payslips`}
            pendingLabel="Computing and posting…"
            hidden={{ period: preview.period }}
            confirm={
              critical.length > 0
                ? `${critical.length} employee${critical.length === 1 ? " has" : "s have"} a problem flagged above. This posts ${formatMoney(preview.totals.gross, ccy, 2)} of wage expense and creates ${formatMoney(preview.totals.net, ccy, 2)} of salaries payable, claims ${preview.totals.commission > 0 ? "the commission entries it pays" : "no commission"}, and reduces every salary advance it recovers. There is no bulk undo — a correction is a manual journal.`
                : `Posts ${formatMoney(preview.totals.gross, ccy, 2)} of wage expense and creates ${formatMoney(preview.totals.net, ccy, 2)} of salaries payable. Commission entries for the month are claimed and salary advances are reduced. There is no bulk undo — a correction is a manual journal.`
            }
          />
        </Card>
      )}

      {!mayApprove && (
        <Card className="p-4" as="div">
          <p className="text-2xs text-subtle leading-relaxed">
            You can read this preview but not approve it. Posting the wage journal needs{" "}
            <code className="text-2xs">payroll:approve</code>.
          </p>
        </Card>
      )}

      {/* ── The runs ────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Payroll runs"
          subtitle="Approved runs post the wage journal; paying one discharges the salaries payable"
        />
        <DataTable
          rows={runs}
          rowKey={(r) => r.runId}
          empty={
            <TableEmpty
              title="No payroll has ever been run"
              detail="Approve a month above and it will appear here with its journal and its payslips."
            />
          }
          columns={[
            {
              key: "period",
              header: "Period",
              render: (r) => (
                <Link href={`/hr/payroll/${r.runId}`} className="font-medium hover:underline">
                  {r.label}
                </Link>
              ),
            },
            {
              key: "scope",
              header: "Scope",
              render: (r) => (
                <span className="text-2xs text-muted">
                  {r.businessUnitName ?? "All businesses"}
                </span>
              ),
            },
            { key: "status", header: "Status", render: (r) => <StatusPill status={r.status} /> },
            {
              key: "staff",
              header: "Staff",
              numeric: true,
              render: (r) => String(r.employeeCount),
            },
            {
              key: "gross",
              header: "Gross",
              numeric: true,
              render: (r) => formatMoney(r.grossTotal, ccy, 2),
            },
            {
              key: "deductions",
              header: "Deductions",
              numeric: true,
              render: (r) =>
                r.deductionTotal > 0 ? (
                  formatMoney(r.deductionTotal, ccy, 2)
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "net",
              header: "Net",
              numeric: true,
              render: (r) => <span className="font-semibold">{formatMoney(r.netTotal, ccy, 2)}</span>,
            },
            {
              key: "journal",
              header: "Journal",
              render: (r) =>
                r.journalNumber ? (
                  <span className="text-2xs tnum text-muted">{r.journalNumber}</span>
                ) : (
                  <span className="text-subtle text-2xs">—</span>
                ),
            },
          ]}
        />
      </Card>

      <Card className="p-4" as="div">
        <p className="label mb-1.5">How a month is computed</p>
        <p className="text-xs leading-relaxed text-muted">
          Each salary component — basic, housing, transport, other — is prorated on its own over
          the real length of the month: 28, 30 or 31 days, never a notional 30. A joiner is paid
          from their joining date, a leaver to their last day, and approved unpaid leave reduces
          the days paid rather than appearing as a deduction afterwards, so the wage expense is
          the cost actually incurred. Commission is not recalculated here — it is the sum of the
          commission entries earned in the month that no payslip has claimed yet, and approving
          the run claims them.
        </p>
        <p className="text-2xs text-subtle mt-2 leading-relaxed">
          Salary advances are recovered at their scheduled monthly amount, never more than is
          outstanding, and never clamped: if a scheduled recovery would make a payslip negative
          the run refuses and names the person, rather than quietly writing off the difference.
          Wages are due on the first day of the following month with no weekend allowance — the
          fifteen-day grace period ended on 1 June 2026.
        </p>
      </Card>
    </div>
  );
}
