/**
 * UAE corporate tax and VAT computation.
 *
 * Corporate tax: Federal Decree-Law No. 47 of 2022, effective for financial
 * years starting on or after 1 June 2023.
 *
 * VAT: Federal Decree-Law No. 8 of 2017, standard rate 5%.
 *
 * These are *estimates for management decision-making*, clearly labelled as
 * such. They are not a tax filing, and the system says so wherever it shows
 * them — a business owner acting on an ERP's tax number without their accountant
 * is a liability the product should not create.
 */

// ── Corporate tax ───────────────────────────────────────────────────────────

import * as M from "../money/index.ts";

export const CT_THRESHOLD = 375_000; // AED — taxable income taxed at 0% below this
export const CT_RATE = 0.09;
export const SBR_REVENUE_CAP = 3_000_000; // AED — Small Business Relief ceiling
/** Ministerial Decision 73 of 2023: SBR is available for tax periods ending on
 *  or before 31 December 2026. */
export const SBR_AVAILABLE_UNTIL = "2026-12-31";

// Money-module forms of the statutory constants, derived from the exported
// numbers above so the two can never drift apart. `String(CT_RATE)` rather than
// `CT_RATE` because a rate that arrives as a literal should be parsed as the
// decimal it is written as, not as the nearest double to it.
const CT_THRESHOLD_M = M.money(CT_THRESHOLD);
const CT_RATE_M = M.money(String(CT_RATE));
const SBR_REVENUE_CAP_M = M.money(SBR_REVENUE_CAP);
/** Article 37(2): brought-forward losses may offset at most 75% of taxable
 *  income in any one period. */
const LOSS_OFFSET_CAP_M = M.money("0.75");

export interface CorporateTaxInput {
  /** Accounting profit before tax for the period. */
  accountingProfit: number;
  /** Total revenue for the period — determines Small Business Relief. */
  revenue: number;
  /** Period end, ISO date. Determines whether SBR is still available. */
  periodEnd: string;
  /**
   * Revenue for every earlier tax period of the same taxable person.
   *
   * Relief is not a fresh test each year: FR-C04 requires eligibility to be
   * evaluated against revenue in the current **and all prior** periods, so a
   * business that turned over AED 4m in 2024 and AED 2m in 2026 is not eligible
   * in 2026. Omitting this is a claim that there are no prior periods — a first
   * tax period — not a claim that they were all under the cap.
   */
  priorPeriodRevenues?: number[];
  /**
   * Expenses disallowed for corporate tax. The common ones for an
   * owner-operated group: entertainment is only 50% deductible, fines are not
   * deductible at all, and owner drawings are not an expense in the first place.
   */
  disallowedExpenses?: number;
  /** Losses carried forward from earlier periods (capped at 75% of income). */
  lossesBroughtForward?: number;
  /** Whether the business elects Small Business Relief where eligible. */
  electSbr?: boolean;
}

export interface CorporateTaxResult {
  accountingProfit: number;
  taxableIncome: number;
  lossesUtilised: number;
  sbrEligible: boolean;
  sbrApplied: boolean;
  /** Income taxed at 0% — the first AED 375,000. */
  exemptSlice: number;
  taxableSlice: number;
  taxDue: number;
  effectiveRate: number;
  notes: string[];
}

/**
 * Corporate tax for one taxable person and one tax period.
 *
 * Exact decimal throughout, via the `Money` module. Nothing here needs 34
 * significant digits to come out right at AED magnitudes — the reason is that
 * this function's output is quoted to a regulator, and a money path that is
 * *usually* fine under IEEE-754 is exactly the shape of the drift the money
 * module exists to remove. `calculateVatReturn` below and `calculateGratuity`
 * next door already work this way; a single float island in the middle of them
 * is the thing that grows back.
 *
 * **Small Business Relief is not free.** Electing relief means the taxable
 * person is treated as having no taxable income for the period, which is worth
 * nothing to a business that made a loss — and, on my reading, the period's tax
 * losses and disallowed net interest are forfeited rather than carried forward,
 * so a loss-making year spent under relief cannot later shelter a profitable
 * one. That reading is NOT confirmed against Ministerial Decision 73 of 2023 or
 * Article 37 and is not stated in any document in this repo, so the election
 * carries a note telling the accountant to confirm it rather than a computation
 * that assumes it. This is why `lossesUtilised` is 0 on the relief path: no
 * losses are used, and the caller should not read that as "no losses were lost".
 *
 * An estimate for planning. The filing position is the accountant's.
 */
export function calculateCorporateTax(input: CorporateTaxInput): CorporateTaxResult {
  const {
    accountingProfit,
    revenue,
    periodEnd,
    priorPeriodRevenues = [],
    disallowedExpenses = 0,
    lossesBroughtForward = 0,
    electSbr = true,
  } = input;

  const notes: string[] = [];

  // Eligibility is two independent tests, and they are kept apart because the
  // note each failure produces is different: a business over the cap needs to
  // be told it is too big, a business under the cap in 2027 needs to be told
  // the relief itself has gone. Folding them into one boolean is how the
  // expiry note came to be unreachable.
  const overCapPeriods = [revenue, ...priorPeriodRevenues].filter(
    (r) => M.gt(M.money(r), SBR_REVENUE_CAP_M),
  );
  const withinRevenueCap = overCapPeriods.length === 0;
  const sbrStillOffered = periodEnd <= SBR_AVAILABLE_UNTIL;
  const sbrEligible = sbrStillOffered && withinRevenueCap;
  const sbrApplied = sbrEligible && electSbr;

  if (!sbrStillOffered && withinRevenueCap) {
    notes.push(
      `Small Business Relief is no longer available for tax periods ending after ` +
        `${SBR_AVAILABLE_UNTIL}. Revenue is within the cap, but the relief has expired — ` +
        `this is why a business that paid nothing last period pays tax on this one.`,
    );
  }

  if (sbrApplied) {
    notes.push(
      `Small Business Relief elected: revenue of ${revenue.toLocaleString("en-AE")} AED is ` +
        `within the ${SBR_REVENUE_CAP.toLocaleString("en-AE")} AED cap, so the business is ` +
        `treated as having no taxable income for this period.`,
    );
    notes.push(
      `Electing relief may forfeit this period's tax losses and disallowed net interest for ` +
        `carry-forward. Confirm with your tax adviser before electing in a loss-making or ` +
        `heavily geared period — the election is not free.`,
    );
    return {
      accountingProfit,
      taxableIncome: 0,
      lossesUtilised: 0,
      sbrEligible,
      sbrApplied: true,
      exemptSlice: 0,
      taxableSlice: 0,
      taxDue: 0,
      effectiveRate: 0,
      notes,
    };
  }

  if (!withinRevenueCap && sbrStillOffered) {
    const currentOverCap = M.gt(M.money(revenue), SBR_REVENUE_CAP_M);
    notes.push(
      currentOverCap
        ? `Revenue of ${revenue.toLocaleString("en-AE")} AED exceeds the ` +
            `${SBR_REVENUE_CAP.toLocaleString("en-AE")} AED Small Business Relief cap.`
        : `Revenue this period is within the cap, but ${overCapPeriods.length} earlier ` +
            `period(s) exceeded ${SBR_REVENUE_CAP.toLocaleString("en-AE")} AED. Relief is ` +
            `tested against the current and all prior periods, so it is not available.`,
    );
  }

  const adjusted = M.add(M.money(accountingProfit), M.money(disallowedExpenses));
  if (disallowedExpenses > 0) {
    notes.push(
      `${disallowedExpenses.toLocaleString("en-AE")} AED of disallowed expenses added back.`,
    );
  }

  // Losses may offset at most 75% of taxable income in any period. Quantized
  // here so the cap itself is a storable amount rather than a repeating
  // fraction that then decides how much loss is used.
  const maxLossOffset = M.quantize(M.mul(M.max(M.ZERO, adjusted), LOSS_OFFSET_CAP_M));
  const lossesUtilisedM = M.min(M.money(lossesBroughtForward), maxLossOffset);
  if (M.gt(lossesUtilisedM, M.ZERO)) {
    notes.push(
      `${M.toNumber(lossesUtilisedM).toLocaleString("en-AE")} AED of brought-forward losses ` +
        `used (capped at 75% of taxable income).`,
    );
  }

  const taxableIncomeM = M.max(M.ZERO, M.sub(adjusted, lossesUtilisedM));
  const exemptSliceM = M.min(taxableIncomeM, CT_THRESHOLD_M);
  const taxableSliceM = M.max(M.ZERO, M.sub(taxableIncomeM, CT_THRESHOLD_M));
  const taxDueM = M.quantize(M.mul(taxableSliceM, CT_RATE_M));

  notes.push(
    `First ${CT_THRESHOLD.toLocaleString("en-AE")} AED at 0%; ` +
      `remainder at ${(CT_RATE * 100).toFixed(0)}%.`,
  );

  return {
    accountingProfit,
    taxableIncome: M.toNumber(taxableIncomeM),
    lossesUtilised: M.toNumber(lossesUtilisedM),
    sbrEligible,
    sbrApplied: false,
    exemptSlice: M.toNumber(exemptSliceM),
    taxableSlice: M.toNumber(taxableSliceM),
    taxDue: M.toNumber(taxDueM),
    effectiveRate: M.gt(taxableIncomeM, M.ZERO) ? M.toNumber(M.div(taxDueM, taxableIncomeM)) : 0,
    notes,
  };
}

// ── VAT ─────────────────────────────────────────────────────────────────────

export const VAT_RATE = 0.05;

export interface VatReturnInput {
  /** Standard-rated supplies, net of VAT (VAT201 box 1). */
  standardRatedSupplies: number;
  outputVat: number;
  /** Zero-rated supplies (box 4) — 0% but input VAT IS recoverable. */
  zeroRatedSupplies: number;
  /** Exempt supplies (box 5) — residential rent. Input VAT NOT recoverable. */
  exemptSupplies: number;
  /** Reverse-charge supplies (box 3). */
  reverseChargeSupplies: number;
  /** Input VAT on purchases directly attributable to taxable supplies. */
  directlyAttributableInput: number;
  /** Input VAT on overheads used for both taxable and exempt supplies. */
  residualInput: number;
  /** Input VAT directly attributable to exempt supplies — never recoverable. */
  exemptAttributableInput: number;
}

export interface VatReturnResult {
  boxes: Record<string, number>;
  /** Share of residual input VAT that may be recovered. */
  recoveryRatio: number;
  recoverableResidual: number;
  totalRecoverableInput: number;
  irrecoverableInput: number;
  netVatDue: number;
  isRefund: boolean;
  notes: string[];
}

/**
 * VAT return position with **input apportionment**.
 *
 * This is the part almost every SMB gets wrong, and it is specifically wrong for
 * this portfolio because the residential flats make exempt supplies. Overheads
 * used across both the taxable businesses and the exempt rentals cannot be
 * reclaimed in full: only the taxable proportion is recoverable, computed using
 * the FTA's standard input-tax apportionment method
 * (taxable supplies ÷ total supplies).
 *
 * Reclaiming 100% of overhead input VAT while renting out residential property
 * is a straightforward assessment risk. Modelling it correctly is worth more
 * than any dashboard widget in this system.
 *
 * **The basis in use is supplies value, and it is not confirmed.** The ratio
 * below is `taxable supplies ÷ total supplies` — turnover. There is a reading of
 * Executive Regulation (Cabinet Decision 52/2017) Article 55 under which the
 * standard method instead works from *input tax amounts*: input tax wholly
 * attributable to taxable supplies ÷ (that plus input tax wholly attributable to
 * exempt supplies). The two diverge materially — on directly-attributable input
 * of 50,000 taxable / 10,000 exempt with 20,000 residual and supplies split
 * 1m/1m, the supplies basis recovers 10,000 and the input-tax basis 16,667,
 * comfortably past the AED 10,000 voluntary-disclosure threshold within two
 * quarters. Both inputs the alternative needs are already on `VatReturnInput`,
 * so switching bases is a small change; deciding which one is right is not.
 * Parked for the tax adviser alongside Q-1. Do not change this on a guess.
 */
export function calculateVatReturn(input: VatReturnInput): VatReturnResult {
  const {
    standardRatedSupplies,
    outputVat,
    zeroRatedSupplies,
    exemptSupplies,
    reverseChargeSupplies,
    directlyAttributableInput,
    residualInput,
    exemptAttributableInput,
  } = input;

  const notes: string[] = [];

  // Zero-rated supplies count as taxable for apportionment; exempt do not.
  // Exact decimal throughout. The recovery ratio is a division that almost
  // never terminates, and it multiplies the residual input VAT that goes on the
  // return — an error here is a misstated reclaim to the FTA, where a
  // difference above AED 10,000 triggers a mandatory voluntary disclosure.
  //
  // The irrecoverable portion is taken as the REMAINDER of the residual rather
  // than recomputed from (1 - ratio), so recoverable + irrecoverable always
  // equals the residual exactly and the return's own boxes reconcile.
  const taxable = M.add(M.money(standardRatedSupplies), M.money(zeroRatedSupplies));
  const exempt = M.money(exemptSupplies);
  const totalSup = M.add(taxable, exempt);
  const residual = M.money(residualInput);

  const ratio = M.gt(totalSup, M.ZERO) ? M.div(taxable, totalSup) : M.money(1);
  const recoverableResidualM = M.quantize(M.mul(residual, ratio));
  const totalRecoverableInputM = M.add(M.money(directlyAttributableInput), recoverableResidualM);
  const irrecoverableInputM = M.add(
    M.money(exemptAttributableInput),
    M.sub(residual, recoverableResidualM),
  );

  const taxableSupplies = M.toNumber(taxable);
  const totalSupplies = M.toNumber(totalSup);
  const recoveryRatio = M.toNumber(ratio);
  const recoverableResidual = M.toNumber(recoverableResidualM);
  const totalRecoverableInput = M.toNumber(totalRecoverableInputM);
  const irrecoverableInput = M.toNumber(irrecoverableInputM);

  if (exemptSupplies > 0) {
    notes.push(
      `Exempt (residential) supplies are ${((exemptSupplies / totalSupplies) * 100).toFixed(1)}% ` +
        `of turnover, so only ${(recoveryRatio * 100).toFixed(1)}% of residual input VAT is ` +
        `recoverable. ${M.toDisplay(irrecoverableInputM)} AED is a cost, not a reclaim.`,
    );
  }

  const netVatDue = M.toNumber(M.sub(M.money(outputVat), totalRecoverableInputM));

  return {
    boxes: {
      "1_standard_rated_supplies": standardRatedSupplies,
      "1_output_vat": outputVat,
      "3_reverse_charge": reverseChargeSupplies,
      "4_zero_rated": zeroRatedSupplies,
      "5_exempt": exemptSupplies,
      "9_recoverable_input": totalRecoverableInput,
    },
    recoveryRatio,
    recoverableResidual,
    totalRecoverableInput,
    irrecoverableInput,
    netVatDue,
    isRefund: netVatDue < 0,
    notes,
  };
}
