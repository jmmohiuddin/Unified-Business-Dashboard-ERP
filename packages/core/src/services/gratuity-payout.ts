import { sql } from "drizzle-orm";
import { z } from "zod";
import * as M from "../money/index.ts";
import { calculateGratuity, type GratuityResult } from "../uae/gratuity.ts";
import {
  ServiceError,
  nextDocumentNumber,
  postJournal,
  requireBusinessUnit,
  requirePermission,
  withIdempotency,
  writeAudit,
  type ServiceContext,
} from "./context.ts";

/**
 * END-OF-SERVICE SETTLEMENT — FR-C05.
 *
 * `calculateGratuity` has always been able to say what an employee is owed.
 * Nothing could pay it. The liability accrued in `employees.gratuity_accrued`
 * and in the GRATUITY_PROVISION account, month after month, and there was no
 * write path in the entire product that took a dirham back out of either — so
 * an employee actually owed AED 84,000 was paid by cheque outside the system,
 * the provision stayed on the balance sheet forever, and the register the owner
 * was asked to trust drifted a little further from the truth with every leaver.
 *
 * This file is the payment. Four things it has to get right.
 *
 * ── 1. THE POSTING RULES ─────────────────────────────────────────────────────
 *
 * A gratuity payout is MOSTLY A BALANCE-SHEET MOVEMENT, not an expense. The
 * expense was recognised month by month as the accrual was booked:
 *
 *     DR GRATUITY_EXPENSE      CR GRATUITY_PROVISION      (every month, already)
 *
 * Paying it out therefore discharges a liability that has already been charged
 * to profit. Booking the whole payout as an expense — the instinctive thing,
 * and what a system without an accrual would do — charges the same money to
 * profit twice and leaves the provision standing. So:
 *
 *   A = the provision already carried for this employee (`gratuity_accrued`)
 *   G = the entitlement at the last working day (`calculateGratuity`)
 *   E = anything else owed on the last day (unpaid salary, leave, notice, other)
 *   R = outstanding salary advances recovered from the settlement
 *   N = net payable = G + E − R
 *
 *     DR GRATUITY_PROVISION   A            the whole carried provision, released
 *     DR GRATUITY_EXPENSE     G − A        only if the accrual UNDER-provided
 *     CR GRATUITY_EXPENSE     A − G        only if it OVER-provided
 *     DR SALARY               E            the rest of the final settlement
 *     CR STAFF_ADVANCE        R            advances cleared, not written off
 *     CR CASH/BANK/PAYABLE    N            what the person actually receives
 *
 * The provision leg is A and never `min(A, G)`: the employee is leaving, so
 * nothing remains to carry, and a provision left standing for someone who has
 * been paid is exactly the stale liability this feature exists to remove.
 * Exactly one of the two GRATUITY_EXPENSE legs is non-zero, and the difference
 * is the accrual error being trued up in the month it is discovered — which is
 * the honest place for it, and is why the screen shows the split BEFORE the
 * owner confirms rather than after.
 *
 * The identity, so the balance is a property rather than a hope:
 *
 *     debits  = A + (G − A) + E                       = G + E
 *     credits = (A − G) + R + N = (A − G) + R + G + E − R
 *                                                     = G + E   (when A > G)
 *
 * Deductions other than salary advances are deliberately NOT modelled. A fine,
 * an unreturned laptop or a disputed amount has no account mapping here that
 * would not be invented, and inventing one puts a number in the ledger that
 * nobody can trace back to a rule. Those go through a salary advance or a
 * manual journal, both of which already exist.
 *
 * ── 2. IT MUST NOT ANSWER THE OPEN LEGAL QUESTIONS ───────────────────────────
 *
 * Q-2 (does resignation still reduce entitlement under the 2021 law?) and Q-2b
 * (did Article 44 gross misconduct forfeiture survive it?) are unresolved, on
 * purpose, and worth AED 83,835.62 on a ten-year employee between them.
 *
 * So `reason` is taken from the caller and handed to `calculateGratuity`
 * untouched. There is no branch in this file that looks at it to decide an
 * amount. Whatever the engine decides is what is paid, and when the engine's
 * answer changes — because an adviser finally answers — this file changes not
 * at all.
 *
 * The one thing it does add is a refusal: a gross-misconduct settlement is
 * rejected unless the caller passes `acknowledgeForfeitureAssumption`. That is
 * not a legal position, it is the opposite of one. A screen that silently pays
 * zero would resolve Q-2b by omission and nobody would ever see it happen; a
 * screen that silently paid full would resolve it the other way. Requiring a
 * human to affirm, in the moment, that the zero rests on a reading of the law
 * nobody has confirmed is the only behaviour that leaves the question open. The
 * settlement row then carries `forfeiture_assumed = true` so that if the answer
 * comes back the other way, the affected payouts are one query away.
 *
 * ── 3. NO DAY OF SERVICE IS EVER PAID FOR TWICE (EC-05) ──────────────────────
 *
 * `resolveGratuityServiceStart` is the whole of it, and it is deliberately not
 * a stored value. The clock starts at the LATER of the employee's own start
 * date and the day after the last settled period. Joining dates are never
 * rewritten — see the docblock on `employees.service_restarted_on` — so an
 * employee paid out on 2024-06-30 and rehired on 2025-03-01 accrues from
 * 2025-03-01, while their contract, their visa file and their first settlement
 * still say they joined in 2019.
 *
 * The derivation means the invariant survives a mistake: even if
 * `service_restarted_on` is never set, or is set wrong, the settled period puts
 * a floor under the clock that no data-entry error can lower.
 *
 * ── 4. THE ROLLUP COLUMN GETS A WRITER ───────────────────────────────────────
 *
 * `employees.gratuity_accrued` is read in three places — this register, the
 * `gratuity_liability` metric and its own sort order — and until now was
 * written by nothing but the seed. A payout sets it to zero, because it has to:
 * leaving it at AED 84,000 for someone who has been paid would keep the metric
 * and the balance sheet disagreeing forever, which is the failure the audit
 * called out. It is still not maintained MONTHLY by any code path; see the
 * report accompanying this change.
 */

/** Paying a settlement is paying a salary. Same key, same sensitivity. */
export const GRATUITY_SETTLE_PERMISSION = "payroll:pay";

/**
 * Rehire carries the same permission as the payout, not `employee:update`.
 *
 * Restarting a service clock is the write that decides what the NEXT settlement
 * pays. Getting it wrong in one direction hands an employee a second payment
 * for years already bought; in the other it quietly deletes service they are
 * entitled to. That is a payroll decision wearing an HR form, so it sits behind
 * the payroll key rather than the one that also covers changing a phone number.
 */
export const GRATUITY_REHIRE_PERMISSION = "payroll:pay";

/**
 * The reasons an employment ends, as the engine understands them.
 *
 * `accrual` is excluded: it is the valuation mode used by the register and the
 * monthly posting, not a way of leaving, and offering it here would let someone
 * settle an employee who has not left.
 */
export const SETTLEMENT_REASONS = ["resignation", "termination", "gross_misconduct"] as const;
export type SettlementReason = (typeof SETTLEMENT_REASONS)[number];

/** Where the net settlement is credited. */
const SETTLEMENT_ACCOUNT: Record<string, string> = {
  bank_transfer: "BANK",
  wps: "BANK",
  cash: "CASH",
  // Recognised as owed now, paid in the next bank run. The employee's last day
  // and the day finance moves the money are rarely the same day, and pretending
  // otherwise misstates the bank balance.
  payable: "SALARY_PAYABLE",
};

/** The employment status a settled employee ends up in. */
const STATUS_FOR_REASON: Record<SettlementReason, string> = {
  resignation: "resigned",
  termination: "terminated",
  gross_misconduct: "terminated",
};

const MS_PER_DAY = 86_400_000;

/** ISO date `days` after `iso`. Parsed at UTC midnight so no offset can shift it. */
function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Fixed-width ISO dates compare chronologically as strings. */
const laterOf = (a: string, b: string): string => (a > b ? a : b);

/**
 * The date this employee's CURRENT period of continuous service began.
 *
 * The one function that decides how much gratuity anyone accrues, and the
 * single place edge case EC-05 is handled. Deliberately pure and deliberately
 * derived rather than stored: see rule 3 in the file header.
 *
 * `lastSettledThrough` is the last day covered by a settlement that has already
 * been paid. The day AFTER it is the earliest day a new clock may start, and
 * the employee's own restart date wins if it is later — which it normally is,
 * because people are rehired weeks or months after they leave, not the next
 * morning.
 */
export function resolveGratuityServiceStart(input: {
  joinedOn: string;
  serviceRestartedOn?: string | null;
  lastSettledThrough?: string | null;
}): string {
  const declared = input.serviceRestartedOn ?? input.joinedOn;
  if (!input.lastSettledThrough) return declared;
  return laterOf(declared, addDays(input.lastSettledThrough, 1));
}

/* ── The register ──────────────────────────────────────────────────────────── */

export interface GratuityRegisterRow {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  designation: string | null;
  businessUnitId: string;
  businessUnitName: string;
  colorToken: string | null;
  status: string;
  /** The contractual joining date. Evidence — never moved. */
  joinedOn: string;
  /** Where the CURRENT service clock starts. Differs from `joinedOn` only after
   *  a settlement. */
  serviceStart: string;
  /** Last day covered by a paid settlement, if any. */
  settledThrough: string | null;
  settlementCount: number;
  /** Total already paid out across every settled period. */
  settledTotal: number;
  basicSalary: number;
  totalSalary: number;
  /** The rollup column, so the screen can show it against the live figure. */
  accruedOnRecord: number;
  gratuity: GratuityResult;
  wpsReady: boolean;
  ibanHint: string | null;
  /** Outstanding salary advances that a settlement would clear. */
  advanceOutstanding: number;
}

/**
 * Everything the register and the payout form need, in one round trip.
 *
 * The entitlement is RECOMPUTED here rather than read from
 * `employees.gratuity_accrued`, for the same reason the page has always done
 * so: this is where the owner comes to check the number, so it has to show the
 * calculation and not a cached copy of it. What is new is that the calculation
 * now starts from `serviceStart`, so a rehired employee's row is right.
 *
 * Takes a bare `tx` rather than a `ServiceContext` — the same shape as
 * `loadCashBoard` — because it is a read and the caller has already gated it.
 *
 * ONE KNOWN DIVERGENCE, stated rather than hidden: `suspended` is in the
 * default status set here and is NOT in the `gratuity_liability` metric's
 * (`metrics/uae-metrics.ts`), so the register's total can exceed the metric's
 * by a suspended employee's accrual. Included deliberately — a suspension is
 * usually the step before a dismissal, so leaving suspended staff off the
 * register would hide exactly the people most likely to need settling, and
 * they are still employed and still accruing under Article 51. The metric is
 * the one that should change; it is not this feature's file to change.
 */
export async function loadGratuityRegister(
  tx: ServiceContext["tx"],
  opts: { asOf: string; includeLeavers?: boolean },
): Promise<GratuityRegisterRow[]> {
  const statuses = opts.includeLeavers
    ? sql`('active','probation','on_leave','suspended','resigned','terminated')`
    : sql`('active','probation','on_leave','suspended')`;

  const rows = await tx.execute<{
    id: string; employee_code: string; full_name: string; designation: string | null;
    status: string; joined_on: string; service_restarted_on: string | null;
    basic: string; housing: string; transport: string; other: string;
    accrued: string; bu_id: string; bu_name: string; color_token: string | null;
    iban_enc: string | null; iban_hint: string | null;
    wps_person_id: string | null; wps_routing_code: string | null;
    settled_through: string | null; settlement_count: number; settled_total: string;
    advance_outstanding: string;
  }>(sql`
    SELECT e.id, e.employee_code, e.full_name, e.designation, e.status::text AS status,
           e.joined_on::text, e.service_restarted_on::text,
           e.base_salary AS basic, e.housing_allowance AS housing,
           e.transport_allowance AS transport, e.other_allowance AS other,
           e.gratuity_accrued AS accrued,
           b.id AS bu_id, b.name AS bu_name, b.color_token,
           e.iban_enc, e.iban_hint, e.wps_person_id, e.wps_routing_code,
           s.settled_through::text, COALESCE(s.settlement_count, 0)::int AS settlement_count,
           COALESCE(s.settled_total, 0) AS settled_total,
           COALESCE(adv.outstanding, 0) AS advance_outstanding
      FROM employees e
      JOIN business_units b ON b.id = e.primary_business_unit_id
      LEFT JOIN LATERAL (
        SELECT MAX(g.service_period_end) AS settled_through,
               COUNT(*) AS settlement_count,
               SUM(g.gratuity_amount) AS settled_total
          FROM gratuity_settlements g
         WHERE g.employee_id = e.id
      ) s ON true
      LEFT JOIN LATERAL (
        SELECT SUM(a.outstanding) AS outstanding
          FROM salary_advances a
         WHERE a.employee_id = e.id AND a.outstanding > 0
      ) adv ON true
     WHERE e.status IN ${statuses} AND e.deleted_at IS NULL
     ORDER BY e.full_name
  `);

  return rows.map((r) => {
    const totalSalary = M.add(
      M.add(M.fromDb(r.basic), M.fromDb(r.housing)),
      M.add(M.fromDb(r.transport), M.fromDb(r.other)),
    );
    const serviceStart = resolveGratuityServiceStart({
      joinedOn: r.joined_on,
      serviceRestartedOn: r.service_restarted_on,
      lastSettledThrough: r.settled_through,
    });
    return {
      employeeId: r.id,
      employeeCode: r.employee_code,
      fullName: r.full_name,
      designation: r.designation,
      businessUnitId: r.bu_id,
      businessUnitName: r.bu_name,
      colorToken: r.color_token,
      status: r.status,
      joinedOn: r.joined_on,
      serviceStart,
      settledThrough: r.settled_through,
      settlementCount: r.settlement_count,
      settledTotal: M.toNumber(M.fromDb(r.settled_total)),
      basicSalary: M.toNumber(M.fromDb(r.basic)),
      totalSalary: M.toNumber(totalSalary),
      accruedOnRecord: M.toNumber(M.fromDb(r.accrued)),
      gratuity: calculateGratuity({
        basicSalary: M.toNumber(M.fromDb(r.basic)),
        totalSalary: M.toNumber(totalSalary),
        joinedOn: serviceStart,
        asOf: opts.asOf,
      }),
      wpsReady: Boolean(r.iban_enc && r.wps_person_id && r.wps_routing_code),
      ibanHint: r.iban_hint,
      advanceOutstanding: M.toNumber(M.fromDb(r.advance_outstanding)),
    };
  })
    /**
     * Ordered by what is actually owed, largest first.
     *
     * The SQL orders by name, and the sort is finished here, because the
     * ordering column is the RECOMPUTED entitlement rather than
     * `gratuity_accrued`. The register used to `ORDER BY e.gratuity_accrued
     * DESC` — a column nothing but the seed has ever written, so the row order
     * was as stale as the figure, and it was one of the three readers the audit
     * found for a column with no writer. Two remain, both in
     * `metrics/uae-metrics.ts`.
     */
    .sort((a, b) => b.gratuity.amount - a.gratuity.amount || a.fullName.localeCompare(b.fullName));
}

/* ── The payout ────────────────────────────────────────────────────────────── */

export const settleGratuityInput = z.object({
  employeeId: z.uuid(),
  /** Passed to the engine untouched. This file never reads it to pick a figure. */
  reason: z.enum(SETTLEMENT_REASONS),
  /** The employee's last day of service. Cannot be in the future. */
  lastWorkingDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Unpaid leave and absconding days, which do not count toward service. */
  unpaidLeaveDays: z.number().int().min(0).max(3650).default(0),

  /** Everything else owed on the last day. Entered, because nothing accrues them. */
  unpaidSalary: z.number().min(0).default(0),
  leaveEncashment: z.number().min(0).default(0),
  noticePay: z.number().min(0).default(0),
  otherEarnings: z.number().min(0).default(0),
  /** Omit to recover every outstanding advance; give a smaller figure to
   *  recover part of one. Never more than is outstanding. */
  advanceRecovery: z.number().min(0).optional(),

  settledVia: z.enum(["bank_transfer", "wps", "cash", "payable"]).default("bank_transfer"),
  /**
   * Required for, and only for, a gross-misconduct settlement. See rule 2 in
   * the file header: this is what stops the screen resolving Q-2b by silence.
   */
  acknowledgeForfeitureAssumption: z.boolean().default(false),
  note: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface GratuitySettlementResult {
  settlementId: string;
  settlementNumber: string;
  journalId: string;
  employeeName: string;
  reason: SettlementReason;
  serviceStart: string;
  lastWorkingDay: string;
  serviceYears: number;
  gratuityAmount: number;
  /** The provision that was carried and has now been released in full. */
  provisionApplied: number;
  /** Charged to this month's profit because the accrual under-provided. */
  expenseShortfall: number;
  /** Credited back to profit because it over-provided. */
  provisionReleased: number;
  otherEarnings: number;
  advanceRecovered: number;
  netPayable: number;
  settledVia: string;
  forfeitureAssumed: boolean;
  explanation: string;
}

/**
 * Settle an employee's end of service and pay them.
 *
 * Irreversible by design — there is no `unsettleGratuity`. Money leaves, a
 * statutory obligation is discharged, and the employment record closes. The
 * screen puts it behind an `ActionForm confirm` for that reason; the guards
 * here are the half that a browser cannot be trusted with.
 */
export async function settleGratuity(
  ctx: ServiceContext,
  raw: unknown,
): Promise<GratuitySettlementResult> {
  const input = settleGratuityInput.parse(raw);
  requirePermission(ctx, GRATUITY_SETTLE_PERMISSION);

  return withIdempotency(ctx, input.idempotencyKey, "gratuity.settle", async () => {
    const [employee] = await ctx.tx.execute<{
      id: string; full_name: string; status: string; joined_on: string;
      service_restarted_on: string | null; left_on: string | null;
      basic: string; housing: string; transport: string; other: string;
      accrued: string; bu_id: string; bu_code: string;
      settled_through: string | null; settled_number: string | null;
    }>(sql`
      SELECT e.id, e.full_name, e.status::text AS status, e.joined_on::text,
             e.service_restarted_on::text, e.left_on::text,
             e.base_salary AS basic, e.housing_allowance AS housing,
             e.transport_allowance AS transport, e.other_allowance AS other,
             e.gratuity_accrued AS accrued,
             b.id AS bu_id, b.code AS bu_code,
             s.service_period_end::text AS settled_through, s.settlement_number AS settled_number
        FROM employees e
        JOIN business_units b ON b.id = e.primary_business_unit_id
        LEFT JOIN LATERAL (
          SELECT g.service_period_end, g.settlement_number
            FROM gratuity_settlements g
           WHERE g.employee_id = e.id
           ORDER BY g.service_period_end DESC
           LIMIT 1
        ) s ON true
       WHERE e.id = ${input.employeeId}::uuid AND e.deleted_at IS NULL
       -- Locks the employee for the life of the transaction so two settlements
       -- cannot read the same provision and release it twice. The join columns
       -- are read-only here, hence OF e.
       FOR UPDATE OF e
    `);
    if (!employee) throw new ServiceError("That employee does not exist.", "not_found");
    requireBusinessUnit(ctx, employee.bu_id);

    /**
     * Q-2b, made visible instead of decided.
     *
     * The engine forfeits the entire entitlement for a gross-misconduct
     * dismissal and that behaviour is untouched. What this refusal buys is
     * that nobody can pay AED 0 to a ten-year employee without having read a
     * sentence saying the zero is an assumption. Note what it is NOT: it does
     * not pay them anyway, it does not offer an override amount, and it does
     * not record a legal opinion. It records that a human saw the question.
     */
    if (input.reason === "gross_misconduct" && !input.acknowledgeForfeitureAssumption) {
      throw new ServiceError(
        "A gross-misconduct settlement pays nothing, and that is an ASSUMPTION, not " +
          "settled law (open question Q-2b). Forfeiture was the rule under the " +
          "superseded Federal Law 8 of 1980; Article 44 of Federal Decree-Law 33 of 2021 " +
          "permits summary dismissal but may not extinguish the Article 51 benefit. " +
          "Confirm with MOHRE or an employment lawyer, then tick the acknowledgement to " +
          "settle at zero.",
        "invalid",
      );
    }

    if (input.lastWorkingDay > ctx.today) {
      throw new ServiceError(
        `The last working day (${input.lastWorkingDay}) is in the future. Settle on or ` +
          "after the day service actually ends — gratuity cannot be paid for days not yet worked.",
        "invalid",
      );
    }

    const serviceStart = resolveGratuityServiceStart({
      joinedOn: employee.joined_on,
      serviceRestartedOn: employee.service_restarted_on,
      lastSettledThrough: employee.settled_through,
    });
    if (input.lastWorkingDay < serviceStart) {
      throw new ServiceError(
        employee.settled_through
          ? `Service since the last settlement (${employee.settled_number}, paid through ` +
            `${employee.settled_through}) starts on ${serviceStart}. A last working day of ` +
            `${input.lastWorkingDay} is inside a period that has already been paid.`
          : `The last working day (${input.lastWorkingDay}) is before this employee's ` +
            `service start (${serviceStart}).`,
        "invalid",
      );
    }

    const basicSalary = M.fromDb(employee.basic);
    const totalSalary = M.add(
      M.add(basicSalary, M.fromDb(employee.housing)),
      M.add(M.fromDb(employee.transport), M.fromDb(employee.other)),
    );

    /**
     * The engine decides the amount. Every field it needs comes from the
     * employee record or the caller; `reason` in particular passes straight
     * through. If Q-2 or Q-2b is answered and `gratuity.ts` changes, this call
     * site does not.
     */
    const result = calculateGratuity({
      basicSalary: M.toNumber(basicSalary),
      totalSalary: M.toNumber(totalSalary),
      joinedOn: serviceStart,
      asOf: input.lastWorkingDay,
      reason: input.reason,
      unpaidLeaveDays: input.unpaidLeaveDays,
    });

    /**
     * Back into exact decimal.
     *
     * `GratuityResult` reports numbers because it is also read by charts and
     * the metrics layer, and `M.toNumber` has already quantised each of them to
     * storage precision. decimal.js constructs from a number via its decimal
     * string, so a value that is already 4 dp round-trips exactly — there is no
     * binary residue to reintroduce here. Everything downstream of this line is
     * Decimal again.
     */
    const gratuity = M.quantize(M.money(result.amount));
    const provisionCarried = M.quantize(M.fromDb(employee.accrued));

    // Exactly one of these is non-zero. See the posting rules in the header.
    const shortfall = M.gt(gratuity, provisionCarried)
      ? M.sub(gratuity, provisionCarried)
      : M.ZERO;
    const excess = M.gt(provisionCarried, gratuity) ? M.sub(provisionCarried, gratuity) : M.ZERO;

    const unpaidSalary = M.quantize(M.money(input.unpaidSalary));
    const leaveEncashment = M.quantize(M.money(input.leaveEncashment));
    const noticePay = M.quantize(M.money(input.noticePay));
    const otherEarnings = M.quantize(M.money(input.otherEarnings));
    const otherOwed = M.sum([unpaidSalary, leaveEncashment, noticePay, otherEarnings]);

    /* ── Salary advances ──────────────────────────────────────────────────── */

    const advances = await ctx.tx.execute<{ id: string; outstanding: string; issued_on: string }>(sql`
      SELECT id, outstanding, issued_on::text
        FROM salary_advances
       WHERE employee_id = ${input.employeeId}::uuid AND outstanding > 0
       ORDER BY issued_on, id
       FOR UPDATE
    `);
    const advanceOutstanding = M.sum(advances.map((a) => M.fromDb(a.outstanding)));
    const recovery =
      input.advanceRecovery === undefined
        ? advanceOutstanding
        : M.quantize(M.money(input.advanceRecovery));

    /**
     * Refused exactly, never clamped.
     *
     * The same rule payments and purchasing enforce, and for the same reason: a
     * `GREATEST(0, …)` here would silently write off the difference and nobody
     * would ever see the number that was lost.
     */
    if (M.gt(recovery, advanceOutstanding)) {
      throw new ServiceError(
        `Cannot recover ${M.toDisplay(recovery)} of salary advances — only ` +
          `${M.toDisplay(advanceOutstanding)} is outstanding.`,
        "invalid",
      );
    }

    const netPayable = M.sub(M.add(gratuity, otherOwed), recovery);
    if (M.isNegative(netPayable)) {
      throw new ServiceError(
        `This settlement comes to ${M.toDisplay(M.add(gratuity, otherOwed))} against ` +
          `${M.toDisplay(recovery)} of salary advances, so the employee would owe ` +
          `${M.toDisplay(M.abs(netPayable))}. A settlement cannot pay a negative amount. ` +
          "Recover less here and deal with the balance separately.",
        "invalid",
      );
    }

    /* ── The record ───────────────────────────────────────────────────────── */

    const settlementNumber = await nextDocumentNumber(
      ctx,
      employee.bu_id,
      "gratuity_settlement",
      `EOS-${employee.bu_code}`,
    );

    // Posted on the last working day when that period is still open, which is
    // the date the obligation crystallises. `postJournal` refuses a closed
    // period and names it, so a leaver in a closed month is a clear error
    // rather than a silent backdate.
    const settledOn = input.lastWorkingDay;

    const breakdown = {
      engine: result,
      inputs: {
        reason: input.reason,
        serviceStart,
        lastWorkingDay: input.lastWorkingDay,
        unpaidLeaveDays: input.unpaidLeaveDays,
        basicSalary: M.toNumber(basicSalary),
        totalSalary: M.toNumber(totalSalary),
      },
      posting: {
        provisionApplied: M.toNumber(provisionCarried),
        expenseShortfall: M.toNumber(shortfall),
        provisionReleased: M.toNumber(excess),
        otherOwed: M.toNumber(otherOwed),
        advanceRecovered: M.toNumber(recovery),
        netPayable: M.toNumber(netPayable),
      },
      note: input.note ?? null,
      openQuestions:
        input.reason === "gross_misconduct"
          ? ["Q-2b: gross-misconduct forfeiture is assumed, not confirmed."]
          : ["Q-2: resignation vs termination is unresolved; the engine treats them alike."],
    };

    const [settlement] = await ctx.tx.execute<{ id: string }>(sql`
      INSERT INTO gratuity_settlements
        (id, tenant_id, employee_id, business_unit_id, settlement_number, reason,
         last_working_day, settled_on, joined_on, service_period_start, service_period_end,
         unpaid_leave_days, basic_salary, total_salary, service_days, service_years,
         daily_basic_wage, gratuity_days, gratuity_gross, gratuity_cap, gratuity_amount,
         provision_applied, expense_shortfall, provision_released,
         unpaid_salary, leave_encashment, notice_pay, other_earnings, advance_recovered,
         net_payable, settled_via, forfeiture_assumed, explanation, breakdown,
         settled_by_user_id)
      VALUES
        (gen_random_uuid(), ${ctx.tenantId}::uuid, ${input.employeeId}::uuid,
         ${employee.bu_id}::uuid, ${settlementNumber}, ${input.reason},
         ${input.lastWorkingDay}::date, ${settledOn}::date, ${employee.joined_on}::date,
         ${serviceStart}::date, ${input.lastWorkingDay}::date,
         ${input.unpaidLeaveDays}, ${M.toDb(basicSalary)}, ${M.toDb(totalSalary)},
         ${result.serviceDays}, ${M.toDb(M.money(result.serviceYears))},
         ${M.toDb(M.money(result.dailyBasicWage))}, ${M.toDb(M.money(result.totalDays))},
         ${M.toDb(M.money(result.grossAmount))},
         ${result.cappedAt === null ? null : M.toDb(M.money(result.cappedAt))},
         ${M.toDb(gratuity)},
         ${M.toDb(provisionCarried)}, ${M.toDb(shortfall)}, ${M.toDb(excess)},
         ${M.toDb(unpaidSalary)}, ${M.toDb(leaveEncashment)}, ${M.toDb(noticePay)},
         ${M.toDb(otherEarnings)}, ${M.toDb(recovery)},
         ${M.toDb(netPayable)}, ${input.settledVia},
         ${input.reason === "gross_misconduct"}, ${result.explanation},
         ${JSON.stringify(breakdown)}::jsonb, ${ctx.principal.userId}::uuid)
      RETURNING id
    `);

    /* ── The journal ──────────────────────────────────────────────────────── */

    const legs: Parameters<typeof postJournal>[1]["legs"] = [];
    if (!M.isZero(provisionCarried)) {
      legs.push({
        accountKey: "GRATUITY_PROVISION",
        businessUnitId: employee.bu_id,
        debit: provisionCarried,
        memo: `Provision released for ${employee.full_name}`,
      });
    }
    if (!M.isZero(shortfall)) {
      legs.push({
        accountKey: "GRATUITY_EXPENSE",
        businessUnitId: employee.bu_id,
        debit: shortfall,
        memo: "Under-accrued gratuity, charged on settlement",
      });
    }
    if (!M.isZero(excess)) {
      legs.push({
        accountKey: "GRATUITY_EXPENSE",
        businessUnitId: employee.bu_id,
        credit: excess,
        memo: "Over-accrued gratuity, released on settlement",
      });
    }
    if (!M.isZero(otherOwed)) {
      // Unpaid salary, leave encashment and notice pay all land in staff cost.
      // NOT in LEAVE_PROVISION: nothing in the product accrues leave salary, so
      // debiting that account would create a negative liability out of nothing.
      // When FR-C06 starts accruing it, this leg is where the mapping changes.
      legs.push({
        accountKey: "SALARY",
        businessUnitId: employee.bu_id,
        debit: otherOwed,
        memo: "Final settlement: salary, leave and notice",
      });
    }
    if (!M.isZero(recovery)) {
      legs.push({
        accountKey: "STAFF_ADVANCE",
        businessUnitId: employee.bu_id,
        credit: recovery,
        memo: "Salary advances recovered from final settlement",
      });
    }
    if (!M.isZero(netPayable)) {
      legs.push({
        accountKey: SETTLEMENT_ACCOUNT[input.settledVia]!,
        businessUnitId: employee.bu_id,
        credit: netPayable,
        memo: `Final settlement paid to ${employee.full_name}`,
      });
    }

    /**
     * A settlement worth nothing at all still posts nothing, and that is a
     * refusal rather than a no-op.
     *
     * It happens when an employee under a year leaves with no provision carried
     * and nothing else owed. There is no journal to write — but silently
     * writing a settlement row with no ledger effect would leave a payment
     * record for a payment that never happened, which is the outbox
     * "success" failure all over again.
     */
    if (legs.length === 0) {
      throw new ServiceError(
        `${employee.full_name} has no gratuity entitlement, no provision carried and ` +
          "nothing else owed, so there is nothing to settle. " +
          result.explanation,
        "invalid",
      );
    }

    const journalId = await postJournal(ctx, {
      postingDate: settledOn,
      source: "payroll",
      sourceTable: "gratuity_settlements",
      sourceId: settlement!.id,
      narration: `${settlementNumber} · end-of-service settlement, ${employee.full_name} (${input.reason})`,
      legs,
    });

    await ctx.tx.execute(sql`
      UPDATE gratuity_settlements SET journal_id = ${journalId}::uuid, updated_at = now()
       WHERE id = ${settlement!.id}::uuid
    `);

    /* ── Clear the advances, oldest first ─────────────────────────────────── */

    let remaining = recovery;
    for (const advance of advances) {
      if (M.isZero(remaining)) break;
      const outstanding = M.fromDb(advance.outstanding);
      // Exact: `M.min` picks one of two Decimals, it does not average or clamp.
      const applied = M.min(remaining, outstanding);
      await ctx.tx.execute(sql`
        UPDATE salary_advances
           SET outstanding = ${M.toDb(M.sub(outstanding, applied))}, updated_at = now()
         WHERE id = ${advance.id}::uuid
      `);
      remaining = M.sub(remaining, applied);
    }

    /* ── Close the employment ─────────────────────────────────────────────── */

    /**
     * `gratuity_accrued` goes to zero because the provision it stands for has
     * just been released in full. `joined_on` is untouched — see rule 3. The
     * status follows the reason, so the register stops showing a liability for
     * someone who no longer has one.
     */
    await ctx.tx.execute(sql`
      UPDATE employees
         SET status = ${STATUS_FOR_REASON[input.reason]}::employment_status,
             left_on = ${input.lastWorkingDay}::date,
             gratuity_accrued = '0',
             gratuity_as_of = ${input.lastWorkingDay}::date,
             updated_at = now()
       WHERE id = ${input.employeeId}::uuid
    `);

    await writeAudit(ctx, {
      action: "gratuity.settle",
      entityTable: "gratuity_settlements",
      entityId: settlement!.id,
      businessUnitId: employee.bu_id,
      diff: {
        employeeId: input.employeeId,
        employeeName: employee.full_name,
        settlementNumber,
        reason: input.reason,
        serviceStart,
        lastWorkingDay: input.lastWorkingDay,
        gratuityAmount: M.toNumber(gratuity),
        provisionApplied: M.toNumber(provisionCarried),
        expenseShortfall: M.toNumber(shortfall),
        provisionReleased: M.toNumber(excess),
        advanceRecovered: M.toNumber(recovery),
        netPayable: M.toNumber(netPayable),
        settledVia: input.settledVia,
        forfeitureAssumed: input.reason === "gross_misconduct",
        statusBefore: employee.status,
        statusAfter: STATUS_FOR_REASON[input.reason],
        journalId,
      },
    });

    return {
      settlementId: settlement!.id,
      settlementNumber,
      journalId,
      employeeName: employee.full_name,
      reason: input.reason,
      serviceStart,
      lastWorkingDay: input.lastWorkingDay,
      serviceYears: result.serviceYears,
      gratuityAmount: M.toNumber(gratuity),
      provisionApplied: M.toNumber(provisionCarried),
      expenseShortfall: M.toNumber(shortfall),
      provisionReleased: M.toNumber(excess),
      otherEarnings: M.toNumber(otherOwed),
      advanceRecovered: M.toNumber(recovery),
      netPayable: M.toNumber(netPayable),
      settledVia: input.settledVia,
      forfeitureAssumed: input.reason === "gross_misconduct",
      explanation: result.explanation,
    };
  });
}

/* ── EC-05: rehire after a payout ──────────────────────────────────────────── */

export const rehireEmployeeInput = z.object({
  employeeId: z.uuid(),
  /** First day of the NEW period of service. */
  rehiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Where they are coming back to work. Defaults to their previous business. */
  businessUnitId: z.uuid().optional(),
  /** A returning employee often comes back on different money. */
  basicSalary: z.number().min(0).optional(),
  housingAllowance: z.number().min(0).optional(),
  transportAllowance: z.number().min(0).optional(),
  otherAllowance: z.number().min(0).optional(),
  note: z.string().max(500).optional(),
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export interface RehireResult {
  employeeId: string;
  employeeName: string;
  joinedOn: string;
  rehiredOn: string;
  /** Where the gratuity clock now starts. */
  serviceStart: string;
  /** The settlement that closed the previous period, if there was one. */
  previousSettlement: string | null;
  settledThrough: string | null;
}

/**
 * Bring a settled employee back, restarting the service clock — edge case EC-05.
 *
 * The mistake this replaces is not hypothetical: without it, an employee paid
 * AED 84,000 and rehired six months later goes on accruing from their ORIGINAL
 * joining date, so the register immediately shows the same eight years of
 * service again and the next settlement pays for them a second time. Nothing
 * would flag it — the arithmetic is internally consistent, it is just applied
 * to years that have been bought.
 *
 * The fix is entirely about which dates are allowed to move. `joined_on` does
 * not: it is on the labour contract and in the MOHRE file, and rewriting it
 * would erase the evidence for the payment that has already been made. What
 * moves is `service_restarted_on`, a second date that says a new period of
 * continuous service began — so the employee's history reads as two periods
 * with a settlement between them, which is what actually happened.
 *
 * NO JOURNAL. Rehiring costs nothing; the accrual for the new period starts
 * from zero and is posted month by month like anyone else's. The one balance
 * this touches is `gratuity_accrued`, which is reset because the provision it
 * represented was released when the previous period was settled.
 */
export async function rehireEmployee(ctx: ServiceContext, raw: unknown): Promise<RehireResult> {
  const input = rehireEmployeeInput.parse(raw);
  requirePermission(ctx, GRATUITY_REHIRE_PERMISSION);

  return withIdempotency(ctx, input.idempotencyKey, "gratuity.rehire", async () => {
    const [employee] = await ctx.tx.execute<{
      id: string; full_name: string; status: string; joined_on: string;
      service_restarted_on: string | null; left_on: string | null; bu_id: string;
      settled_through: string | null; settled_number: string | null;
    }>(sql`
      SELECT e.id, e.full_name, e.status::text AS status, e.joined_on::text,
             e.service_restarted_on::text, e.left_on::text,
             e.primary_business_unit_id AS bu_id,
             s.service_period_end::text AS settled_through,
             s.settlement_number AS settled_number
        FROM employees e
        LEFT JOIN LATERAL (
          SELECT g.service_period_end, g.settlement_number
            FROM gratuity_settlements g
           WHERE g.employee_id = e.id
           ORDER BY g.service_period_end DESC
           LIMIT 1
        ) s ON true
       WHERE e.id = ${input.employeeId}::uuid AND e.deleted_at IS NULL
       FOR UPDATE OF e
    `);
    if (!employee) throw new ServiceError("That employee does not exist.", "not_found");
    requireBusinessUnit(ctx, input.businessUnitId ?? employee.bu_id);

    if (!["resigned", "terminated"].includes(employee.status)) {
      throw new ServiceError(
        `${employee.full_name} is already ${employee.status.replace("_", " ")}. ` +
          "Rehiring restarts a service clock, so it only applies to someone who has left.",
        "conflict",
      );
    }

    /**
     * The floor, restated as a refusal rather than left to the derivation.
     *
     * `resolveGratuityServiceStart` would silently move a too-early restart date
     * forward to the day after the settled period, which is safe but dishonest:
     * the record would say one thing and the arithmetic another. Refusing means
     * whoever typed the date finds out.
     */
    if (employee.settled_through && input.rehiredOn <= employee.settled_through) {
      throw new ServiceError(
        `Service to ${employee.settled_through} was settled and paid (${employee.settled_number}). ` +
          `A rehire date of ${input.rehiredOn} is inside that period — the new service clock ` +
          `has to start on ${addDays(employee.settled_through, 1)} or later.`,
        "invalid",
      );
    }
    if (employee.left_on && input.rehiredOn < employee.left_on) {
      throw new ServiceError(
        `${employee.full_name} left on ${employee.left_on}. They cannot be rehired before that.`,
        "invalid",
      );
    }
    if (input.rehiredOn > ctx.today) {
      throw new ServiceError(
        `A rehire date of ${input.rehiredOn} is in the future. Record it when they start.`,
        "invalid",
      );
    }

    const serviceStart = resolveGratuityServiceStart({
      joinedOn: employee.joined_on,
      serviceRestartedOn: input.rehiredOn,
      lastSettledThrough: employee.settled_through,
    });

    // Salary is optional on the way back in: only the components that were
    // given are written, so omitting them keeps the old package rather than
    // zeroing it. `COALESCE` on a NULL parameter does exactly that.
    await ctx.tx.execute(sql`
      UPDATE employees
         SET status = 'active'::employment_status,
             left_on = NULL,
             service_restarted_on = ${input.rehiredOn}::date,
             primary_business_unit_id = COALESCE(${input.businessUnitId ?? null}::uuid,
                                                 primary_business_unit_id),
             base_salary = COALESCE(${
               input.basicSalary === undefined ? null : M.toDb(M.money(input.basicSalary))
             }::numeric, base_salary),
             housing_allowance = COALESCE(${
               input.housingAllowance === undefined ? null : M.toDb(M.money(input.housingAllowance))
             }::numeric, housing_allowance),
             transport_allowance = COALESCE(${
               input.transportAllowance === undefined
                 ? null
                 : M.toDb(M.money(input.transportAllowance))
             }::numeric, transport_allowance),
             other_allowance = COALESCE(${
               input.otherAllowance === undefined ? null : M.toDb(M.money(input.otherAllowance))
             }::numeric, other_allowance),
             -- The previous period's provision was released when it was
             -- settled. The new clock starts at zero liability, not at whatever
             -- the old one happened to leave behind.
             gratuity_accrued = '0',
             gratuity_as_of = ${input.rehiredOn}::date,
             updated_at = now()
       WHERE id = ${input.employeeId}::uuid
    `);

    await writeAudit(ctx, {
      action: "gratuity.rehire",
      entityTable: "employees",
      entityId: input.employeeId,
      businessUnitId: input.businessUnitId ?? employee.bu_id,
      diff: {
        employeeName: employee.full_name,
        joinedOn: employee.joined_on,
        rehiredOn: input.rehiredOn,
        serviceStart,
        previousSettlement: employee.settled_number,
        settledThrough: employee.settled_through,
        statusBefore: employee.status,
        statusAfter: "active",
        note: input.note ?? null,
      },
    });

    return {
      employeeId: input.employeeId,
      employeeName: employee.full_name,
      joinedOn: employee.joined_on,
      rehiredOn: input.rehiredOn,
      serviceStart,
      previousSettlement: employee.settled_number,
      settledThrough: employee.settled_through,
    };
  });
}
