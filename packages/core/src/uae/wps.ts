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
 * Field order is fixed by MOHRE and unforgiving; a single misplaced column
 * rejects the whole file. Generating it here — rather than asking the owner to
 * fill a spreadsheet — removes an entire class of monthly error.
 *
 * Filename convention: <EmployerUniqueID><YYMMDD><HHMM>.SIF
 */

export interface WpsEmployee {
  /** MOHRE Person ID / labour card number — 14 digits. */
  personId: string;
  /** Agent (bank/exchange house) ID of the employee's account. */
  agentId: string;
  /** Routing code of the employee's bank. */
  routingCode: string;
  /** Employee IBAN, without spaces. */
  iban: string;
  /** Days covered in the period (usually the days in the month). */
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

export interface WpsFile {
  fileName: string;
  content: string;
  recordCount: number;
  totalSalaries: number;
  warnings: string[];
}

const pad = (n: number, len: number) => String(n).padStart(len, "0");
const money = (n: number) => n.toFixed(2);

function stamp(d: Date) {
  const yy = pad(d.getUTCFullYear() % 100, 2);
  const mm = pad(d.getUTCMonth() + 1, 2);
  const dd = pad(d.getUTCDate(), 2);
  const hh = pad(d.getUTCHours(), 2);
  const mi = pad(d.getUTCMinutes(), 2);
  return { date: `${yy}${mm}${dd}`, time: `${hh}${mi}`, full: `${yy}${mm}${dd}${hh}${mi}` };
}

/**
 * Validate before generating.
 *
 * Every one of these is a real rejection reason. Surfacing them as warnings the
 * owner can fix beforehand is far better than a bank rejection two days before
 * payday — which is when it would otherwise be discovered.
 */
export function validateWps(input: WpsFileInput): string[] {
  const warnings: string[] = [];

  if (!/^\d{13}$/.test(input.employerId)) {
    warnings.push(`Employer ID must be 13 digits (got "${input.employerId}").`);
  }

  for (const e of input.employees) {
    const who = e.employeeName ?? e.personId;
    if (!/^\d{14}$/.test(e.personId)) {
      warnings.push(`${who}: MOHRE Person ID must be 14 digits.`);
    }
    if (!/^AE\d{21}$/.test(e.iban.replace(/\s/g, ""))) {
      warnings.push(`${who}: IBAN must be a 23-character UAE IBAN (AE + 21 digits).`);
    }
    if (!e.routingCode) {
      warnings.push(`${who}: missing bank routing code — the salary cannot be routed.`);
    }
    if (e.fixedIncome <= 0) {
      warnings.push(`${who}: fixed income is zero; MOHRE will reject the record.`);
    }
    if (e.daysOnLeave > e.daysInPeriod) {
      warnings.push(`${who}: leave days exceed days in the period.`);
    }
  }

  return warnings;
}

export function generateSif(input: WpsFileInput): WpsFile {
  const warnings = validateWps(input);
  const ts = stamp(input.generatedAt);
  const [year, month] = input.salaryMonth.split("-");
  const salaryYm = `${year}${month}`;

  const lines: string[] = [];
  let total = 0;

  // EDR — Employee Detail Records.
  for (const e of input.employees) {
    const amount = e.fixedIncome + e.variableIncome;
    total += amount;
    lines.push(
      [
        "EDR",
        e.personId,
        e.agentId,
        e.routingCode,
        e.iban.replace(/\s/g, ""),
        `${salaryYm}01`, // pay period start
        `${salaryYm}${pad(e.daysInPeriod, 2)}`, // pay period end
        String(e.daysInPeriod),
        money(e.fixedIncome),
        money(e.variableIncome),
        String(e.daysOnLeave),
      ].join(","),
    );
  }

  // SCR — Salary Control Record. Exactly one, and it must be last.
  lines.push(
    [
      "SCR",
      input.employerId,
      input.employerAgentId,
      input.employerRoutingCode,
      ts.date,
      ts.time,
      salaryYm,
      money(total),
      String(input.employees.length),
      "AED",
    ].join(","),
  );

  return {
    fileName: `${input.employerId}${ts.full}.SIF`,
    content: `${lines.join("\r\n")}\r\n`, // MOHRE expects CRLF
    recordCount: input.employees.length,
    totalSalaries: total,
    warnings,
  };
}
