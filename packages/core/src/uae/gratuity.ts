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
 * SERVICE IS MEASURED IN CALENDAR ANNIVERSARIES, NOT IN DAYS ÷ 365.
 *
 * This module used to divide elapsed days by 365 to get service years. That is
 * wrong in exactly one way, and it always errs in the employee's favour: any
 * period spanning a leap day holds more than 365n days, so the divisor reports
 * an anniversary as passed before it is. Someone who joined 2019-01-01 and is
 * valued at 2024-01-01 has served five years to the day; days ÷ 365 called that
 * 5.0027 years and paid 2.47 days at the 30-day rate before the fifth
 * anniversary arrived — AED 34,547.57 against a correct AED 34,520.55, and
 * roughly AED 135 by year twenty.
 *
 * The money is small. What it costs is the thing the register exists for:
 * `hr/gratuity/page.tsx` promises the owner that every row reconciles by hand
 * against Article 51, and a row that is 2.47 days out on a round anniversary
 * cannot be reconciled by hand at all. So the band boundary is a real date —
 * `joinedOn` plus five years — and a year of service is worth its 21 or 30 days
 * on the day it completes, never before.
 *
 * Within a part-completed year the accrual is pro-rated over the actual length
 * of THAT service year, 365 or 366 days, not a nominal 365. This is a stated
 * convention rather than a statutory rule — Article 51 says only that partial
 * years are pro-rated — and it is the convention that keeps the invariant
 * honest: the fraction reaches 1.0 on the anniversary and never before it.
 * Pro-rating over a flat 365 would credit a whole year's days a day early in a
 * leap service year, which is the same error, one band lower down.
 *
 * The 365 that stays: the DAILY WAGE is monthly basic × 12 ÷ 365. That is the
 * MOHRE and court convention for turning a monthly salary into a daily rate, it
 * has nothing to do with measuring service, and it is right. The two must not
 * be conflated again, which is why the constant is named for its one job.
 *
 * Under the 2021 law the old reductions for resignation (1/3 and 2/3 for
 * unlimited contracts) were removed: an employee who resigns after one year
 * receives the same accrual as one who is terminated. `reason` is retained for
 * gross-misconduct forfeiture under Article 44 — read the assumption recorded
 * on that branch before trusting it. It is open question Q-2b and it is not
 * settled law.
 */

import * as M from "../money/index.ts";

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
  /** Completed anniversaries plus the fraction of the current service year. */
  serviceYears: number;
  dailyBasicWage: number;
  /** Days of wage earned in the first five years (at 21/yr), pro-rated in the part year. */
  firstFiveYearDays: number;
  /** Days of wage earned beyond five years (at 30/yr), pro-rated in the part year. */
  beyondFiveYearDays: number;
  totalDays: number;
  grossAmount: number;
  /** Statutory ceiling: two years' total wage. */
  cappedAt: number | null;
  amount: number;
  explanation: string;
}

/**
 * The divisor that turns a monthly salary into a daily rate, and NOTHING else.
 *
 * Named this way on purpose. The defect this module carried was a single
 * `DAYS_PER_YEAR = 365` used both here, where it is the MOHRE convention and
 * correct, and to measure length of service, where it silently moved the
 * 21→30 day band boundary earlier on every leap day. Service length is counted
 * in anniversaries below; nothing outside `dailyBasicWage` may use this.
 */
const WAGE_DAYS_PER_YEAR = 365;

/** The 21-day band runs to the fifth anniversary; 30 days a year after it. */
const FIRST_BAND_YEARS = 5;
const FIRST_BAND_DAYS_PER_YEAR = 21;
const BEYOND_BAND_DAYS_PER_YEAR = 30;

const MS_PER_DAY = 86_400_000;

function daysBetween(from: string, to: string): number {
  // Both ends are parsed at UTC midnight, so the quotient is always integral
  // and no DST or local-offset shift can round it the wrong way.
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY,
  );
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * `iso` plus `years` calendar years, with 29 February clamped back to the 28th
 * in a target year that has no 29th.
 *
 * Clamping rather than rolling forward to 1 March: an employee who joined on a
 * leap day completes a year of service at the end of February, not a day into
 * March. Rolling forward would delay the band boundary by a day, which is the
 * same class of error as the divisor this replaced, pointed the other way.
 */
function addYears(iso: string, years: number): string {
  // Read the parts off a UTC Date rather than slicing the string: this file is
  // on a money path, so `check-money.mjs` refuses a bare `Number()` here, and
  // the accessors are the right tool anyway.
  const from = new Date(Date.parse(`${iso}T00:00:00Z`));
  const targetYear = from.getUTCFullYear() + years;
  const monthIndex = from.getUTCMonth();
  // Day 0 of the NEXT month is the last day of this one — the standard way to
  // ask "how long is February in this particular year".
  const lastDayOfMonth = new Date(Date.UTC(targetYear, monthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(from.getUTCDate(), lastDayOfMonth);
  return new Date(Date.UTC(targetYear, monthIndex, clampedDay)).toISOString().slice(0, 10);
}

/** Anniversaries of `from` that have been reached on or before `to`. */
function completedYears(from: string, to: string): number {
  if (to <= from) return 0; // fixed-width ISO dates compare chronologically
  // No calendar year exceeds 366 days, so this seed can only undershoot; the
  // loop then walks up to the true count using real anniversary dates.
  let years = Math.floor(daysBetween(from, to) / 366);
  while (addYears(from, years + 1) <= to) years += 1;
  return years;
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

  // Unpaid leave and absconding push the start of the service clock forward
  // rather than being netted off a day total. Same arithmetic, but it leaves
  // the anniversary a real date, which is what the band boundary now needs.
  const serviceStart = addDays(joinedOn, unpaidLeaveDays);
  const serviceDays = Math.max(0, daysBetween(serviceStart, asOf));

  const years = completedYears(serviceStart, asOf);
  const lastAnniversary = addYears(serviceStart, years);
  const nextAnniversary = addYears(serviceStart, years + 1);
  const daysIntoYear = Math.max(0, daysBetween(lastAnniversary, asOf));
  const daysInThisYear = daysBetween(lastAnniversary, nextAnniversary); // 365 or 366
  const serviceYears = years + daysIntoYear / daysInThisYear;

  /**
   * ASSUMPTION, NOT SETTLED LAW — open question Q-2b.
   *
   * This branch forfeits the whole entitlement on dismissal for gross
   * misconduct. That was unambiguously the rule under Articles 120 and 139 of
   * the superseded Federal Law 8 of 1980. Whether it survived is not clear:
   * Article 44 of Federal Decree-Law 33/2021 permits summary dismissal without
   * notice, but on the reading we have — which no adviser has confirmed — it
   * does not extinguish the Article 51 end-of-service benefit.
   *
   * What the assumption is worth: a ten-year employee on an AED 10,000 basic
   * receives AED 0 here against AED 83,835.62 on an ordinary termination
   * (255 days × 328.767123).
   *
   * The behaviour is deliberately left as it stands. Flipping it would be
   * guessing in the other direction, and paying a gratuity the law does not
   * require is as hard to unwind as withholding one it does. What has changed
   * is that the guess is now marked everywhere it is visible: `uae.test.ts`
   * carries it as an `it.todo` rather than a passing assertion, and both the
   * register page and `docs/05-uae-localisation.md` present it as an assumption
   * rather than as fact.
   *
   * What would settle it: a written position from MOHRE or an employment
   * lawyer. If the forfeiture is gone, delete this branch — `reason` then has
   * no effect on the amount at all and becomes a record-keeping field. If it
   * survived, replace this comment with the citation.
   */
  if (reason === "gross_misconduct") {
    return {
      entitled: false, serviceDays, serviceYears,
      dailyBasicWage: 0, firstFiveYearDays: 0, beyondFiveYearDays: 0,
      totalDays: 0, grossAmount: 0, cappedAt: null, amount: 0,
      explanation:
        "Forfeited: dismissal under Article 44 (gross misconduct). " +
        "Assumed, not confirmed — see Q-2b.",
    };
  }

  if (years < 1) {
    return {
      entitled: false, serviceDays, serviceYears,
      dailyBasicWage: 0, firstFiveYearDays: 0, beyondFiveYearDays: 0,
      totalDays: 0, grossAmount: 0, cappedAt: null, amount: 0,
      explanation:
        `No entitlement: ${serviceDays} days of service since ${serviceStart}. ` +
        `The first anniversary falls on ${nextAnniversary}.`,
    };
  }

  // Daily wage is the monthly basic annualised over a 365-day year — the
  // convention MOHRE and the courts use, not monthly ÷ 30.
  //
  // Computed in exact decimal. (basic × 12) ÷ 365 does not terminate for most
  // salaries, and the result is then multiplied by up to ~700 days, so float
  // error is amplified rather than absorbed. This figure is what an employee is
  // actually paid on termination and what the accrued liability is measured
  // against, so it is not a place for "close enough".
  const dailyBasicWage = M.div(M.mul(M.money(basicSalary), 12), WAGE_DAYS_PER_YEAR);

  // The day counts are exact decimals too, not floats.
  //
  // The claim above only held from the daily wage onward while service years
  // came from a float division: a non-integral `totalDays` was multiplied into
  // an exact `Money` and carried its own binary error in with it. Completed
  // years are whole numbers, and the one division left — the fraction of the
  // part-completed year — runs at Decimal's 34 significant digits rather than
  // IEEE-754's 15-and-a-bit, thirty orders of magnitude below the fils this is
  // quantised to.
  //
  // The part-completed year accrues at the rate of the band it sits IN: year
  // six is a 30-day year from its first day, even though only part of it has
  // been served.
  const partialRate =
    years >= FIRST_BAND_YEARS ? BEYOND_BAND_DAYS_PER_YEAR : FIRST_BAND_DAYS_PER_YEAR;
  const partialDays = M.mul(M.div(M.money(daysIntoYear), daysInThisYear), partialRate);

  const completedInFirstBand = Math.min(years, FIRST_BAND_YEARS);
  const completedBeyondBand = Math.max(0, years - FIRST_BAND_YEARS);

  const firstFiveYearDays = M.add(
    M.mul(M.money(completedInFirstBand), FIRST_BAND_DAYS_PER_YEAR),
    years < FIRST_BAND_YEARS ? partialDays : M.ZERO,
  );
  const beyondFiveYearDays = M.add(
    M.mul(M.money(completedBeyondBand), BEYOND_BAND_DAYS_PER_YEAR),
    years >= FIRST_BAND_YEARS ? partialDays : M.ZERO,
  );
  const totalDays = M.add(firstFiveYearDays, beyondFiveYearDays);

  const grossAmount = M.quantize(M.mul(dailyBasicWage, totalDays));

  // Statutory ceiling: the total may not exceed two years' total remuneration.
  const ceiling = M.quantize(M.mul(M.money(totalSalary), 24));
  const capped = M.gt(grossAmount, ceiling);
  const amount = capped ? ceiling : grossAmount;

  const firstBandDays = M.toNumber(firstFiveYearDays);
  const beyondBandDays = M.toNumber(beyondFiveYearDays);
  const allDays = M.toNumber(totalDays);

  // Stated so the row can be checked by hand: the completed years, the exact
  // fraction of the year in progress, and the daily wage they multiply.
  const serviceLabel =
    `${years} complete year${years === 1 ? "" : "s"} since ${serviceStart}` +
    (daysIntoYear > 0 ? ` plus ${daysIntoYear}/${daysInThisYear} days` : "");
  const explanation = capped
    ? `${serviceLabel} → ${allDays.toFixed(1)} days' basic wage, ` +
      `capped at two years' total wage (${M.toDisplay(ceiling)}).`
    : `${serviceLabel} → ${firstBandDays.toFixed(1)} days at 21/year` +
      (beyondBandDays > 0 ? ` plus ${beyondBandDays.toFixed(1)} days at 30/year` : "") +
      `, at a daily basic wage of ${M.toDisplay(dailyBasicWage)}.`;

  return {
    entitled: true,
    serviceDays,
    serviceYears,
    dailyBasicWage: M.toNumber(dailyBasicWage),
    firstFiveYearDays: firstBandDays,
    beyondFiveYearDays: beyondBandDays,
    totalDays: allDays,
    grossAmount: M.toNumber(grossAmount),
    cappedAt: capped ? M.toNumber(ceiling) : null,
    amount: M.toNumber(amount),
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
    // Exact: the accrual is the movement in the liability, and a float
    // subtraction here would drift the balance every month it is posted.
    accrual: M.toNumber(M.sub(M.money(result.amount), M.money(alreadyAccrued))),
    closingLiability: result.amount,
    result,
  };
}
