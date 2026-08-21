import { notFound } from "next/navigation";
import { withTenant } from "@nexus/db";
import { can, formatMoney } from "@nexus/core";
import { requireSession } from "@/lib/session";
import { Card, CardHeader } from "@/components/ui";
import { ActionForm, Field } from "@/components/action-form";
import { BuTag, DataTable, PageHeader, StatStrip, StatusPill, TableEmpty } from "@/components/page";
import { payrollPayAction } from "@/lib/actions/payroll";
/**
 * See the note in `lib/actions/payroll.ts`: this reaches into the service
 * module directly only until the coordinator adds the payroll line to the
 * `@nexus/core` services barrel.
 */
import {
  loadPayrollRun,
  loadWpsExport,
  wpsPreflight,
  PAYROLL_PAY_PERMISSION,
  PAYROLL_READ_PERMISSION,
} from "../../../../../../../../packages/core/src/services/payroll.ts";

export const dynamic = "force-dynamic";

/**
 * ONE PAYROLL RUN — the payslips, the journal, and the file that pays them.
 *
 * The screen exists to make three things checkable in one place, because until
 * FR-C06 none of them existed at all:
 *
 *  1. WHAT EACH PERSON WAS PAID, with the working. The breakdown snapshot on
 *     each payslip is the figure that was paid, not a recomputation from
 *     today's master data — an employee's salary changes, and a payslip
 *     regenerated two years later from current values is not the payslip that
 *     was paid, which is exactly the argument the gratuity settlement record
 *     makes for the same reason.
 *  2. THAT THE MONEY HAS NOT MOVED YET. Approving posts wage expense and
 *     creates Salaries Payable. It does not touch the bank. "Mark paid" is a
 *     separate action behind a separate permission, and until it is pressed the
 *     liability is real and visible.
 *  3. WHETHER THE WPS FILE WILL BE ACCEPTED, BEFORE payday rather than after.
 *     Validation warnings used to be reduced to a count in a response header
 *     and the file was handed over anyway (audit CALC-16). They are now shown
 *     here in words, and the download refuses while any of them stand.
 *
 * WHY THE IBAN CHECK IS SPLIT. The pre-flight below decrypts nothing: IBANs are
 * encrypted at rest, the download route is the only path that decrypts them,
 * and that route is rate-limited and emits a `pii.decrypted` security event
 * with the count. Validating on this page by decrypting would create a second,
 * unthrottled path over every employee's account number on a page view. So the
 * page checks everything that does not need the plaintext — including whether
 * an IBAN exists at all — and says plainly that the format is checked when the
 * file is generated.
 *
 * The five states of WF-05 §0: default below, `loading.tsx` on the parent
 * route, the group-level `error.tsx`, `notFound()` for a run that does not
 * exist, and the permission-denied card immediately after the session lookup.
 */

/** Kept next to the route that uses them; see the note in `api/wps/[month]`. */
const EMPLOYER = {
  id: "1234567890123",
  agentId: "0000000",
  routingCode: "402010101",
};

export default async function PayrollRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const session = await requireSession();
  const { runId } = await params;
  const ccy = session.baseCurrency;

  const mayRead = can(session.principal, PAYROLL_READ_PERMISSION);
  const mayPay = can(session.principal, PAYROLL_PAY_PERMISSION);

  if (!mayRead) {
    return (
      <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[900px] mx-auto space-y-5">
        <PageHeader title="Payroll run" back={{ href: "/hr/payroll", label: "Payroll" }} />
        <Card className="p-5" as="div">
          <p className="text-xs font-semibold">You do not have access to payroll.</p>
          <p className="text-2xs text-subtle mt-1.5 leading-relaxed max-w-[56ch]">
            Reading what people were paid needs <code className="text-2xs">payroll:read</code>.
            Releasing the money needs <code className="text-2xs">payroll:pay</code>.
          </p>
        </Card>
      </div>
    );
  }

  const data = await withTenant(
    { tenantId: session.tenantId, userId: session.userId },
    async (tx) => {
      const detail = await loadPayrollRun(tx, runId);
      if (!detail) return null;
      const wps = await loadWpsExport(tx, {
        period: detail.run.period,
        businessUnitId: detail.run.businessUnitId ?? undefined,
        businessUnitIds: session.principal.businessUnitIds,
        // See the docblock: this page never decrypts.
        decryptIbans: false,
      });
      return { detail, wps };
    },
  );

  if (!data) notFound();
  const { run, payslips } = data.detail;
  const wps = data.wps;
  const preflight = wps ? wpsPreflight(wps, EMPLOYER) : [];
  const blocking = preflight.filter((w) => w.severity === "blocking");
  const advisory = preflight.filter((w) => w.severity === "advisory");

  const downloadHref = `/api/wps/${run.period}${blocking.length > 0 ? "?acknowledgeWarnings=1" : ""}`;

  return (
    <div className="px-4 lg:px-6 py-4 lg:py-6 max-w-[1300px] mx-auto space-y-5">
      <PageHeader
        title={`Payroll · ${run.label}`}
        subtitle={
          `${run.businessUnitName ?? "All businesses"} · ${run.periodStart} to ${run.periodEnd}` +
          (run.approvedBy ? ` · approved by ${run.approvedBy}` : "")
        }
        back={{ href: "/hr/payroll", label: "Payroll" }}
        actions={<StatusPill status={run.status} />}
      />

      <StatStrip
        stats={[
          { label: "Payslips", value: String(run.employeeCount) },
          { label: "Gross", value: formatMoney(run.grossTotal, ccy, 2) },
          {
            label: "Deductions",
            value: formatMoney(run.deductionTotal, ccy, 2),
            tone: run.deductionTotal > 0 ? "caution" : "default",
            hint: run.deductionTotal > 0 ? "salary advances recovered" : undefined,
          },
          { label: "Net", value: formatMoney(run.netTotal, ccy, 2), tone: "positive" },
          {
            label: "Journal",
            value: run.journalNumber ?? "—",
            hint: run.journalNumber ? "wage expense posted" : "not posted",
          },
          {
            label: run.status === "paid" ? "Paid on" : "Money moved?",
            value: run.status === "paid" ? (run.paidOn ?? "—") : "Not yet",
            tone: run.status === "paid" ? "positive" : "caution",
            hint: run.status === "paid" ? undefined : "salaries payable outstanding",
          },
        ]}
      />

      {/* ── The WPS file ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="WPS salary information file"
          subtitle={
            wps
              ? `${wps.employeeCount} employee records · ${formatMoney(wps.netTotal, ccy, 2)} to be transferred`
              : "No approved run to serialise"
          }
        />
        <div className="px-4 pb-4 space-y-3">
          {blocking.length > 0 ? (
            <div>
              <p className="label mb-1.5" style={{ color: "var(--negative)" }}>
                This file would be rejected — {blocking.length} problem
                {blocking.length === 1 ? "" : "s"}
              </p>
              <ul className="space-y-1">
                {blocking.map((w, i) => (
                  <li
                    key={`${w.code}-${w.subject}-${i}`}
                    className="text-2xs leading-relaxed px-2.5 py-1.5 rounded-[var(--radius-md)]"
                    style={{ background: "var(--negative-soft)", color: "var(--negative)" }}
                  >
                    {w.message}
                  </li>
                ))}
              </ul>
              <p className="text-2xs text-subtle mt-2 leading-relaxed">
                Fix these on the employee records. Catching a malformed IBAN here is materially
                better than the bank rejecting the whole batch two days before payday. The
                download below is deliberately marked as an override.
              </p>
            </div>
          ) : (
            <p
              className="text-2xs leading-relaxed px-2.5 py-1.5 rounded-[var(--radius-md)]"
              style={{ background: "var(--surface-3)", color: "var(--text-muted)" }}
            >
              Pre-flight passed: employer ID, MOHRE Person IDs, routing codes, amounts and every
              pay period check out.
            </p>
          )}

          {advisory.map((w, i) => (
            <p
              key={`adv-${i}`}
              className="text-2xs leading-relaxed px-2.5 py-1.5 rounded-[var(--radius-md)]"
              style={{ background: "var(--caution-soft)", color: "var(--caution)" }}
            >
              {w.message}
            </p>
          ))}

          {wps && wps.deductionsFolded > 0 && (
            <p
              className="text-2xs leading-relaxed px-2.5 py-1.5 rounded-[var(--radius-md)]"
              style={{ background: "var(--caution-soft)", color: "var(--caution)" }}
            >
              {formatMoney(wps.deductionsFolded, ccy, 2)} of salary-advance recovery is folded
              into the fixed-income column, because the layout in use carries no deduction field.
              The file therefore instructs the bank to transfer NET pay, which is what the ledger
              says is owed — but the income figures MOHRE receives are net of the recovery. The
              exact layout this group&rsquo;s WPS agent requires is still open question Q-7.
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap pt-1">
            {wps ? (
              <a
                href={downloadHref}
                className={`btn text-xs ${blocking.length > 0 ? "" : "btn-primary"}`}
                download
              >
                ↓{" "}
                {blocking.length > 0
                  ? `Download anyway (${blocking.length} problem${blocking.length === 1 ? "" : "s"})`
                  : `Download ${run.period} SIF`}
              </a>
            ) : null}
            <span className="text-2xs text-subtle">
              Generated from this run&rsquo;s payslips, never from the employee records.
            </span>
          </div>
        </div>
      </Card>

      {/* ── Pay it ──────────────────────────────────────────────────────── */}
      {run.status === "approved" && mayPay && (
        <Card className="p-4" as="div">
          <p className="text-xs font-semibold mb-1">
            Release {formatMoney(run.netTotal, ccy, 2)} to {run.employeeCount} employees
          </p>
          <p className="text-2xs text-subtle mb-3 leading-relaxed">
            Debits Salaries Payable and credits the bank, discharging the liability this run
            created. Do it when the transfer has actually gone — recording it early misstates the
            bank balance, which is the reason approving and paying are two steps.
          </p>
          <ActionForm
            action={payrollPayAction}
            submitLabel="Mark paid"
            pendingLabel="Posting the payment…"
            hidden={{ runId: run.runId }}
            confirm={`Posts ${formatMoney(run.netTotal, ccy, 2)} out of the bank and clears Salaries Payable for ${run.label}. There is no undo — a correction is a manual journal.`}
          >
            <div className="grid grid-cols-2 gap-2">
              <Field label="Paid on" name="paidOn" type="date" defaultValue={run.periodEnd} />
              <Field
                label="Paid via"
                name="paidVia"
                options={[
                  { value: "wps", label: "WPS transfer" },
                  { value: "bank_transfer", label: "Bank transfer" },
                  { value: "cash", label: "Cash" },
                ]}
              />
            </div>
          </ActionForm>
        </Card>
      )}

      {run.status === "approved" && !mayPay && (
        <Card className="p-4" as="div">
          <p className="text-2xs text-subtle leading-relaxed">
            This run is approved and the wage journal is posted, but the money has not moved.
            Releasing it needs <code className="text-2xs">payroll:pay</code>.
          </p>
        </Card>
      )}

      {/* ── The payslips ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Payslips"
          subtitle="Each figure as it was computed and posted — a snapshot, not a recomputation"
        />
        <DataTable
          rows={payslips}
          rowKey={(p) => p.payslipId}
          empty={
            <TableEmpty
              title="This run has no payslips"
              detail="Nothing was paid. That should not be possible — report it."
            />
          }
          columns={[
            {
              key: "who",
              header: "Employee",
              render: (p) => (
                <div className="min-w-0">
                  <p className="font-medium truncate">{p.fullName}</p>
                  <p className="text-2xs text-subtle">{p.employeeCode}</p>
                </div>
              ),
            },
            {
              key: "bu",
              header: "Business",
              render: (p) => <BuTag name={p.businessUnitName} color={p.colorToken ?? "default"} />,
            },
            {
              key: "covers",
              header: "Covers",
              render: (p) => {
                const b = p.breakdown as {
                  period?: { start?: string; end?: string };
                  days?: { paid?: number; inMonth?: number; unpaidLeave?: number };
                };
                return (
                  <div>
                    <p className="text-2xs text-muted tnum">
                      {b.period?.start} → {b.period?.end}
                    </p>
                    <p className="text-2xs text-subtle">
                      {b.days?.paid}/{b.days?.inMonth} days
                      {b.days?.unpaidLeave ? ` · ${b.days.unpaidLeave}d unpaid` : ""}
                    </p>
                  </div>
                );
              },
            },
            {
              key: "basic",
              header: "Basic",
              numeric: true,
              render: (p) => formatMoney(p.baseAmount, ccy, 2),
            },
            {
              key: "allowance",
              header: "Allowances",
              numeric: true,
              render: (p) => formatMoney(p.allowanceAmount, ccy, 2),
            },
            {
              key: "overtime",
              header: "Overtime",
              numeric: true,
              render: (p) =>
                p.overtimeAmount > 0 ? (
                  formatMoney(p.overtimeAmount, ccy, 2)
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "commission",
              header: "Commission",
              numeric: true,
              render: (p) =>
                p.commissionAmount > 0 ? (
                  formatMoney(p.commissionAmount, ccy, 2)
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "gross",
              header: "Gross",
              numeric: true,
              render: (p) => formatMoney(p.grossAmount, ccy, 2),
            },
            {
              key: "deduction",
              header: "Advance",
              numeric: true,
              render: (p) =>
                p.advanceDeduction > 0 ? (
                  <span style={{ color: "var(--caution)" }}>
                    −{formatMoney(p.advanceDeduction, ccy, 2)}
                  </span>
                ) : (
                  <span className="text-subtle">—</span>
                ),
            },
            {
              key: "net",
              header: "Net",
              numeric: true,
              render: (p) => (
                <span className="font-semibold">{formatMoney(p.netAmount, ccy, 2)}</span>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
