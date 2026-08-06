/**
 * UAE end-of-service gratuity.
 *
 * Federal Decree-Law No. 33 of 2021 (the Labour Law), Article 51, and Cabinet
 * Resolution 1 of 2022.
 *
 * Why this is its own module rather than a line in the payroll run:
 *
 * Gratuity is a liability that accrues on every single day an employee works,
 * but it is only *paid* when they leave. Businesses that do not accrue it are
 * carrying an unrecorded debt — and for a group with long-serving staff it is
 * frequently one of the largest items that should be on the balance sheet and
 * is not. Owners discover it the week someone resigns.
 *
 * The rules, precisely:
 *
 *  • Less than 1 year of continuous service → no entitlement.
 *  • Years 1–5 → 21 calendar days' BASIC wage per year of service.
 *  • Beyond 5 years → 30 calendar days' basic wage for each additional year.
 *  • Total entitlement is capped at 2 years' total wage.
 *  • Partial years are pro-rated on completed days.
 *  • Calculated on BASIC salary only — housing, transport and other allowances
 *    are excluded. This is why `employees` splits the package into components
 *    rather than storing one figure.
 *
 * Under the 2021 law the old reductions for resignation (1/3 and 2/3 for
 * unlimited contracts) were removed: an employee who resigns after one year
 * receives the same accrual as one who is terminated. `reason` is retained for
 * gross-misconduct forfeiture under Article 44.
 */

export interface GratuityInput {
  /** Monthly BASIC wage, excluding all allowances. */
  basicSalary: number;
  /** Total monthly wage including allowances — used only for the 2-year cap. */
  totalSalary: number;
  joinedOn: string; // ISO date
  /** Date to value the liability at (accrual) or the last working day (payout). */
  asOf: string; // ISO date
  reason?: "accrual" | "resignation" | "termination" | "gross_misconduct";
  /** Unpaid leave and absconding periods do not count toward service. */
  unpaidLeaveDays?: number;
}

export interface GratuityResult {
  entitled: boolean;
  serviceDays: number;
  serviceYears: number;
  dailyBasicWage: number;
  /** Days of wage earned in the first five years (at 21/yr). */
  firstFiveYearDays: number;
  /** Days of wage earned beyond five years (at 30/yr). */
  beyondFiveYearDays: number;
  totalDays: number;
  grossAmount: number;
  /** Statutory ceiling: two years' total wage. */
  cappedAt: number | null;
  amount: number;
  explanation: string;
}

const DAYS_PER_YEAR = 365;

function daysBetween(from: string, to: string): number {
  return Math.floor(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  );
}

export function calculateGratuity(input: GratuityInput): GratuityResult {
  const {
    basicSalary,
    totalSalary,
    joinedOn,
    asOf,
    reason = "accrual",
    unpaidLeaveDays = 0,
  } = input;

  const serviceDays = Math.max(0, daysBetween(joinedOn, asOf) - unpaidLeaveDays);
  const serviceYears = serviceDays / DAYS_PER_YEAR;

  // Article 44 — dismissal for gross misconduct forfeits the entitlement.
  if (reason === "gross_misconduct") {
    return {
      entitled: false, serviceDays, serviceYears,
      dailyBasicWage: 0, firstFiveYearDays: 0, beyondFiveYearDays: 0,
      totalDays: 0, grossAmount: 0, cappedAt: null, amount: 0,
      explanation: "Forfeited: dismissal under Article 44 (gross misconduct).",
    };
  }

  if (serviceDays < DAYS_PER_YEAR) {
    return {
      entitled: false, serviceDays, serviceYears,
      dailyBasicWage: 0, firstFiveYearDays: 0, beyondFiveYearDays: 0,
      totalDays: 0, grossAmount: 0, cappedAt: null, amount: 0,
      explanation: `No entitlement: ${serviceDays} days of service, minimum is 365.`,
    };
  }

  // Daily wage is the monthly basic annualised over a 365-day year — the
  // convention MOHRE and the courts use, not monthly ÷ 30.
  const dailyBasicWage = (basicSalary * 12) / DAYS_PER_YEAR;

  const yearsInFirstBand = Math.min(serviceYears, 5);
  const yearsBeyondFive = Math.max(0, serviceYears - 5);

  const firstFiveYearDays = yearsInFirstBand * 21;
  const beyondFiveYearDays = yearsBeyondFive * 30;
  const totalDays = firstFiveYearDays + beyondFiveYearDays;

  const grossAmount = totalDays * dailyBasicWage;

  // Statutory ceiling: the total may not exceed two years' total remuneration.
  const ceiling = totalSalary * 24;
  const capped = grossAmount > ceiling;
  const amount = capped ? ceiling : grossAmount;

  const yearsLabel = serviceYears.toFixed(2);
  const explanation = capped
    ? `${yearsLabel} years of service → ${totalDays.toFixed(1)} days' basic wage, ` +
      `capped at two years' total wage (${ceiling.toFixed(2)}).`
    : `${yearsLabel} years of service → ${firstFiveYearDays.toFixed(1)} days at 21/year` +
      (yearsBeyondFive > 0 ? ` plus ${beyondFiveYearDays.toFixed(1)} days at 30/year` : "") +
      `, at a daily basic wage of ${dailyBasicWage.toFixed(2)}.`;

  return {
    entitled: true,
    serviceDays,
    serviceYears,
    dailyBasicWage,
    firstFiveYearDays,
    beyondFiveYearDays,
    totalDays,
    grossAmount,
    cappedAt: capped ? ceiling : null,
    amount,
    explanation,
  };
}

/**
 * The delta to post this month.
 *
 * Accrual is booked as the *movement* in the liability, not the whole balance,
 * so re-running the job is idempotent and does not double-count.
 */
export function monthlyGratuityAccrual(
  input: GratuityInput,
  alreadyAccrued: number,
): { accrual: number; closingLiability: number; result: GratuityResult } {
  const result = calculateGratuity(input);
  return {
    accrual: result.amount - alreadyAccrued,
    closingLiability: result.amount,
    result,
  };
}
