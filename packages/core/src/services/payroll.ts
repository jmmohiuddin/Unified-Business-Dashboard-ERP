import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import * as M from "../money/index.ts";
import { tryDecryptPii } from "../security/pii.ts";
import {
  inclusiveDays,
  validateWpsDetailed,
  type WpsEmployee,
  type WpsWarning,
} from "../uae/wps.ts";
import {
  ServiceError,
  postJournal,
  requireBusinessUnit,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";

/**
 * PAYROLL RUN — FR-C06.
 *
 * `payroll_runs` and `payslips` have existed since the first migration and
 * NOTHING HAS EVER WRITTEN THEM. Gross, deductions and net were not computed
 * anywhere in the product; the ledger had no wage expense from a payroll run,
 * no salaries-payable balance and no record of what anyone was paid. What did
 * exist was a WPS export built directly from the `employees` table — so the
 * file handed to the bank each month was a parallel computation over master
 * data that no human had ever approved, and which by construction reported
 * every employee as a full-month, fixed-package payee (audit CALC-15).
 *
 * That is the defect this file fixes, ahead of any question about the file
 * format: a payroll export should be the CONSEQUENCE of a payroll run, not a
 * second opinion about it. `loadWpsExport` at the bottom serialises a committed
 * run and nothing else; `uae/wps.ts` lays it out and no longer computes.
 *
 * Five rules govern everything below.
 *
 * ── 1. PREVIEW PREDICTS THE POSTER EXACTLY ──────────────────────────────────
 *
 * `commitPayrollRun` calls `previewPayrollRun` under a lock rather than
 * reimplementing the selection, for the same reason the rent run does: a
 * preview computed by a different route is a preview of a different payroll.
 * Every figure on the screen is the figure that posts, and the commit re-reads
 * the payslips it wrote and refuses the whole transaction if the total it
 * promised is not the total it produced.
 *
 * ── 2. A PERIOD IS PAID ONCE ────────────────────────────────────────────────
 *
 * "Running August twice must not pay everyone twice" needs three guards,
 * because each of them misses cases the others catch:
 *
 *   • THE SAME SUBMIT, TWICE. `withIdempotency` fingerprints the payload and
 *     replays the first result. Covers a double-tapped button.
 *   • TWO DIFFERENT SUBMITS. Two operators or two tabs produce different keys
 *     and defeat that entirely. A transaction-scoped advisory lock serialises
 *     runs for the tenant and period; the loser then re-runs the preview
 *     against the winner's committed rows and finds nothing to pay.
 *   • THE DOMAIN ITSELF. The per-employee check is the real guard: an employee
 *     who already has a payslip for the period is excluded from the preview by
 *     name. That is what makes a tenant-wide run after a salon-only run pay the
 *     other six businesses and not the salon again — which a single "has this
 *     month run" flag on `payroll_runs` could never express, because that row
 *     is scoped to a business unit and the unique index over it is
 *     `NULLS DISTINCT` for a tenant-wide run.
 *
 * A run whose scope and period exactly match an existing one is refused by name
 * as well, so the operator gets "August has already been run for the salon"
 * rather than "no employees to pay".
 *
 * ── 3. THE JOURNAL BALANCES BY IDENTITY, NOT BY LUCK ────────────────────────
 *
 *     DR SALARY          fixed pay earned + overtime      per business unit
 *     DR COMMISSION      commission earned in the period  per business unit
 *     CR STAFF_ADVANCE   salary advances recovered        per business unit
 *     CR SALARY_PAYABLE  net payable                      per business unit
 *
 *     debits  = fixed + overtime + commission           = gross
 *     credits = advances + net = advances + gross − advances = gross
 *
 * Net is DEFINED as gross − deductions, so the two sides are the same quantity
 * written twice. Nothing is rounded between them: every component is quantized
 * at storage precision before it is summed, so the sum of the parts is the part
 * that is written.
 *
 * Wages are an expense of the month worked, so the journal is posted on the
 * LAST DAY OF THE PERIOD, not on the pay date. `postJournal` refuses a closed
 * period and names it, so running payroll for a month the accountant has
 * already closed is a clear error rather than a silent backdate.
 *
 * SALARY_PAYABLE is a liability, not a payment. `markPayrollRunPaid` is what
 * discharges it (DR SALARY_PAYABLE / CR BANK) when the money actually leaves.
 * A run that posted straight to BANK would misstate the bank balance for the
 * days between approval and the WPS transfer, and would leave nothing for the
 * WPS file to be an instruction ABOUT.
 *
 * ── 4. COMMISSION IS READ, NOT RECOMPUTED ───────────────────────────────────
 *
 * `commission_entries` already holds what each person earned, per source
 * document, with the rule that produced it. The audit found the table
 * seed-only, with no screen and no consumer — which is the same shape of defect
 * as the unwritten payroll tables: a ledger nothing reads and nothing settles.
 *
 * So the run SUMS THE ENTRIES. It does not re-derive a rate from
 * `commission_rules`, because a second implementation of "what did Imran earn
 * on that haircut" is a second set of rounding, and because an entry is
 * evidence — it names the appointment it came from. Entries are claimed by the
 * payslip that pays them (`payslip_id`, `is_paid`), so the same commission can
 * never be paid by two runs. That claim is also the reason the selection reads
 * `is_paid = false AND payslip_id IS NULL` rather than a date range alone.
 *
 * Nothing accrues commission at the moment it is earned, so the run is the
 * first recognition of the expense and it debits COMMISSION directly. When
 * something does start accruing it, that leg becomes COMMISSION_PAYABLE and
 * nothing else in this file changes.
 *
 * ── 5. WHAT IS DELIBERATELY NOT MODELLED, AND WHY ───────────────────────────
 *
 * Deductions other than salary advances are not modelled — the same decision
 * `gratuity-payout.ts` records for the same reason: a fine, an unreturned
 * laptop or a disputed amount has no account mapping here that would not be
 * invented, and inventing one puts a number in the ledger nobody can trace back
 * to a rule. Those go through a salary advance or a manual journal, both of
 * which already exist.
 *
 * Suspended employees are EXCLUDED with a critical warning rather than paid.
 * Article 41 of Federal Decree-Law 33/2021 pays half wage during an
 * investigative suspension, and the schema records no suspension start date, so
 * the run cannot compute the half and cannot honestly pay the whole. Paying
 * them in full would be wrong; paying them zero silently would be worse.
 *
 * Hourly and daily pay bases are paid from their contractual package prorated
 * by days, WITH a critical warning, because attendance-derived hourly payroll
 * is not implemented. They are still paid — dropping someone from payroll
 * silently is the worst available outcome — but nobody is told they were paid
 * correctly.
 */

/* ── Permissions ───────────────────────────────────────────────────────────── */

/** Reading what people are paid is reading payroll. Same key as the register. */
export const PAYROLL_READ_PERMISSION = "payroll:read";

/**
 * Committing a run posts the wage expense and creates the obligation to pay.
 * It does not move cash, which is why it is `approve` and not `pay`: the
 * accountant approves the payroll, the owner releases the money.
 */
export const PAYROLL_APPROVE_PERMISSION = "payroll:approve";

/** Discharging SALARY_PAYABLE — the money actually leaving the bank. */
export const PAYROLL_PAY_PERMISSION = "payroll:pay";

/* ── Calendar arithmetic ───────────────────────────────────────────────────── */
//
// All UTC. A pay period is a run of calendar dates, not an instant; routing it
// through a local timezone can only introduce an off-by-one at the boundary.

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const minDate = (a: string, b: string): string => (a < b ? a : b);
const maxDate = (a: string, b: string): string => (a > b ? a : b);

/** Last calendar day of a `YYYY-MM`, as ISO. Day 0 of the next month. */
function monthEnd(period: string): string {
  const [y, m] = period.split("-").map((p) => parseInt(p, 10));
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/** First day of the month AFTER `period` — the day the wage falls due. */
function dayAfterMonth(period: string): string {
  const [y, m] = period.split("-").map((p) => parseInt(p, 10));
  return new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
}

/** `2026-08` → `August 2026`. */
export function payrollPeriodLabel(period: string): string {
  const [y, m] = period.split("-");
  return `${MONTH_NAMES[parseInt(m!, 10) - 1] ?? m} ${y}`;
}

/* ── Pay arithmetic ────────────────────────────────────────────────────────── */

/**
 * Overtime premium — Article 19 of Cabinet Resolution 1 of 2022.
 *
 * Normal-hours wage plus 25%. The 150% band for hours worked between 22:00 and
 * 04:00 is deliberately NOT applied: `attendance.overtime_minutes` is a single
 * total with no indication which of those minutes fell in the night window, so
 * distinguishing the bands would mean guessing. A warning says so on any
 * payslip that carries overtime rather than quietly paying the lower rate as if
 * the question did not exist.
 */
export const OVERTIME_MULTIPLIER = M.money("1.25");

/** Minutes in an hour. Named so the division below reads as an intent. */
const MINUTES_PER_HOUR = 60;

/**
 * Article 25 of Federal Decree-Law 33/2021 caps recovery of a debt owed to the
 * employer at 20% of the wage. ADVISORY here — it raises a warning and never
 * changes a figure. The deduction schedule is the operator's to set; this file
 * telling them the statute exists is useful, this file silently rewriting their
 * recovery to satisfy its own reading of it is not.
 */
const ADVANCE_CAP_FRACTION = M.money("0.20");

/**
 * A month's pay for part of a month.
 *
 * Charged over the REAL length of the period — 28, 30 or 31 days, never a
 * notional 30 — and a full period never routed through the division at all, so
 * the fourteen unremarkable employees in the pilot produce fourteen amounts
 * identical to their contract rows and the run's totals have nothing to absorb.
 *
 * Each salary component is prorated SEPARATELY rather than the package being
 * prorated once and split. That is what makes the payslip hand-checkable: basic
 * on the payslip is the basic on the contract times days over days, which is
 * the arithmetic a person doing the control sample will actually perform.
 */
export function proratePay(amount: M.Money, daysPaid: number, daysInPeriod: number): M.Money {
  if (daysInPeriod <= 0 || daysPaid <= 0) return M.ZERO;
  if (daysPaid >= daysInPeriod) return M.quantize(amount);
  return M.quantize(M.div(M.mul(amount, daysPaid), daysInPeriod));
}

/** Overtime pay for a number of minutes at an hourly rate. Exact throughout. */
export function overtimePay(hourlyRate: M.Money, minutes: number): M.Money {
  if (minutes <= 0) return M.ZERO;
  const hours = M.div(M.money(minutes), MINUTES_PER_HOUR);
  return M.quantize(M.mul(M.mul(hourlyRate, OVERTIME_MULTIPLIER), hours));
}

/* ── Input ─────────────────────────────────────────────────────────────────── */

export const payrollRunInput = z.object({
  /** The calendar month being paid, `YYYY-MM`. */
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period must be YYYY-MM."),
  /** Limit the run to one business — the salon without the property company. */
  businessUnitId: z.uuid().optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export type PayrollWarningCode =
  | "prorated"
  | "unpaid_leave"
  | "pay_basis_unsupported"
  | "suspended"
  | "overtime_no_rate"
  | "overtime_night_band"
  | "advance_exceeds_pay"
  | "advance_over_statutory_cap"
  | "wps_incomplete"
  | "zero_pay"
  | "already_paid";

export interface PayrollWarning {
  code: PayrollWarningCode;
  severity: "info" | "warning" | "critical";
  employeeId: string;
  employeeCode: string;
  fullName: string;
  message: string;
}

export interface PayrollLine {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  designation: string | null;
  status: string;
  payBasis: string;
  businessUnitId: string;
  businessUnitCode: string;
  businessUnitName: string;
  colorToken: string | null;

  joinedOn: string;
  leftOn: string | null;
  /** The span this payslip pays for, inclusive. */
  periodStart: string;
  periodEnd: string;
  daysInMonth: number;
  daysEmployed: number;
  unpaidLeaveDays: number;
  daysPaid: number;
  prorated: boolean;

  /** Prorated contractual components. These four sum to `fixedPay`. */
  basic: number;
  housing: number;
  transport: number;
  other: number;
  fixedPay: number;

  overtimeMinutes: number;
  overtimeAmount: number;
  commissionEntries: number;
  commissionAmount: number;

  grossAmount: number;
  advanceDeduction: number;
  otherDeduction: number;
  deductionTotal: number;
  netAmount: number;

  /** Can this person actually be paid through WPS with what is on file? */
  wpsReady: boolean;
  ibanHint: string | null;
}

export interface PayrollBusinessUnitGroup {
  businessUnitId: string;
  businessUnitCode: string;
  businessUnitName: string;
  employees: number;
  gross: number;
  deductions: number;
  net: number;
}

export interface PayrollTotals {
  employees: number;
  fixedPay: number;
  overtime: number;
  commission: number;
  gross: number;
  advances: number;
  deductions: number;
  net: number;
}

export interface PayrollPreview {
  period: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  /**
   * When the wage is legally due. Since 1 June 2026 the fifteen-day grace
   * period is gone and wages are due on the first day of the following month,
   * with no weekend allowance (PRD FR-C06).
   */
  dueOn: string;
  /** Every payable employee is already on a payslip for this period. */
  alreadyRun: boolean;
  lines: PayrollLine[];
  /** Already paid for this period — shown so "nothing happened" is explicable. */
  alreadyPaid: { employeeCode: string; fullName: string; runLabel: string }[];
  /** Eligible but deliberately not paid by this run, each with a reason. */
  notPaid: { employeeCode: string; fullName: string; reason: string }[];
  byBusinessUnit: PayrollBusinessUnitGroup[];
  totals: PayrollTotals;
  warnings: PayrollWarning[];
  /** Anything in here makes the run refuse. Surfaced so the screen can say why. */
  blockers: PayrollWarning[];
}

/* ── Selection ─────────────────────────────────────────────────────────────── */

/**
 * Business-unit scope, applied in SQL.
 *
 * RLS guarantees tenant isolation and knows nothing about a membership's
 * business-unit scope. Payroll is the most sensitive read in the product, so
 * the filter is applied even though only tenant-scoped roles hold `payroll:*`
 * today — "no role currently has it" is a fact about the seed, not an
 * invariant. Same shape as `search.ts` and `rentals.ts`.
 */
function businessUnitScope(ctx: ServiceContext, column: SQL): SQL {
  const ids = ctx.principal.businessUnitIds;
  if (!ids || ids.length === 0) return sql`true`;
  return sql`${column} = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}])`;
}

/** Statuses that are on the payroll at all. */
const PAYABLE_STATUSES = sql`('active','probation','on_leave','suspended')`;

type EmployeeRow = {
  id: string;
  employee_code: string;
  full_name: string;
  designation: string | null;
  status: string;
  pay_basis: string;
  joined_on: string;
  left_on: string | null;
  basic: string;
  housing: string;
  transport: string;
  other: string;
  hourly_rate: string | null;
  iban_hint: string | null;
  wps_person_id: string | null;
  wps_routing_code: string | null;
  has_iban: boolean;
  bu_id: string;
  bu_code: string;
  bu_name: string;
  color_token: string | null;
  overtime_minutes: number;
  commission_amount: string;
  commission_entries: number;
  unpaid_leave_days: number;
  advance_due: string;
  advance_outstanding: string;
  paid_run_label: string | null;
};

/**
 * Everything the run needs about every employee, in one round trip.
 *
 * The lateral joins are what keep it one query rather than one query per
 * employee: overtime minutes, unclaimed commission, unpaid leave overlapping
 * the period, the scheduled advance recovery, and whether a payslip for this
 * period already exists.
 */
async function selectEmployees(
  ctx: ServiceContext,
  opts: { period: string; periodStart: string; periodEnd: string; businessUnitId?: string },
): Promise<EmployeeRow[]> {
  const buFilter = opts.businessUnitId
    ? sql`AND e.primary_business_unit_id = ${opts.businessUnitId}::uuid`
    : sql``;

  return ctx.tx.execute<EmployeeRow>(sql`
    SELECT e.id, e.employee_code, e.full_name, e.designation,
           e.status::text AS status, e.pay_basis::text AS pay_basis,
           e.joined_on::text, e.left_on::text,
           e.base_salary AS basic, e.housing_allowance AS housing,
           e.transport_allowance AS transport, e.other_allowance AS other,
           e.hourly_rate, e.iban_hint, e.wps_person_id, e.wps_routing_code,
           (e.iban_enc IS NOT NULL) AS has_iban,
           b.id AS bu_id, b.code AS bu_code, b.name AS bu_name, b.color_token,
           COALESCE(ot.minutes, 0)::int AS overtime_minutes,
           COALESCE(cm.amount, 0) AS commission_amount,
           COALESCE(cm.entries, 0)::int AS commission_entries,
           COALESCE(lv.days, 0)::int AS unpaid_leave_days,
           COALESCE(adv.due, 0) AS advance_due,
           COALESCE(adv.outstanding, 0) AS advance_outstanding,
           paid.run_label AS paid_run_label
      FROM employees e
      JOIN business_units b ON b.id = e.primary_business_unit_id
      LEFT JOIN LATERAL (
        SELECT SUM(a.overtime_minutes) AS minutes
          FROM attendance a
         WHERE a.employee_id = e.id
           AND a.on_date BETWEEN ${opts.periodStart}::date AND ${opts.periodEnd}::date
      ) ot ON true
      -- Unclaimed commission only. payslip_id IS NULL AND is_paid = false is
      -- what makes a second run unable to pay the same haircut twice, and it is
      -- a stronger guard than the date range because it survives a correction
      -- that moves an entry between periods.
      LEFT JOIN LATERAL (
        SELECT SUM(ce.commission_amount) AS amount, COUNT(*) AS entries
          FROM commission_entries ce
         WHERE ce.employee_id = e.id
           AND ce.earned_on BETWEEN ${opts.periodStart}::date AND ${opts.periodEnd}::date
           AND ce.is_paid = false AND ce.payslip_id IS NULL
      ) cm ON true
      -- Approved UNPAID leave overlapping the period, in whole days. The
      -- overlap cannot be negative: the WHERE already requires the ranges to
      -- intersect.
      LEFT JOIN LATERAL (
        SELECT SUM(
                 (LEAST(l.ends_on, ${opts.periodEnd}::date)
                  - GREATEST(l.starts_on, ${opts.periodStart}::date)) + 1
               ) AS days
          FROM leave_requests l
         WHERE l.employee_id = e.id AND l.is_paid = false AND l.status = 'approved'
           AND l.starts_on <= ${opts.periodEnd}::date
           AND l.ends_on >= ${opts.periodStart}::date
      ) lv ON true
      LEFT JOIN LATERAL (
        SELECT SUM(LEAST(a.monthly_deduction, a.outstanding)) AS due,
               SUM(a.outstanding) AS outstanding
          FROM salary_advances a
         WHERE a.employee_id = e.id AND a.outstanding > 0
      ) adv ON true
      LEFT JOIN LATERAL (
        SELECT r.period_label AS run_label
          FROM payslips p JOIN payroll_runs r ON r.id = p.payroll_run_id
         WHERE p.employee_id = e.id AND r.period_label = ${opts.period}
         LIMIT 1
      ) paid ON true
     WHERE e.deleted_at IS NULL
       -- On the payroll, or left DURING the period and owed the days worked.
       AND (e.status IN ${PAYABLE_STATUSES}
            OR (e.left_on IS NOT NULL AND e.left_on >= ${opts.periodStart}::date))
       AND e.joined_on <= ${opts.periodEnd}::date
       AND (e.left_on IS NULL OR e.left_on >= ${opts.periodStart}::date)
       AND ${businessUnitScope(ctx, sql`e.primary_business_unit_id`)}
       ${buFilter}
     ORDER BY b.sort_order, e.employee_code
  `);
}

/* ── The preview ───────────────────────────────────────────────────────────── */

/**
 * What a payroll run would pay, without paying any of it.
 *
 * Nothing here writes. It is also the query behind the commit, which calls this
 * function under a lock rather than reimplementing the selection — see rule 1.
 */
export async function previewPayrollRun(
  ctx: ServiceContext,
  raw: unknown,
): Promise<PayrollPreview> {
  const input = payrollRunInput.parse(raw);
  requirePermission(ctx, PAYROLL_READ_PERMISSION);
  if (input.businessUnitId) requireBusinessUnit(ctx, input.businessUnitId);

  const periodStart = `${input.period}-01`;
  const periodEnd = monthEnd(input.period);
  const daysInMonth = inclusiveDays(periodStart, periodEnd);

  const rows = await selectEmployees(ctx, {
    period: input.period,
    periodStart,
    periodEnd,
    businessUnitId: input.businessUnitId,
  });

  const lines: PayrollLine[] = [];
  const warnings: PayrollWarning[] = [];
  const blockers: PayrollWarning[] = [];
  const alreadyPaid: PayrollPreview["alreadyPaid"] = [];
  const notPaid: PayrollPreview["notPaid"] = [];

  for (const r of rows) {
    const warn = (
      code: PayrollWarningCode,
      severity: PayrollWarning["severity"],
      message: string,
    ) => {
      const w: PayrollWarning = {
        code,
        severity,
        employeeId: r.id,
        employeeCode: r.employee_code,
        fullName: r.full_name,
        message,
      };
      warnings.push(w);
      return w;
    };

    if (r.paid_run_label) {
      alreadyPaid.push({
        employeeCode: r.employee_code,
        fullName: r.full_name,
        runLabel: payrollPeriodLabel(r.paid_run_label),
      });
      warn(
        "already_paid",
        "info",
        `Already has a payslip for ${payrollPeriodLabel(r.paid_run_label)} — not paid again.`,
      );
      continue;
    }

    /**
     * Article 41: an employee suspended pending investigation is paid HALF
     * wage for the suspension. Nothing in the schema records when the
     * suspension began, so the half cannot be computed and the whole cannot
     * honestly be paid. Excluded loudly.
     */
    if (r.status === "suspended") {
      notPaid.push({
        employeeCode: r.employee_code,
        fullName: r.full_name,
        reason: "Suspended — Article 41 half-wage is not modelled",
      });
      warn(
        "suspended",
        "critical",
        "Suspended. Article 41 of Federal Decree-Law 33/2021 pays half wage during an " +
          "investigative suspension, and the employee record does not say when the " +
          "suspension began, so the run cannot compute it. Pay this person by manual journal.",
      );
      continue;
    }

    if (r.pay_basis === "hourly" || r.pay_basis === "daily") {
      warn(
        "pay_basis_unsupported",
        "critical",
        `Paid ${r.pay_basis}, but this run pays the contractual package prorated by days — ` +
          "hours-worked payroll is not implemented. Check this payslip by hand before approving.",
      );
    }

    /* ── The span actually paid for ──────────────────────────────────────── */

    const employedFrom = maxDate(periodStart, r.joined_on);
    const employedTo = minDate(periodEnd, r.left_on ?? periodEnd);
    const daysEmployed = inclusiveDays(employedFrom, employedTo);
    // Unpaid leave cannot exceed the days the person was employed; the SQL
    // clips the leave range to the period but not to the employment span.
    const unpaidLeaveDays = Math.min(r.unpaid_leave_days, daysEmployed);
    const daysPaid = daysEmployed - unpaidLeaveDays;
    const prorated = daysPaid !== daysInMonth;

    if (daysEmployed !== daysInMonth) {
      warn(
        "prorated",
        "info",
        r.joined_on > periodStart
          ? `Joined ${r.joined_on} — paid for ${daysEmployed} of ${daysInMonth} days.`
          : `Left ${r.left_on} — paid for ${daysEmployed} of ${daysInMonth} days.`,
      );
    }
    if (unpaidLeaveDays > 0) {
      warn(
        "unpaid_leave",
        "warning",
        `${unpaidLeaveDays} day${unpaidLeaveDays === 1 ? "" : "s"} of approved unpaid leave — ` +
          "the fixed package is reduced by those days rather than deducted afterwards, so " +
          "the wage expense is the cost actually incurred.",
      );
    }

    /* ── Earnings ────────────────────────────────────────────────────────── */

    const basic = proratePay(M.fromDb(r.basic), daysPaid, daysInMonth);
    const housing = proratePay(M.fromDb(r.housing), daysPaid, daysInMonth);
    const transport = proratePay(M.fromDb(r.transport), daysPaid, daysInMonth);
    const other = proratePay(M.fromDb(r.other), daysPaid, daysInMonth);
    const fixedPay = M.sum([basic, housing, transport, other]);

    let overtimeAmount = M.ZERO;
    if (r.overtime_minutes > 0) {
      if (r.hourly_rate === null) {
        // Refusing to invent a divisor. Deriving an hourly rate from a monthly
        // package needs a convention — 30 days of 8 hours? 26? the contract's
        // own? — and picking one here would put a number nobody can trace back
        // to a rule into a wage.
        warn(
          "overtime_no_rate",
          "critical",
          `${r.overtime_minutes} minutes of overtime recorded, but no hourly rate is on file. ` +
            "No overtime has been paid. Set the employee's hourly rate, or pay it by manual journal.",
        );
      } else {
        overtimeAmount = overtimePay(M.fromDb(r.hourly_rate), r.overtime_minutes);
        warn(
          "overtime_night_band",
          "info",
          "Overtime paid at 125% (Article 19, Cabinet Resolution 1/2022). The 150% band for " +
            "hours between 22:00 and 04:00 is not applied — attendance records a single " +
            "overtime total and does not say which minutes fell in the night window.",
        );
      }
    }

    const commissionAmount = M.quantize(M.fromDb(r.commission_amount));
    const grossAmount = M.sum([fixedPay, overtimeAmount, commissionAmount]);

    /* ── Deductions ──────────────────────────────────────────────────────── */

    // Scheduled recovery, never more than is outstanding. `LEAST` in the SQL is
    // "you cannot recover a debt that is already repaid", not a clamp that
    // hides a difference: anything not recovered stays on the advance.
    const advanceDeduction = M.quantize(M.fromDb(r.advance_due));
    const otherDeduction = M.ZERO; // See rule 5.
    const deductionTotal = M.add(advanceDeduction, otherDeduction);
    const netAmount = M.sub(grossAmount, deductionTotal);

    if (M.isNegative(netAmount)) {
      blockers.push(
        warn(
          "advance_exceeds_pay",
          "critical",
          `Scheduled advance recovery of ${M.toDisplay(advanceDeduction)} exceeds ` +
            `${M.toDisplay(grossAmount)} of pay, so this payslip would be negative. ` +
            "Reduce the monthly deduction on the advance. Nothing is clamped — the run " +
            "refuses rather than quietly writing off the difference.",
        ),
      );
    } else if (
      !M.isZero(advanceDeduction) &&
      M.gt(advanceDeduction, M.mul(grossAmount, ADVANCE_CAP_FRACTION))
    ) {
      warn(
        "advance_over_statutory_cap",
        "warning",
        `Advance recovery of ${M.toDisplay(advanceDeduction)} is more than 20% of ` +
          `${M.toDisplay(grossAmount)}. Article 25 of Federal Decree-Law 33/2021 caps recovery ` +
          "of a debt owed to the employer at 20% of the wage. Advisory only — nothing here " +
          "changes the figure.",
      );
    }

    /**
     * Nobody earns nothing.
     *
     * A commission-only employee with no entries, or someone whose unpaid leave
     * swallowed the whole month, comes to zero. A zero payslip is not payroll —
     * MOHRE rejects a zero fixed income outright — so they are excluded with a
     * reason rather than given an empty payslip that makes the run look
     * complete.
     */
    if (!M.isNegative(netAmount) && M.isZero(grossAmount)) {
      notPaid.push({
        employeeCode: r.employee_code,
        fullName: r.full_name,
        reason: "Earned nothing in this period",
      });
      warn(
        "zero_pay",
        "critical",
        "Earns nothing this period — no prorated package, no overtime and no unclaimed " +
          "commission. Not included: a zero payslip is rejected by MOHRE and would make the " +
          "run look like this person was paid.",
      );
      continue;
    }

    const wpsReady = Boolean(r.has_iban && r.wps_person_id && r.wps_routing_code);
    if (!wpsReady) {
      const missing = [
        r.has_iban ? null : "IBAN",
        r.wps_person_id ? null : "MOHRE Person ID",
        r.wps_routing_code ? null : "bank routing code",
      ].filter((x): x is string => x !== null);
      warn(
        "wps_incomplete",
        "critical",
        `Missing ${missing.join(", ")} — this employee cannot be paid through WPS and the ` +
          "SIF will be rejected with them in it.",
      );
    }

    lines.push({
      employeeId: r.id,
      employeeCode: r.employee_code,
      fullName: r.full_name,
      designation: r.designation,
      status: r.status,
      payBasis: r.pay_basis,
      businessUnitId: r.bu_id,
      businessUnitCode: r.bu_code,
      businessUnitName: r.bu_name,
      colorToken: r.color_token,
      joinedOn: r.joined_on,
      leftOn: r.left_on,
      periodStart: employedFrom,
      periodEnd: employedTo,
      daysInMonth,
      daysEmployed,
      unpaidLeaveDays,
      daysPaid,
      prorated,
      basic: M.toNumber(basic),
      housing: M.toNumber(housing),
      transport: M.toNumber(transport),
      other: M.toNumber(other),
      fixedPay: M.toNumber(fixedPay),
      overtimeMinutes: r.overtime_minutes,
      overtimeAmount: M.toNumber(overtimeAmount),
      commissionEntries: r.commission_entries,
      commissionAmount: M.toNumber(commissionAmount),
      grossAmount: M.toNumber(grossAmount),
      advanceDeduction: M.toNumber(advanceDeduction),
      otherDeduction: M.toNumber(otherDeduction),
      deductionTotal: M.toNumber(deductionTotal),
      netAmount: M.toNumber(netAmount),
      wpsReady,
      ibanHint: r.iban_hint,
    });
  }

  /* ── Roll up ──────────────────────────────────────────────────────────── */

  const totals = totalsOf(lines);

  const groups = new Map<string, PayrollBusinessUnitGroup>();
  for (const l of lines) {
    const g = groups.get(l.businessUnitId) ?? {
      businessUnitId: l.businessUnitId,
      businessUnitCode: l.businessUnitCode,
      businessUnitName: l.businessUnitName,
      employees: 0,
      gross: 0,
      deductions: 0,
      net: 0,
    };
    g.employees += 1;
    g.gross = M.toNumber(M.add(M.money(g.gross), M.money(l.grossAmount)));
    g.deductions = M.toNumber(M.add(M.money(g.deductions), M.money(l.deductionTotal)));
    g.net = M.toNumber(M.add(M.money(g.net), M.money(l.netAmount)));
    groups.set(l.businessUnitId, g);
  }

  return {
    period: input.period,
    label: payrollPeriodLabel(input.period),
    periodStart,
    periodEnd,
    dueOn: dayAfterMonth(input.period),
    alreadyRun: lines.length === 0 && alreadyPaid.length > 0,
    lines,
    alreadyPaid,
    notPaid,
    byBusinessUnit: [...groups.values()],
    totals,
    warnings,
    blockers,
  };
}

/** The run's totals, accumulated in exact decimal from the lines. */
function totalsOf(lines: PayrollLine[]): PayrollTotals {
  const acc = (pick: (l: PayrollLine) => number) =>
    M.toNumber(M.sum(lines.map((l) => M.money(pick(l)))));
  return {
    employees: lines.length,
    fixedPay: acc((l) => l.fixedPay),
    overtime: acc((l) => l.overtimeAmount),
    commission: acc((l) => l.commissionAmount),
    gross: acc((l) => l.grossAmount),
    advances: acc((l) => l.advanceDeduction),
    deductions: acc((l) => l.deductionTotal),
    net: acc((l) => l.netAmount),
  };
}

/* ── The commit ────────────────────────────────────────────────────────────── */

export interface PayrollRunResult {
  runId: string;
  period: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  dueOn: string;
  status: string;
  journalId: string;
  businessUnitId: string | null;
  totals: PayrollTotals;
  skipped: number;
  payslips: {
    payslipId: string;
    employeeCode: string;
    fullName: string;
    gross: number;
    deduction: number;
    net: number;
  }[];
}

/**
 * Compute the month, write the payslips, post the journal.
 *
 * Approving a payroll is not paying it: this creates the obligation
 * (SALARY_PAYABLE) and recognises the cost. `markPayrollRunPaid` discharges it.
 * There is no `unrunPayroll` — the correction for a wrong run is a manual
 * journal and a corrected one, which is why the screen puts this behind an
 * `ActionForm confirm` that states the effect in words.
 */
export async function commitPayrollRun(
  ctx: ServiceContext,
  raw: unknown,
): Promise<PayrollRunResult> {
  const input = payrollRunInput.parse(raw);
  requirePermission(ctx, PAYROLL_APPROVE_PERMISSION);
  if (input.businessUnitId) requireBusinessUnit(ctx, input.businessUnitId);

  return withIdempotency(ctx, input.idempotencyKey, "payroll.commit", async () => {
    /**
     * Serialised for the tenant and the PERIOD — not the period and the
     * business unit. A tenant-wide August and a salon-only August overlap on
     * every salon employee, so they must queue behind each other; keying the
     * lock on the scope as well would let both run concurrently and both decide
     * the salon was unpaid.
     *
     * `pg_advisory_xact_lock` is released at COMMIT and this transaction is
     * READ COMMITTED, so the preview that runs next takes a fresh snapshot and
     * sees whatever the previous holder committed.
     */
    await ctx.tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId}::text),
                                   hashtext(${`payroll-run:${input.period}`}::text))
    `);

    // The domain's own refusal, by name, before the per-employee guard reduces
    // it to "nothing to pay".
    const [existing] = await ctx.tx.execute<{ id: string; status: string; net_total: string }>(sql`
      SELECT id, status, net_total FROM payroll_runs
       WHERE period_label = ${input.period}
         AND business_unit_id IS NOT DISTINCT FROM ${input.businessUnitId ?? null}::uuid
       LIMIT 1
    `);
    if (existing) {
      throw new ServiceError(
        `${payrollPeriodLabel(input.period)} has already been run for this scope — ` +
          `${M.toDisplay(M.fromDb(existing.net_total))} net, status "${existing.status}". ` +
          "Running it again would pay the same month twice.",
        "duplicate",
      );
    }

    const preview = await previewPayrollRun(ctx, input);

    if (preview.blockers.length > 0) {
      throw new ServiceError(
        `${preview.blockers.length} employee${preview.blockers.length === 1 ? "" : "s"} cannot ` +
          `be paid as configured. ${preview.blockers[0]!.fullName}: ` +
          `${preview.blockers[0]!.message} Nothing has been saved.`,
        "invalid",
      );
    }

    if (preview.lines.length === 0) {
      if (preview.alreadyPaid.length > 0) {
        throw new ServiceError(
          `${preview.label} has already been paid — ${preview.alreadyPaid.length} ` +
            `employee${preview.alreadyPaid.length === 1 ? "" : "s"} already have a payslip. ` +
            "Nothing to do.",
          "duplicate",
        );
      }
      throw new ServiceError(`Nobody is payable in ${preview.label}.`, "invalid");
    }

    /* ── The run row ──────────────────────────────────────────────────────── */

    const [run] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO payroll_runs
        (id, tenant_id, business_unit_id, period_label, period_start, period_end,
         status, gross_total, deduction_total, net_total, employee_count,
         approved_by_user_id)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.businessUnitId ?? null}::uuid,
         -- The machine key, not "August 2026": this column is the period's
         -- identity in payroll_runs_uq and in the per-employee duplicate
         -- guard, and a sortable, unambiguous key is what those need. The human
         -- label is derived for display.
         ${input.period}, ${preview.periodStart}::date, ${preview.periodEnd}::date,
         'approved', ${M.toDb(M.money(preview.totals.gross))},
         ${M.toDb(M.money(preview.totals.deductions))},
         ${M.toDb(M.money(preview.totals.net))}, ${preview.lines.length},
         ${ctx.principal.userId}::uuid)
      RETURNING id
    `);
    const runId = run!.id;

    /* ── Payslips ─────────────────────────────────────────────────────────── */

    const payslips: PayrollRunResult["payslips"] = [];

    for (const l of preview.lines) {
      /**
       * The breakdown snapshot.
       *
       * Everything needed to reprint this payslip, and to build the WPS record
       * for it, WITHOUT recomputing anything: the span paid for, the day
       * counts, the components. `payslips.breakdown` exists for exactly this —
       * an employee's salary changes, and a payslip regenerated from today's
       * master data two years later is not the payslip that was paid.
       */
      const breakdown = {
        period: { start: l.periodStart, end: l.periodEnd, dueOn: preview.dueOn },
        days: {
          inMonth: l.daysInMonth,
          employed: l.daysEmployed,
          unpaidLeave: l.unpaidLeaveDays,
          paid: l.daysPaid,
          prorated: l.prorated,
        },
        components: {
          basic: l.basic,
          housing: l.housing,
          transport: l.transport,
          other: l.other,
        },
        overtime: { minutes: l.overtimeMinutes, amount: l.overtimeAmount, multiplier: "1.25" },
        commission: { entries: l.commissionEntries, amount: l.commissionAmount },
        deductions: { advance: l.advanceDeduction, other: l.otherDeduction },
        employment: { joinedOn: l.joinedOn, leftOn: l.leftOn, status: l.status, payBasis: l.payBasis },
        wpsReady: l.wpsReady,
      };

      const [slip] = await ctx.tx.execute<{ id: string }>(sql`
        INSERT INTO payslips
          (id, tenant_id, payroll_run_id, employee_id, base_amount, overtime_amount,
           commission_amount, allowance_amount, deduction_amount, advance_deduction,
           gross_amount, net_amount, breakdown)
        VALUES
          (gen_random_uuid(), ${ctx.tenantId}::uuid, ${runId}::uuid, ${l.employeeId}::uuid,
           ${M.toDb(M.money(l.basic))}, ${M.toDb(M.money(l.overtimeAmount))},
           ${M.toDb(M.money(l.commissionAmount))},
           ${M.toDb(M.sum([M.money(l.housing), M.money(l.transport), M.money(l.other)]))},
           ${M.toDb(M.money(l.otherDeduction))}, ${M.toDb(M.money(l.advanceDeduction))},
           ${M.toDb(M.money(l.grossAmount))}, ${M.toDb(M.money(l.netAmount))},
           ${JSON.stringify(breakdown)}::jsonb)
        RETURNING id
      `);

      /**
       * Claim the commission entries this payslip pays.
       *
       * The same predicate the preview selected on, so an entry created between
       * the preview and the commit is left for the next run rather than being
       * paid without appearing in the total the operator approved. The claim is
       * what stops a second run paying the same entry: `payslip_id` is set and
       * `is_paid` flips, and both are in the selection's WHERE.
       */
      if (l.commissionEntries > 0) {
        await ctx.tx.execute(sql`
          UPDATE commission_entries
             SET payslip_id = ${slip!.id}::uuid, is_paid = true, updated_at = now()
           WHERE employee_id = ${l.employeeId}::uuid
             AND earned_on BETWEEN ${preview.periodStart}::date AND ${preview.periodEnd}::date
             AND is_paid = false AND payslip_id IS NULL
        `);
      }

      // Recover the advances, oldest first. `M.min` picks one of two Decimals;
      // it does not average or clamp, and anything not recovered stays owed.
      if (!M.isZero(M.money(l.advanceDeduction))) {
        const advances = await ctx.tx.execute<{ id: string; outstanding: string }>(sql`
          SELECT id, outstanding FROM salary_advances
           WHERE employee_id = ${l.employeeId}::uuid AND outstanding > 0
           ORDER BY issued_on, id
           FOR UPDATE
        `);
        let remaining = M.money(l.advanceDeduction);
        for (const advance of advances) {
          if (M.isZero(remaining)) break;
          const outstanding = M.fromDb(advance.outstanding);
          const applied = M.min(remaining, outstanding);
          await ctx.tx.execute(sql`
            UPDATE salary_advances
               SET outstanding = ${M.toDb(M.sub(outstanding, applied))}, updated_at = now()
             WHERE id = ${advance.id}::uuid
          `);
          remaining = M.sub(remaining, applied);
        }
        if (!M.isZero(remaining)) {
          // The scheduled recovery was computed from the same rows under the
          // same transaction, so this cannot happen without a concurrent write
          // that the FOR UPDATE should have serialised. Failing loudly beats
          // writing a payslip whose deduction was never applied to a debt.
          throw new ServiceError(
            `Could not apply ${M.toDisplay(remaining)} of advance recovery for ` +
              `${l.fullName} — the outstanding balance changed during the run. ` +
              "Nothing has been saved.",
            "conflict",
          );
        }
      }

      payslips.push({
        payslipId: slip!.id,
        employeeCode: l.employeeCode,
        fullName: l.fullName,
        gross: l.grossAmount,
        deduction: l.deductionTotal,
        net: l.netAmount,
      });
    }

    /* ── Reconcile before posting ─────────────────────────────────────────── */

    /**
     * Read the payslips back rather than trusting what this function believed
     * it wrote. Exact: at storage precision there is no honest tolerance. A
     * disagreement between the preview's arithmetic and what landed in the
     * table takes the whole run down before a single dirham reaches the ledger,
     * instead of leaving fourteen payslips whose sum the operator was told
     * would be something else.
     */
    const [posted] = await ctx.tx.execute<{
      gross: string; deduction: string; advance: string; net: string; n: number;
    }>(sql`
      SELECT COALESCE(SUM(gross_amount), 0) AS gross,
             COALESCE(SUM(deduction_amount + advance_deduction), 0) AS deduction,
             COALESCE(SUM(advance_deduction), 0) AS advance,
             COALESCE(SUM(net_amount), 0) AS net,
             COUNT(*)::int AS n
        FROM payslips WHERE payroll_run_id = ${runId}::uuid
    `);
    const grossWritten = M.quantize(M.fromDb(posted!.gross));
    const netWritten = M.quantize(M.fromDb(posted!.net));
    if (
      !M.eq(grossWritten, M.quantize(M.money(preview.totals.gross))) ||
      !M.eq(netWritten, M.quantize(M.money(preview.totals.net))) ||
      posted!.n !== preview.lines.length
    ) {
      throw new ServiceError(
        `Payroll does not reconcile: the preview promised ${M.toDisplay(M.money(preview.totals.gross))} ` +
          `gross over ${preview.lines.length} payslips but the payslips total ` +
          `${M.toDisplay(grossWritten)} over ${posted!.n}. Nothing has been saved.`,
        "invalid",
      );
    }

    /* ── The journal ──────────────────────────────────────────────────────── */

    const journalId = await postJournal(ctx, {
      // The expense of the month worked, not of the day it is paid.
      postingDate: preview.periodEnd,
      source: "payroll",
      sourceTable: "payroll_runs",
      sourceId: runId,
      narration: `Payroll ${preview.label} · ${preview.lines.length} employees, ` +
        `${M.toDisplay(M.money(preview.totals.net))} net`,
      legs: payrollLegs(preview.lines),
    });

    await ctx.tx.execute(sql`
      UPDATE payroll_runs SET journal_id = ${journalId}::uuid, updated_at = now()
       WHERE id = ${runId}::uuid
    `);

    await writeAudit(ctx, {
      action: "payroll.commit",
      entityTable: "payroll_runs",
      entityId: runId,
      businessUnitId: input.businessUnitId,
      diff: {
        period: input.period,
        employees: preview.lines.length,
        gross: preview.totals.gross,
        commission: preview.totals.commission,
        overtime: preview.totals.overtime,
        advances: preview.totals.advances,
        net: preview.totals.net,
        skipped: preview.alreadyPaid.length + preview.notPaid.length,
        criticalWarnings: preview.warnings.filter((w) => w.severity === "critical").length,
        journalId,
      },
    });

    return {
      runId,
      period: preview.period,
      label: preview.label,
      periodStart: preview.periodStart,
      periodEnd: preview.periodEnd,
      dueOn: preview.dueOn,
      status: "approved",
      journalId,
      businessUnitId: input.businessUnitId ?? null,
      totals: preview.totals,
      skipped: preview.alreadyPaid.length + preview.notPaid.length,
      payslips,
    };
  });
}

/**
 * The journal, grouped by business unit.
 *
 * Exported and pure so the identity in rule 3 can be tested without a database:
 * whatever the lines are, the debits and the credits are the same quantity.
 * Zero legs are omitted — a business with no commission should not carry a
 * COMMISSION line for AED 0.00.
 */
export function payrollLegs(lines: PayrollLine[]): Parameters<typeof postJournal>[1]["legs"] {
  const byBu = new Map<
    string,
    { wage: M.Money; commission: M.Money; advance: M.Money; net: M.Money; code: string }
  >();

  for (const l of lines) {
    const g = byBu.get(l.businessUnitId) ?? {
      wage: M.ZERO,
      commission: M.ZERO,
      advance: M.ZERO,
      net: M.ZERO,
      code: l.businessUnitCode,
    };
    // Overtime is a wage, so it lands in SALARY with the fixed pay rather than
    // in an account of its own — the chart has no overtime account and adding
    // one to the ledger from here would be inventing a mapping.
    g.wage = M.sum([g.wage, M.money(l.fixedPay), M.money(l.overtimeAmount)]);
    g.commission = M.add(g.commission, M.money(l.commissionAmount));
    g.advance = M.add(g.advance, M.money(l.advanceDeduction));
    g.net = M.add(g.net, M.money(l.netAmount));
    byBu.set(l.businessUnitId, g);
  }

  const legs: Parameters<typeof postJournal>[1]["legs"] = [];
  for (const [businessUnitId, g] of byBu) {
    if (!M.isZero(g.wage)) {
      legs.push({
        accountKey: "SALARY",
        businessUnitId,
        debit: g.wage,
        memo: `Wages and allowances — ${g.code}`,
      });
    }
    if (!M.isZero(g.commission)) {
      legs.push({
        accountKey: "COMMISSION",
        businessUnitId,
        debit: g.commission,
        memo: `Staff commission earned — ${g.code}`,
      });
    }
    if (!M.isZero(g.advance)) {
      legs.push({
        accountKey: "STAFF_ADVANCE",
        businessUnitId,
        credit: g.advance,
        memo: `Salary advances recovered — ${g.code}`,
      });
    }
    if (!M.isZero(g.net)) {
      legs.push({
        accountKey: "SALARY_PAYABLE",
        businessUnitId,
        credit: g.net,
        memo: `Net pay due — ${g.code}`,
      });
    }
  }
  return legs;
}

/* ── Paying it ─────────────────────────────────────────────────────────────── */

export const markPayrollPaidInput = z.object({
  runId: z.uuid(),
  /** The day the money left. Defaults to the context's today. */
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  paidVia: z.enum(["wps", "bank_transfer", "cash"]).default("wps"),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface PayrollPaidResult {
  runId: string;
  period: string;
  label: string;
  paidOn: string;
  paidVia: string;
  journalId: string;
  employees: number;
  net: number;
}

/** Where the net pay is credited when the run is settled. */
const PAY_ACCOUNT: Record<string, string> = {
  wps: "BANK",
  bank_transfer: "BANK",
  cash: "CASH",
};

/**
 * Discharge the salaries payable — the money actually leaving.
 *
 *     DR SALARY_PAYABLE      CR BANK / CASH        per business unit
 *
 * Separate from the run on purpose. The run recognises the cost on the last day
 * of the month worked; the transfer happens on or before the first of the next
 * month, and until it does the liability is real and belongs on the balance
 * sheet. Collapsing the two would misstate the bank balance for those days and
 * would leave SALARY_PAYABLE accruing forever with nothing able to take a
 * dirham back out of it — which is precisely the stale-liability failure the
 * gratuity provision had before FR-C05.
 */
export async function markPayrollRunPaid(
  ctx: ServiceContext,
  raw: unknown,
): Promise<PayrollPaidResult> {
  const input = markPayrollPaidInput.parse(raw);
  requirePermission(ctx, PAYROLL_PAY_PERMISSION);

  return withIdempotency(ctx, input.idempotencyKey, "payroll.pay", async () => {
    const [run] = await ctx.tx.execute<{
      id: string; period_label: string; status: string; net_total: string;
      employee_count: number; business_unit_id: string | null; period_end: string;
    }>(sql`
      SELECT id, period_label, status, net_total, employee_count, business_unit_id,
             period_end::text
        FROM payroll_runs WHERE id = ${input.runId}::uuid
        -- Locked so two operators cannot both release the same month's wages.
        FOR UPDATE
    `);
    if (!run) throw new ServiceError("That payroll run does not exist.", "not_found");
    if (run.business_unit_id) requireBusinessUnit(ctx, run.business_unit_id);

    if (run.status === "paid") {
      throw new ServiceError(
        `${payrollPeriodLabel(run.period_label)} has already been paid.`,
        "duplicate",
      );
    }
    if (run.status !== "approved") {
      throw new ServiceError(
        `${payrollPeriodLabel(run.period_label)} is "${run.status}", not approved. ` +
          "Only an approved run can be paid.",
        "invalid",
      );
    }

    const paidOn = input.paidOn ?? ctx.today;

    // Net by business unit, read from the payslips rather than from the run's
    // rollup, so the credit to BANK is the sum of what each person is actually
    // owed and the debit to SALARY_PAYABLE reverses exactly what the run
    // credited to it.
    const rows = await ctx.tx.execute<{ bu_id: string; bu_code: string; net: string }>(sql`
      SELECT e.primary_business_unit_id AS bu_id, b.code AS bu_code,
             SUM(p.net_amount) AS net
        FROM payslips p
        JOIN employees e ON e.id = p.employee_id
        JOIN business_units b ON b.id = e.primary_business_unit_id
       WHERE p.payroll_run_id = ${run.id}::uuid
       GROUP BY 1, 2
    `);
    if (rows.length === 0) {
      throw new ServiceError("That run has no payslips, so there is nothing to pay.", "invalid");
    }

    const legs: Parameters<typeof postJournal>[1]["legs"] = [];
    let total = M.ZERO;
    for (const r of rows) {
      const net = M.quantize(M.fromDb(r.net));
      if (M.isZero(net)) continue;
      total = M.add(total, net);
      legs.push({
        accountKey: "SALARY_PAYABLE",
        businessUnitId: r.bu_id,
        debit: net,
        memo: `Salaries paid — ${r.bu_code}`,
      });
      legs.push({
        accountKey: PAY_ACCOUNT[input.paidVia]!,
        businessUnitId: r.bu_id,
        credit: net,
        memo: `${payrollPeriodLabel(run.period_label)} payroll, ${input.paidVia}`,
      });
    }

    const journalId = await postJournal(ctx, {
      postingDate: paidOn,
      source: "payroll",
      sourceTable: "payroll_runs",
      sourceId: run.id,
      narration: `Payroll ${payrollPeriodLabel(run.period_label)} paid · ${M.toDisplay(total)} via ${input.paidVia}`,
      legs,
    });

    await ctx.tx.execute(sql`
      UPDATE payroll_runs
         SET status = 'paid', paid_on = ${paidOn}::date, updated_at = now()
       WHERE id = ${run.id}::uuid
    `);
    await ctx.tx.execute(sql`
      UPDATE payslips SET paid_at = now(), updated_at = now()
       WHERE payroll_run_id = ${run.id}::uuid
    `);

    await writeAudit(ctx, {
      action: "payroll.pay",
      entityTable: "payroll_runs",
      entityId: run.id,
      businessUnitId: run.business_unit_id ?? undefined,
      diff: {
        period: run.period_label,
        paidOn,
        paidVia: input.paidVia,
        employees: run.employee_count,
        net: M.toNumber(total),
        journalId,
      },
    });

    return {
      runId: run.id,
      period: run.period_label,
      label: payrollPeriodLabel(run.period_label),
      paidOn,
      paidVia: input.paidVia,
      journalId,
      employees: run.employee_count,
      net: M.toNumber(total),
    };
  });
}

/* ── Reads for the screens ─────────────────────────────────────────────────── */

export interface PayrollRunSummary {
  runId: string;
  period: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  businessUnitId: string | null;
  businessUnitName: string | null;
  employeeCount: number;
  grossTotal: number;
  deductionTotal: number;
  netTotal: number;
  paidOn: string | null;
  journalId: string | null;
  journalNumber: string | null;
  approvedBy: string | null;
  createdAt: string;
}

/**
 * The runs, newest first.
 *
 * Takes a bare `tx` rather than a `ServiceContext` — the same shape as
 * `loadGratuityRegister` and `loadCashBoard` — because it is a read and the
 * caller has already gated it.
 */
export async function loadPayrollRuns(
  tx: ServiceContext["tx"],
  opts: { limit?: number } = {},
): Promise<PayrollRunSummary[]> {
  const rows = await tx.execute<{
    id: string; period_label: string; period_start: string; period_end: string;
    status: string; business_unit_id: string | null; bu_name: string | null;
    employee_count: number; gross_total: string; deduction_total: string; net_total: string;
    paid_on: string | null; journal_id: string | null; journal_number: string | null;
    approved_by: string | null; created_at: string;
  }>(sql`
    SELECT r.id, r.period_label, r.period_start::text, r.period_end::text, r.status,
           r.business_unit_id, b.name AS bu_name, r.employee_count,
           r.gross_total, r.deduction_total, r.net_total, r.paid_on::text,
           r.journal_id, j.journal_number, u.full_name AS approved_by,
           r.created_at::text
      FROM payroll_runs r
      LEFT JOIN business_units b ON b.id = r.business_unit_id
      LEFT JOIN journals j ON j.id = r.journal_id
      LEFT JOIN users u ON u.id = r.approved_by_user_id
     ORDER BY r.period_label DESC, r.created_at DESC
     LIMIT ${opts.limit ?? 24}
  `);

  return rows.map((r) => ({
    runId: r.id,
    period: r.period_label,
    label: payrollPeriodLabel(r.period_label),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    businessUnitId: r.business_unit_id,
    businessUnitName: r.bu_name,
    employeeCount: r.employee_count,
    grossTotal: M.toNumber(M.fromDb(r.gross_total)),
    deductionTotal: M.toNumber(M.fromDb(r.deduction_total)),
    netTotal: M.toNumber(M.fromDb(r.net_total)),
    paidOn: r.paid_on,
    journalId: r.journal_id,
    journalNumber: r.journal_number,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
  }));
}

export interface PayslipRow {
  payslipId: string;
  employeeId: string;
  employeeCode: string;
  fullName: string;
  businessUnitName: string;
  colorToken: string | null;
  baseAmount: number;
  allowanceAmount: number;
  overtimeAmount: number;
  commissionAmount: number;
  grossAmount: number;
  advanceDeduction: number;
  deductionAmount: number;
  netAmount: number;
  paidAt: string | null;
  breakdown: Record<string, unknown>;
}

/** One run and every payslip on it. */
export async function loadPayrollRun(
  tx: ServiceContext["tx"],
  runId: string,
): Promise<{ run: PayrollRunSummary; payslips: PayslipRow[] } | null> {
  const runs = await loadPayrollRuns(tx, { limit: 200 });
  const run = runs.find((r) => r.runId === runId);
  if (!run) return null;

  const rows = await tx.execute<{
    id: string; employee_id: string; employee_code: string; full_name: string;
    bu_name: string; color_token: string | null;
    base_amount: string; allowance_amount: string; overtime_amount: string;
    commission_amount: string; gross_amount: string; advance_deduction: string;
    deduction_amount: string; net_amount: string; paid_at: string | null;
    breakdown: Record<string, unknown>;
  }>(sql`
    SELECT p.id, p.employee_id, e.employee_code, e.full_name,
           b.name AS bu_name, b.color_token,
           p.base_amount, p.allowance_amount, p.overtime_amount, p.commission_amount,
           p.gross_amount, p.advance_deduction, p.deduction_amount, p.net_amount,
           p.paid_at::text, p.breakdown
      FROM payslips p
      JOIN employees e ON e.id = p.employee_id
      JOIN business_units b ON b.id = e.primary_business_unit_id
     WHERE p.payroll_run_id = ${runId}::uuid
     ORDER BY e.employee_code
  `);

  return {
    run,
    payslips: rows.map((r) => ({
      payslipId: r.id,
      employeeId: r.employee_id,
      employeeCode: r.employee_code,
      fullName: r.full_name,
      businessUnitName: r.bu_name,
      colorToken: r.color_token,
      baseAmount: M.toNumber(M.fromDb(r.base_amount)),
      allowanceAmount: M.toNumber(M.fromDb(r.allowance_amount)),
      overtimeAmount: M.toNumber(M.fromDb(r.overtime_amount)),
      commissionAmount: M.toNumber(M.fromDb(r.commission_amount)),
      grossAmount: M.toNumber(M.fromDb(r.gross_amount)),
      advanceDeduction: M.toNumber(M.fromDb(r.advance_deduction)),
      deductionAmount: M.toNumber(M.fromDb(r.deduction_amount)),
      netAmount: M.toNumber(M.fromDb(r.net_amount)),
      paidAt: r.paid_at,
      breakdown: r.breakdown ?? {},
    })),
  };
}

/* ── The WPS bridge ────────────────────────────────────────────────────────── */

export interface WpsExportSource {
  period: string;
  label: string;
  periodStart: string;
  periodEnd: string;
  runIds: string[];
  /** "approved" until every contributing run is paid. */
  status: string;
  employees: WpsEmployee[];
  employeeCount: number;
  /** The money the file instructs the bank to move. Equals the SIF control total. */
  netTotal: number;
  /** Deductions folded into `fixedIncome` because the layout has no column. */
  deductionsFolded: number;
  /**
   * Was the IBAN actually read?
   *
   * False on the pre-flight path, where nothing is decrypted. An IBAN's FORMAT
   * cannot be checked without decrypting it, so a caller that declines to
   * decrypt must not present the absence of IBAN warnings as a clean bill of
   * health — `wpsPreflight` uses this flag to say so out loud instead.
   */
  ibanChecked: boolean;
  /** How many IBANs were decrypted to build this. Never the values. */
  ibanDecryptions: number;
  /** Envelopes that would not decrypt — a rotated or missing key. */
  ibanFailures: number;
  /** Employees with no IBAN envelope at all. Visible without decrypting. */
  employeesWithoutIban: string[];
}

/**
 * Serialise an approved payroll run into WPS records.
 *
 * THE POINT OF THIS FUNCTION is that the SIF is now downstream of something a
 * human approved. Amounts come from `payslips` — the row that was reconciled,
 * journalled and audited — and never from `employees`. Bank details DO come
 * from `employees`, because an IBAN is a current fact about where to send
 * money, not a historical one; a payslip reprinted after someone changes bank
 * should still pay them at the new account.
 *
 * ── HOW A NET PAYSLIP MAPS ONTO A LAYOUT WITH NO DEDUCTION COLUMN (Q-7) ─────
 *
 * The layout in `SIF_LAYOUT` carries fixed income and variable income and
 * nothing else, so `fixed + variable` is the amount the bank transfers. What
 * the bank must transfer is NET pay. Reporting gross would instruct the bank to
 * pay out money the ledger says was withheld against a salary advance — a real
 * cash loss on every run with a deduction in it.
 *
 * So: `variableIncome` is overtime plus commission (never more than the net),
 * and `fixedIncome` is the remainder, so the two are non-negative and sum to
 * net. Nothing is hidden by that split — the deduction is on the payslip, in
 * the journal and in the audit record — but the file's fixed-income column is
 * then net of it, and `deductionsFolded` reports exactly how much so the screen
 * can say so out loud. If the agent's real layout turns out to carry a
 * deduction column, this is the mapping that changes, next to `SIF_LAYOUT`.
 */
export async function loadWpsExport(
  tx: ServiceContext["tx"],
  opts: {
    period: string;
    businessUnitId?: string;
    businessUnitIds?: string[] | null;
    /**
     * Decrypt the IBANs. Default true — the download needs them.
     *
     * A screen that only wants to warn the operator BEFORE payday passes false
     * and gets everything except the IBAN itself, so validating the run does
     * not create a second, unthrottled path that decrypts every employee's
     * account number on a page view. The download route stays the only
     * decryptor, and it is the one that is rate-limited and emits the
     * `pii.decrypted` event.
     */
    decryptIbans?: boolean;
  },
): Promise<WpsExportSource | null> {
  const decryptIbans = opts.decryptIbans !== false;
  const buFilter = opts.businessUnitId
    ? sql`AND r.business_unit_id = ${opts.businessUnitId}::uuid`
    : sql``;
  const scope = opts.businessUnitIds;
  const scopeFilter =
    scope && scope.length > 0
      ? sql`AND e.primary_business_unit_id = ANY(ARRAY[${sql.join(
          scope.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}])`
      : sql``;

  const rows = await tx.execute<{
    run_id: string; status: string; period_start: string; period_end: string;
    full_name: string; wps_person_id: string | null; wps_routing_code: string | null;
    iban_enc: string | null; gross_amount: string; net_amount: string;
    overtime_amount: string; commission_amount: string;
    advance_deduction: string; deduction_amount: string;
    breakdown: { period?: { start?: string; end?: string }; days?: { employed?: number; unpaidLeave?: number } } | null;
  }>(sql`
    SELECT r.id AS run_id, r.status, r.period_start::text, r.period_end::text,
           e.full_name, e.wps_person_id, e.wps_routing_code, e.iban_enc,
           p.gross_amount, p.net_amount, p.overtime_amount, p.commission_amount,
           p.advance_deduction, p.deduction_amount, p.breakdown
      FROM payroll_runs r
      JOIN payslips p ON p.payroll_run_id = r.id
      JOIN employees e ON e.id = p.employee_id
     WHERE r.period_label = ${opts.period}
       AND r.status IN ('approved', 'paid')
       ${buFilter}
       ${scopeFilter}
     ORDER BY e.employee_code
  `);

  if (rows.length === 0) return null;

  const runIds = [...new Set(rows.map((r) => r.run_id))];
  const allPaid = rows.every((r) => r.status === "paid");

  let netTotal = M.ZERO;
  let deductionsFolded = M.ZERO;
  let ibanDecryptions = 0;
  let ibanFailures = 0;
  const employeesWithoutIban: string[] = [];

  const employees: WpsEmployee[] = rows.map((r) => {
    const net = M.quantize(M.fromDb(r.net_amount));
    const variableEarned = M.add(M.fromDb(r.overtime_amount), M.fromDb(r.commission_amount));
    // Non-negative by construction and summing to net; see the docblock above.
    const variable = M.min(variableEarned, net);
    const fixed = M.sub(net, variable);
    netTotal = M.add(netTotal, net);
    deductionsFolded = M.sum([
      deductionsFolded,
      M.fromDb(r.advance_deduction),
      M.fromDb(r.deduction_amount),
    ]);

    // Decrypted only here, in the one place that legitimately needs the full
    // account number, and never logged. A null envelope is a missing IBAN; a
    // non-null envelope that returns null is a decryption failure, and the two
    // are counted separately because they need different fixes.
    let iban = "";
    if (!r.iban_enc) {
      employeesWithoutIban.push(r.full_name);
    } else if (decryptIbans) {
      const plain = tryDecryptPii(r.iban_enc);
      if (plain === null) ibanFailures += 1;
      else {
        ibanDecryptions += 1;
        iban = plain;
      }
    }

    const start = r.breakdown?.period?.start ?? r.period_start;
    const end = r.breakdown?.period?.end ?? r.period_end;

    return {
      personId: r.wps_person_id ?? "",
      /**
       * The employee's agent ID.
       *
       * Hard-coded "0000000" for everyone before FR-C06, which is what a field
       * with no source looks like (audit CALC-15 / CALC-17). The routing code
       * IS the bank identifier this product actually holds, so it is used for
       * both columns rather than one of them being a constant that means
       * nothing. Whether the agent's layout wants one column or two is Q-7.
       */
      agentId: r.wps_routing_code ?? "",
      routingCode: r.wps_routing_code ?? "",
      iban,
      periodStart: start,
      periodEnd: end,
      daysInPeriod: r.breakdown?.days?.employed ?? inclusiveDays(start, end),
      fixedIncome: M.toNumber(fixed),
      variableIncome: M.toNumber(variable),
      daysOnLeave: r.breakdown?.days?.unpaidLeave ?? 0,
      employeeName: r.full_name,
    };
  });

  return {
    period: opts.period,
    label: payrollPeriodLabel(opts.period),
    periodStart: rows[0]!.period_start,
    periodEnd: rows[0]!.period_end,
    runIds,
    status: allPaid ? "paid" : "approved",
    employees,
    employeeCount: employees.length,
    netTotal: M.toNumber(netTotal),
    deductionsFolded: M.toNumber(deductionsFolded),
    ibanChecked: decryptIbans,
    ibanDecryptions,
    ibanFailures,
    employeesWithoutIban,
  };
}

/**
 * The warnings a screen can show BEFORE anyone downloads the file.
 *
 * CALC-16 asks that validation reach the operator rather than being reduced to
 * a count in a response header. The complication is that one of the rules — is
 * this a well-formed 23-character UAE IBAN? — cannot be evaluated without
 * decrypting the IBAN, and the download route is deliberately the only path
 * that decrypts, because it is the one that is rate-limited and the one that
 * emits `pii.decrypted`.
 *
 * So the check is split rather than duplicated:
 *
 *   • PRE-FLIGHT (this function, no decryption): the employer ID, MOHRE Person
 *     IDs, routing codes, zero and negative amounts, the pay-period/day-count
 *     identity, and employees with NO IBAN on file at all — which is the common
 *     failure and is visible from the envelope being null.
 *   • FULL FLIGHT (the route, after decrypting): everything above plus the IBAN
 *     format, returned as HTTP 409 with the messages, blocking the download.
 *
 * The one thing this must never do is present a clean pre-flight as proof the
 * file is good. When `source.ibanChecked` is false an advisory warning says the
 * formats are checked at download, so "no warnings" cannot be misread.
 */
export function wpsPreflight(
  source: WpsExportSource,
  employer: { id: string; agentId: string; routingCode: string },
): WpsWarning[] {
  const warnings = validateWpsDetailed({
    employerId: employer.id,
    employerAgentId: employer.agentId,
    employerRoutingCode: employer.routingCode,
    salaryMonth: source.period,
    generatedAt: new Date(`${source.period}-01T09:00:00Z`),
    employees: source.employees,
  }).filter((w) => source.ibanChecked || w.code !== "iban");

  if (!source.ibanChecked) {
    for (const name of source.employeesWithoutIban) {
      warnings.push({
        code: "iban",
        severity: "blocking",
        subject: name,
        message: `${name}: no IBAN on file — this employee cannot be paid through WPS.`,
      });
    }
    warnings.push({
      code: "iban",
      severity: "advisory",
      subject: "All employees",
      message:
        "IBANs are encrypted at rest, so their format is checked when the file is generated " +
        "rather than here. A malformed IBAN will refuse the download and name the employee.",
    });
  }

  if (source.ibanFailures > 0) {
    warnings.push({
      code: "iban",
      severity: "blocking",
      subject: "Encryption",
      message:
        `${source.ibanFailures} IBAN envelope${source.ibanFailures === 1 ? "" : "s"} could not ` +
        "be decrypted — a rotated or missing key. Those salaries cannot be routed.",
    });
  }

  return warnings;
}
