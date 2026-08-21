/**
 * WPS — Wage Protection System (MOHRE).
 *
 * Every mainland UAE employer must pay salaries through a MOHRE-approved agent
 * and file a Salary Information File (SIF) each month. Miss it and the
 * establishment is blocked from issuing or renewing work permits — which for a
 * business running on sponsored staff is an existential problem, not a fine.
 *
 * The SIF is a plain CSV with two record types:
 *
 *   EDR — Employee Detail Record, one per employee
 *   SCR — Salary Control Record, exactly one, as the final line
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ───────────────────────────────────
 *
 * It is a serialiser. It is NOT a payroll calculation, and it must never
 * become one again. Until FR-C06 the SIF was built by reading `employees`
 * directly and treating everyone as a full-month, fixed-package payee — so the
 * file handed to the bank was a second, parallel computation over master data
 * that nothing in the business had ever approved. Joiners, leavers, unpaid
 * leave, overtime, commission and advance recovery were all misreported by
 * construction (audit CALC-15).
 *
 * The input to `generateSif` is now serialised from a committed payroll run.
 * The arithmetic lives in `services/payroll.ts`; this file's entire job is to
 * lay those figures out in the columns the agent expects and to refuse a file
 * the bank will reject.
 *
 * ── THE LAYOUT IS AN OPEN QUESTION — Q-7 ────────────────────────────────────
 *
 * `SIF_LAYOUT` below is the ONLY place the column order, the date formats, the
 * filename convention and the line ending are expressed. That is deliberate:
 * the exact layout required by THIS group's WPS agent is unresolved (open
 * question Q-7, `docs/PRD-02-product-requirements.md:1069`, owner: the WPS
 * agent), and when the agent's written spec arrives the correction is one
 * object literal rather than a hunt through string concatenation.
 *
 * WHAT IS ACTUALLY KNOWN. Nothing in this repository cites a source for the
 * layout. It is a RECONSTRUCTION, not a transcription. `05-uae-localisation.md`
 * §6 states the format is "unforgiving… fixed column order" with a confidence
 * that nothing checked in supports, and audit CALC-17 lists four specific
 * respects in which it diverges from the commonly documented MOHRE SIF — an
 * extra EDR agent-ID column, a concatenated `YYYYMM` where the documented SCR
 * has separate month and year fields, `total` before `count` where the
 * documented order is the reverse, and `YYMMDD`/`HHMM` stamps where the
 * documented ones are `YYYY-MM-DD` and `HH:mm`. That recall is itself
 * unverified and formats do genuinely vary by agent, so NO correction is
 * attempted here. The layout is preserved exactly as it was, and marked.
 *
 * The tests in `services/payroll.test.ts` therefore assert only what is true under ANY
 * layout: that the SCR control total equals the sum of the EDR amounts, that
 * there is exactly one SCR and it is last, that the record count matches, that
 * the pay-period dates and the day count describe the same span, and that every
 * validation rule fires. Those survive Q-7 being answered; a fixture of column
 * positions would not.
 */

import * as M from "../money/index.ts";

const DAY_MS = 86_400_000;

const pad = (n: number, len: number) => String(n).padStart(len, "0");

/** ISO `YYYY-MM-DD` at UTC midnight. Dates here are calendar days, not instants. */
const parseIso = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

/** Inclusive day count between two ISO dates: 2026-03-20 → 2026-03-31 is 12. */
export function inclusiveDays(startIso: string, endIso: string): number {
  return Math.round((parseIso(endIso) - parseIso(startIso)) / DAY_MS) + 1;
}

/** Last calendar day of a `YYYY-MM` salary month, as ISO. */
export function salaryMonthEnd(salaryMonth: string): string {
  const [y, m] = salaryMonth.split("-").map((p) => parseInt(p, 10));
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

export interface WpsEmployee {
  /** MOHRE Person ID / labour card number — 14 digits. */
  personId: string;
  /** Agent (bank/exchange house) ID of the employee's account. */
  agentId: string;
  /** Routing code of the employee's bank. */
  routingCode: string;
  /** Employee IBAN, without spaces. */
  iban: string;
  /**
   * First and last day of the span this record pays for, inclusive, ISO.
   *
   * CALC-14: these used to be DERIVED from `daysInPeriod` as
   * `${YYYYMM}01` … `${YYYYMM}${pad(daysInPeriod, 2)}` — the month, plus the
   * NUMBER OF DAYS PAID as if it were a day-of-month. For an employee who
   * joined on 20 March and was paid for 12 days that produced "1 March to 12
   * March": both dates wrong, and the start before their employment began. It
   * was only ever right by coincidence, when the employee was paid for a whole
   * month AND the month happened to have exactly that many days.
   *
   * They are now the actual span, supplied by the caller from the employee's
   * joining and leaving dates. Optional only so that a full-month payee needs
   * no ceremony: omitted, they default to the whole salary month.
   */
  periodStart?: string;
  periodEnd?: string;
  /** Days covered in the period. Must equal the inclusive span above. */
  daysInPeriod: number;
  /** Contractual fixed component: basic + fixed allowances. */
  fixedIncome: number;
  /** Variable component: overtime, commission, bonus. */
  variableIncome: number;
  /** Unpaid leave days in the period. */
  daysOnLeave: number;
  /** Not part of the SIF — carried for the reconciliation report. */
  employeeName?: string;
}

export interface WpsFileInput {
  /** Employer Unique ID issued by MOHRE — 13 digits. */
  employerId: string;
  /** Employer's own agent (the bank paying the salaries). */
  employerAgentId: string;
  employerRoutingCode: string;
  /** Period being paid, as YYYY-MM. */
  salaryMonth: string;
  /** Generation timestamp — passed in rather than read from the clock so the
   *  output is reproducible and testable. */
  generatedAt: Date;
  employees: WpsEmployee[];
}

export type WpsWarningCode =
  | "employer_id"
  | "person_id"
  | "iban"
  | "routing_code"
  | "zero_income"
  | "leave_exceeds_period"
  | "period_mismatch"
  | "period_outside_month"
  | "negative_amount"
  | "no_employees";

export interface WpsWarning {
  code: WpsWarningCode;
  /**
   * Every rule in `validateWpsDetailed` is a documented rejection reason, so
   * they are all blocking. The severity is carried explicitly anyway: when Q-7
   * is answered and the agent's spec turns out to tolerate something this file
   * currently refuses, the change is a severity, not a deleted rule.
   */
  severity: "blocking" | "advisory";
  /** Who or what the warning is about — an employee name, or the employer. */
  subject: string;
  message: string;
}

export interface WpsFile {
  fileName: string;
  content: string;
  recordCount: number;
  totalSalaries: number;
  /** Plain-language rejection reasons. Empty means the file should be accepted. */
  warnings: string[];
  /** The same warnings with codes and subjects, for a screen that groups them. */
  detailedWarnings: WpsWarning[];
}

/**
 * Amounts written into the SIF.
 *
 * This file goes to a MOHRE-approved agent and moves real salaries. It was
 * `n.toFixed(2)` over a float sum of four allowance columns — each of which had
 * already been through Number() on the way out of numeric(18,4). A rounding
 * error here is a payroll discrepancy submitted to a bank.
 *
 * Exact decimal, rounded half-up at the currency unit, which is what a payslip
 * shows. `Decimal.toFixed(2)` emits no thousands separator, so no stray comma
 * can ever split a CSV field.
 */
const money = (n: number | string | M.Money) => M.toDisplay(M.money(n));

function stamp(d: Date) {
  const yy = pad(d.getUTCFullYear() % 100, 2);
  const mm = pad(d.getUTCMonth() + 1, 2);
  const dd = pad(d.getUTCDate(), 2);
  const hh = pad(d.getUTCHours(), 2);
  const mi = pad(d.getUTCMinutes(), 2);
  return { date: `${yy}${mm}${dd}`, time: `${hh}${mi}`, full: `${yy}${mm}${dd}${hh}${mi}` };
}

/** `2026-08-20` → `20260820`. The EDR pay-period date format. */
const compactDate = (iso: string) => iso.replace(/-/g, "");

/* ── THE LAYOUT — everything Q-7 will change lives here ─────────────────────
 *
 * Swap this object when the agent's written spec arrives, and cite the spec in
 * `source`. Nothing else in the codebase encodes a column position.
 */

interface EdrValues {
  personId: string;
  agentId: string;
  routingCode: string;
  iban: string;
  periodStart: string;
  periodEnd: string;
  daysInPeriod: number;
  fixedIncome: M.Money;
  variableIncome: M.Money;
  daysOnLeave: number;
}

interface ScrValues {
  employerId: string;
  employerAgentId: string;
  employerRoutingCode: string;
  createdDate: string;
  createdTime: string;
  salaryYearMonth: string;
  totalSalaries: M.Money;
  employeeCount: number;
  currency: string;
}

export const SIF_LAYOUT = {
  /**
   * UNVERIFIED. Reconstructed from `docs/05-uae-localisation.md` §6, which
   * cites no source. See the Q-7 block in this file's header and audit CALC-17
   * for the four specific respects in which it may diverge from the commonly
   * documented MOHRE layout. Do not treat this as a transcription of a spec.
   */
  source: "UNVERIFIED reconstruction — open question Q-7 (PRD-02:1069)",

  /** MOHRE expects CRLF. Also unverified; also here rather than inline. */
  lineEnding: "\r\n",

  currency: "AED",

  edr: (v: EdrValues): string[] => [
    "EDR",
    v.personId,
    v.agentId,
    v.routingCode,
    v.iban,
    compactDate(v.periodStart),
    compactDate(v.periodEnd),
    String(v.daysInPeriod),
    money(v.fixedIncome),
    money(v.variableIncome),
    String(v.daysOnLeave),
  ],

  scr: (v: ScrValues): string[] => [
    "SCR",
    v.employerId,
    v.employerAgentId,
    v.employerRoutingCode,
    v.createdDate,
    v.createdTime,
    v.salaryYearMonth,
    money(v.totalSalaries),
    String(v.employeeCount),
    v.currency,
  ],

  fileName: (employerId: string, ts: ReturnType<typeof stamp>): string =>
    `${employerId}${ts.full}.SIF`,
};

/* ── Validation ────────────────────────────────────────────────────────────── */

/**
 * Resolve the span an EDR pays for.
 *
 * Defaults to the whole salary month so a full-month payee needs no ceremony,
 * and so callers written against the old shape keep working — but a payroll run
 * always supplies both, because a joiner or a leaver is exactly the case the
 * default gets wrong.
 */
export function edrPeriod(e: WpsEmployee, salaryMonth: string): { start: string; end: string } {
  return {
    start: e.periodStart ?? `${salaryMonth}-01`,
    end: e.periodEnd ?? salaryMonthEnd(salaryMonth),
  };
}

/**
 * Validate before generating.
 *
 * Every one of these is a real rejection reason. Surfacing them as warnings the
 * owner can fix beforehand is far better than a bank rejection two days before
 * payday — which is when it would otherwise be discovered.
 *
 * CALC-16: these messages used to be produced, counted, and thrown away. The
 * API route returned `X-WPS-Warnings: 4` and handed the user a file containing
 * `BAD` as an IBAN, an empty routing field and a zero salary, with nothing on
 * screen to say it would bounce. The messages are the point of the function;
 * returning their cardinality defeats it entirely.
 */
export function validateWpsDetailed(input: WpsFileInput): WpsWarning[] {
  const warnings: WpsWarning[] = [];
  const add = (
    code: WpsWarningCode,
    subject: string,
    message: string,
    severity: WpsWarning["severity"] = "blocking",
  ) => warnings.push({ code, severity, subject, message });

  if (!/^\d{13}$/.test(input.employerId)) {
    add("employer_id", "Employer", `Employer ID must be 13 digits (got "${input.employerId}").`);
  }

  if (input.employees.length === 0) {
    add(
      "no_employees",
      "Employer",
      "The file has no employee records. A SIF with an SCR and no EDR pays nobody and " +
        "will not discharge the month's WPS obligation.",
    );
  }

  const monthStart = `${input.salaryMonth}-01`;
  const monthEnd = salaryMonthEnd(input.salaryMonth);

  for (const e of input.employees) {
    const who = e.employeeName ?? e.personId;
    if (!/^\d{14}$/.test(e.personId)) {
      add("person_id", who, `${who}: MOHRE Person ID must be 14 digits.`);
    }
    if (!/^AE\d{21}$/.test(e.iban.replace(/\s/g, ""))) {
      add("iban", who, `${who}: IBAN must be a 23-character UAE IBAN (AE + 21 digits).`);
    }
    if (!e.routingCode) {
      add("routing_code", who, `${who}: missing bank routing code — the salary cannot be routed.`);
    }
    if (M.lte(M.money(e.fixedIncome), M.ZERO)) {
      add("zero_income", who, `${who}: fixed income is zero; MOHRE will reject the record.`);
    }
    if (M.isNegative(M.money(e.variableIncome))) {
      add(
        "negative_amount",
        who,
        `${who}: variable income is negative. A SIF cannot instruct a bank to take money back.`,
      );
    }
    if (e.daysOnLeave > e.daysInPeriod) {
      add("leave_exceeds_period", who, `${who}: leave days exceed days in the period.`);
    }

    /**
     * The span and the day count must describe the same thing.
     *
     * This is the check that would have caught CALC-14 the day it was written,
     * and it is true under any layout: whatever columns the agent wants, a
     * record claiming 12 days and a start-to-end span of 31 is internally
     * inconsistent and no bank should accept it.
     */
    const { start, end } = edrPeriod(e, input.salaryMonth);
    const span = inclusiveDays(start, end);
    if (span !== e.daysInPeriod) {
      add(
        "period_mismatch",
        who,
        `${who}: the pay period ${start} to ${end} is ${span} day${span === 1 ? "" : "s"}, ` +
          `but the record claims ${e.daysInPeriod}.`,
      );
    }
    if (start < monthStart || end > monthEnd || start > end) {
      add(
        "period_outside_month",
        who,
        `${who}: the pay period ${start} to ${end} falls outside the salary month ` +
          `${input.salaryMonth} (${monthStart} to ${monthEnd}).`,
      );
    }
  }

  return warnings;
}

/**
 * The messages, flat.
 *
 * Kept because it is the documented entry point in `05-uae-localisation.md` §6
 * and because most callers only want something to print.
 */
export function validateWps(input: WpsFileInput): string[] {
  return validateWpsDetailed(input).map((w) => w.message);
}

export function generateSif(input: WpsFileInput): WpsFile {
  const detailedWarnings = validateWpsDetailed(input);
  const ts = stamp(input.generatedAt);
  const [year, month] = input.salaryMonth.split("-");
  const salaryYm = `${year}${month}`;

  const lines: string[] = [];
  let total = M.ZERO;

  // EDR — Employee Detail Records.
  for (const e of input.employees) {
    // The SCR control total must equal the sum of the EDR amounts exactly, or
    // the agent rejects the file. Accumulated from the same Decimals that are
    // formatted into the detail lines, so the control record cannot drift from
    // the detail it controls — which is the failure that rejects a whole batch.
    const fixed = M.money(e.fixedIncome);
    const variable = M.money(e.variableIncome);
    total = M.add(total, M.add(fixed, variable));

    const { start, end } = edrPeriod(e, input.salaryMonth);
    lines.push(
      SIF_LAYOUT.edr({
        personId: e.personId,
        agentId: e.agentId,
        routingCode: e.routingCode,
        iban: e.iban.replace(/\s/g, ""),
        periodStart: start,
        periodEnd: end,
        daysInPeriod: e.daysInPeriod,
        fixedIncome: fixed,
        variableIncome: variable,
        daysOnLeave: e.daysOnLeave,
      }).join(","),
    );
  }

  // SCR — Salary Control Record. Exactly one, and it must be last.
  lines.push(
    SIF_LAYOUT.scr({
      employerId: input.employerId,
      employerAgentId: input.employerAgentId,
      employerRoutingCode: input.employerRoutingCode,
      createdDate: ts.date,
      createdTime: ts.time,
      salaryYearMonth: salaryYm,
      totalSalaries: total,
      employeeCount: input.employees.length,
      currency: SIF_LAYOUT.currency,
    }).join(","),
  );

  return {
    fileName: SIF_LAYOUT.fileName(input.employerId, ts),
    content: `${lines.join(SIF_LAYOUT.lineEnding)}${SIF_LAYOUT.lineEnding}`,
    recordCount: input.employees.length,
    totalSalaries: M.toNumber(total),
    warnings: detailedWarnings.map((w) => w.message),
    detailedWarnings,
  };
}
